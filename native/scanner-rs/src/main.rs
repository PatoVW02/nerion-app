use std::collections::HashSet;
use std::env;
use std::fs::{self, Metadata};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Foundation::GetLastError;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    GetCompressedFileSizeW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, IDLE_PRIORITY_CLASS,
};

const PROTOCOL_VERSION: u8 = 1;

#[cfg(target_os = "macos")]
#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn FSEventsGetCurrentEventId() -> u64;
}

#[cfg(target_os = "macos")]
fn current_journal_id() -> Option<u64> {
    Some(unsafe { FSEventsGetCurrentEventId() })
}

#[cfg(not(target_os = "macos"))]
fn current_journal_id() -> Option<u64> {
    None
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScanProfile {
    Interactive,
    Background,
}

impl ScanProfile {
    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("background") => Self::Background,
            _ => Self::Interactive,
        }
    }

    fn yield_policy(self) -> (u64, Duration) {
        match self {
            Self::Interactive => (128, Duration::from_millis(1)),
            Self::Background => (64, Duration::from_millis(2)),
        }
    }
}

#[cfg(windows)]
fn apply_process_priority(profile: ScanProfile) {
    let priority = match profile {
        ScanProfile::Interactive => BELOW_NORMAL_PRIORITY_CLASS,
        ScanProfile::Background => IDLE_PRIORITY_CLASS,
    };
    unsafe {
        SetPriorityClass(GetCurrentProcess(), priority);
    }
}

#[cfg(not(windows))]
fn apply_process_priority(_profile: ScanProfile) {}

struct ScanContext<'a, W: Write> {
    scan_id: &'a str,
    root_id: &'a str,
    writer: W,
    seen_hardlinks: HashSet<(u64, u64)>,
    entry_count: u64,
    issue_count: u64,
    profile: ScanProfile,
    journal_id: Option<u64>,
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if c.is_control() => {
                use std::fmt::Write as _;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(unix)]
fn file_identity(_path: &Path, metadata: &Metadata) -> (Option<u64>, Option<u64>) {
    (Some(metadata.dev()), Some(metadata.ino()))
}

#[cfg(windows)]
fn file_identity(path: &Path, _metadata: &Metadata) -> (Option<u64>, Option<u64>) {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return (None, None),
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } != 0;
    if !succeeded {
        return (None, None);
    }
    let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    (Some(info.dwVolumeSerialNumber as u64), Some(index))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_path: &Path, _metadata: &Metadata) -> (Option<u64>, Option<u64>) {
    (None, None)
}

#[cfg(unix)]
fn allocated_size(_path: &Path, metadata: &Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}

#[cfg(windows)]
fn allocated_size(path: &Path, metadata: &Metadata) -> u64 {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut high = 0u32;
    let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
    if low == u32::MAX && unsafe { GetLastError() } != 0 {
        metadata.len()
    } else {
        ((high as u64) << 32) | low as u64
    }
}

#[cfg(not(any(unix, windows)))]
fn allocated_size(_path: &Path, metadata: &Metadata) -> u64 {
    metadata.len()
}

fn option_number(value: Option<u64>) -> String {
    value
        .map(|v| json_string(&v.to_string()))
        .unwrap_or_else(|| "null".to_string())
}

impl<W: Write> ScanContext<'_, W> {
    fn write_entry(
        &mut self,
        path: &Path,
        full_path: &str,
        allocated_bytes: u64,
        is_dir: bool,
        metadata: &Metadata,
        hardlink_duplicate: bool,
    ) {
        let (device, inode) = file_identity(path, metadata);
        let line = format!(
            "{{\"protocolVersion\":{},\"event\":\"entry\",\"scanId\":{},\"rootId\":{},\"path\":{},\"allocatedBytes\":{},\"isDir\":{},\"device\":{},\"inode\":{},\"hardlinkDuplicate\":{}}}",
            PROTOCOL_VERSION,
            json_string(self.scan_id),
            json_string(self.root_id),
            json_string(full_path),
            allocated_bytes,
            is_dir,
            option_number(device),
            option_number(inode),
            hardlink_duplicate,
        );
        let _ = writeln!(self.writer, "{}", line);
        self.entry_count += 1;
        if self.entry_count.is_multiple_of(128) {
            let _ = self.writer.flush();
        }
        let (yield_every, duration) = self.profile.yield_policy();
        if self.entry_count.is_multiple_of(yield_every) {
            thread::sleep(duration);
        }
    }

    fn write_issue(&mut self, valid_path: &str, code: &str, message: &str) {
        let line = format!(
            "{{\"protocolVersion\":{},\"event\":\"issue\",\"scanId\":{},\"rootId\":{},\"issue\":{{\"path\":{},\"code\":{},\"message\":{}}}}}",
            PROTOCOL_VERSION,
            json_string(self.scan_id),
            json_string(self.root_id),
            json_string(valid_path),
            json_string(code),
            json_string(message),
        );
        let _ = writeln!(self.writer, "{}", line);
        self.issue_count += 1;
    }

    fn write_summary(&mut self) {
        let complete = self.issue_count == 0;
        let journal_id = self
            .journal_id
            .map(|value| json_string(&value.to_string()))
            .unwrap_or_else(|| "null".to_string());
        let line = format!(
            "{{\"protocolVersion\":{},\"event\":\"summary\",\"scanId\":{},\"rootId\":{},\"complete\":{},\"cancelled\":false,\"entryCount\":{},\"issueCount\":{},\"rootsCompleted\":1,\"rootsRequested\":1,\"fatalError\":null,\"journalId\":{}}}",
            PROTOCOL_VERSION,
            json_string(self.scan_id),
            json_string(self.root_id),
            complete,
            self.entry_count,
            self.issue_count,
            journal_id,
        );
        let _ = writeln!(self.writer, "{}", line);
        let _ = self.writer.flush();
    }
}

