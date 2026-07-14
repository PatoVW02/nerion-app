import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import type { Dirent } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { LeftoverArtifact, LeftoverGroup, LeftoverScanResult } from '../shared/contracts'

const execFileAsync = promisify(execFile)

interface InstalledIdentity {
  sourcePath: string
  bundleIds: Set<string>
  names: Set<string>
  tokens: Set<string>
}

interface ArtifactIdentity {
  bundleId: string | null
  canonicalName: string
  displayName: string
  tokens: Set<string>
  strong: boolean
}

interface PendingGroup {
  identity: ArtifactIdentity
  systemLevel: boolean
  artifacts: LeftoverArtifact[]
  evidence: Set<string>
}

interface InventoryResult {
  identities: InstalledIdentity[]
  complete: boolean
  inaccessiblePaths: string[]
}

interface InventoryAudit {
  inaccessiblePaths: Set<string>
  timedOut: boolean
}

function recordInventoryReadFailure(directory: string, error: unknown, audit: InventoryAudit): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') audit.inaccessiblePaths.add(directory)
}

const GENERIC_TOKENS = new Set([
  'app', 'application', 'applications', 'support', 'cache', 'caches', 'data', 'group',
  'container', 'containers', 'helper', 'agent', 'daemon', 'service', 'services',
  'launcher', 'login', 'state', 'saved', 'preferences', 'preference', 'webkit',
  'http', 'storage', 'storages', 'script', 'scripts', 'update', 'updater', 'crash',
  'software', 'company', 'corporation', 'localized', 'default', 'store', 'prod',
  'database', 'databases', 'authorization', 'computer', 'plugin', 'crashpad',
  'chrome', 'frontend', 'swift',
])

const SYSTEM_NAMES = new Set([
  'accountsd', 'akd', 'apsd', 'bird', 'cloudd', 'coreaudiod', 'corebluetoothd',
  'coreduetd', 'diagnosticreportingservice', 'findmydevice', 'finder', 'launchservices',
  'loginwindow', 'notificationcenter', 'rapportd', 'secd', 'sharingd', 'storeaccountd',
  'storeassetd', 'systemuiserver', 'trustd', 'usernoted', 'webkit', 'animoji',
  'photossearch', 'photosupgrade', 'tvappservices', 'crashreporter',
  'amsdatamigratortool', 'arfilecache', 'baseband', 'btserver', 'callhistorydb',
  'callhistorytransactions', 'coresimulator', 'diagnosticreports', 'knowledge',
  'lsmimagecache', 'mobilesync', 'privacypreservingmeasurement', 'sesstorage',
  'sharedimagecache', 'trickplay',
])

const GENERIC_CANONICAL_NAMES = new Set([
  ...GENERIC_TOKENS,
  'crashreporter', 'backgrounditem', 'loginitem',
])

const IGNORED_ARTIFACT_NAMES = new Set(['.ds_store', '.localized', 'desktop.ini', 'thumbs.db'])
const NON_APP_BUNDLE_IDS = new Set(['com.github.electron', 'com.vercel.cli', 'org.swift.swiftpm'])
const NON_APP_CANONICAL_NAMES = new Set(['electronbuilder', 'msplaywright', 'swiftfrontend', 'typescript'])
const WEAK_NAME_ONLY_LOCATIONS = new Set(['Caches', 'Logs'])
const LEFTOVER_SCAN_BUDGET_MS = 30_000

const APP_ROOTS = [
  '/Applications',
  '/System/Applications',
  '/System/Library/CoreServices',
  path.join(os.homedir(), 'Applications'),
]

const USER_LEFTOVER_LOCATIONS = [
  ['Application Support', path.join(os.homedir(), 'Library', 'Application Support')],
  ['Application Scripts', path.join(os.homedir(), 'Library', 'Application Scripts')],
  ['Caches', path.join(os.homedir(), 'Library', 'Caches')],
  ['Containers', path.join(os.homedir(), 'Library', 'Containers')],
  ['Group Containers', path.join(os.homedir(), 'Library', 'Group Containers')],
  ['HTTP Storages', path.join(os.homedir(), 'Library', 'HTTPStorages')],
  ['Launch Agents', path.join(os.homedir(), 'Library', 'LaunchAgents')],
  ['Logs', path.join(os.homedir(), 'Library', 'Logs')],
  ['Preferences', path.join(os.homedir(), 'Library', 'Preferences')],
  ['Saved Application State', path.join(os.homedir(), 'Library', 'Saved Application State')],
  ['WebKit', path.join(os.homedir(), 'Library', 'WebKit')],
] as const

