import Foundation

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: scanner <path>\n", stderr)
    exit(1)
}

let rootPath = (CommandLine.arguments[1] as NSString).standardizingPath
let rootURL = URL(fileURLWithPath: rootPath, isDirectory: true)
let fm = FileManager.default
let stdoutHandle = FileHandle.standardOutput

let resourceKeys: [URLResourceKey] = [
    .totalFileAllocatedSizeKey,
    .isDirectoryKey,
    .isSymbolicLinkKey
]

// Stack frame for DFS size aggregation
struct Frame {
    let path: String
    var bytes: Int64
    let level: Int
}

var stack = [Frame(path: rootPath, bytes: 0, level: 0)]

func emitLine(sizeBytes: Int64, isDir: Bool, path: String) {
    let line = "\(sizeBytes)\t\(isDir ? "d" : "f")\t\(path)\n"
    if let data = line.data(using: .utf8) {
        stdoutHandle.write(data)
    }
}

guard let enumerator = fm.enumerator(
    at: rootURL,
    includingPropertiesForKeys: resourceKeys,
    options: [],
    errorHandler: { _, _ in true } // skip permission errors, keep going
) else {
    fputs("Cannot enumerate \(rootPath)\n", stderr)
    exit(1)
}

for case let url as URL in enumerator {
    guard let rv = try? url.resourceValues(forKeys: Set(resourceKeys)) else { continue }

    // Skip symlinks entirely to avoid cycles and double-counting
    if rv.isSymbolicLink == true { continue }

    let currentLevel = enumerator.level
    let path = url.path

    // Pop any completed directories whose subtrees are now fully scanned.
    // A directory at depth N is complete when we encounter an item at depth <= N.
    while stack.count > 1 && stack.last!.level >= currentLevel {
        let completed = stack.removeLast()
        stack[stack.count - 1].bytes += completed.bytes
        emitLine(sizeBytes: completed.bytes, isDir: true, path: completed.path)
    }

    if rv.isDirectory == true {
        stack.append(Frame(path: path, bytes: 0, level: currentLevel))
    } else {
        let size = Int64(rv.totalFileAllocatedSize ?? 0)
        stack[stack.count - 1].bytes += size
        emitLine(sizeBytes: size, isDir: false, path: path)
    }
}

// Flush remaining stack. Directories are emitted as their subtrees complete.
// Skip index 0 (the root itself — it's the scan target, not a child entry).
while stack.count > 1 {
    let completed = stack.removeLast()
    stack[stack.count - 1].bytes += completed.bytes
    emitLine(sizeBytes: completed.bytes, isDir: true, path: completed.path)
}