fn issue_code(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::PermissionDenied => "permission-denied",
        io::ErrorKind::NotFound => "not-found",
        _ => "io-error",
    }
}

fn protocol_path<'p, W: Write>(
    path: &'p Path,
    nearest_valid_path: &str,
    context: &mut ScanContext<'_, W>,
    message: &str,
) -> Option<&'p str> {
    match path.to_str() {
        Some(value) => Some(value),
        None => {
            context.write_issue(nearest_valid_path, "non_utf8_path", message);
            None
        }
    }
}

fn walk_dir<W: Write>(path: &Path, root: &Path, context: &mut ScanContext<'_, W>) -> u64 {
    // Traversal is only allowed through paths that can round-trip through the
    // UTF-8 JSON protocol. The root is validated by main and every child is
    // validated below before metadata access or recursion.
    let valid_path = match protocol_path(
        path,
        root.to_str().unwrap_or("."),
        context,
        "Skipped an entry whose path is not valid UTF-8 and cannot be represented safely.",
    ) {
        Some(value) => value,
        None => return 0,
    };
    let own_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            context.write_issue(valid_path, issue_code(&error), &error.to_string());
            return 0;
        }
    };
    let mut total = allocated_size(path, &own_metadata);

    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => {
            context.write_issue(valid_path, issue_code(&error), &error.to_string());
            return total;
        }
    };

    for entry_result in entries {
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(error) => {
                context.write_issue(valid_path, issue_code(&error), &error.to_string());
                continue;
            }
        };

        let child_path: PathBuf = entry.path();
        // Report against the nearest representable parent. Never emit a
        // replacement-character path that could identify a different file when
        // sent back for deletion.
        let child_path_string = match protocol_path(
            &child_path,
            valid_path,
            context,
            "Skipped an entry whose name is not valid UTF-8 and cannot be represented safely.",
        ) {
            Some(value) => value,
            None => continue,
        };
        let metadata = match fs::symlink_metadata(&child_path) {
            Ok(metadata) => metadata,
            Err(error) => {
                context.write_issue(child_path_string, issue_code(&error), &error.to_string());
                continue;
            }
        };

        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            continue;
        }

        if metadata.is_dir() {
            let dir_size = walk_dir(&child_path, root, context);
            total = total.saturating_add(dir_size);
            if child_path != root {
                context.write_entry(
                    &child_path,
                    child_path_string,
                    dir_size,
                    true,
                    &metadata,
                    false,
                );
            }
        } else if metadata.is_file() {
            let (device, inode) = file_identity(&child_path, &metadata);
            let identity = device.zip(inode);
            let duplicate = identity
                .map(|value| !context.seen_hardlinks.insert(value))
                .unwrap_or(false);
            let size = if duplicate {
                0
            } else {
                allocated_size(&child_path, &metadata)
            };
            total = total.saturating_add(size);
            if child_path != root {
                context.write_entry(
                    &child_path,
                    child_path_string,
                    size,
                    false,
                    &metadata,
                    duplicate,
                );
            }
        }
    }

    total
}