const SYSTEM_LEFTOVER_LOCATIONS = [
  ['System Application Support', '/Library/Application Support'],
  ['System Launch Agents', '/Library/LaunchAgents'],
  ['System Launch Daemons', '/Library/LaunchDaemons'],
] as const

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

function stripArtifactSuffix(value: string): string {
  return value
    .replace(/-(wal|shm)$/i, '')
    .replace(/\.savedstate$/i, '')
    .replace(/\.(plist|json|sqlite|db|log)$/i, '')
    .replace(/\.app$/i, '')
}

function canonicalName(value: string): string {
  return normalize(stripArtifactSuffix(value)).replace(/[^a-z0-9]+/g, '')
}

function tokens(value: string): Set<string> {
  const result = new Set<string>()
  const separated = stripArtifactSuffix(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  for (const token of normalize(separated).split(/[^a-z0-9]+/)) {
    if (token.length >= 4 && !GENERIC_TOKENS.has(token) && token !== 'com' && token !== 'org' && token !== 'net') {
      result.add(token === 'logitech' ? 'logi' : token)
    }
  }
  return result
}

function normalizeBundleId(value: string): string | null {
  let candidate = normalize(stripArtifactSuffix(value))
  candidate = candidate.replace(/^group\./, '')
  const segments = candidate.split('.')
  if (/^[a-z0-9]{8,12}$/i.test(segments[0]) && /[0-9]/.test(segments[0])) {
    // A Team-ID container such as TEAMID.Office is not itself a bundle ID.
    if (segments.length < 3) return null
    candidate = segments.slice(1).join('.')
  }
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){1,}$/i.test(candidate)) return null
  return candidate
}

function bundleVendor(bundleId: string | null): string | null {
  if (!bundleId) return null
  const segments = bundleId.split('.')
  if (segments.length < 3 || segments[0] === 'homebrew') return null
  const vendor = canonicalName(segments[1])
  return vendor.length >= 3 && !GENERIC_CANONICAL_NAMES.has(vendor) ? vendor : null
}

function isSystemOwned(identity: ArtifactIdentity, discoveredSystemNames: Set<string> = new Set()): boolean {
  if (identity.bundleId?.startsWith('com.apple.')) return true
  if (identity.bundleId?.startsWith('apple.')) return true
  if (identity.bundleId?.startsWith('is.workflow.')) return true
  if (identity.bundleId?.startsWith('org.swift.')) return true
  if (identity.canonicalName.startsWith('comapple')) return true
  if (SYSTEM_NAMES.has(identity.canonicalName)) return true
  if ([...identity.tokens].some((token) => SYSTEM_NAMES.has(token))) return true
  return discoveredSystemNames.has(identity.canonicalName)
}

function isNonApplicationArtifact(name: string, identity: ArtifactIdentity): boolean {
  const normalizedName = normalize(stripArtifactSuffix(name))
  return (identity.bundleId !== null && NON_APP_BUNDLE_IDS.has(identity.bundleId))
    || NON_APP_CANONICAL_NAMES.has(identity.canonicalName)
    || /(?:^|[._-])nodejs(?:$|[._-])/.test(normalizedName)
}

function remainingTimeout(deadline: number, maximumMs: number): number {
  if (!Number.isFinite(deadline)) return maximumMs
  return Math.max(1, Math.min(maximumMs, deadline - Date.now()))
}

async function plistDictionary(plistPath: string, deadline = Number.POSITIVE_INFINITY): Promise<Record<string, unknown> | null> {
  if (Date.now() >= deadline) return null
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', plistPath],
      { timeout: remainingTimeout(deadline, 2000), maxBuffer: 2 * 1024 * 1024 },
    )
    const parsed: unknown = JSON.parse(stdout)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

