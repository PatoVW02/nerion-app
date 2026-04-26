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

function userLibraryExactProtectedRoots(home: string): string[] {
  return [
    `${home}/Library/Application Scripts`,
    `${home}/Library/Application Support`,
    `${home}/Library/Assistants`,
    `${home}/Library/Audio`,
    `${home}/Library/Autosave Information`,
    `${home}/Library/ColorPickers`,
    `${home}/Library/ColorSync`,
    `${home}/Library/Components`,
    `${home}/Library/Containers`,
    `${home}/Library/Contextual Menu Items`,
    `${home}/Library/Cookies`,
    `${home}/Library/Developer`,
    `${home}/Library/Dictionaries`,
    `${home}/Library/Documentation`,
    `${home}/Library/Extensions`,
    `${home}/Library/Favorites`,
    `${home}/Library/Fonts`,
    `${home}/Library/Group Containers`,
    `${home}/Library/Internet Plug-ins`,
    `${home}/Library/Keyboards`,
    `${home}/Library/Keychains`,
    `${home}/Library/LaunchAgents`,
    `${home}/Library/LaunchDaemons`,
    `${home}/Library/Mail`,
    `${home}/Library/Messages`,
    `${home}/Library/Mobile Documents`,
    `${home}/Library/PreferencePanes`,
    `${home}/Library/Preferences`,
    `${home}/Library/Printers`,
    `${home}/Library/QuickLook`,
    `${home}/Library/QuickTime`,
    `${home}/Library/Safari`,
    `${home}/Library/Scripting Additions`,
    `${home}/Library/Sounds`,
    `${home}/Library/CloudStorage`,
  ]
}

function userLibraryProtectedPrefixes(home: string): string[] {
  return [
    `${home}/Library/Containers/`,
    `${home}/Library/CloudStorage/`,
    `${home}/Library/Fonts/`,
    `${home}/Library/Group Containers/`,
    `${home}/Library/Keychains/`,
    `${home}/Library/Mail/`,
    `${home}/Library/Messages/`,
    `${home}/Library/Mobile Documents/`,
    `${home}/Library/Safari/`,
  ]
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

function isProtectedAppleSystemApp(normalized: string): boolean {
  if (normalized.startsWith('/System/Applications/')) return true
  if (normalized.startsWith('/System/Library/CoreServices/')) return true

  const appName = normalized.split('/').pop()
  if (!appName) return false

  if (normalized.startsWith('/Applications/') && APPLE_BUILTIN_APPS.has(appName)) return true
  if (normalized.startsWith('/Applications/Utilities/') && APPLE_BUILTIN_UTILITIES.has(appName)) return true
  return false
}

export function isCriticalPath(itemPath: string): boolean {
  const home = getHome()
  const normalized = itemPath.replace(/\/+$/, '')
  const contentOnlyRoots = [
    `${home}/Desktop`,
    `${home}/Documents`,
    `${home}/Downloads`,
    `${home}/Movies`,
    `${home}/Music`,
    `${home}/Pictures`,
    `${home}/.Trash`,
    `${home}/Library/Caches`,
    `${home}/Library/Logs`,
    `${home}/Library/HTTPStorages`,
    `${home}/Library/Saved Application State`,
    `${home}/Library/WebKit`,
  ]

  const BLOCKED_EXACT = new Set([
    '/',
    '/Users',
    '/System',
    '/System/Library',
    '/Library',
    '/Applications',
    '/bin',
    '/lib',
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
    `${home}/Applications`,
    ...userLibraryExactProtectedRoots(home),
    ...contentOnlyRoots,
  ])

  if (BLOCKED_EXACT.has(normalized)) return true
  if (isProtectedAppleSystemApp(normalized)) return true

  // Anything inside core system trees
  const BLOCKED_PREFIXES = [
    '/System/',
    '/Library/',
    '/usr/',
    '/var/',
    '/private/',
    '/usr/lib/',
    '/usr/bin/',
    '/sbin/',
    '/bin/',
    '/lib/',
    '/private/etc/',
    '/private/var/db/',
    '/private/var/root/',
    ...userLibraryProtectedPrefixes(home),
  ]

  for (const prefix of BLOCKED_PREFIXES) {
    if (normalized.startsWith(prefix)) return true
  }

  // Any direct user home directory under /Users (e.g. /Users/jane)
  if (/^\/Users\/[^/]+$/.test(normalized)) return true

  // Common user data roots should always be protected, even if HOME couldn't be resolved.
  if (/^\/Users\/[^/]+\/(Desktop|Downloads|Documents|Movies|Music|Pictures|Applications)$/.test(normalized)) {
    return true
  }
  if (/^\/Users\/[^/]+\/\.Trash$/.test(normalized)) return true
  if (/^\/Users\/[^/]+\/Library\/(Caches|Logs|HTTPStorages|Saved Application State|WebKit)$/.test(normalized)) {
    return true
  }
  if (/^\/Users\/[^/]+\/Library\/(Application Scripts|Application Support|Containers|Fonts|Group Containers|Keychains|Mail|Messages|Mobile Documents|Preferences|Safari|CloudStorage)$/.test(normalized)) {
    return true
  }

  return false
}

// Protected user roots where cleanup should target contents only (never the root folder).
export function isContentOnlyProtectedRoot(itemPath: string): boolean {
  const normalized = itemPath.replace(/\/+$/, '')
  return /^\/Users\/[^/]+\/(Desktop|Downloads|Documents|Movies|Music|Pictures|\.Trash)$/.test(normalized)
    || /^\/Users\/[^/]+\/Library\/(Caches|Logs|HTTPStorages|Saved Application State|WebKit)$/.test(normalized)
}