fn main() {
    let mut args = env::args_os().skip(1);
    let target = match args.next() {
        Some(path) => PathBuf::from(path),
        None => {
            eprintln!("Usage: scanner-bin <path> [scan-id] [root-id]");
            std::process::exit(1);
        }
    };
    let scan_id = args
        .next()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| "legacy-scan".to_string());
    let root_id = args
        .next()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| "root-0".to_string());
    let profile = ScanProfile::parse(args.next().as_deref().and_then(|value| value.to_str()));
    apply_process_priority(profile);

    // Capture the journal cursor before traversal. FSEvents can then replay
    // every mutation that raced with the scan instead of trusting a mixed
    // point-in-time result.
    let journal_id = current_journal_id();
    let stdout = io::stdout();
    let mut context = ScanContext {
        scan_id: &scan_id,
        root_id: &root_id,
        writer: io::BufWriter::new(stdout.lock()),
        seen_hardlinks: HashSet::new(),
        entry_count: 0,
        issue_count: 0,
        profile,
        journal_id,
    };

    if target.to_str().is_none() {
        let nearest_valid = target.parent().and_then(Path::to_str).unwrap_or(".");
        context.write_issue(
            nearest_valid,
            "non_utf8_path",
            "The scan root is not valid UTF-8 and cannot be represented safely.",
        );
        context.write_summary();
        return;
    }

    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) => {
            eprintln!("Could not access scan root: {}", error);
            std::process::exit(2);
        }
    };

    if !metadata.is_dir() {
        eprintln!("Scan root is not a directory");
        std::process::exit(2);
    }

    let _ = walk_dir(&target, &target, &mut context);
    context.write_summary();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_string_escapes_arbitrary_file_name_characters() {
        assert_eq!(
            json_string("tab\tline\n\"quoted\"\\path"),
            "\"tab\\tline\\n\\\"quoted\\\"\\\\path\""
        );
    }

    #[test]
    fn hard_links_share_the_same_file_identity() {
        let root = env::temp_dir().join(format!("nerion-scanner-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create fixture directory");
        let original = root.join("original");
        let linked = root.join("linked");
        fs::write(&original, b"scanner fixture").expect("write fixture");
        fs::hard_link(&original, &linked).expect("create hard link");

        let original_identity = file_identity(
            &original,
            &fs::metadata(&original).expect("original metadata"),
        );
        let linked_identity =
            file_identity(&linked, &fs::metadata(&linked).expect("linked metadata"));
        assert_eq!(original_identity, linked_identity);

        fs::remove_dir_all(&root).expect("remove fixture directory");
    }

    #[cfg(unix)]
    #[test]
    fn invalid_utf8_path_is_reported_at_its_valid_parent_and_never_serialized_lossily() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let root = env::temp_dir().join("nerion-scanner-valid-parent");
        let valid_path = root.join("valid-unicode-ñ.txt");
        let invalid_name =
            OsString::from_vec(vec![b'i', b'n', b'v', b'a', b'l', b'i', b'd', b'-', 0xff]);
        let invalid_path = root.join(invalid_name);

        let mut context = ScanContext {
            scan_id: "invalid-utf8-scan",
            root_id: "root-fixture",
            writer: Vec::<u8>::new(),
            seen_hardlinks: HashSet::new(),
            entry_count: 0,
            issue_count: 0,
            profile: ScanProfile::Interactive,
            journal_id: None,
        };
        let root_path = root.to_str().expect("valid root path");

        let rejected = protocol_path(
            &invalid_path,
            root_path,
            &mut context,
            "Skipped an entry whose name is not valid UTF-8 and cannot be represented safely.",
        );
        assert!(
            rejected.is_none(),
            "invalid bytes must not become an actionable path"
        );

        let preserved = protocol_path(&valid_path, root_path, &mut context, "unreachable");
        assert_eq!(
            preserved,
            valid_path.to_str(),
            "valid Unicode must round-trip exactly"
        );
        context.write_summary();

        assert_eq!(
            context.entry_count, 0,
            "an invalid path is never emitted as an entry"
        );
        assert_eq!(context.issue_count, 1, "the invalid entry is reported once");
        let output = String::from_utf8(context.writer).expect("scanner output remains UTF-8 JSONL");
        assert!(output.contains(&format!(
            "\"issue\":{{\"path\":{},\"code\":\"non_utf8_path\"",
            json_string(root_path)
        )));
        assert!(
            !output.contains('�'),
            "a lossy replacement path must never be emitted"
        );
    }

    #[test]
    fn scan_profiles_default_to_interactive_and_accept_background() {
        assert_eq!(ScanProfile::parse(None), ScanProfile::Interactive);
        assert_eq!(
            ScanProfile::parse(Some("unknown")),
            ScanProfile::Interactive
        );
        assert_eq!(
            ScanProfile::parse(Some("background")),
            ScanProfile::Background
        );
    }
}