async function applicationGroups(bundlePath: string, deadline = Number.POSITIVE_INFINITY): Promise<string[]> {
  if (Date.now() >= deadline) return []
  try {
    const { stdout, stderr } = await execFileAsync(
      '/usr/bin/codesign',
      ['-d', '--entitlements', ':-', bundlePath],
      { timeout: remainingTimeout(deadline, 3000), maxBuffer: 2 * 1024 * 1024 },
    )
    const plist = `${stdout}\n${stderr}`
    const section = plist.match(/<key>com\.apple\.security\.application-groups<\/key>\s*<array>([\s\S]*?)<\/array>/i)?.[1]
    if (!section) return []
    return [...section.matchAll(/<string>([\s\S]*?)<\/string>/gi)]
      .map((match) => decodeXmlText(match[1].trim()))
      .filter(Boolean)
  } catch {
    return []
  }
}

async function identityForBundle(bundlePath: string, deadline = Number.POSITIVE_INFINITY): Promise<InstalledIdentity> {
  const plistPath = path.join(bundlePath, 'Contents', 'Info.plist')
  const [info, groups] = await Promise.all([
    plistDictionary(plistPath, deadline),
    applicationGroups(bundlePath, deadline),
  ])
  const values = [
    info?.CFBundleIdentifier,
    info?.CFBundleName,
    info?.CFBundleDisplayName,
    info?.CFBundleExecutable,
  ].map((value) => typeof value === 'string' ? value : null)
  const fallbackName = stripArtifactSuffix(path.basename(bundlePath))
  const bundleIds = new Set<string>()
  const names = new Set<string>([canonicalName(fallbackName)].filter(Boolean))
  const identityTokens = tokens(fallbackName)

  const bundleId = values[0] ? normalizeBundleId(values[0]) : null
  if (bundleId) {
    bundleIds.add(bundleId)
    tokens(bundleId).forEach((token) => identityTokens.add(token))
  }
  for (const group of groups) {
    const groupId = normalizeBundleId(group)
    if (groupId) {
      bundleIds.add(groupId)
      tokens(groupId).forEach((token) => identityTokens.add(token))
    }
  }
  for (const value of values.slice(1)) {
    if (!value) continue
    const name = canonicalName(value)
    if (name) names.add(name)
    tokens(value).forEach((token) => identityTokens.add(token))
  }
  return { sourcePath: bundlePath, bundleIds, names, tokens: identityTokens }
}

async function findBundles(
  root: string,
  maxDepth = 2,
  deadline = Number.POSITIVE_INFINITY,
  audit?: InventoryAudit,
): Promise<string[]> {
  const result: string[] = []
  async function walk(directory: string, depth: number): Promise<void> {
    if (Date.now() >= deadline) {
      if (audit) audit.timedOut = true
      return
    }
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (audit) recordInventoryReadFailure(directory, error, audit)
      return
    }
    for (const entry of entries) {
      if (Date.now() >= deadline) {
        if (audit) audit.timedOut = true
        return
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const itemPath = path.join(directory, entry.name)
      if (
        entry.name.endsWith('.app')
        || entry.name.endsWith('.xpc')
        || entry.name.endsWith('.appex')
        || entry.name.endsWith('.service')
      ) {
        result.push(itemPath)
        continue
      }
      if (entry.isSymbolicLink()) continue
      if (depth < maxDepth) await walk(itemPath, depth + 1)
    }
  }
  await walk(root, 0)
  return result
}

async function mapWithConcurrencyUntil<T, R>(
  values: T[],
  limit: number,
  deadline: number,
  mapper: (value: T) => Promise<R>,
): Promise<{ results: R[]; timedOut: boolean }> {
  const results: R[] = []
  let nextIndex = 0
  let timedOut = false
  async function worker(): Promise<void> {
    while (true) {
      if (Date.now() >= deadline) {
        timedOut = nextIndex < values.length
        return
      }
      const index = nextIndex++
      if (index >= values.length) return
      results.push(await mapper(values[index]))
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()))
  return { results, timedOut }
}

