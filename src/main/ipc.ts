import { ipcMain, dialog, shell, net, Notification, app } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { stat, readdir, realpath } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { scanDirectoryStreaming } from './scanner'
import { loadSettings, saveSettings, patchSettings, NerionSettings } from './settings'
import { rebuildTrayMenu, scheduleBackgroundScan, stopBackgroundScan, runBackgroundScanNow, updateLastScanPath, setTrayVisibility, setQuitting, testNotification } from './background'
import { getLicenseInfo, activateLicense, startLicenseValidationService, deactivateLicense } from './license'
import { runAutoUpdateCheck, installDownloadedUpdateNow, isUpdateReadyToInstall } from './updater'
import { getPlatformAppearance, getPlatformMeta, revealInFileManager, supportsFullDiskAccess } from './platform'
import { SCAN_PROTOCOL_VERSION, type DeleteBatchResult, type LeftoverScanResult, type ScanEntryV1, type ScanEventV1, type ScanIssueV1, type ScanSummaryV1, type ScanSuspiciousV1, type SuspiciousFinding } from '../shared/contracts'
import { collapseOverlappingPaths, isSameOrDescendantPath } from '../shared/path-utils'
import { deleteRequestedPaths } from './deletion'
import { findAppLeftovers } from './leftovers'
import { inspectMasqueradingEntry, inspectSuspiciousPersistence } from './suspicious'
import { getAiCapabilities, getCloudAiConfig, normalizeAiMode } from './ai-config'
import { canConfigureCloudAi, loadCloudAiKey, OPENAI_MODEL, removeCloudAiKey, validateAndSaveCloudAiKey } from './cloud-ai'
import { isAllowedExternalUrl } from './security'
import { isValidIpcPath, normalizeNonNegativeKilobytes, normalizeRendererSettings, parseOllamaPullRecord } from './runtime-policy'
import { beginForegroundScan, endForegroundScan } from './scan-coordination'
import { createBufferedEventSender } from './scan-event-buffer'

const execFileAsync = promisify(execFile)

let cancelCurrentScan: (() => void) | null = null
let currentScanId: string | null = null
let deletionInProgress = false
let leftoverScanInFlight: Promise<LeftoverScanResult> | null = null

// Ollama state — tracked per active request
let ollamaAbort: AbortController | null = null
let ollamaRequestSequence = 0
const FREE_DELETE_LIMIT_PER_MONTH = 15

export function disposeIpcRuntime(): void {
  cancelCurrentScan?.()
  cancelCurrentScan = null
  currentScanId = null
  ollamaRequestSequence += 1
  ollamaAbort?.abort()
  ollamaAbort = null
  pullRequestSequence += 1
  pullAbort?.abort()
  pullAbort = null
}

