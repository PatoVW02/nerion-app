import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { SCAN_PROTOCOL_VERSION, type ScanEntryV1, type ScanEventV1, type ScanIssue, type ScanIssueV1, type ScanSummaryV1 } from '../shared/contracts'
import { getAppPlatform, resolveScannerBinaryPath } from './platform'

export type DiskEntry = ScanEntryV1

export interface ScanOptions {
  scanId: string
  rootId: string
  lowPriority?: boolean
}

export interface ScanCompletion {
  summary: ScanSummaryV1
}

function summary(options: ScanOptions, values: Partial<ScanSummaryV1> = {}): ScanSummaryV1 {
  return {
    protocolVersion: SCAN_PROTOCOL_VERSION,
    event: 'summary',
    scanId: options.scanId,
    rootId: options.rootId,
    complete: values.complete ?? true,
    cancelled: values.cancelled ?? false,
    entryCount: values.entryCount ?? 0,
    issueCount: values.issueCount ?? 0,
    rootsCompleted: 1,
    rootsRequested: 1,
    fatalError: values.fatalError ?? null,
    securityAnalysis: values.securityAnalysis ?? 'disabled',
    suspiciousCount: values.suspiciousCount ?? 0,
  }
}

function issueEvent(options: ScanOptions, issue: ScanIssue): ScanIssueV1 {
  return {
    protocolVersion: SCAN_PROTOCOL_VERSION,
    event: 'issue',
    scanId: options.scanId,
    rootId: options.rootId,
    issue,
  }
}

function parseNativeEvent(line: string, options: ScanOptions): ScanEventV1 | null {
  try {
    const value = JSON.parse(line) as Partial<ScanEventV1> & Record<string, unknown>
    if (value.protocolVersion !== SCAN_PROTOCOL_VERSION) return null
    if (value.scanId !== options.scanId || value.rootId !== options.rootId) return null

    if (value.event === 'entry') {
      const fullPath = value.path
      const allocatedBytes = value.allocatedBytes
      if (typeof fullPath !== 'string' || typeof allocatedBytes !== 'number' || typeof value.isDir !== 'boolean') return null
      return {
        protocolVersion: SCAN_PROTOCOL_VERSION,
        event: 'entry',
        scanId: options.scanId,
        rootId: options.rootId,
        name: path.basename(fullPath),
        path: fullPath,
        allocatedBytes: Math.max(0, allocatedBytes),
        sizeKB: Math.ceil(Math.max(0, allocatedBytes) / 1024),
        isDir: value.isDir,
        device: typeof value.device === 'string' ? value.device : null,
        inode: typeof value.inode === 'string' ? value.inode : null,
        hardlinkDuplicate: value.hardlinkDuplicate === true,
      }
    }

    if (value.event === 'issue' && value.issue && typeof value.issue === 'object') {
      const issue = value.issue as Partial<ScanIssue>
      if (typeof issue.path !== 'string' || typeof issue.message !== 'string' || typeof issue.code !== 'string') return null
      return issueEvent(options, {
        path: issue.path,
        code: issue.code as ScanIssue['code'],
        message: issue.message,
      })
    }

    if (value.event === 'summary') {
      return summary(options, {
        complete: value.complete === true,
        cancelled: value.cancelled === true,
        entryCount: typeof value.entryCount === 'number' ? value.entryCount : 0,
        issueCount: typeof value.issueCount === 'number' ? value.issueCount : 0,
        fatalError: typeof value.fatalError === 'string' ? value.fatalError : null,
      })
    }
  } catch {
    return null
  }
  return null
}

function spawnNativeScanner(
  binary: string,
  dirPath: string,
  options: ScanOptions,
  onEvent: (event: ScanEventV1) => void,
  onDone: (completion: ScanCompletion) => void,
): () => void {
  const scannerPath = getAppPlatform() === 'windows' ? dirPath.replace(/\//g, '\\') : dirPath
  const lowPriority = options.lowPriority === true && getAppPlatform() !== 'windows'
  const command = lowPriority ? 'nice' : binary
  const args = lowPriority
    ? ['-n', '10', binary, scannerPath, options.scanId, options.rootId]
    : [scannerPath, options.scanId, options.rootId]
  const process = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let buffer = ''
  let stderr = ''
  let cancelled = false
  let emittedEntries = 0
  let emittedIssues = 0
  let scannerSummary: ScanSummaryV1 | null = null
  let finished = false
  const finish = (completion: ScanCompletion) => {
    if (finished) return
    finished = true
    onDone(completion)
  }

  const consume = (line: string) => {
    if (!line) return
    const event = parseNativeEvent(line, options)
    if (!event) {
      emittedIssues += 1
      onEvent(issueEvent(options, {
        path: scannerPath,
        code: 'invalid-event',
        message: 'The native scanner emitted an invalid protocol event.',
      }))
      return
    }
    if (event.event === 'summary') scannerSummary = event
    else {
      if (event.event === 'entry') emittedEntries += 1
      else emittedIssues += 1
      onEvent(event)
    }
  }

  process.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consume(line.replace(/\r$/, ''))
  })
  process.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

  process.on('close', (code) => {
    if (buffer) consume(buffer.replace(/\r$/, ''))
    if (cancelled) {
      finish({ summary: summary(options, { complete: false, cancelled: true, entryCount: emittedEntries, issueCount: emittedIssues }) })
      return
    }
    const fatalError = code && code !== 0 ? (stderr.trim() || `Scanner exited with code ${code}`) : null
    const missingSummary = scannerSummary === null ? 'Scanner exited without a terminal protocol summary.' : null
    const issueCount = Math.max(emittedIssues, scannerSummary?.issueCount ?? 0)
    finish({
      summary: summary(options, {
        complete: fatalError === null && missingSummary === null && scannerSummary?.complete === true && issueCount === 0,
        entryCount: emittedEntries,
        issueCount,
        fatalError: fatalError ?? missingSummary,
      }),
    })
  })
  process.on('error', (error) => {
    if (!cancelled) finish({ summary: summary(options, { complete: false, fatalError: error.message }) })
  })

  return () => {
    cancelled = true
    process.kill()
  }
}

