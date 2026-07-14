import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type {
  ScanEntryV1,
  SuspiciousEvidence,
  SuspiciousFinding,
} from '../shared/contracts'
import type { AppPlatform } from '../shared/platform'
import { isSameOrDescendantPath, pathComparisonKey } from '../shared/path-utils'

const execFileAsync = promisify(execFile)
const MAX_PLIST_BYTES = 1024 * 1024
const BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/u
const EXECUTABLE_EXTENSIONS = new Set([
  'app', 'bat', 'cmd', 'com', 'command', 'exe', 'js', 'jse', 'msi', 'ps1', 'scr', 'sh', 'vbs',
])
const DECOY_EXTENSIONS = new Set([
  'doc', 'docm', 'docx', 'gif', 'jpeg', 'jpg', 'pdf', 'png', 'ppt', 'pptx', 'rtf', 'txt', 'xls', 'xlsm', 'xlsx', 'zip',
])
const INTERPRETER_NAMES = new Set([
  'bash', 'dash', 'node', 'osascript', 'perl', 'php', 'python', 'python3', 'ruby', 'sh', 'zsh',
])

interface LaunchConfiguration {
  Label?: unknown
  Program?: unknown
  ProgramArguments?: unknown
  RunAtLoad?: unknown
  KeepAlive?: unknown
}

interface TargetProbe {
  exists: boolean
  unsignedExecutable: boolean
}

export interface SuspiciousInspectionResult {
  findings: SuspiciousFinding[]
  complete: boolean
  inaccessiblePaths: string[]
}

function allocatedBytes(stats: Awaited<ReturnType<typeof fsp.lstat>>): number {
  return typeof stats.blocks === 'number' ? stats.blocks * 512 : Number(stats.size)
}

function evidence(
  code: SuspiciousEvidence['code'],
  label: string,
  detail: string | null = null,
): SuspiciousEvidence {
  return { code, label, detail }
}

function findingId(_category: SuspiciousFinding['category'], itemPath: string, platform: AppPlatform): string {
  return `security:${pathComparisonKey(itemPath, platform)}`
}

function extensionParts(name: string): string[] {
  return name.toLocaleLowerCase('en-US').split('.').filter(Boolean)
}

/** High-signal filename camouflage only; ordinary executables are intentionally suppressed. */
export function classifyMasqueradingName(name: string): SuspiciousEvidence[] {
  const parts = extensionParts(name)
  const finalExtension = parts.at(-1) ?? ''
  if (!EXECUTABLE_EXTENSIONS.has(finalExtension)) return []

  const result: SuspiciousEvidence[] = []
  const previousExtension = parts.at(-2) ?? ''
  if (DECOY_EXTENSIONS.has(previousExtension)) {
    result.push(evidence(
      'double-extension',
      'Document-like double extension',
      `The filename ends in .${previousExtension}.${finalExtension}.`,
    ))
  }
  if (BIDI_CONTROL.test(name)) {
    result.push(evidence(
      'bidi-control',
      'Hidden text-direction control',
      'The filename contains an invisible character that can make its extension look different.',
    ))
  }
  return result
}

export function inspectMasqueradingEntry(entry: ScanEntryV1, platform: AppPlatform): SuspiciousFinding | null {
  if (entry.isDir) return null
  const findingEvidence = classifyMasqueradingName(entry.name)
  if (findingEvidence.length === 0) return null

  return {
    id: findingId('masquerading-file', entry.path, platform),
    path: entry.path,
    name: entry.name,
    isDir: false,
    allocatedBytes: entry.allocatedBytes,
    sizeKB: entry.sizeKB,
    category: 'masquerading-file',
    risk: 'elevated',
    summary: 'This executable filename may be trying to look like a document or hide its real extension.',
    evidence: findingEvidence,
    targetPath: null,
    recommendedAction: 'Reveal the file and verify its origin before opening or deleting it.',
  }
}