async function checkNotificationPermissionStatus(): Promise<boolean | null> {
  if (process.platform === 'win32') return Notification.isSupported() ? true : null
  // Read the user-level TCC database — no FDA required, it lives in ~/Library.
  // Returns true (granted), false (denied), or null (no entry yet).
  try {
    const userTCC = path.join(os.homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db')
    const clientIds = Array.from(new Set([
      'com.patricio.nerion',
      'com.github.Electron',
      'com.github.electron',
    ].filter((value): value is string => !!value)))

    const quotedClients = clientIds.map((clientId) => `'${clientId.replace(/'/g, "''")}'`).join(', ')
    const { stdout: schemaOutput } = await execFileAsync('/usr/bin/sqlite3', [userTCC, 'PRAGMA table_info(access);'])
    const columns = new Set(
      schemaOutput
        .split(/\r?\n/)
        .map((line) => line.split('|')[1])
        .filter((column): column is string => typeof column === 'string' && column.length > 0),
    )
    const permissionExpression = columns.has('auth_value')
      ? 'auth_value'
      : columns.has('allowed') ? 'CASE WHEN allowed = 1 THEN 2 ELSE 0 END' : null
    if (!permissionExpression) return null
    const query = [
      'SELECT',
      `  ${permissionExpression} AS permission`,
      'FROM access',
      "WHERE service='kTCCServiceUserNotification'",
      `  AND client IN (${quotedClients})`,
      'ORDER BY permission DESC',
      'LIMIT 1;',
    ].join(' ')

    const { stdout } = await execFileAsync('/usr/bin/sqlite3', [userTCC, query])
    const value = stdout.trim()
    if (value === '2' || value === '3') return true
    if (value === '0' || value === '1') return false
    return null
  } catch {
    return null
  }
}

function currentMonthKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${now.getFullYear()}-${month}`
}

const APPLE_BUILTIN_APPS = new Set([
  'App Store.app',
  'Books.app',
  'Calendar.app',
  'Contacts.app',
  'FaceTime.app',
  'Mail.app',
  'Messages.app',
  'Music.app',
  'Notes.app',
  'Photos.app',
  'Podcasts.app',
  'Preview.app',
  'QuickTime Player.app',
  'Reminders.app',
  'Safari.app',
  'System Settings.app',
  'System Preferences.app',
  'TV.app',
])

const APPLE_BUILTIN_UTILITIES = new Set([
  'Activity Monitor.app',
  'Console.app',
  'Disk Utility.app',
  'Migration Assistant.app',
  'Terminal.app',
])

export function isProtectedAppleSystemApp(itemPath: string): boolean {
  if (itemPath.startsWith('/System/Applications/')) return true
  if (itemPath.startsWith('/System/Library/CoreServices/')) return true

  const appName = path.basename(itemPath)
  if (itemPath.startsWith('/Applications/') && APPLE_BUILTIN_APPS.has(appName)) return true
  if (itemPath.startsWith('/Applications/Utilities/') && APPLE_BUILTIN_UTILITIES.has(appName)) return true
  return false
}

function formatSizeForPrompt(sizeKB: number): string {
  if (sizeKB > 1024 * 1024) return `${(sizeKB / 1024 / 1024).toFixed(1)} GB`
  if (sizeKB > 1024) return `${(sizeKB / 1024).toFixed(1)} MB`
  return `${sizeKB} KB`
}

// Known macOS path descriptions — gives the AI accurate context so it reasons
// correctly about what a path is and whether it is safe to delete.
function getMacOSPathContext(itemPath: string): string {
  const home = os.homedir()
  const normalized = itemPath.replace(/\/+$/, '')

  // Ordered most-specific → least-specific so the first match wins.
  const knownPaths: Array<{ match: string | RegExp; description: string }> = [

    // ── Root ─────────────────────────────────────────────────────────────────
    { match: '/', description: 'The root of the macOS filesystem. Deleting it would make the system completely non-functional.' },

    // ── Core OS ──────────────────────────────────────────────────────────────
    { match: '/System/Library', description: 'macOS system frameworks, kernel extensions, and low-level resources. Deleting anything here breaks the operating system.' },
    { match: '/System', description: 'Core macOS operating system managed by Apple. Nothing here should ever be deleted — the Mac would become unbootable.' },
    { match: '/bin', description: 'Fundamental UNIX shell commands (ls, cp, mv, bash). Required to boot and operate. Never delete.' },
    { match: '/sbin', description: 'System administration binaries used at boot by macOS daemons. Never delete.' },
    { match: '/usr/bin', description: 'Essential UNIX binaries used by macOS internals and developer tools (python3, ruby, git wrappers). Deleting breaks the shell environment.' },
    { match: '/usr/lib', description: 'Shared system libraries that macOS and apps link against at runtime. Removing causes crashes.' },
    { match: '/usr/local/Cellar', description: 'Homebrew package cellar (Intel Mac). Each subfolder is one installed Homebrew package. Deleting a subfolder uninstalls that package; deleting the whole folder removes all of them.' },
    { match: '/usr/local', description: 'User-installed UNIX tools such as Homebrew packages. Safer than /usr/bin but scripts and apps may depend on tools here.' },
    { match: '/usr', description: 'UNIX system resources including compilers, libraries, and command-line tools used by macOS and Xcode. Removing it breaks the system.' },
    { match: '/private/etc', description: 'System-wide config files (/etc/hosts, /etc/passwd, networking). Required for macOS to configure itself on every boot.' },
    { match: '/etc', description: 'Symlink to /private/etc — system-wide configuration files. Removing it breaks system configuration.' },
    { match: '/private/var', description: 'Variable system data: logs, caches, databases, runtime state. Many system services write here continuously.' },
    { match: '/var', description: 'Symlink to /private/var — dynamic system data managed by macOS.' },
    { match: '/private/tmp', description: 'OS-managed temporary files. macOS clears this automatically; individual tmp files are safe to delete.' },
    { match: '/private', description: 'Contains the real /etc, /var, and /tmp directories. Managed entirely by macOS.' },
    { match: '/cores', description: 'Crash core dump files. Individual dumps are safe to delete to recover space; the folder itself must stay.' },
    { match: '/Volumes', description: 'Mount point for connected drives and disk images. The folder must not be deleted; mounted drives inside it are independent.' },

    // ── System-wide Library ───────────────────────────────────────────────────
    { match: '/Library/Caches', description: 'System-wide app cache files. Safe to delete — apps and macOS recreate them automatically.' },
    { match: '/Library/Application Support', description: 'System-wide persistent app data. Deleting items here may break apps installed for all users.' },
    { match: '/Library/Logs', description: 'System-wide log files. Safe to delete — apps recreate logs as needed.' },
    { match: '/Library/Preferences', description: 'System-wide preference plists. Deleting an individual plist resets that service\'s settings; deleting the folder breaks many system services.' },
    { match: '/Library', description: 'System-wide support files, fonts, preferences, and extensions for all users. Many items are required by apps and system features.' },
    { match: '/Applications', description: 'Standard install location for all macOS apps. Deleting the folder removes every app; deleting a single .app uninstalls that app.' },

    // ── Homebrew (Apple Silicon) ──────────────────────────────────────────────
    { match: '/opt/homebrew/Cellar', description: 'Homebrew package cellar (Apple Silicon Mac). Each subfolder is one installed package. Deleting a subfolder uninstalls that package.' },
    { match: '/opt/homebrew', description: 'Homebrew package manager installation (Apple Silicon). Deleting this uninstalls all Homebrew packages and the package manager itself.' },

    // ── Users parent ─────────────────────────────────────────────────────────
    { match: '/Users', description: 'Parent of all user home directories on this Mac. Deleting it destroys every user account\'s personal data permanently.' },
    { match: /^\/Users\/[^/]+$/, description: 'A macOS user home directory containing every file, setting, and document for that account. Deleting it permanently destroys all that user\'s data.' },

    // ── This user's home ─────────────────────────────────────────────────────
    { match: home, description: 'Your personal home directory — documents, settings, and all personal files. Deleting it causes permanent, total data loss.' },

    // ── ~/Library — specific subdirs (most specific first) ────────────────────
    { match: `${home}/Library/Keychains`, description: 'Keychain files storing all saved passwords, certificates, and secure credentials. Deleting causes permanent loss of all saved passwords.' },
    { match: `${home}/Library/Mail`, description: 'Mail app local database and downloaded messages. Deleting removes all locally stored emails.' },
    { match: `${home}/Library/Messages`, description: 'iMessage and SMS conversation history synced from iPhone. Deleting permanently erases local message history.' },
    { match: `${home}/Library/Photos`, description: 'Photos app library — your entire photo and video collection. Deleting causes permanent data loss unless you have a backup.' },
    { match: `${home}/Library/Containers`, description: 'Sandboxed data containers for Mac App Store and sandboxed apps. Each subfolder holds one app\'s complete data (documents, databases, settings). Deleting a container resets or fully removes that app\'s data — use only if uninstalling the app or if the data is known to be regenerable.' },
    { match: `${home}/Library/Group Containers`, description: 'Shared data containers used by groups of related apps (e.g. iCloud-enabled app families). Deleting items here can break cross-app syncing and shared features.' },
    { match: `${home}/Library/Developer/Xcode/DerivedData`, description: 'Xcode\'s build cache — compiled object files and intermediate build products for all Xcode projects. Completely safe to delete; Xcode rebuilds everything automatically on the next build. Commonly 10–50 GB on an active developer machine.' },
    { match: `${home}/Library/Developer/Xcode/iOS DeviceSupport`, description: 'Device support files for physical iOS/iPadOS devices connected to Xcode. Can grow very large over time. Safe to delete; Xcode re-downloads them when you reconnect a device.' },
    { match: `${home}/Library/Developer/Xcode/watchOS DeviceSupport`, description: 'Device support files for Apple Watch connected to Xcode. Safe to delete; re-downloaded when device is reconnected.' },
    { match: `${home}/Library/Developer/CoreSimulator/Caches`, description: 'iOS/iPadOS Simulator cache. Safe to delete — regenerated automatically.' },
    { match: `${home}/Library/Developer/CoreSimulator`, description: 'iOS, iPadOS, and watchOS Simulator data including device files and app installs. Safe to delete if simulators are not in active use; Xcode re-downloads runtimes when needed.' },
    { match: `${home}/Library/Developer`, description: 'Developer tool data including Xcode build caches, device support files, and iOS Simulator data. Most contents are large and safely regenerable.' },
    { match: `${home}/Library/Application Support`, description: 'Persistent per-user app data: databases, saved states, user content created by apps. Deleting items here may cause permanent data loss or app resets.' },
    { match: `${home}/Library/Preferences`, description: 'Per-user .plist preference files. Deleting an individual plist resets that app\'s settings to defaults; the app recreates it on next launch.' },
    { match: `${home}/Library/Caches`, description: 'Per-user app cache files. Automatically regenerated — safe to delete to recover disk space.' },
    { match: `${home}/Library/Logs`, description: 'Log files from user-level apps. Safe to delete; apps recreate logs as needed.' },
    { match: `${home}/Library/Saved Application State`, description: 'Saved window and app states used by macOS to restore apps on reopen. Safe to delete; apps recreate these on next launch.' },
    { match: `${home}/Library/WebKit`, description: 'WebKit browser data (cookies, storage) for apps using the system WebView. Safe to delete; causes apps to lose web session state.' },
    { match: `${home}/Library/HTTPStorages`, description: 'HTTP cookie and storage data for apps using the system network stack. Safe to delete; apps will re-fetch data.' },
    { match: `${home}/Library`, description: 'Stores all per-user app support data, preferences, caches, and saved states. Deleting it resets or breaks every app for this user.' },

    // ── Personal folders ──────────────────────────────────────────────────────
    { match: `${home}/Desktop`, description: 'Files on the user\'s desktop. Contains personal data — deleting causes data loss.' },
    { match: `${home}/Documents`, description: 'Standard user documents folder. Contains personal files — deleting causes irreversible data loss.' },
    { match: `${home}/Downloads`, description: 'Files downloaded from the internet. May include important files not yet organized. Review before deleting.' },
    { match: `${home}/Movies`, description: 'Video files, Final Cut Pro / iMovie project libraries, and screen recordings. Personal media — deleting causes data loss.' },
    { match: `${home}/Music`, description: 'Music app / iTunes library including purchased music and playlists. Deleting removes your music library.' },
    { match: `${home}/Pictures`, description: 'Photos app library and image files. The Photos library contains your entire photo collection — deleting causes permanent data loss.' },
    { match: `${home}/Applications`, description: 'Apps installed only for this user (not system-wide). Deleting removes those apps for this user.' },
    { match: `${home}/Public`, description: 'Files shared with other users on this Mac via local file sharing. Generally safe to delete if sharing is not in use.' },
  ]

  for (const entry of knownPaths) {
    const hit = typeof entry.match === 'string'
      ? normalized === entry.match || normalized.startsWith(entry.match + '/')
      : entry.match.test(normalized)
    if (hit) return entry.description
  }

  // Generic fallbacks for common subtrees
  if (normalized.startsWith(`${home}/Library/Containers/`)) {
    const bundle = normalized.replace(`${home}/Library/Containers/`, '').split('/')[0]
    return `Sandboxed data container for the app with bundle ID "${bundle}". Contains that app's complete data. Deleting resets the app or removes its data entirely.`
  }
  if (normalized.startsWith(`${home}/Library/Caches/`)) {
    return 'An app cache directory inside the user Library. Regenerated automatically — safe to delete to recover disk space.'
  }
  if (normalized.startsWith(`${home}/Library/Application Support/`)) {
    return 'Persistent data for an app stored in the user Library Application Support folder. Deleting may cause data loss or reset the app.'
  }
  if (normalized.startsWith(`${home}/Library/`)) {
    return 'A subdirectory inside the user Library — stores per-user app data, preferences, or support files.'
  }
  if (normalized.startsWith('/Library/Caches/')) {
    return 'System-wide app cache. Safe to delete — recreated automatically.'
  }
  if (normalized.startsWith('/Library/')) {
    return 'A subdirectory inside the system Library — stores system-wide app support files, fonts, or configuration.'
  }

  return ''
}

