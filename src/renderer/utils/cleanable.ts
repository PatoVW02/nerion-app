import { DiskEntry } from '../types'

// Conservative set — only generic system-level cache/temp directories.
// Dev project artifacts (node_modules, build outputs, venvs, etc.) are excluded
// because they are project-scoped and should not be auto-suggested for deletion.
const CLEANABLE_NAMES = new Set([
  // Generic caches
  '.cache',
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

export function isCleanable(entry: DiskEntry): boolean {
  return entry.isDir && CLEANABLE_NAMES.has(entry.name.toLowerCase())
}