async function installedInventory(deadline: number): Promise<InventoryResult> {
  const audit: InventoryAudit = { inaccessiblePaths: new Set(), timedOut: false }
  const bundlePaths = new Set<string>()
  for (const root of APP_ROOTS) {
    if (Date.now() >= deadline) {
      audit.timedOut = true
      break
    }
    for (const bundlePath of await findBundles(root, 2, deadline, audit)) bundlePaths.add(bundlePath)
  }

  // Embedded helpers and login items are authoritative only when their parent
  // application bundle is present in a trusted install root.
  helperLoop: for (const bundlePath of [...bundlePaths]) {
    for (const relative of [
      'Contents/Frameworks',
      'Contents/Helpers',
      'Contents/Library/LoginItems',
      'Contents/Library/Services',
      'Contents/PlugIns',
      'Contents/XPCServices',
    ]) {
      if (Date.now() >= deadline) {
        audit.timedOut = true
        break helperLoop
      }
      for (const helperPath of await findBundles(path.join(bundlePath, relative), 1, deadline, audit)) bundlePaths.add(helperPath)
    }
  }
  const mapped = await mapWithConcurrencyUntil(
    [...bundlePaths],
    8,
    deadline,
    (bundlePath) => identityForBundle(bundlePath, deadline),
  )
  const identities = mapped.results
  if (mapped.timedOut) audit.timedOut = true
  for (const prefix of ['/opt/homebrew', '/usr/local']) {
    if (Date.now() >= deadline) {
      audit.timedOut = true
      break
    }
    try {
      const casks = await fsp.readdir(path.join(prefix, 'Caskroom'))
      for (const cask of casks) {
        if (Date.now() >= deadline) {
          audit.timedOut = true
          break
        }
        identities.push({
          sourcePath: path.join(prefix, 'Caskroom', cask),
          bundleIds: new Set(),
          names: new Set([canonicalName(cask)]),
          tokens: tokens(cask),
        })
      }
    } catch {
      // Homebrew is optional.
    }
    try {
      await fsp.access(path.join(prefix, 'bin', 'brew'))
      identities.push({
        sourcePath: path.join(prefix, 'bin', 'brew'),
        bundleIds: new Set(),
        names: new Set(['homebrew']),
        tokens: new Set(['homebrew']),
      })
    } catch {
      // The prefix is not a live Homebrew installation.
    }
    try {
      const formulae = await fsp.readdir(path.join(prefix, 'Cellar'))
      for (const formula of formulae) {
        if (Date.now() >= deadline) {
          audit.timedOut = true
          break
        }
        const formulaTokens = tokens(formula)
        formulaTokens.add('homebrew')
        formulaTokens.add('mxcl')
        identities.push({
          sourcePath: path.join(prefix, 'Cellar', formula),
          bundleIds: new Set([`homebrew.mxcl.${normalize(formula)}`]),
          names: new Set([canonicalName(formula)]),
          tokens: formulaTokens,
        })
      }
    } catch {
      // Formulae are optional; Caskroom identities above still remain valid.
    }
  }
  return {
    identities,
    complete: !audit.timedOut && audit.inaccessiblePaths.size === 0,
    inaccessiblePaths: [...audit.inaccessiblePaths],
  }
}

function artifactIdentity(name: string): ArtifactIdentity {
  const stripped = stripArtifactSuffix(name)
  const normalizedBundleId = normalizeBundleId(stripped)
  const rawSegments = stripped.replace(/^group\./i, '').split('.')
  const teamPrefixed = /^[a-z0-9]{8,12}$/i.test(rawSegments[0]) && /[0-9]/.test(rawSegments[0])
  const explicitAppGroup = /^group\./i.test(stripped) || teamPrefixed
  // Ordinary dotted files such as `default.store` are not authoritative bundle
  // identifiers. Require a conventional reverse-DNS shape unless the item is
  // explicitly an app-group/team container.
  const bundleId = normalizedBundleId && (explicitAppGroup || rawSegments.length >= 3)
    ? normalizedBundleId
    : null
  const identitySource = teamPrefixed ? rawSegments.slice(1).join('.') : stripped
  const identityTokens = tokens(identitySource)
  const bundleLeaf = bundleId?.split('.').at(-1) ?? null
  const originalBundleLeaf = bundleId ? identitySource.split('.').at(-1) ?? bundleLeaf : null
  const displayName = originalBundleLeaf
    ? originalBundleLeaf.replace(/([a-z])([A-Z])/g, '$1 $2')
    : identitySource.replace(/[._-]+/g, ' ')
  return {
    bundleId,
    canonicalName: canonicalName(bundleLeaf ?? identitySource),
    displayName: displayName.trim() || stripped,
    tokens: identityTokens,
    strong: bundleId !== null || (canonicalName(identitySource).length >= 4 && identityTokens.size > 0),
  }
}