function spawnNodeFallback(
  dirPath: string,
  options: ScanOptions,
  onEvent: (event: ScanEventV1) => void,
  onDone: (completion: ScanCompletion) => void,
): () => void {
  let cancelled = false
  let entryCount = 0
  let issueCount = 0
  const seenHardlinks = new Set<string>()

  const emitIssue = (itemPath: string, code: ScanIssue['code'], message: string) => {
    issueCount += 1
    onEvent(issueEvent(options, { path: itemPath, code, message }))
  }

  const reportIssue = (itemPath: string, error: unknown) => {
    const nodeError = error as NodeJS.ErrnoException
    const code: ScanIssue['code'] = nodeError.code === 'EACCES' || nodeError.code === 'EPERM'
      ? 'permission-denied'
      : nodeError.code === 'ENOENT' ? 'not-found' : 'io-error'
    emitIssue(itemPath, code, nodeError.message ?? String(error))
  }

  const allocatedBytes = (stats: Awaited<ReturnType<typeof fsp.lstat>>): number => {
    return typeof stats.blocks === 'number' ? stats.blocks * 512 : Number(stats.size)
  }

  const emitEntry = (itemPath: string, bytes: number, isDir: boolean, stats: Awaited<ReturnType<typeof fsp.lstat>>, duplicate = false) => {
    entryCount += 1
    onEvent({
      protocolVersion: SCAN_PROTOCOL_VERSION,
      event: 'entry',
      scanId: options.scanId,
      rootId: options.rootId,
      name: path.basename(itemPath),
      path: itemPath,
      allocatedBytes: bytes,
      sizeKB: Math.ceil(bytes / 1024),
      isDir,
      device: Number.isFinite(stats.dev) ? String(stats.dev) : null,
      inode: Number.isFinite(stats.ino) ? String(stats.ino) : null,
      hardlinkDuplicate: duplicate,
    })
  }

  async function walk(directory: string): Promise<number> {
    if (cancelled) return 0
    let directoryStats: Awaited<ReturnType<typeof fsp.lstat>>
    let entries: Buffer[]
    try {
      directoryStats = await fsp.lstat(directory)
      entries = await fsp.readdir(directory, { encoding: 'buffer' })
    } catch (error) {
      reportIssue(directory, error)
      return 0
    }

    let total = allocatedBytes(directoryStats)
    for (const nativeName of entries) {
      if (cancelled) break
      const name = decodeExactUtf8Name(nativeName)
      if (name === null) {
        emitIssue(
          directory,
          'non_utf8_path',
          'Skipped an entry whose name is not valid UTF-8 and cannot be represented safely.',
        )
        continue
      }
      const childPath = path.join(directory, name)
      try {
        const stats = await fsp.lstat(childPath)
        if (stats.isSymbolicLink()) continue
        if (stats.isDirectory()) {
          const bytes = await walk(childPath)
          total += bytes
          if (!cancelled) emitEntry(childPath, bytes, true, stats)
        } else if (stats.isFile()) {
          const identity = `${stats.dev}:${stats.ino}`
          const duplicate = stats.nlink > 1 && seenHardlinks.has(identity)
          if (!duplicate && stats.nlink > 1) seenHardlinks.add(identity)
          const bytes = duplicate ? 0 : allocatedBytes(stats)
          total += bytes
          if (!cancelled) emitEntry(childPath, bytes, false, stats, duplicate)
        }
      } catch (error) {
        reportIssue(childPath, error)
      }
    }
    return total
  }

  void (async () => {
    try {
      const rootStats = await fsp.lstat(dirPath)
      if (!rootStats.isDirectory()) {
        onDone({ summary: summary(options, { complete: false, fatalError: 'Scan root is not a directory' }) })
        return
      }
      await walk(dirPath)
      onDone({ summary: summary(options, {
        complete: !cancelled && issueCount === 0,
        cancelled,
        entryCount,
        issueCount,
      }) })
    } catch (error) {
      onDone({ summary: summary(options, { complete: false, fatalError: (error as Error).message }) })
    }
  })()

  return () => { cancelled = true }
}

function decodeExactUtf8Name(nativeName: Buffer): string | null {
  const decoded = nativeName.toString('utf8')
  return Buffer.from(decoded, 'utf8').equals(nativeName) ? decoded : null
}

export const scannerTesting = {
  decodeExactUtf8Name,
  parseNativeEvent,
  spawnNodeFallback,
}

export function scanDirectoryStreaming(
  dirPath: string,
  options: ScanOptions,
  onEvent: (event: ScanEventV1) => void,
  onDone: (completion: ScanCompletion) => void,
): () => void {
  const binary = resolveScannerBinaryPath()
  if (binary) return spawnNativeScanner(binary, dirPath, options, onEvent, onDone)
  return spawnNodeFallback(dirPath, options, onEvent, onDone)
}