export function getSuspiciousPersistenceRoots(
  platform: AppPlatform,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'windows') {
    const appData = environment.APPDATA ?? path.win32.join(homeDirectory, 'AppData', 'Roaming')
    const programData = environment.ProgramData ?? environment.PROGRAMDATA ?? 'C:\\ProgramData'
    return [
      path.win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
      path.win32.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    ]
  }
  return [
    path.posix.join(homeDirectory, 'Library', 'LaunchAgents'),
    '/Library/LaunchAgents',
    '/Library/LaunchDaemons',
  ]
}

function isAppleLaunchItem(itemPath: string, config: LaunchConfiguration): boolean {
  const label = typeof config.Label === 'string' ? config.Label.toLocaleLowerCase('en-US') : ''
  const filename = path.posix.basename(itemPath).toLocaleLowerCase('en-US')
  return label.startsWith('com.apple.')
    || filename.startsWith('com.apple.')
    || label === 'com.patricio.nerion'
    || filename === 'com.patricio.nerion.plist'
}

function expandHome(value: string, homeDirectory: string, platform: AppPlatform): string {
  if (value === '~') return homeDirectory
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    const pathApi = platform === 'windows' ? path.win32 : path.posix
    return pathApi.join(homeDirectory, value.slice(2))
  }
  return value
}

export function extractLaunchTarget(
  config: LaunchConfiguration,
  homeDirectory: string,
  platform: AppPlatform = 'macos',
): string | null {
  const args = Array.isArray(config.ProgramArguments)
    ? config.ProgramArguments.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
  const program = typeof config.Program === 'string' && config.Program.length > 0 ? config.Program : args[0]
  if (!program) return null

  const pathApi = platform === 'windows' ? path.win32 : path.posix
  const expandedProgram = expandHome(program, homeDirectory, platform)
  if (!INTERPRETER_NAMES.has(pathApi.basename(expandedProgram).toLocaleLowerCase('en-US'))) return expandedProgram

  const payload = args.slice(args[0] === program ? 1 : 0).find((argument) => {
    if (argument.startsWith('-')) return false
    const expanded = expandHome(argument, homeDirectory, platform)
    return pathApi.isAbsolute(expanded) || argument.startsWith('~')
  })
  return payload ? expandHome(payload, homeDirectory, platform) : expandedProgram
}

export function isRiskyPersistenceTarget(targetPath: string, homeDirectory: string, platform: AppPlatform): boolean {
  const candidates = platform === 'windows'
    ? [
        path.win32.join(homeDirectory, 'Desktop'),
        path.win32.join(homeDirectory, 'Downloads'),
        path.win32.join(homeDirectory, 'AppData', 'Local', 'Temp'),
      ]
    : [
        path.posix.join(homeDirectory, 'Desktop'),
        path.posix.join(homeDirectory, 'Downloads'),
        path.posix.join(homeDirectory, '.Trash'),
        path.posix.join(homeDirectory, 'Library', 'Caches'),
        '/private/tmp',
        '/tmp',
      ]
  return candidates.some((candidate) => isSameOrDescendantPath(targetPath, candidate, platform))
}

function keepAliveEnabled(value: unknown): boolean {
  if (value === true) return true
  if (!value || typeof value !== 'object') return false
  return Object.keys(value as Record<string, unknown>).length > 0
}

function isMachOHeader(header: Buffer): boolean {
  if (header.length < 4) return false
  const magic = header.subarray(0, 4).toString('hex')
  return new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca']).has(magic)
}

async function probeMacTarget(targetPath: string): Promise<TargetProbe> {
  try {
    const stats = await fsp.lstat(targetPath)
    if (!stats.isFile()) return { exists: true, unsignedExecutable: false }
    const handle = await fsp.open(targetPath, 'r')
    let header: Buffer
    try {
      header = Buffer.alloc(4)
      await handle.read(header, 0, 4, 0)
    } finally {
      await handle.close()
    }
    if (!isMachOHeader(header)) return { exists: true, unsignedExecutable: false }
    try {
      await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', targetPath], { timeout: 2000 })
      return { exists: true, unsignedExecutable: false }
    } catch {
      return { exists: true, unsignedExecutable: true }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, unsignedExecutable: false }
    throw error
  }
}