function installedConflicts(identity: ArtifactIdentity, installed: InstalledIdentity[]): string[] {
  const conflicts = new Set<string>()
  const identityVendor = bundleVendor(identity.bundleId)
  for (const app of installed) {
    const bundleConflict = identity.bundleId && [...app.bundleIds].some((bundleId) =>
      identity.bundleId === bundleId
      || identity.bundleId!.startsWith(`${bundleId}.`)
      || bundleId.startsWith(`${identity.bundleId}.`),
    )
    const nameConflict = identity.canonicalName.length >= 4 && app.names.has(identity.canonicalName)
    const sharedTokens = [...identity.tokens].filter((token) => app.tokens.has(token))
    const exactVendorConflict = identity.tokens.size === 1
      && sharedTokens.length === 1
    // Updaters, launch agents, and shared support tools often use a sibling
    // bundle ID rather than the installed app's exact ID. If any live app from
    // that reverse-DNS vendor remains installed, fail closed and keep its data.
    const bundleVendorConflict = identityVendor !== null
      && [...app.bundleIds].some((bundleId) => bundleVendor(bundleId) === identityVendor)
    if (bundleConflict || bundleVendorConflict || nameConflict || exactVendorConflict || sharedTokens.length >= 2) {
      conflicts.add(app.sourcePath)
    }
  }
  return [...conflicts]
}

async function measureArtifact(itemPath: string, location: string, inaccessible: Set<string>, scanDeadline: number): Promise<LeftoverArtifact> {
  const deadline = Math.min(Date.now() + 5000, scanDeadline)
  // macOS privacy-protected container roots can block a readdir syscall instead
  // of rejecting it promptly when Full Disk Access is unavailable. Keep those
  // measurements shallow and explicitly incomplete so detection remains bounded.
  const shallowDirectoryMeasurement = location === 'Application Scripts' || location.includes('Containers')
  const seen = new Set<string>()
  let complete = true
  let isDir = false

  async function walk(currentPath: string): Promise<number> {
    if (Date.now() > deadline) {
      complete = false
      return 0
    }
    try {
      const stats = await fsp.lstat(currentPath)
      if (currentPath === itemPath) isDir = stats.isDirectory()
      if (stats.isSymbolicLink()) return 0
      const ownBytes = typeof stats.blocks === 'number' ? stats.blocks * 512 : Number(stats.size)
      if (stats.isFile()) {
        const identity = `${stats.dev}:${stats.ino}`
        if (stats.nlink > 1 && seen.has(identity)) return 0
        if (stats.nlink > 1) seen.add(identity)
        return ownBytes
      }
      if (!stats.isDirectory()) return ownBytes
      if (currentPath === itemPath && shallowDirectoryMeasurement) {
        complete = false
        return ownBytes
      }
      let total = ownBytes
      const children = await fsp.readdir(currentPath)
      for (const child of children) {
        if (Date.now() > deadline) {
          complete = false
          break
        }
        total += await walk(path.join(currentPath, child))
      }
      return total
    } catch {
      complete = false
      inaccessible.add(currentPath)
      return 0
    }
  }

  const allocatedBytes = await walk(itemPath)
  return {
    path: itemPath,
    name: path.basename(itemPath),
    location,
    isDir,
    allocatedBytes,
    sizeKB: Math.ceil(allocatedBytes / 1024),
    sizeComplete: complete,
  }
}