function getWindowsPathContext(itemPath: string): string {
  const normalized = itemPath.replace(/\//g, '\\')
  const lowerPath = normalized.toLowerCase()

  const knownPaths: Array<{ match: string | RegExp; description: string }> = [
    { match: /^c:\\$/, description: 'The root of the Windows system drive. Deleting it would make the machine unusable.' },
    { match: 'C:\\Windows', description: 'Core Windows operating system files. Never delete anything here manually.' },
    { match: 'C:\\Program Files', description: 'Installed 64-bit applications. Deleting items here uninstalls or breaks apps.' },
    { match: 'C:\\Program Files (x86)', description: 'Installed 32-bit applications. Deleting items here uninstalls or breaks apps.' },
    { match: 'C:\\ProgramData', description: 'Shared application data for all users. Often required for installed apps to keep working.' },
    { match: /\\AppData\\Local\\Temp/i, description: 'Temporary files for Windows and installed apps. Usually safe to delete if not currently in use.' },
    { match: /\\AppData\\Local\\Packages/i, description: 'Microsoft Store app packages and caches. Deleting items here can reset app state.' },
    { match: /\\AppData\\Roaming/i, description: 'Per-user app settings and data that roam with the account. Usually keep unless you know the app is gone.' },
    { match: /\\Downloads$/i, description: 'A personal downloads folder. Review carefully before deleting because it often contains user files.' },
    { match: /\\Desktop$/i, description: 'A personal desktop folder. Review carefully before deleting because it often contains user files.' },
    { match: '\\$Recycle.Bin', description: 'The Recycle Bin store for deleted files. Individual contents are generally safe to delete permanently.' },
  ]

  for (const { match, description } of knownPaths) {
    if ((typeof match === 'string' && lowerPath.startsWith(match.toLowerCase())) || (match instanceof RegExp && match.test(normalized))) {
      return description
    }
  }

  return ''
}

function getPathContext(itemPath: string): string {
  return process.platform === 'win32' ? getWindowsPathContext(itemPath) : getMacOSPathContext(itemPath)
}

/** Infer a human-readable app name from a macOS bundle ID or .app name. */
export function inferAppName(name: string): string | null {
  // Strip .app suffix
  const withoutApp = name.endsWith('.app') ? name.slice(0, -4) : name

  // Looks like a bundle ID (e.g. com.docker.docker, net.whatsapp.WhatsApp)
  const isBundleId = /^[a-z]{2,6}\.[a-zA-Z][\w.-]+$/.test(withoutApp)
  if (isBundleId) {
    const parts = withoutApp.split('.')
    // Last segment, split camelCase into words
    const raw = parts[parts.length - 1]
    return raw.replace(/([A-Z])/g, ' $1').trim()
  }

  // Already a plain name (e.g. "Xcode", "com.apple.Safari" → take last segment)
  return null
}

/** Return a file-type hint for common extensions to help the AI give a better verdict. */
export function getFileTypeHint(name: string, isDir: boolean): string {
  if (isDir) {
    const lower = name.toLowerCase()
    if (lower === 'node_modules')       return 'npm/yarn dependency directory — safe to delete; regenerated by running npm install.'
    if (lower === '.gradle')            return 'Gradle build cache — safe to delete; regenerated on next build.'
    if (lower === 'deriveddata')        return 'Xcode build cache — safe to delete; rebuilt automatically.'
    if (lower === '.build')             return 'Swift Package Manager build cache — safe to delete; rebuilt automatically.'
    if (lower === 'vendor')             return 'Third-party dependency directory (Go, PHP, Ruby) — safe to delete; regenerated by the package manager.'
    if (lower === 'target')             return 'Rust/Maven/Gradle build output directory — safe to delete; rebuilt automatically.'
    if (lower === 'dist' || lower === 'build' || lower === 'out')
      return 'Build output directory — safe to delete; regenerated by the build tool.'
    if (lower === '.cache')             return 'Tool or build cache directory — usually safe to delete.'
    if (lower === 'tmp' || lower === 'temp') return 'Temporary files directory — safe to delete.'
    return ''
  }
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const hints: Record<string, string> = {
    dmg:      'macOS disk image installer — safe to delete once the app is installed.',
    pkg:      'macOS installer package — safe to delete after installation.',
    zip:      'ZIP archive — safe to delete once extracted.',
    'tar.gz': 'Compressed archive — safe to delete once extracted.',
    gz:       'Gzip-compressed file (usually a downloaded archive) — safe to delete once extracted.',
    tgz:      'Compressed tar archive — safe to delete once extracted.',
    log:      'Log file — safe to delete.',
    crash:    'Crash report — safe to delete.',
    tmp:      'Temporary file — safe to delete.',
    bak:      'Backup file — safe to delete if the original is intact.',
    old:      'Old/backup file — usually safe to delete.',
    ipa:      'iOS app archive — safe to delete if you no longer need this build.',
    xcarchive:'Xcode build archive for distribution. Can be large. Safe to delete if you no longer need this specific build for App Store submission or crash symbolication.',
    'dSYM':   'Xcode debug symbols — needed for crash report symbolication. Safe to delete if not needed.',
    bz2:      'BZip2-compressed archive — safe to delete once extracted.',
    xz:       'XZ-compressed archive — safe to delete once extracted.',
    iso:      'Disk image (CD/DVD/ISO) — safe to delete if contents are no longer needed.',
    img:      'Disk image — safe to delete if no longer needed.',
  }
  return hints[ext] ? `File type: ${hints[ext]}` : ''
}

async function pickOllamaModel(): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await net.fetch('http://localhost:11434/api/tags', { signal: controller.signal })
    if (!res.ok) throw new Error(`Ollama responded with ${res.status}`)
    const data = (await res.json()) as { models?: { name: string }[] }
    const models = data.models ?? []
    if (models.length === 0) {
      throw new Error('No models installed in Ollama. Run: ollama pull llama3.2')
    }
    // Honour user's preferred model if it's installed
    const { preferredOllamaModel } = loadSettings()
    if (preferredOllamaModel) {
      const found = models.find(
        (m) => m.name === preferredOllamaModel || m.name.startsWith(preferredOllamaModel + ':')
      )
      if (found) return found.name
    }
    const preferred = ['llama3.2', 'llama3.1', 'llama3', 'mistral', 'gemma2', 'gemma']
    for (const pref of preferred) {
      const found = models.find((m) => m.name.startsWith(pref))
      if (found) return found.name
    }
    return models[0].name
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch') || msg.includes('Failed')) {
      throw new Error('Ollama is not running. Start it with: ollama serve')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

let pullAbort: AbortController | null = null
let pullRequestSequence = 0

// ── App leftover detection ────────────────────────────────────────────────────

// Locations under ~/Library that commonly hold per-app data
export const LEFTOVER_LOCATIONS = [
  path.join('Library', 'Application Support'),
  path.join('Library', 'Application Scripts'),
  path.join('Library', 'Autosave Information'),
  path.join('Library', 'Containers'),
  path.join('Library', 'Group Containers'),
  path.join('Library', 'HTTPStorages'),
  path.join('Library', 'Preferences'),  // .plist files
  path.join('Library', 'Saved Application State'),
  path.join('Library', 'WebKit'),
]

// Prefixes that unconditionally mark a Library entry as system/Apple-owned.
// These never appear as app leftovers regardless of what's installed.
const SYSTEM_PREFIXES = [
  'com.apple.',
  // macOS UI server and core daemons write to Library under their own name
  'systemuiserver', 'loginwindow', 'notificationcenter', 'usernoted',
  'sharingd', 'coreaudiod', 'corebluetooth', 'coreduet',
  'findmydevice', 'cloudd', 'bird', 'rapportd',
  // Crash / diagnostic infrastructure
  'crashreporter', 'diagnosticreportingservice', 'submissionservice',
  // Python runtimes — any version
  'python',
  // Symbol caches (Xcode / Instruments)
  'symbolsource',
  // Common helper/agent suffix patterns that indicate spawned sub-processes, not apps
  // (handled by suffix check in isKnownApp rather than prefix here)
]

// Apple-branded app names whose Library data must never be flagged as leftovers.
// Covers apps that may not carry a com.apple. bundle prefix (e.g. MAS purchases,
// beta builds, apps renamed across OS versions).
const APPLE_APP_NAMES = new Set([
  // Developer tools
  'xcode', 'instruments', 'simulator', 'iphonesimulator', 'tvossimulator',
  'realitycomposer', 'createml', 'swift', 'swiftpm', 'xcodeextensionservice',
  // Pro media & creative
  'garageband', 'logic', 'logicpro', 'finalcut', 'imovie', 'motion',
  'compressor', 'mainstage', 'soundtrack',
  // iWork
  'pages', 'numbers', 'keynote',
  // Core system apps
  'itunes', 'music', 'podcasts', 'books', 'ibooks', 'news', 'stocks',
  'photos', 'facetime', 'messages', 'mail', 'notes', 'reminders',
  'calendar', 'contacts', 'maps', 'shortcuts', 'automator', 'scripteditor',
  'voicememos', 'freeform', 'journal', 'chess', 'textedit', 'preview',
  'quicklookd', 'quicklookuiservice',
  // iCloud / system background services
  'icloud', 'mobiledocuments', 'clouddocs', 'cloudkit', 'mobilesync',
  'mobiledevice', 'itunessync',
  // System UI / OS features
  'animoji', 'networkserviceproxy', 'storeaccountd', 'storeassetd',
  'akd', 'trustd', 'secd', 'apsd', 'dasd', 'assertiond',
  // Safari and WebKit
  'safari', 'webkit', 'safariextensionservice',
  // Accessibility
  'voiceover', 'accessibility',
  // Python runtimes and virtual envs (python.org, brew, conda)
  'python', 'python3', 'pip', 'conda', 'anaconda', 'miniconda',
  'virtualenv', 'virtualenvs', 'venv', 'pyenv',
  // This app — never recommend deleting Nerion's own data
  'nerion',
  // Firebase / Google infrastructure
  'firestore', 'firebase',
  // Developer tools and version managers — data is always valid
  'copilot', 'github', 'githubcopilot',
  'nvm', 'rbenv', 'asdf', 'mise',
  'homebrew', 'linuxbrew',
  'npm', 'yarn', 'pnpm', 'bun',
  'rustup', 'cargo', 'rust',
  'golang', 'gopath',
  'ruby', 'rbenv', 'rvm', 'gem', 'bundler',
  'node', 'nodejs', 'deno',
  // VS Code family — data is valid as long as the editor is installed
  'code', 'vscode', 'visual', 'cursor', 'windsurf', 'zed',
  // Package managers / build tools that write to Library
  'cocoapods', 'pods', 'carthage',
  'gradle', 'maven', 'sbt',
])

const NON_APP_WORDS = new Set([
  'agent', 'cache', 'cli', 'daemon', 'database', 'db', 'framework',
  'helper', 'runtime', 'sdk', 'service',
])
const NON_APP_SUFFIXES = [
  'agent', 'cache', 'caches', 'cli', 'daemon', 'database', 'db',
  'framework', 'helper', 'runtime', 'sdk', 'service', 'services',
]

function looksLikeBundleId(name: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+){1,}$/.test(name)
}

