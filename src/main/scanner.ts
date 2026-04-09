import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import * as path from 'node:path'
import { is } from '@electron-toolkit/utils'

export interface DiskEntry {
  name: string
  path: string
  sizeKB: number
  isDir: boolean
}

function getScannerBinaryPath(): string | null {
  const candidates = [
    is.dev
      ? path.join(process.cwd(), 'resources', 'scanner-bin')
      : path.join(process.resourcesPath, 'scanner-bin')
  ]
  for (const p of candidates) {
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      // not found or not executable
    }
  }
  return null
}

// Parse Swift binary output: "<sizeBytes>\t<d|f>\t<path>"
function parseSwiftLine(line: string, rootPath: string): DiskEntry | null {
  const t1 = line.indexOf('\t')
  if (t1 === -1) return null
  const t2 = line.indexOf('\t', t1 + 1)
  if (t2 === -1) return null

  const sizeBytes = parseInt(line.slice(0, t1), 10)
  const isDir = line[t1 + 1] === 'd'
  const fullPath = line.slice(t2 + 1)

  if (!fullPath || isNaN(sizeBytes)) return null
  // Skip the root itself
  if (fullPath === rootPath) return null

  return {
    name: path.basename(fullPath),
    path: fullPath,
    sizeKB: Math.round(sizeBytes / 1024),
    isDir
  }
}

// Parse du fallback output: "<sizeKB>\t<path>" (directories only, full tree)
function parseDuLine(line: string, rootPath: string): DiskEntry | null {
  const tabIndex = line.indexOf('\t')
  if (tabIndex === -1) return null

  const sizeKB = parseInt(line.slice(0, tabIndex).trim(), 10)
  const fullPath = line.slice(tabIndex + 1).trim()

  if (!fullPath || isNaN(sizeKB)) return null
  if (fullPath === rootPath) return null

  return {
    name: path.basename(fullPath),
    path: fullPath,
    sizeKB,
    isDir: true // du only outputs directories
  }
}

function spawnSwift(
  binary: string,
  dirPath: string,
  onEntry: (entry: DiskEntry) => void,
  onDone: (error?: string) => void
): () => void {
  const proc = spawn(binary, [dirPath], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  let buffer = ''
  let cancelled = false

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      const entry = parseSwiftLine(line, dirPath)
      if (!cancelled && entry) onEntry(entry)
    }
  })

  proc.on('close', () => {
    if (buffer.trim()) {
      const entry = parseSwiftLine(buffer.trim(), dirPath)
      if (!cancelled && entry) onEntry(entry)
    }
    if (!cancelled) onDone()
  })

  proc.on('error', (err) => {
    if (!cancelled) onDone(err.message)
  })

  return () => {
    cancelled = true
    proc.kill()
  }
}

function spawnDuFallback(
  dirPath: string,
  onEntry: (entry: DiskEntry) => void,
  onDone: (error?: string) => void
): () => void {
  // Full recursive scan — no depth limit, directories only
  const proc = spawn('du', ['-k', dirPath], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  let buffer = ''
  let cancelled = false

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const entry = parseDuLine(line, dirPath)
      if (!cancelled && entry) onEntry(entry)
    }
  })

  proc.on('close', () => {
    if (buffer.trim()) {
      const entry = parseDuLine(buffer.trim(), dirPath)
      if (!cancelled && entry) onEntry(entry)
    }
    if (!cancelled) onDone()
  })

  proc.on('error', (err) => {
    if (!cancelled) onDone(err.message)
  })

  return () => {
    cancelled = true
    proc.kill()
  }
}

export function scanDirectoryStreaming(
  dirPath: string,
  onEntry: (entry: DiskEntry) => void,
  onDone: (error?: string) => void
): () => void {
  const binary = getScannerBinaryPath()
  if (binary) {
    return spawnSwift(binary, dirPath, onEntry, onDone)
  }
  return spawnDuFallback(dirPath, onEntry, onDone)
}
