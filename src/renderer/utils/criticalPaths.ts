/**
 * Critical macOS paths that should never be moved to Trash.
 * Used in the renderer to disable destructive actions for protected locations.
 */

// Safely derive the home directory without relying on process.env (which may
// not be defined in the Vite renderer bundle).
function getHome(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = (globalThis as any).process?.env
    if (env?.HOME) return env.HOME as string
    if (env?.USER) return `/Users/${env.USER as string}`
  } catch {
    // ignore — fall through to default
  }
  // Last resort: derive from a known macOS path pattern.
  // This is only used for the blocked-exact set; regex checks for /Users/<name>
  // still work correctly without knowing the exact home path.
  return '/Users/__unknown__'
}

export function isCriticalPath(itemPath: string): boolean {
  const home = getHome()
  const normalized = itemPath.replace(/\/+$/, '')

  const BLOCKED_EXACT = new Set([
    '/',
    '/Users',
    '/System',
    '/System/Library',
    '/Library',
    '/Applications',
    '/bin',
    '/sbin',
    '/usr',
    '/usr/bin',
    '/usr/lib',
    '/usr/local',
    '/etc',
    '/var',
    '/private',
    '/private/etc',
    '/private/var',
    '/private/tmp',
    '/Volumes',
    '/Network',
    '/cores',
    home,
    `${home}/Library`,
    `${home}/Library/Preferences`,
    `${home}/Library/Application Support`,
    `${home}/Library/Keychains`,
    `${home}/Library/Mail`,
    `${home}/Library/Messages`,
    `${home}/Documents`,
    `${home}/Desktop`,
    `${home}/Downloads`,
    `${home}/Movies`,
    `${home}/Music`,
    `${home}/Pictures`,
    `${home}/Applications`,
  ])

  if (BLOCKED_EXACT.has(normalized)) return true

  // Anything inside core system trees
  const BLOCKED_PREFIXES = [
    '/System/',
    '/usr/lib/',
    '/usr/bin/',
    '/sbin/',
    '/bin/',
    '/private/etc/',
    '/private/var/db/',
    '/private/var/root/',
  ]

  for (const prefix of BLOCKED_PREFIXES) {
    if (normalized.startsWith(prefix)) return true
  }

  // Any direct user home directory under /Users (e.g. /Users/jane)
  if (/^\/Users\/[^/]+$/.test(normalized)) return true

  return false
}