function looksLikeAppCandidate(rawName: string): boolean {
  const name = rawName.trim().toLowerCase()
  if (!name) return false

  // Bundle IDs are strong evidence of app-owned data.
  if (looksLikeBundleId(name)) return true

  const compact = name.replace(/[^a-z0-9]+/g, '')
  if (compact.length < 3) return false

  const words = name.split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return false

  // Reject entries that are purely technical components / databases / runtimes.
  if (words.every((word) => NON_APP_WORDS.has(word))) return false
  if (words[words.length - 1] && NON_APP_WORDS.has(words[words.length - 1])) return false
  if (NON_APP_SUFFIXES.some((suffix) => compact.endsWith(suffix))) return false

  // Treat human-readable names as app candidates only when they are not
  // generic technical labels.
  return words.some((word) => /[a-z]/.test(word) && !NON_APP_WORDS.has(word))
}

function addWords(ids: Set<string>, text: string) {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return

  // Always index the full string as-is
  ids.add(normalized)
  // Also index a compact alphanumeric form so "Google Chrome" and
  // "googlechrome" can match the same installed app identity.
  const compact = normalized.replace(/[^a-z0-9]+/g, '')
  if (compact.length >= 5) ids.add(compact)
  // Index each segment split on non-alphanumeric runs, min 5 chars to avoid noise
  // (e.g. 'com.google.chrome' → 'google', 'chrome'; NOT 'com' which is too generic)
  for (const word of normalized.split(/[\s.\-_]+/)) {
    if (word.length >= 5) ids.add(word)
  }
}

export async function getInstalledAppIdentifiers(): Promise<Set<string>> {
  const ids = new Set<string>()
  const home = os.homedir()
  const brewPrefixes = ['/opt/homebrew', '/usr/local']

  async function indexAppBundle(appPath: string, fallbackName: string) {
    addWords(ids, fallbackName.replace(/\.app$/, '').toLowerCase())

    const plistPath = path.join(appPath, 'Contents', 'Info.plist')
    for (const key of ['CFBundleIdentifier', 'CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable']) {
      try {
        const { stdout } = await execFileAsync(
          '/usr/bin/plutil',
          ['-extract', key, 'raw', '-o', '-', plistPath],
          { timeout: 1500 }
        )
        const value = stdout.trim().toLowerCase()
        if (value) addWords(ids, value)
      } catch {
        // plist key missing or unreadable — keep indexing whatever we can
      }
    }
  }

  async function indexHomebrewInstallations() {
    // 4a. Homebrew casks
    // Cask names often don't match the .app display name (e.g. "google-chrome" ≠ "Google Chrome").
    // The cask folder name is the canonical identifier we index here.
    for (const prefix of brewPrefixes) {
      const caskRoot = path.join(prefix, 'Caskroom')
      try {
        const casks = await readdir(caskRoot)
        for (const cask of casks) addWords(ids, cask.toLowerCase())
      } catch { /* not present on this machine */ }
    }

    // 4b. Homebrew formulas in the Cellar
    // Index formula names and common binary names shipped by each keg, so CLI tools
    // installed by brew also prevent matching Library data as leftovers.
    await Promise.allSettled(
      brewPrefixes.map(async (prefix) => {
        const cellarRoot = path.join(prefix, 'Cellar')
        try {
          const formulas = await readdir(cellarRoot)
          await Promise.allSettled(
            formulas.map(async (formula) => {
              addWords(ids, formula.toLowerCase())

              const formulaRoot = path.join(cellarRoot, formula)
              let versions: string[] = []
              try {
                versions = await readdir(formulaRoot)
              } catch {
                return
              }

              await Promise.allSettled(
                versions.map(async (version) => {
                  for (const relDir of ['bin', path.join('libexec', 'bin'), 'sbin']) {
                    const dir = path.join(formulaRoot, version, relDir)
                    try {
                      const entries = await readdir(dir)
                      for (const entry of entries) addWords(ids, entry.toLowerCase())
                    } catch {
                      // dir missing for this formula/version
                    }
                  }
                })
              )
            })
          )
        } catch {
          // Homebrew not installed at this prefix
        }
      })
    )

    // 4c. Homebrew-linked CLI shims in bin/sbin
    // Many active formulas expose executables here via symlinks into the Cellar.
    for (const prefix of brewPrefixes) {
      for (const relDir of ['bin', 'sbin']) {
        const linkDir = path.join(prefix, relDir)
        try {
          const entries = await readdir(linkDir)
          await Promise.allSettled(
            entries.map(async (entry) => {
              const fullPath = path.join(linkDir, entry)
              try {
                const resolved = await realpath(fullPath)
                if (resolved.includes(`${path.sep}Cellar${path.sep}`) || resolved.includes(`${path.sep}Caskroom${path.sep}`)) {
                  addWords(ids, entry.toLowerCase())
                }
              } catch {
                // broken symlink or unreadable target
              }
            })
          )
        } catch {
          // prefix/bin or prefix/sbin missing
        }
      }
    }
  }

  // ── 1. Installed .app bundles ────────────────────────────────────────────────
  // Scan standard app locations plus Setapp (if present).
  const appDirs = [
    '/Applications',
    '/System/Applications',
    '/System/Applications/Utilities',
    path.join(home, 'Applications'),
    '/Applications/Setapp',          // Setapp subscription apps
    path.join(home, 'Applications', 'Setapp'),
  ]
  await Promise.allSettled(
    appDirs.map(async (dir) => {
      try {
        const entries = await readdir(dir)
        const apps = entries.filter((n) => n.endsWith('.app'))
        await Promise.allSettled(apps.map((appName) => indexAppBundle(path.join(dir, appName), appName)))
      } catch {
        // directory does not exist
      }
    })
  )

  // ── 1b. Spotlight-discovered app bundles ───────────────────────────────────
  // Catches installed apps that live outside the standard folders, such as
  // custom locations or developer tools bundled inside dependencies.
  try {
    const { stdout } = await execFileAsync('/usr/bin/mdfind', [
      'kMDItemContentTypeTree == "com.apple.application-bundle"'
    ], { timeout: 4000, maxBuffer: 1024 * 1024 * 8 })
    const appPaths = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.app'))
    await Promise.allSettled(
      appPaths.slice(0, 4000).map((appPath) => indexAppBundle(appPath, path.basename(appPath)))
    )
  } catch {
    // Spotlight unavailable or timed out — standard app dirs above are still used.
  }

  // ── 2. ~/Library/Containers ─────────────────────────────────────────────────
  // The most authoritative source: macOS ONLY creates a container for a sandboxed
  // app that has actually been run on this machine. Every folder name here is the
  // exact bundle ID of an installed (or recently uninstalled but still present) app.
  // We include these because the user consciously ran these apps — their Library
  // data is not an orphan even if the .app has been moved outside /Applications.
  try {
    const containers = await readdir(path.join(home, 'Library', 'Containers'))
    for (const c of containers) addWords(ids, c.toLowerCase())
  } catch { /* directory missing or unreadable */ }

  // ── 3. ~/Library/Group Containers ───────────────────────────────────────────
  // Group containers are shared between a primary app and its extensions / helpers.
  // Their existence indicates the owning app group is active.
  try {
    const gcs = await readdir(path.join(home, 'Library', 'Group Containers'))
    for (const gc of gcs) addWords(ids, gc.toLowerCase())
  } catch { /* directory missing */ }

  // ── 4. Homebrew installs (casks + formulas + linked CLIs) ──────────────────
  await indexHomebrewInstallations()

  // ── 5. LaunchAgent / LaunchDaemon plists ────────────────────────────────────
  // Background services installed by apps write .plist files here. The filename
  // (without extension) is the service label, which is usually the bundle ID prefix.
  // Including these prevents flagging e.g. "com.dropbox.DropboxMacUpdate" Library data.
  const launchDirs = [
    path.join(home, 'Library', 'LaunchAgents'),
    '/Library/LaunchAgents',
    '/Library/LaunchDaemons',
    '/System/Library/LaunchAgents',
    '/System/Library/LaunchDaemons',
  ]
  for (const launchDir of launchDirs) {
    try {
      const plists = await readdir(launchDir)
      for (const p of plists.filter(n => n.endsWith('.plist'))) {
        addWords(ids, p.replace(/\.plist$/, '').toLowerCase())
      }
    } catch { /* directory missing or unreadable */ }
  }

  // ── 6. Preference panes ──────────────────────────────────────────────────────
  const prefPaneDirs = [
    path.join(home, 'Library', 'PreferencePanes'),
    '/Library/PreferencePanes',
  ]
  for (const ppDir of prefPaneDirs) {
    try {
      const panes = await readdir(ppDir)
      for (const p of panes.filter(n => n.endsWith('.prefPane'))) {
        addWords(ids, p.replace(/\.prefPane$/, '').toLowerCase())
      }
    } catch { /* directory missing */ }
  }

  // ── 7. VS Code–family extension publishers ───────────────────────────────────
  // Extension dirs are named {publisher}.{name}-{semver}. We strip the version
  // and index the publisher and extension name so their Application Support data
  // is never flagged.
  const editorExtDirs = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.windsurf', 'extensions'),
  ]
  await Promise.allSettled(
    editorExtDirs.map(async (extDir) => {
      try {
        const entries = await readdir(extDir)
        for (const name of entries) {
          addWords(ids, name.replace(/-\d+\.\d+.*$/, '').toLowerCase())
        }
      } catch { /* directory missing */ }
    })
  )

  return ids
}

