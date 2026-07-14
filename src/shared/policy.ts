import type { DiskEntry } from '../renderer/types'
import { detectRuntimePlatform, getPlatformInfo, type AppPlatform } from './platform'

function getEnvVar(name: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = (globalThis as any)?.process?.env
    const value = env?.[name]
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

function detectHomeDir(platform: AppPlatform): string | null {
  if (platform === 'windows') {
    const userProfile = getEnvVar('USERPROFILE')
    if (userProfile) return userProfile.replace(/\\+/g, '\\')
    const drive = getEnvVar('HOMEDRIVE')
    const path = getEnvVar('HOMEPATH')
    return drive && path ? `${drive}${path}` : null
  }

  return getEnvVar('HOME')
}

function normalizeMacPath(itemPath: string): string {
  const absolute = itemPath.startsWith('/')
  const stack: string[] = []
  for (const segment of itemPath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (stack.length > 0) stack.pop()
      continue
    }
    stack.push(segment)
  }
  const normalized = `${absolute ? '/' : ''}${stack.join('/')}`
  return normalized.replace(/\/+$/, '') || (absolute ? '/' : '.')
}

function normalizeWindowsPath(itemPath: string): string {
  const slashified = itemPath.replace(/\//g, '\\')
  const drive = slashified.match(/^([a-z]:)\\/i)
  const unc = slashified.match(/^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/)
  const root = drive ? `${drive[1]}\\` : unc ? `\\\\${unc[1]}\\${unc[2]}` : ''
  const remainder = drive
    ? slashified.slice(drive[0].length)
    : unc ? slashified.slice(unc[0].length) : slashified
  const stack: string[] = []
  for (const segment of remainder.split('\\')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (stack.length > 0) stack.pop()
      continue
    }
    stack.push(segment)
  }
  if (!root) return stack.join('\\') || '.'
  if (drive) return stack.length > 0 ? `${root}${stack.join('\\')}` : root
  return stack.length > 0 ? `${root}\\${stack.join('\\')}` : root
}

export function normalizePathForPlatform(itemPath: string, platform: AppPlatform = detectRuntimePlatform()): string {
  return platform === 'windows' ? normalizeWindowsPath(itemPath) : normalizeMacPath(itemPath)
}

function lower(itemPath: string): string {
  return itemPath.toLowerCase()
}

function getMacQuickFolderPath(folder: string, homeDir: string): string {
  if (folder.startsWith('/')) return folder
  if (folder === 'Trash') return `${homeDir}/.Trash`
  if (folder === 'Downloads' || folder === 'Desktop') return `${homeDir}/${folder}`
  return `${homeDir}/Library/${folder}`
}

function getWindowsQuickFolderPath(folder: string, homeDir: string): string {
  if (
    /^[a-z]:(\\|\/)/i.test(folder)
    || /^[a-z]:$/i.test(folder)
    || /^\\\\[^\\]+\\[^\\]+/.test(folder)
    || /^\/\/[^/]+\/[^/]+/.test(folder)
  ) return folder
  switch (folder) {
    case 'Temp':
      return `${homeDir}\\AppData\\Local\\Temp`
    case 'Logs':
      return `${homeDir}\\AppData\\Local\\Logs`
    case 'Downloads':
      return `${homeDir}\\Downloads`
    case 'Desktop':
      return `${homeDir}\\Desktop`
    case 'Recycle Bin':
      return 'C:\\$Recycle.Bin'
    case 'AppData Local Temp':
      return `${homeDir}\\AppData\\Local\\Temp`
    case 'AppData Local Packages':
      return `${homeDir}\\AppData\\Local\\Packages`
    case 'AppData Roaming':
      return `${homeDir}\\AppData\\Roaming`
    default:
      return `${homeDir}\\AppData\\Local\\${folder}`
  }
}

export function resolveQuickFolderPath(
  folder: string,
  homeDir: string | null,
  platform: AppPlatform = detectRuntimePlatform()
): string | null {
  if (!homeDir) return null
  return platform === 'windows'
    ? getWindowsQuickFolderPath(folder, homeDir)
    : getMacQuickFolderPath(folder, homeDir)
}

export function getDefaultQuickScanFolders(platform: AppPlatform = detectRuntimePlatform()): string[] {
  return [...getPlatformInfo(platform).quickScanDefaults]
}

export function getQuickScanRootPath(homeDir: string | null, platform: AppPlatform = detectRuntimePlatform()): string | null {
  if (!homeDir) return null
  return platform === 'windows' ? `${homeDir}\\AppData\\Local` : `${homeDir}/Library`
}

export function isAppleMetadata(entry: DiskEntry, platform: AppPlatform = detectRuntimePlatform()): boolean {
  const lowerName = entry.name.toLowerCase()
  if (platform === 'windows') {
    return lowerName === 'thumbs.db' || lowerName === 'desktop.ini'
  }

  const appleMetadataNames = new Set([
    '.ds_store',
    '.spotlight-v100',
    '.fseventsd',
    '.temporaryitems',
    '.trashes',
    '.documentrevisions-v100',
    '.volumesicon.icns',
    '.apdisk',
  ])

  if (appleMetadataNames.has(lowerName)) return true
  return !entry.isDir && entry.name.startsWith('._')
}

