import { DiskEntry } from '../types'

// Conservative set — only generic system-level cache/temp directories.
const CLEANABLE_NAMES = new Set([
  // Generic caches
  '.cache',
  '.trash',
  // Temp directories
  '.tmp',
  'tmp',
  'temp',
  '.temp',
  // Log directories
  'logs',
  // Xcode build cache (lives in ~/Library/Developer, not in project dirs)
  'deriveddata',
])

// Dev project artifact directories — excluded by default, shown when the
// "Show development dependencies" setting is enabled.
// Only project-scoped, regenerable artifacts — NOT build outputs, frameworks,
// or anything that could match system/tool directories.
export const DEV_DEPENDENCY_NAMES = new Set([
  // JavaScript / Node.js
  'node_modules',
  // Python virtual environments and caches
  'venv', '.venv', 'env', '__pycache__', '.tox',
  // Java / Kotlin / Scala
  '.m2',           // Maven local repository
  '.gradle',       // Gradle cache
  // Rust
  // (target is listed below — used by Rust, Java Maven, and others)
  // Go / PHP / Ruby
  'vendor',        // Go modules cache, PHP Composer, Ruby Bundler
  // Multi-ecosystem build artifacts
  'target',        // Rust, Java Maven, Scala SBT
  // Swift / iOS
  '.build',        // Swift Package Manager
  'pods',          // CocoaPods (matched case-insensitively)
  // Haskell
  '.stack-work',
  // Legacy JS
  'bower_components',
  // Note: .yarn is intentionally excluded — Yarn Berry's .yarn directory often
  // contains committed offline cache / PnP files and is not safe to auto-clean.
])

// Paths under these prefixes are never flagged as dev dependencies —
// they belong to system tools, Homebrew, frameworks, or installed apps.
const SYSTEM_PATH_PREFIXES = [
  '/opt/',              // Homebrew (Apple Silicon) and other opt installs
  '/usr/',              // system binaries and libraries
  '/System/',           // macOS system frameworks
  '/Library/',          // system-level Library (NOT ~/Library — that starts with /Users/)
  '/Applications/',     // installed applications
  '/Developer/',        // Xcode / system developer tools
  '/private/',          // private system paths
  '/bin/',
  '/sbin/',
]

// Path substrings that indicate a managed tool installation — never flag these
// even when they contain folder names like node_modules or .venv.
const MANAGED_PATH_SUBSTRINGS = [
  '/.nvm/',             // NVM-managed Node.js versions
  '/.vscode/',          // VS Code extensions / settings
  '/.rbenv/',           // rbenv Ruby versions
  '/.pyenv/',           // pyenv Python versions
  '/.asdf/',            // asdf version manager
  '/homebrew/',         // catch-all for any homebrew path
  '.app/Contents/',     // inside a macOS app bundle (staged updates, installed apps)
  '/ShipIt/',           // Squirrel/Sparkle update staging directories
  '/.npm/',             // npm's own package cache (~/.npm)
  '/.copilot/',         // GitHub Copilot workspace data
  '/go/pkg/',           // Go module download cache (~/go/pkg/mod)
  '/Application Support/', // macOS per-user app data (~/Library/Application Support)
  '/Library/Python/',   // pip --user installed packages (~/Library/Python)
  '/Library/Containers/', // macOS app sandbox containers — never delete app internals
]

// Apple/macOS housekeeping files that shouldn't surface in Smart Clean.
const APPLE_METADATA_NAMES = new Set([
  '.ds_store',
  '.spotlight-v100',
  '.fseventsd',
  '.temporaryitems',
  '.trashes',
  '.documentrevisions-v100',
  '.volumesicon.icns',
  '.apdisk',
])

export function isAppleMetadata(entry: DiskEntry): boolean {
  const lowerName = entry.name.toLowerCase()
  if (APPLE_METADATA_NAMES.has(lowerName)) return true

  // AppleDouble sidecar files created by Finder on some filesystems.
  if (!entry.isDir && entry.name.startsWith('._')) return true

  return false
}

export function isCleanable(entry: DiskEntry): boolean {
  if (isAppleMetadata(entry)) return false
  if (!entry.isDir) return false
  if (!CLEANABLE_NAMES.has(entry.name.toLowerCase())) return false
  // Never flag dirs inside system or tool locations (same guard as isDevDependency).
  // Note: ~/Library starts with /Users/…, so it is NOT excluded by the /Library/ prefix.
  for (const prefix of SYSTEM_PATH_PREFIXES) {
    if (entry.path.startsWith(prefix)) return false
  }
  // Never flag cache/log dirs that live inside app sandbox containers.
  if (entry.path.includes('/Library/Containers/')) return false
  return true
}

export function isDevDependency(entry: DiskEntry): boolean {
  // Note: isDir is intentionally not checked — some package managers (e.g. pnpm)
  // create node_modules as a symlink, which scanners may report as non-directory.
  if (!DEV_DEPENDENCY_NAMES.has(entry.name.toLowerCase())) return false
  // Never flag directories that live inside system/tool locations
  for (const prefix of SYSTEM_PATH_PREFIXES) {
    if (entry.path.startsWith(prefix)) return false
  }
  // Never flag directories inside managed version managers or VS Code
  for (const sub of MANAGED_PATH_SUBSTRINGS) {
    if (entry.path.includes(sub)) return false
  }
  return true
}