async function readLaunchConfiguration(itemPath: string): Promise<LaunchConfiguration> {
  const { stdout } = await execFileAsync(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', itemPath],
    { timeout: 2000, maxBuffer: MAX_PLIST_BYTES * 2 },
  )
  const parsed: unknown = JSON.parse(stdout)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The property list is not a dictionary.')
  return parsed as LaunchConfiguration
}

export async function classifyLaunchConfiguration(
  item: Pick<ScanEntryV1, 'path' | 'name' | 'allocatedBytes' | 'sizeKB'>,
  config: LaunchConfiguration,
  homeDirectory: string,
  targetProbe: (targetPath: string) => Promise<TargetProbe> = probeMacTarget,
): Promise<SuspiciousFinding | null> {
  if (isAppleLaunchItem(item.path, config)) return null

  const findingEvidence: SuspiciousEvidence[] = [
    evidence('startup-location', 'Background startup registration', 'This property list can start a process when you sign in or when macOS starts.'),
  ]
  if (config.RunAtLoad === true || keepAliveEnabled(config.KeepAlive)) {
    findingEvidence.push(evidence('autorun', 'Configured to run automatically'))
  }

  const targetPath = extractLaunchTarget(config, homeDirectory)
  let risk: SuspiciousFinding['risk'] = 'review'
  if (!targetPath) {
    findingEvidence.push(evidence('invalid-config', 'No executable target could be identified'))
  } else if (!path.posix.isAbsolute(targetPath)) {
    findingEvidence.push(evidence('invalid-config', 'Startup target is not an absolute path', targetPath))
  } else {
    if (isRiskyPersistenceTarget(targetPath, homeDirectory, 'macos')) {
      risk = 'elevated'
      findingEvidence.push(evidence('risky-target', 'Starts from a user-writable temporary location', targetPath))
    }
    const probe = await targetProbe(targetPath)
    if (!probe.exists) {
      risk = 'elevated'
      findingEvidence.push(evidence('missing-target', 'Startup target is missing', targetPath))
    } else if (probe.unsignedExecutable) {
      risk = 'elevated'
      findingEvidence.push(evidence('unsigned-target', 'Executable target has no valid code signature', targetPath))
    }
  }

  return {
    id: findingId('background-item', item.path, 'macos'),
    path: item.path,
    name: typeof config.Label === 'string' && config.Label.length > 0 ? config.Label : item.name.replace(/\.plist$/i, ''),
    isDir: false,
    allocatedBytes: item.allocatedBytes,
    sizeKB: item.sizeKB,
    category: 'background-item',
    risk,
    summary: risk === 'elevated'
      ? 'This background registration has a detail that deserves closer review.'
      : 'This non-Apple item is registered to run in the background.',
    evidence: findingEvidence,
    targetPath,
    recommendedAction: 'Confirm you recognize this item. Removing its startup file prevents future launches but does not stop a process that is already running.',
  }
}

function unreadableLaunchFinding(
  itemPath: string,
  name: string,
  bytes: number,
  detail: string,
  risk: SuspiciousFinding['risk'] = 'review',
): SuspiciousFinding {
  return {
    id: findingId('background-item', itemPath, 'macos'),
    path: itemPath,
    name: name.replace(/\.plist$/i, ''),
    isDir: false,
    allocatedBytes: bytes,
    sizeKB: Math.ceil(bytes / 1024),
    category: 'background-item',
    risk,
    summary: 'This startup configuration could not be fully inspected and may be stale or malformed.',
    evidence: [
      evidence('startup-location', 'Background startup registration'),
      evidence('invalid-config', detail),
    ],
    targetPath: null,
    recommendedAction: 'Reveal the file and confirm which installed app created it before making changes.',
  }
}