function isKnownApp(itemName: string, installedIds: Set<string>): boolean {
  // Normalise: strip common extensions and lowercase
  const name = itemName.toLowerCase()
    .replace(/\.plist$/, '')
    .replace(/\.prefpane$/, '')
  const compactName = name.replace(/[^a-z0-9]+/g, '')

  if (!name) return true
  if (!looksLikeAppCandidate(name)) return true

  // ── System prefix check ───────────────────────────────────────────────────
  for (const prefix of SYSTEM_PREFIXES) {
    if (name.startsWith(prefix)) return true
  }

  // ── Apple app name check (exact + word-level) ─────────────────────────────
  if (APPLE_APP_NAMES.has(name)) return true
  for (const word of name.split(/[\s.\-_]+/)) {
    if (word.length >= 5 && APPLE_APP_NAMES.has(word)) return true
  }

  // ── Common helper/agent/daemon suffix patterns ────────────────────────────
  // Sub-process executables (e.g. "com.x.helper", "com.x.updater") always belong
  // to an installed app — they are never standalone orphans.
  const HELPER_SUFFIXES = ['.helper', '.agent', '.daemon', '.launcher',
    '.updater', '.crashreporter', '.xpc', '.loginhelper']
  for (const suf of HELPER_SUFFIXES) {
    if (name.endsWith(suf)) return true
  }

  // ── Exact match against installed identifiers ─────────────────────────────
  if (installedIds.has(name)) return true
  if (compactName.length >= 5 && installedIds.has(compactName)) return true

  // ── Segment-level match for bundle-ID–style names ─────────────────────────
  // "com.google.chrome" → segments: ['google', 'chrome']
  // "B8234FKSHK.com.tapbots.Tweetbot3" → MAS prefix + real bundle ID
  if (name.includes('.')) {
    const segments = name.split('.')
    for (const seg of segments) {
      if (seg.length >= 5 && installedIds.has(seg)) return true
    }
    // Prefix/suffix match: "com.google.chrome.helper" ↔ "com.google.chrome"
    for (const id of installedIds) {
      if (id.length >= 5 && (name.startsWith(id + '.') || id.startsWith(name + '.'))) return true
    }
  }

  // ── Substring match for display-name–style folders ────────────────────────
  // "Adobe Photoshop 2024" → every 5-char-or-longer word checked
  for (const word of name.split(/[\s.\-_]+/)) {
    if (word.length >= 5 && installedIds.has(word)) return true
  }

  return false
}

export interface AppLeftover {
  path: string
  name: string
  sizeKB: number
  location: string  // e.g. "Application Support"
}

/**
 * Recursively sum the size of all files under `entryPath` using only Node.js
 * fs APIs — no child processes. This avoids macOS TCC prompts that appear when
 * external binaries (e.g. `du`) access protected directories like ~/Library/Containers,
 * because TCC grants are per-binary and Electron's grant is not inherited by spawned processes.
 *
 * A deadline short-circuits the walk so deeply nested trees don't stall the scan.
 */
async function getEntrySizeKB(entryPath: string, deadlineMs = Date.now() + 8000): Promise<number> {
  let totalBytes = 0
  async function walk(p: string): Promise<void> {
    if (Date.now() > deadlineMs) return
    try {
      const s = await stat(p)
      if (s.isDirectory()) {
        const children = await readdir(p)
        await Promise.all(children.map((c) => walk(path.join(p, c))))
      } else {
        totalBytes += s.size
      }
    } catch {
      // permission denied or entry disappeared — skip
    }
  }
  await walk(entryPath)
  return Math.round(totalBytes / 1024)
}

export async function findLeftoversInDir(
  dirPath: string,
  locationLabel: string,
  installedIds: Set<string>,
  minSizeKB: number
): Promise<AppLeftover[]> {
  const results: AppLeftover[] = []
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    await Promise.allSettled(
      entries.map(async (entry) => {
        const name = entry.name
        if (isKnownApp(name, installedIds)) return

        const fullPath = path.join(dirPath, name)
        const sizeKB = await getEntrySizeKB(fullPath)
        if (sizeKB >= minSizeKB) {
          results.push({ path: fullPath, name, sizeKB, location: locationLabel })
        }
      })
    )
  } catch {
    // location doesn't exist or permission denied
  }
  return results
}

// ─────────────────────────────────────────────────────────────────────────────