function identitiesBelongTogether(a: ArtifactIdentity, b: ArtifactIdentity): boolean {
  if (a.bundleId && b.bundleId && a.bundleId === b.bundleId) return true
  if (a.bundleId && b.bundleId) {
    return a.bundleId.startsWith(`${b.bundleId}.`) || b.bundleId.startsWith(`${a.bundleId}.`)
  }
  const bundleIdentity = a.bundleId ? a : b.bundleId ? b : null
  const namedIdentity = a.bundleId ? b : b.bundleId ? a : null
  if (bundleIdentity?.bundleId && namedIdentity) {
    const segments = bundleIdentity.bundleId.split('.')
    const vendor = bundleVendor(bundleIdentity.bundleId)
    const leaf = canonicalName(segments.at(-1) ?? '')
    const vendorAndLeaf = canonicalName(segments.slice(-2).join(' '))
    if (
      namedIdentity.canonicalName.length >= 4
      && (
        namedIdentity.canonicalName === leaf
        || namedIdentity.canonicalName === vendorAndLeaf
        || namedIdentity.canonicalName === vendor
      )
    ) return true
  }
  const exactNonGenericName = a.canonicalName.length >= 4
    && a.canonicalName === b.canonicalName
    && !GENERIC_CANONICAL_NAMES.has(a.canonicalName)
  if (exactNonGenericName) return true
  const shared = [...a.tokens].filter((token) => b.tokens.has(token))
  return shared.length >= 2
}

function identitiesCanShareGroup(
  a: ArtifactIdentity,
  aSystemLevel: boolean,
  b: ArtifactIdentity,
  bSystemLevel: boolean,
): boolean {
  return aSystemLevel === bSystemLevel && identitiesBelongTogether(a, b)
}

function shouldEmitGroup(identity: ArtifactIdentity, artifacts: LeftoverArtifact[]): boolean {
  if (identity.bundleId) return true
  const locations = new Set(artifacts.map((artifact) => artifact.location))
  if (locations.size >= 2) return true
  return artifacts.some((artifact) => !WEAK_NAME_ONLY_LOCATIONS.has(artifact.location))
}

async function discoverSystemManagedNames(): Promise<Set<string>> {
  const result = new Set<string>()
  for (const directory of ['/System/Library/LaunchAgents', '/System/Library/LaunchDaemons']) {
    try {
      const names = await fsp.readdir(directory)
      for (const name of names) {
        if (!name.toLocaleLowerCase('en-US').startsWith('com.apple.')) continue
        const leaf = stripArtifactSuffix(name).split('.').at(-1)
        if (leaf) result.add(canonicalName(leaf))
      }
    } catch {
      // Static Apple identities still provide a conservative fallback.
    }
  }
  for (const directory of [
    '/System/Library/Frameworks',
    '/System/Library/PrivateFrameworks',
    '/System/Library/CoreServices',
  ]) {
    try {
      const names = await fsp.readdir(directory)
      for (const name of names) {
        const stripped = name.replace(/\.(app|appex|bundle|framework|plugin|service|xpc)$/i, '')
        const canonical = canonicalName(stripped)
        if (canonical.length >= 4) result.add(canonical)
      }
    } catch {
      // The fixed system locations are optional across macOS versions.
    }
  }
  return result
}

function leftoverConfidence(
  identity: ArtifactIdentity,
  distinctLocations: number,
  inventoryComplete: boolean,
  systemLevelOnly = false,
): LeftoverGroup['confidence'] {
  return inventoryComplete && !systemLevelOnly && (identity.bundleId !== null || distinctLocations >= 2)
    ? 'recommended'
    : 'review'
}

export const leftoverTesting = {
  artifactIdentity,
  identitiesCanShareGroup,
  identitiesBelongTogether,
  installedConflicts,
  isSystemOwned,
  isNonApplicationArtifact,
  leftoverConfidence,
  mapWithConcurrencyUntil,
  measureArtifact,
  bundleVendor,
  normalizeBundleId,
  recordInventoryReadFailure,
  shouldEmitGroup,
}