async function inspectMacPersistenceRoot(rootPath: string, homeDirectory: string): Promise<SuspiciousInspectionResult> {
  const findings: SuspiciousFinding[] = []
  const inaccessiblePaths: string[] = []
  try {
    const entries = await fsp.readdir(rootPath, { withFileTypes: true })
    for (const entry of entries) {
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.toLocaleLowerCase('en-US').endsWith('.plist')) continue
      const itemPath = path.posix.join(rootPath, entry.name)
      try {
        const stats = await fsp.lstat(itemPath)
        const bytes = allocatedBytes(stats)
        if (stats.isSymbolicLink()) {
          let linkDetail = 'Symbolic startup configuration was not followed across a filesystem boundary'
          try {
            linkDetail += `: ${await fsp.readlink(itemPath)}`
          } catch {
            // The lstat succeeded, so keep the registration visible even if readlink races or fails.
          }
          findings.push(unreadableLaunchFinding(itemPath, entry.name, bytes, linkDetail))
          continue
        }
        if (stats.size > MAX_PLIST_BYTES) {
          findings.push(unreadableLaunchFinding(
            itemPath,
            entry.name,
            bytes,
            'Configuration exceeds the safe local inspection size limit',
          ))
          continue
        }
        const item = {
          path: itemPath,
          name: entry.name,
          allocatedBytes: bytes,
          sizeKB: Math.ceil(bytes / 1024),
        }
        try {
          const finding = await classifyLaunchConfiguration(item, await readLaunchConfiguration(itemPath), homeDirectory)
          if (finding) findings.push(finding)
        } catch {
          if (!entry.name.toLocaleLowerCase('en-US').startsWith('com.apple.')) {
            findings.push(unreadableLaunchFinding(itemPath, entry.name, item.allocatedBytes, 'Configuration could not be parsed'))
          }
        }
      } catch {
        inaccessiblePaths.push(itemPath)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') inaccessiblePaths.push(rootPath)
  }
  return { findings, complete: inaccessiblePaths.length === 0, inaccessiblePaths }
}

async function inspectWindowsStartupRoot(rootPath: string): Promise<SuspiciousInspectionResult> {
  const findings: SuspiciousFinding[] = []
  const inaccessiblePaths: string[] = []
  try {
    const entries = await fsp.readdir(rootPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const itemPath = path.win32.join(rootPath, entry.name)
      try {
        const stats = await fsp.lstat(itemPath)
        const nameEvidence = classifyMasqueradingName(entry.name)
        findings.push({
          id: findingId('background-item', itemPath, 'windows'),
          path: itemPath,
          name: entry.name,
          isDir: false,
          allocatedBytes: allocatedBytes(stats),
          sizeKB: Math.ceil(allocatedBytes(stats) / 1024),
          category: 'background-item',
          risk: nameEvidence.length > 0 ? 'elevated' : 'review',
          summary: nameEvidence.length > 0
            ? 'This startup item has a filename that deserves closer review.'
            : 'This file is registered to run when the user signs in.',
          evidence: [
            evidence('startup-location', 'Windows Startup folder item'),
            ...nameEvidence,
          ],
          targetPath: null,
          recommendedAction: 'Confirm you recognize this startup item. Removing it prevents future launches but does not stop a process that is already running.',
        })
      } catch {
        inaccessiblePaths.push(itemPath)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') inaccessiblePaths.push(rootPath)
  }
  return { findings, complete: inaccessiblePaths.length === 0, inaccessiblePaths }
}

export const suspiciousTesting = {
  inspectMacPersistenceRoot,
}

export async function inspectSuspiciousPersistence(
  platform: AppPlatform,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SuspiciousInspectionResult> {
  const results = await Promise.all(getSuspiciousPersistenceRoots(platform, homeDirectory, environment).map((rootPath) => (
    platform === 'macos' ? inspectMacPersistenceRoot(rootPath, homeDirectory) : inspectWindowsStartupRoot(rootPath)
  )))
  const findings = new Map<string, SuspiciousFinding>()
  for (const result of results) {
    for (const finding of result.findings) findings.set(finding.id, finding)
  }
  return {
    findings: [...findings.values()],
    complete: results.every((result) => result.complete),
    inaccessiblePaths: results.flatMap((result) => result.inaccessiblePaths),
  }
}