export function registerIpcHandlers(): void {
  // ── Scanner ──────────────────────────────────────────────────────────────

  ipcMain.on('scan-start', (event, request: string | string[] | { scanId: string; paths: string[] }) => {
    if (cancelCurrentScan) {
      cancelCurrentScan()
      cancelCurrentScan = null
    }
    const structuredRequest = request !== null && typeof request === 'object' && !Array.isArray(request) ? request : null
    const requestedScanId = structuredRequest && typeof structuredRequest.scanId === 'string' && structuredRequest.scanId
      && /^[A-Za-z0-9_-]{1,128}$/.test(structuredRequest.scanId)
      ? structuredRequest.scanId
      : randomUUID()
    const requestedPaths = structuredRequest && Array.isArray(structuredRequest.paths)
      ? structuredRequest.paths
      : Array.isArray(request) ? request : typeof request === 'string' ? [request] : []
    const platform = process.platform === 'win32' ? 'windows' : 'macos'
    const paths = collapseOverlappingPaths(
      requestedPaths
        .filter(isValidIpcPath)
        .filter((value) => platform === 'windows' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value))
        .slice(0, 64),
      platform,
    )
    const securityEnabled = getLicenseInfo().active
    currentScanId = requestedScanId
    beginForegroundScan(requestedScanId)

    const dispatcher = createBufferedEventSender<ScanEventV1>((events) => {
      if (currentScanId === requestedScanId && !event.sender.isDestroyed()) {
        event.sender.send('scan-events', events)
      }
    })
    const send = (data: ScanEventV1) => dispatcher.enqueue(data)

    if (paths.length === 0) {
      send({
        protocolVersion: SCAN_PROTOCOL_VERSION,
        event: 'summary',
        scanId: requestedScanId,
        rootId: null,
        complete: false,
        cancelled: false,
        entryCount: 0,
        issueCount: 0,
        rootsCompleted: 0,
        rootsRequested: 0,
        fatalError: 'No readable scan roots were provided.',
        securityAnalysis: securityEnabled ? 'partial' : 'disabled',
        suspiciousCount: 0,
      } satisfies ScanSummaryV1)
      dispatcher.dispose(true)
      endForegroundScan(requestedScanId)
      currentScanId = null
      return
    }

    const summaries: ScanSummaryV1[] = []
    const seenHardlinks = new Set<string>()
    const crossRootDuplicateBytes = new Map<string, Array<{ path: string; bytes: number }>>()
    const suspiciousFindings = new Map<string, SuspiciousFinding>()
    const persistenceInspection = securityEnabled
      ? inspectSuspiciousPersistence(platform, os.homedir()).catch(() => ({
          findings: [] as SuspiciousFinding[],
          complete: false,
          inaccessiblePaths: [] as string[],
        }))
      : Promise.resolve({ findings: [] as SuspiciousFinding[], complete: true, inaccessiblePaths: [] as string[] })
    let activeCancel: (() => void) | null = null

    const sendSuspiciousFinding = (finding: SuspiciousFinding, rootId: string) => {
      if (!securityEnabled) return
      const existing = suspiciousFindings.get(finding.id)
      const combinedFinding: SuspiciousFinding = existing ? {
        ...finding,
        category: existing.category === 'background-item' || finding.category === 'background-item'
          ? 'background-item'
          : 'masquerading-file',
        risk: existing.risk === 'elevated' || finding.risk === 'elevated' ? 'elevated' : 'review',
        summary: existing.category !== finding.category
          ? 'This startup item also has a filename that deserves closer review.'
          : finding.summary,
        evidence: [...existing.evidence, ...finding.evidence].filter((item, index, values) => (
          values.findIndex((candidate) => candidate.code === item.code && candidate.detail === item.detail) === index
        )),
        targetPath: finding.targetPath ?? existing.targetPath,
      } : finding
      suspiciousFindings.set(finding.id, combinedFinding)
      send({
        protocolVersion: SCAN_PROTOCOL_VERSION,
        event: 'suspicious',
        scanId: requestedScanId,
        rootId,
        finding: combinedFinding,
      } satisfies ScanSuspiciousV1)
    }

    const finishScan = async () => {
      const persistence = await persistenceInspection
      if (currentScanId !== requestedScanId) return
      for (const finding of persistence.findings) sendSuspiciousFinding(finding, 'security-persistence')

      const fatalErrors = summaries.map((item) => item.fatalError).filter((value): value is string => !!value)
      const scanComplete = summaries.every((item) => item.complete)
      send({
        protocolVersion: SCAN_PROTOCOL_VERSION,
        event: 'summary',
        scanId: requestedScanId,
        rootId: null,
        complete: scanComplete,
        cancelled: summaries.some((item) => item.cancelled),
        entryCount: summaries.reduce((total, item) => total + item.entryCount, 0),
        issueCount: summaries.reduce((total, item) => total + item.issueCount, 0),
        rootsCompleted: summaries.filter((item) => !item.fatalError).length,
        rootsRequested: paths.length,
        fatalError: fatalErrors.length === paths.length ? fatalErrors[0] : null,
        securityAnalysis: securityEnabled
          ? (persistence.complete && scanComplete ? 'complete' : 'partial')
          : 'disabled',
        suspiciousCount: suspiciousFindings.size,
      } satisfies ScanSummaryV1)
      dispatcher.dispose(true)
      cancelCurrentScan = null
      endForegroundScan(requestedScanId)
      currentScanId = null
    }

    const scanNextRoot = (index: number) => {
      if (currentScanId !== requestedScanId) return
      if (index >= paths.length) {
        void finishScan()
        return
      }

      const dirPath = paths[index]
      const rootId = `root-${index}`
      crossRootDuplicateBytes.set(rootId, [])
      activeCancel = scanDirectoryStreaming(
        dirPath,
        { scanId: requestedScanId, rootId, profile: 'interactive' },
        (scanEvent) => {
          if (scanEvent.event === 'entry' && securityEnabled) {
            const finding = inspectMasqueradingEntry(scanEvent as ScanEntryV1, platform)
            if (finding) sendSuspiciousFinding(finding, rootId)
          }
          if (scanEvent.event === 'entry' && !scanEvent.isDir && scanEvent.device && scanEvent.inode) {
            const identity = `${scanEvent.device}:${scanEvent.inode}`
            if (seenHardlinks.has(identity) && !scanEvent.hardlinkDuplicate) {
              crossRootDuplicateBytes.get(rootId)?.push({ path: scanEvent.path, bytes: scanEvent.allocatedBytes })
              send({ ...scanEvent, allocatedBytes: 0, sizeKB: 0, hardlinkDuplicate: true })
              return
            }
            seenHardlinks.add(identity)
          }
          if (scanEvent.event === 'entry' && scanEvent.isDir) {
            const duplicateBytes = (crossRootDuplicateBytes.get(rootId) ?? [])
              .filter((duplicate) => isSameOrDescendantPath(duplicate.path, scanEvent.path, platform))
              .reduce((total, duplicate) => total + duplicate.bytes, 0)
            if (duplicateBytes > 0) {
              const allocatedBytes = Math.max(0, scanEvent.allocatedBytes - duplicateBytes)
              send({ ...scanEvent, allocatedBytes, sizeKB: Math.ceil(allocatedBytes / 1024) })
              return
            }
          }
          if (scanEvent.event !== 'summary') send(scanEvent)
        },
        ({ summary }) => {
          if (currentScanId !== requestedScanId) return
          activeCancel = null
          // Root-level scanner failures have no native issue event. Surface
          // them alongside ordinary inaccessible paths so one failed root is
          // not hidden merely because another root completed successfully.
          const finalSummary = summary.fatalError
            ? { ...summary, issueCount: summary.issueCount + 1 }
            : summary
          if (summary.fatalError) {
            send({
              protocolVersion: SCAN_PROTOCOL_VERSION,
              event: 'issue',
              scanId: requestedScanId,
              rootId,
              issue: {
                path: dirPath,
                code: 'scanner-error',
                message: summary.fatalError,
              },
            } satisfies ScanIssueV1)
          }
          summaries.push(finalSummary)
          scanNextRoot(index + 1)
        },
      )
    }

    cancelCurrentScan = () => {
      currentScanId = null
      dispatcher.dispose()
      activeCancel?.()
      activeCancel = null
      endForegroundScan(requestedScanId)
      cancelCurrentScan = null
    }
    scanNextRoot(0)
  })

  ipcMain.on('scan-cancel', () => {
    if (cancelCurrentScan) cancelCurrentScan()
  })

  // ── File operations ───────────────────────────────────────────────────────

  ipcMain.handle('open-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose a folder to analyze'
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('open-external', async (_event, url: unknown) => {
    if (!isAllowedExternalUrl(url)) throw new Error('This link type is not allowed.')
    await shell.openExternal(url)
  })

  ipcMain.handle('reveal-in-file-manager', (_event, filePath: unknown) => {
    if (!isValidIpcPath(filePath)) throw new Error('Invalid file path.')
    revealInFileManager(filePath)
  })

  ipcMain.handle('trash-entries', async (_event, paths: string[]) => {
    const requestedPaths = Array.isArray(paths)
      ? paths.filter((itemPath): itemPath is string => typeof itemPath === 'string' && itemPath.length > 0)
      : []
    if (deletionInProgress) {
      const message = 'Another deletion is already in progress.'
      return {
        items: requestedPaths.map((requestedPath) => ({
          requestedPath,
          status: 'skipped',
          movedToTrash: false,
          reclaimedBytes: 0,
          movedToTrashBytes: 0,
          operations: [],
          error: message,
        })),
        requestedCount: requestedPaths.length,
        successfulCount: 0,
        failedCount: 0,
        quotaUsed: 0,
        reclaimedBytes: 0,
        movedToTrashBytes: 0,
        error: message,
      } satisfies DeleteBatchResult
    }

    deletionInProgress = true
    try {
    const premium = getLicenseInfo().active
    const settingsAtStart = loadSettings()
    const monthKey = currentMonthKey()
    const usedAtStart = settingsAtStart.deleteQuota.monthKey === monthKey ? settingsAtStart.deleteQuota.used : 0
    const result = await deleteRequestedPaths(requestedPaths, {
      deleteImmediately: settingsAtStart.deleteImmediately === true,
      premium,
      remainingQuota: Math.max(0, FREE_DELETE_LIMIT_PER_MONTH - usedAtStart),
      onProgress: (progress) => {
        if (!_event.sender.isDestroyed()) _event.sender.send('trash-progress', progress)
      },
    })

    if (!premium && result.quotaUsed > 0) {
      const settings = loadSettings()
      const used = settings.deleteQuota.monthKey === monthKey ? settings.deleteQuota.used : 0
      patchSettings({
        deleteQuota: {
          monthKey,
          used: Math.min(FREE_DELETE_LIMIT_PER_MONTH, used + result.quotaUsed),
        }
      })
    }
    return result
    } finally {
      deletionInProgress = false
    }
  })

  ipcMain.handle('get-item-stats', async (_event, filePath: unknown) => {
    if (!isValidIpcPath(filePath)) return { error: 'Invalid file path.' }
    try {
      const s = await stat(filePath)
      return {
        modified: s.mtime.toISOString(),
        created: s.birthtime.toISOString(),
        sizeBytes: s.size
      }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── App leftover detection ────────────────────────────────────────────────

  ipcMain.handle('find-app-leftovers', async () => {
    if (!leftoverScanInFlight) {
      leftoverScanInFlight = findAppLeftovers().finally(() => {
        leftoverScanInFlight = null
      })
    }
    return leftoverScanInFlight
  })

  // ── AI Analysis (Cloud or Ollama) ─────────────────────────────────────────

  // Runtime credentials support managed/internal deployments. Public builds
  // can instead use a user-provided key protected by the operating system.
  const currentAiCapabilities = () => getAiCapabilities(
    process.env,
    loadCloudAiKey() !== null,
    canConfigureCloudAi(),
  )

  /** Stream an OpenAI Responses API SSE response and emit ollama-token / ollama-done events. */
  async function streamResponsesAPI(
    body: ReadableStream<Uint8Array>,
    send: (ch: string, d: unknown) => void
  ): Promise<void> {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const json = trimmed.slice(5).trim()
        if (!json) continue

        let obj: { type?: string; delta?: string; response?: { error?: { message?: string } } }
        try {
          obj = JSON.parse(json)
        } catch {
          continue  // partial / malformed line — skip and wait for next chunk
        }

        if (obj.type === 'response.output_text.delta' && obj.delta) {
          send('ollama-token', obj.delta)
        } else if (obj.type === 'response.completed') {
          send('ollama-done', null)
          return
        } else if (obj.type === 'response.failed') {
          throw new Error(obj.response?.error?.message ?? 'AI analysis failed')
        }
      }
    }
    send('ollama-done', null)
  }

  /** System-level persona for the AI — shared across cloud and Ollama. */
  const AI_SYSTEM_PROMPT = `You are a storage expert built into a disk-cleaner app. Your job is to analyze a single file or folder and give the user a concise, accurate verdict on what it is and whether deleting it is safe. You reason strictly from the actual path provided — never assume a path is in a different location than stated.

Rules:
- Plain prose only. No markdown, no bullet points, no headings.
- 2-3 sentences maximum.
- End with exactly one line: RECOMMENDATION: DELETE  or  RECOMMENDATION: KEEP
- Your recommendation must be consistent with your explanation. Never say "risky" and then DELETE. Never say "safe" and then KEEP.`

  /** Build the user-turn prompt for a given disk item. */
  function buildAnalysisPrompt(payload: { path: string; name: string; isDir: boolean; sizeKB: number }): string {
    const platformLabel = process.platform === 'win32' ? 'Windows' : 'macOS'
    const pathContext = getPathContext(payload.path)
    return `Analyze this ${platformLabel} disk item:

Name: ${payload.name}
Path: ${payload.path}
Type: ${payload.isDir ? 'Folder' : 'File'}
Size: ${formatSizeForPrompt(payload.sizeKB)}
${pathContext ? `Path context: ${pathContext}\n` : ''}
${process.platform === 'win32'
? `Windows path reference (use this to reason accurately — match the actual path above):
- C:\\Windows  C:\\Program Files  C:\\Program Files (x86)  C:\\ProgramData → system or installed-app data. Usually keep.
- C:\\Users\\<name>\\AppData\\Local\\Temp → temporary files. Usually safe to delete.
- C:\\Users\\<name>\\AppData\\Roaming → app settings and user data. Usually keep.
- C:\\Users\\<name>\\Downloads  Desktop  Documents  Pictures  Music  Videos → personal files. Review carefully before deleting.
- C:\\$Recycle.Bin → deleted-file storage. Contents are usually safe to delete permanently.
- node_modules  .gradle  target  build  dist (inside project folders) → build/dependency dirs. Safe to delete; regenerated by the build tool.`
: `macOS path reference (use this to reason accurately — match the actual path above):
- /System  /usr  /bin  /sbin  /private/etc  /private/var → core OS. Never delete.
- /Library (system-level) → system app support, fonts, extensions. Usually required.
- /Applications → installed apps. Delete only if you want to uninstall.
- ~/Library/Containers/{bundle} → sandboxed app data. May contain important user data; only delete if the app is already uninstalled or the folder is extremely large and the app can rebuild it.
- ~/Library/Group Containers → shared data between app groups. Usually keep.
- ~/Library/Application Support/{app} → persistent app config and data. Usually keep; deleting resets the app.
- ~/Library/Preferences/{app}.plist → app preferences. Deleting resets settings only.
- ~/Library/Keychains → credentials and certificates. Never delete.
- ~/Library/Caches/{app} → regenerable cache. Safe to delete.
- ~/Library/Logs  /Library/Logs → log files. Safe to delete.
- ~/Library/Developer/Xcode/DerivedData → Xcode build cache. Safe to delete.
- ~/Library/Developer/CoreSimulator → iOS Simulator data. Large; safe to delete if not actively using simulators.
- node_modules  .gradle  target  build  dist (inside project folders) → build/dependency dirs. Safe to delete; regenerated by the build tool.
- ~/Documents  ~/Desktop  ~/Downloads  ~/Movies  ~/Music  ~/Pictures → personal files. Never delete.
- /Users → parent of all home folders. Never delete.`}

What is this item and is it safe to delete?`
  }

  /** Stream NDJSON from a ReadableStream and emit ollama-token / ollama-done IPC events. */
  async function streamNdjson(
    body: ReadableStream<Uint8Array>,
    send: (ch: string, d: unknown) => void
  ): Promise<void> {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const obj = JSON.parse(line) as { response?: string; done?: boolean; error?: string }
        if (obj.error) throw new Error(obj.error)
        if (obj.response) send('ollama-token', obj.response)
        if (obj.done) { send('ollama-done', null); return }
      }
    }
    send('ollama-done', null)
  }

  ipcMain.on(
    'ollama-start',
    async (event, payload: { path: string; name: string; isDir: boolean; sizeKB: number }) => {
      if (!getLicenseInfo().active) {
        if (!event.sender.isDestroyed()) event.sender.send('ollama-done', 'A paid license is required for AI analysis.')
        return
      }
      if (!payload || typeof payload.path !== 'string' || payload.path.length === 0 || payload.path.length > 4096 ||
          typeof payload.name !== 'string' || payload.name.length === 0 || payload.name.length > 512 ||
          typeof payload.isDir !== 'boolean' || !Number.isFinite(payload.sizeKB) || payload.sizeKB < 0) {
        if (!event.sender.isDestroyed()) event.sender.send('ollama-done', 'The selected item could not be analyzed.')
        return
      }

      // Cancel any in-progress request
      ollamaAbort?.abort()
      const requestSequence = ++ollamaRequestSequence
      const controller = new AbortController()
      ollamaAbort = controller

      const send = (channel: string, data: unknown) => {
        if (requestSequence === ollamaRequestSequence && !event.sender.isDestroyed()) event.sender.send(channel, data)
      }

      try {
        const aiMode = normalizeAiMode(loadSettings().aiMode, process.env, loadCloudAiKey() !== null)

        if (aiMode === 'cloud') {
          const runtimeCloudConfig = getCloudAiConfig()
          const userApiKey = runtimeCloudConfig ? null : loadCloudAiKey()
          if (!runtimeCloudConfig && !userApiKey) {
            throw new Error('Cloud AI is not available. Choose Local AI in Settings.')
          }

          send('ollama-model', runtimeCloudConfig ? 'Nerion Cloud AI' : `OpenAI · ${OPENAI_MODEL}`)

          const requestBody = runtimeCloudConfig
            ? {
                stream: true,
                prompt: {
                  id: runtimeCloudConfig.promptId,
                  version: runtimeCloudConfig.promptVersion,
                  variables: {
                    name: payload.name,
                    path: payload.path,
                    is_directory: payload.isDir ? 'true' : 'false',
                    size: formatSizeForPrompt(payload.sizeKB),
                    path_context: getPathContext(payload.path),
                  },
                },
              }
            : {
                model: OPENAI_MODEL,
                instructions: AI_SYSTEM_PROMPT,
                input: buildAnalysisPrompt(payload),
                stream: true,
              }

          const res = await net.fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${runtimeCloudConfig?.apiKey ?? userApiKey!}`,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
          })

          if (!res.ok || !res.body) {
            const errText = (await res.text().catch(() => '')).slice(0, 500)
            throw new Error(`OpenAI returned ${res.status}${errText ? ': ' + errText : ''}`)
          }
          await streamResponsesAPI(res.body, send)
        } else {
          // ── Ollama (local) path ────────────────────────────────────────────
          const prompt = buildAnalysisPrompt(payload)
          const model = await pickOllamaModel()
          if (requestSequence !== ollamaRequestSequence) return

          send('ollama-model', model)

          const res = await net.fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: `${AI_SYSTEM_PROMPT}\n\n${prompt}`, stream: true }),
            signal: controller.signal
          })

          if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}`)
          await streamNdjson(res.body, send)
        }
      } catch (err: unknown) {
        if (requestSequence !== ollamaRequestSequence || controller.signal.aborted) return
        const msg = err instanceof Error ? err.message : String(err)
        send('ollama-done', msg)
      } finally {
        if (ollamaAbort === controller) ollamaAbort = null
      }
    }
  )

  ipcMain.on('ollama-cancel', () => {
    if (ollamaAbort) {
      ollamaRequestSequence += 1
      ollamaAbort.abort()
      ollamaAbort = null
    }
  })

  ipcMain.handle('get-ai-capabilities', () => currentAiCapabilities())
  ipcMain.handle('get-ai-mode', () => normalizeAiMode(
    loadSettings().aiMode,
    process.env,
    loadCloudAiKey() !== null,
  ))
  ipcMain.handle('set-ai-mode', (_event, mode: unknown) => {
    const normalizedMode = normalizeAiMode(mode, process.env, loadCloudAiKey() !== null)
    patchSettings({ aiMode: normalizedMode })
    return normalizedMode
  })
  ipcMain.handle('cloud-ai:configure', async (_event, apiKey: unknown) => {
    if (!getLicenseInfo().active) throw new Error('A paid license is required for Cloud AI.')
    await validateAndSaveCloudAiKey(apiKey)
    patchSettings({ aiMode: 'cloud' })
    return currentAiCapabilities()
  })
  ipcMain.handle('cloud-ai:remove', () => {
    removeCloudAiKey()
    const capabilities = currentAiCapabilities()
    if (!capabilities.cloudAvailable) patchSettings({ aiMode: 'ollama' })
    return capabilities
  })

  // ── Settings ───────────────────────────────────────────────────────────────
  ipcMain.handle('get-settings', () => loadSettings())
  ipcMain.handle('get-platform-info', () => getPlatformMeta())
  ipcMain.handle('appearance:get', () => getPlatformAppearance(true))
  ipcMain.handle('get-home-dir', () => os.homedir())
  ipcMain.handle('get-app-version', () => app.getVersion())
  ipcMain.handle('get-app-arch', () => process.arch)

  ipcMain.handle('save-settings', (_event, settings: unknown) => {
    const prev = loadSettings()
    const premium = getLicenseInfo().active
    // Keep runtime-managed counters from the source of truth in main process,
    // so stale renderer state can't overwrite delete quota or scan history.
    const validatedSettings = normalizeRendererSettings(settings, prev, {
      premium,
      allowedQuickFolderPresets: new Set(getPlatformMeta().quickScanOptions.map((option) => option.name)),
    })
    const mergedSettings: NerionSettings = {
      ...validatedSettings,
      aiMode: normalizeAiMode(validatedSettings.aiMode, process.env, loadCloudAiKey() !== null),
    }
    saveSettings(mergedSettings)
    if (mergedSettings.backgroundScan.enabled !== prev.backgroundScan.enabled ||
        mergedSettings.backgroundScan.intervalHours !== prev.backgroundScan.intervalHours ||
        mergedSettings.backgroundScan.scanTimeHour !== prev.backgroundScan.scanTimeHour) {
      if (mergedSettings.backgroundScan.enabled) scheduleBackgroundScan()
      else stopBackgroundScan()
    }
    if (mergedSettings.showMenuBarIcon !== prev.showMenuBarIcon) {
      setTrayVisibility(mergedSettings.showMenuBarIcon)
    }
    if (mergedSettings.autoUpdateEnabled && !prev.autoUpdateEnabled) {
      runAutoUpdateCheck('settings-enabled').catch(() => {})
    }
    rebuildTrayMenu()
    return mergedSettings
  })

  ipcMain.handle('test-notification', () => testNotification())

  ipcMain.handle('check-for-updates', () => {
    return runAutoUpdateCheck('manual')
  })

  ipcMain.handle('install-update-now', () => {
    return installDownloadedUpdateNow()
  })

  ipcMain.handle('is-update-ready-to-install', () => {
    return isUpdateReadyToInstall()
  })

  ipcMain.handle('request-notification-permission', () => {
    if (Notification.isSupported()) {
      new Notification({
        title: 'Nerion',
        body: "You'll be notified when background scans find space to reclaim."
      }).show()
    }
  })

  ipcMain.handle('mark-onboarding-complete', () => {
    patchSettings({ onboardingComplete: true })
  })

  ipcMain.handle('get-login-item', () => {
    return app.getLoginItemSettings(process.platform === 'win32' ? { args: ['--hidden'] } : {}).openAtLogin
  })

  ipcMain.handle('set-login-item', (_event, enable: unknown) => {
    if (typeof enable !== 'boolean') throw new Error('Invalid startup setting.')
    app.setLoginItemSettings(process.platform === 'win32'
      ? { openAtLogin: enable, args: ['--hidden'] }
      : { openAtLogin: enable, openAsHidden: enable })
  })

  ipcMain.handle('check-full-disk-access', async () => {
    if (!supportsFullDiskAccess()) return true
    try {
      // /Library/Application Support/com.apple.TCC is readable only with Full Disk Access
      // and is guaranteed to exist on all macOS systems.
      await readdir('/Library/Application Support/com.apple.TCC')
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('relaunch-app', () => {
    setQuitting()
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle('get-electron-exe-path', () => {
    // Returns the path to the running executable.
    // In dev mode this points into node_modules/electron/dist/Electron.app.
    return app.getPath('exe')
  })

  ipcMain.handle('check-notification-permission', () => checkNotificationPermissionStatus())

  ipcMain.handle('check-ollama', async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const res = await net.fetch('http://localhost:11434/api/tags', { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) return { installed: false }
      const data = await res.json() as { models?: { name: string }[] }
      return { installed: true, hasModels: (data.models?.length ?? 0) > 0 }
    } catch {
      return { installed: false }
    }
  })

  ipcMain.handle('get-ollama-models', async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      const res = await net.fetch('http://localhost:11434/api/tags', { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) return { ok: false, models: [] }
      const data = await res.json() as {
        models?: Array<{ name: string; size: number; modified_at: string }>
      }
      return { ok: true, models: data.models ?? [] }
    } catch {
      return { ok: false, models: [] }
    }
  })

  ipcMain.on('pull-model', async (event, modelName: string) => {
    if (!getLicenseInfo().active) {
      if (!event.sender.isDestroyed()) event.sender.send('pull-done', { model: modelName, error: 'A paid license is required to download AI models.' })
      return
    }
    if (typeof modelName !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(modelName)) {
      if (!event.sender.isDestroyed()) event.sender.send('pull-done', { model: String(modelName), error: 'Invalid model name.' })
      return
    }
    if (pullAbort) pullAbort.abort()
    const requestSequence = ++pullRequestSequence
    const controller = new AbortController()
    pullAbort = controller

    const send = (channel: string, data: unknown) => {
      if (requestSequence === pullRequestSequence && !event.sender.isDestroyed()) event.sender.send(channel, data)
    }

    const layerProgress = new Map<string, { total: number; completed: number }>()

    try {
      const res = await net.fetch('http://localhost:11434/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: true }),
        signal: controller.signal
      })

      if (!res.ok || !res.body) {
        send('pull-done', { model: modelName, error: `Ollama returned ${res.status}` })
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let explicitSuccess = false

      const consumePullLine = (line: string): boolean => {
        const obj = parseOllamaPullRecord(line)
        if (!obj) return false
        if (obj.error) throw new Error(obj.error)
        if (obj.digest && obj.total) {
          layerProgress.set(obj.digest, { total: obj.total, completed: obj.completed })
        }
        const totalBytes = [...layerProgress.values()].reduce((s, v) => s + v.total, 0)
        const completedBytes = [...layerProgress.values()].reduce((s, v) => s + v.completed, 0)
        const progress = totalBytes > 0 ? Math.round((completedBytes / totalBytes) * 100) : null
        send('pull-progress', { model: modelName, progress, status: obj.status })
        return obj.status === 'success'
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        if (buf.length > 1_048_576) throw new Error('Ollama returned an invalid oversized response.')
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (consumePullLine(line)) {
            explicitSuccess = true
            break
          }
        }
        if (explicitSuccess) break
      }
      if (!explicitSuccess && buf.trim()) explicitSuccess = consumePullLine(buf)
      if (!explicitSuccess) throw new Error('The Ollama download stream ended before the model was ready.')
      send('pull-done', { model: modelName, error: null })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('abort') && !msg.includes('AbortError')) {
        send('pull-done', { model: modelName, error: msg })
      }
    } finally {
      if (pullAbort === controller) pullAbort = null
    }
  })

  ipcMain.on('cancel-pull', () => {
    pullRequestSequence += 1
    if (pullAbort) { pullAbort.abort(); pullAbort = null }
  })

  // ── License ────────────────────────────────────────────────────────────────
  ipcMain.handle('license:get', () => getLicenseInfo())
  ipcMain.handle('license:activate', (_event, key: unknown) => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 512) {
      return { ok: false, error: 'Enter a valid license key.' }
    }
    return activateLicense(key)
  })
  ipcMain.handle('license:deactivate', () => deactivateLicense())

  // Single-flight startup + recurring entitlement refresh service.
  startLicenseValidationService()

  ipcMain.handle('run-bg-scan', () => runBackgroundScanNow())

  ipcMain.on('update-last-scan-path', (_event, scanPath: unknown) => {
    if (isValidIpcPath(scanPath)) updateLastScanPath(scanPath)
  })

  ipcMain.on('notify-manual-scan-done', (_event, foundKB: unknown) => {
    const normalizedFoundKB = normalizeNonNegativeKilobytes(foundKB)
    if (normalizedFoundKB === null) return
    patchSettings({
      lastManualScanTime: Date.now(),
      lastManualScanFoundKB: normalizedFoundKB,
      // Reset cleaned state so tray shows "Found" for the new scan
      lastCleanedTime: null,
      lastCleanedKB: 0
    })
    rebuildTrayMenu()
  })

  ipcMain.on('notify-cleaned', (_event, cleanedKB: unknown) => {
    const normalizedCleanedKB = normalizeNonNegativeKilobytes(cleanedKB)
    if (normalizedCleanedKB === null) return
    patchSettings({ lastCleanedTime: Date.now(), lastCleanedKB: normalizedCleanedKB })
    rebuildTrayMenu()
  })
}