export async function findAppLeftovers(): Promise<LeftoverScanResult> {
  if (process.platform !== 'darwin') return { groups: [], complete: true, inaccessiblePaths: [] }

  const scanDeadline = Date.now() + LEFTOVER_SCAN_BUDGET_MS
  const [inventory, discoveredSystemNames] = await Promise.all([
    installedInventory(scanDeadline),
    discoverSystemManagedNames(),
  ])
  const inaccessible = new Set<string>()
  inventory.inaccessiblePaths.forEach((itemPath) => inaccessible.add(itemPath))
  const pending: PendingGroup[] = []
  let timedOut = Date.now() >= scanDeadline

  locationLoop: for (const [location, directory] of [...USER_LEFTOVER_LOCATIONS, ...SYSTEM_LEFTOVER_LOCATIONS]) {
    if (Date.now() >= scanDeadline) {
      timedOut = true
      break
    }
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') inaccessible.add(directory)
      continue
    }

    for (const entry of entries) {
      if (Date.now() >= scanDeadline) {
        timedOut = true
        break locationLoop
      }
      if (entry.isSymbolicLink() || IGNORED_ARTIFACT_NAMES.has(normalize(entry.name))) continue
      const identity = artifactIdentity(entry.name)
      if (!identity.strong || isSystemOwned(identity, discoveredSystemNames) || isNonApplicationArtifact(entry.name, identity)) continue
      const isSystemLocation = location.startsWith('System ')
      const isLaunchRegistration = location.includes('Launch Agent') || location.includes('Launch Daemon')
      const isOpaqueIdentifier = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.name)
      // A loose file or opaque script directory is not an application identity.
      // Keep launch registrations and structured bundle artifacts, but suppress
      // weak filename-only matches such as cache images, logs, and SQLite files.
      if (isOpaqueIdentifier) continue
      if (entry.name.startsWith('.') && !identity.bundleId) continue
      if (entry.isFile() && !identity.bundleId && !isLaunchRegistration) continue
      if (location === 'Application Scripts' && !identity.bundleId) continue
      if (isSystemLocation && !identity.bundleId) continue
      if (installedConflicts(identity, inventory.identities).length > 0) continue

      const artifact = await measureArtifact(path.join(directory, entry.name), location, inaccessible, scanDeadline)
      if (artifact.allocatedBytes === 0) continue
      if (!artifact.sizeComplete && Date.now() >= scanDeadline) timedOut = true
      // A system-wide support item or launch service must never borrow the
      // confidence of related user-level cache data. Keep it in Review even
      // when both artifacts share an identity.
      let group = pending.find((candidate) => identitiesCanShareGroup(
        candidate.identity,
        candidate.systemLevel,
        identity,
        isSystemLocation,
      ))
      if (!group) {
        group = { identity, systemLevel: isSystemLocation, artifacts: [], evidence: new Set() }
        pending.push(group)
      }
      group.artifacts.push(artifact)
      if (identity.bundleId) group.evidence.add(`Bundle identifier ${identity.bundleId}`)
      group.evidence.add(`${location} artifact`)
    }
  }

  const groups: LeftoverGroup[] = pending.filter((group) => shouldEmitGroup(group.identity, group.artifacts)).map((group) => {
    const artifacts = group.artifacts.sort((a, b) => b.allocatedBytes - a.allocatedBytes)
    const allocatedBytes = artifacts.reduce((total, artifact) => total + artifact.allocatedBytes, 0)
    const distinctLocations = new Set(artifacts.map((artifact) => artifact.location)).size
    const confidence = leftoverConfidence(group.identity, distinctLocations, inventory.complete, group.systemLevel)
    const primary = artifacts[0]
    const baseId = group.identity.bundleId ?? `${group.identity.canonicalName}:${primary.path}`
    const id = group.systemLevel ? `${baseId}:system-review` : baseId
    return {
      id,
      appName: group.identity.displayName,
      bundleId: group.identity.bundleId,
      confidence,
      evidence: [...group.evidence],
      installedConflicts: [],
      allocatedBytes,
      sizeKB: Math.ceil(allocatedBytes / 1024),
      complete: artifacts.every((artifact) => artifact.sizeComplete),
      artifacts,
      path: primary.path,
      name: group.identity.displayName,
      location: artifacts.length === 1 ? primary.location : `${artifacts.length} locations`,
    }
  })

  groups.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'recommended' ? -1 : 1
    return b.allocatedBytes - a.allocatedBytes
  })
  return {
    groups,
    complete: inventory.complete && !timedOut && inaccessible.size === 0 && groups.every((group) => group.complete),
    inaccessiblePaths: [...inaccessible],
  }
}