const DEV_DEPENDENCY_NAMES = new Set([
  'node_modules', 'venv', '.venv', 'env', '__pycache__', '.tox', '.m2', '.gradle',
  'vendor', 'target', '.build', 'pods', '.stack-work', 'bower_components'
])

export function isDevDependency(entry: DiskEntry, platform: AppPlatform = detectRuntimePlatform()): boolean {
  if (!DEV_DEPENDENCY_NAMES.has(entry.name.toLowerCase())) return false
  const pathValue = lower(normalizePathForPlatform(entry.path, platform))

  const blockedPrefixes = platform === 'windows'
    ? ['c:\\windows\\', 'c:\\program files\\', 'c:\\program files (x86)\\', 'c:\\programdata\\']
    : ['/opt/', '/usr/', '/system/', '/library/', '/applications/', '/developer/', '/private/', '/bin/', '/sbin/']

  if (blockedPrefixes.some((prefix) => pathValue.startsWith(prefix))) return false
  if (platform === 'windows' && /^[a-z]:\\(windows|program files|program files \(x86\)|programdata)\\/i.test(pathValue)) return false

  const managedSubstrings = platform === 'windows'
    ? ['\\appdata\\local\\programs\\', '\\appdata\\roaming\\code\\', '\\program files\\', '\\windowsapps\\']
    : ['/.nvm/', '/.vscode/', '/.rbenv/', '/.pyenv/', '/.asdf/', '/homebrew/', '.app/contents/', '/shipit/', '/.npm/', '/.copilot/', '/go/pkg/', '/application support/', '/library/python/', '/library/containers/']

  return !managedSubstrings.some((segment) => pathValue.includes(segment))
}

export function isCleanable(
  entry: DiskEntry,
  platform: AppPlatform = detectRuntimePlatform(),
  explicitHomeDir?: string | null,
): boolean {
  if (isAppleMetadata(entry, platform)) return false
  const cleanableNames = platform === 'windows'
    ? new Set(['temp', 'tmp', 'logs', 'cache', 'caches'])
    : new Set(['.cache', '.trash', '.tmp', 'tmp', 'temp', '.temp', 'logs', 'deriveddata'])

  if (!entry.isDir) return false
  if (!cleanableNames.has(entry.name.toLowerCase())) return false

  const pathValue = lower(normalizePathForPlatform(entry.path, platform))
  if (platform === 'windows') {
    const home = lower(normalizeWindowsPath(explicitHomeDir ?? detectHomeDir(platform) ?? 'c:\\users\\__unknown__'))
    const safeRoots = [
      `${home}\\appdata\\local\\temp`,
      `${home}\\appdata\\local\\logs`,
    ]
    return safeRoots.some((root) => pathValue === root || pathValue.startsWith(`${root}\\`))
  }

  const home = lower(normalizeMacPath(explicitHomeDir ?? detectHomeDir(platform) ?? '/Users/__unknown__'))
  const safeRoots = [
    `${home}/.cache`,
    `${home}/library/caches`,
    `${home}/library/logs`,
    `${home}/library/developer/xcode/deriveddata`,
  ]
  return safeRoots.some((root) => pathValue === root || pathValue.startsWith(`${root}/`))
}

/**
 * Roots whose direct children are ordinary disposable cache/log/temp content.
 * Scanners do not emit their root as an entry, so consumers need this policy
 * to classify the root's first-level children consistently.
 */
export function isAutomaticCleanupRoot(
  itemPath: string,
  platform: AppPlatform = detectRuntimePlatform(),
  explicitHomeDir?: string | null,
): boolean {
  const pathValue = lower(normalizePathForPlatform(itemPath, platform))
  if (platform === 'windows') {
    const home = lower(normalizeWindowsPath(explicitHomeDir ?? detectHomeDir(platform) ?? 'c:\\users\\__unknown__'))
    return pathValue === `${home}\\appdata\\local\\temp`
      || pathValue === `${home}\\appdata\\local\\logs`
  }

  const home = lower(normalizeMacPath(explicitHomeDir ?? detectHomeDir(platform) ?? '/Users/__unknown__'))
  return pathValue === `${home}/library/caches`
    || pathValue === `${home}/library/logs`
}

export function isCriticalPath(itemPath: string, platform: AppPlatform = detectRuntimePlatform(), explicitHomeDir?: string | null): boolean {
  const homeDir = explicitHomeDir ?? detectHomeDir(platform)
  const normalized = normalizePathForPlatform(itemPath, platform)
  const pathValue = lower(normalized)

  if (platform === 'windows') {
    const raw = itemPath.replace(/\//g, '\\')
    // Device namespaces and administrative shares can alias protected local
    // paths while bypassing ordinary drive-letter comparisons. Alternate data
    // streams are not valid cleanup selections either.
    if (
      /^\\\\[?.]\\/i.test(raw)
      || /^\\(?:\?\?|globalroot)\\/i.test(raw)
      || /^\\\\[^\\]+\\(?:[a-z]|admin|ipc|print)\$(?:\\|$)/i.test(raw)
      || (/^[a-z]:/i.test(raw) && raw.slice(2).includes(':'))
    ) return true
    if (!/^[a-z]:\\/i.test(normalized) && !/^\\\\[^\\]+\\[^\\]+/i.test(normalized)) return true
    const home = lower(homeDir ?? 'c:\\users\\__unknown__')
    const exact = new Set([
      'c:\\',
      'c:\\windows',
      'c:\\program files',
      'c:\\program files (x86)',
      'c:\\programdata',
      'c:\\users',
      home,
      `${home}\\documents`,
      `${home}\\downloads`,
      `${home}\\desktop`,
      `${home}\\pictures`,
      `${home}\\music`,
      `${home}\\videos`,
      `${home}\\appdata`,
      `${home}\\appdata\\local`,
      `${home}\\appdata\\roaming`,
      'c:\\$recycle.bin',
    ])
    if (exact.has(pathValue)) return true
    if (/^[a-z]:\\$/i.test(pathValue) || /^\\\\[^\\]+\\[^\\]+$/i.test(pathValue)) return true
    if (/^[a-z]:\\(windows|program files|program files \(x86\)|programdata|users)$/i.test(pathValue)) return true
    return (
      /^[a-z]:\\(windows|program files|program files \(x86\))\\/i.test(pathValue)
      || /^[a-z]:\\programdata\\microsoft\\/i.test(pathValue)
      || /^[a-z]:\\users\\[^\\]+$/i.test(pathValue)
      || pathValue.includes('\\onedrive\\')
    )
  }

  if (!normalized.startsWith('/')) return true

  const home = homeDir ?? '/Users/__unknown__'
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
  const sensitiveUserRoots = [
    `${home}/Library/CloudStorage`,
    `${home}/Library/Keychains`,
    `${home}/Library/Mobile Documents`,
    `${home}/Library/Mail`,
    `${home}/Library/Messages`,
    `${home}/Library/Safari`,
  ]

  const blockedExact = new Set([
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
    `${home}/Library/Application Support`,
    `${home}/Library/Containers`,
    `${home}/Library/Preferences`,
    `${home}/Library/CloudStorage`,
    `${home}/Library/Keychains`,
    ...contentOnlyRoots,
  ])

  if (blockedExact.has(normalized)) return true

  // Leftover detection may surface one direct third-party artifact from these
  // bounded system Library locations. Their parent roots remain protected.
  const allowedSystemLibraryArtifact = /^\/Library\/(Application Support|LaunchAgents|LaunchDaemons)\/[^/]+$/.test(normalized)
  const insideSensitiveUserRoot = sensitiveUserRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))

  return (
    normalized.startsWith('/System/')
    || (!allowedSystemLibraryArtifact && normalized.startsWith('/Library/'))
    || normalized.startsWith('/usr/')
    || normalized.startsWith('/var/')
    || normalized.startsWith('/private/')
    || normalized.startsWith('/sbin/')
    || normalized.startsWith('/bin/')
    || normalized.startsWith('/lib/')
    || /^\/Volumes\/[^/]+$/.test(normalized)
    || /^\/Network\/[^/]+$/.test(normalized)
    || /^\/Users\/[^/]+$/.test(normalized)
    || insideSensitiveUserRoot
  )
}

export function isContentOnlyProtectedRoot(itemPath: string, platform: AppPlatform = detectRuntimePlatform(), explicitHomeDir?: string | null): boolean {
  const homeDir = explicitHomeDir ?? detectHomeDir(platform)
  const normalized = normalizePathForPlatform(itemPath, platform)
  const pathValue = lower(normalized)

  if (platform === 'windows') {
    const home = lower(homeDir ?? 'c:\\users\\__unknown__')
    return (
      pathValue === `${home}\\desktop`
      || pathValue === `${home}\\downloads`
      || pathValue === `${home}\\documents`
      || pathValue === `${home}\\pictures`
      || pathValue === `${home}\\music`
      || pathValue === `${home}\\videos`
      || pathValue === `${home}\\appdata\\local\\temp`
      || pathValue === `${home}\\appdata\\local\\logs`
      || /^[a-z]:\\\$recycle\.bin$/i.test(pathValue)
    )
  }

  const home = normalizeMacPath(homeDir ?? '/Users/__unknown__')
  return new Set([
    `${home}/Desktop`,
    `${home}/Downloads`,
    `${home}/Documents`,
    `${home}/Movies`,
    `${home}/Music`,
    `${home}/Pictures`,
    `${home}/.Trash`,
    `${home}/Library/Caches`,
    `${home}/Library/Logs`,
    `${home}/Library/HTTPStorages`,
    `${home}/Library/Saved Application State`,
    `${home}/Library/WebKit`,
  ]).has(normalized)
}
