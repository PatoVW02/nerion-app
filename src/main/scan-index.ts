import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createReadStream, createWriteStream, watch as watchFileSystem, type FSWatcher } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import * as path from 'node:path'
import type { AppPlatform } from '../shared/platform'
import { isSameOrDescendantPath, pathComparisonKey } from '../shared/path-utils'
import type { ScanEntryV1 } from '../shared/contracts'

const INDEX_VERSION = 1
const MAX_INDEX_ENTRIES = 250_000
const MAX_INDEX_BYTES = 192 * 1024 * 1024
const MAX_RESIDENT_ENTRIES = 350_000
const MAX_INDEX_DIRECTORY_BYTES = 512 * 1024 * 1024
const MAX_INDEX_FILES = 16
const WATCH_VALIDATION_TIMEOUT_MS = 3_000
const requireFromMain = createRequire(__filename)

interface StoredHeader {
  type: 'header'
  version: typeof INDEX_VERSION
  root: string
  createdAt: number
  journalId: string | null
}

interface StoredEntry {
  type: 'entry'
  name: string
  path: string
  allocatedBytes: number
  sizeKB: number
  isDir: boolean
  device: string | null
  inode: string | null
  hardlinkDuplicate: boolean
}

interface StoredFooter {
  type: 'footer'
  entryCount: number
}

interface FSEventsModule {
  watch: (root: string, since: number, handler: (eventPath: string, flags: number, id: string) => void) => () => Promise<void>
  constants: {
    HistoryDone: number
    MustScanSubDirs: number
    UserDropped: number
    KernelDropped: number
    EventIdsWrapped: number
    RootChanged: number
  }
}

interface RootIndex {
  root: string
  entries: ScanEntryV1[]
  journalId: string | null
  trusted: boolean
  dirty: boolean
  lastUsedAt: number
  stopWatcher: (() => void | Promise<void>) | null
  validation: Promise<void> | null
  resolveValidation: (() => void) | null
  validationTimer: ReturnType<typeof setTimeout> | null
}

export interface ScanMutationGuard {
  isStable: () => boolean
  dispose: () => void
}

let indexDirectory: string | null = null
let configuredPlatform: AppPlatform = process.platform === 'win32' ? 'windows' : 'macos'
let watchersEnabled = true
const indexes = new Map<string, RootIndex>()
const pendingLoads = new Map<string, Promise<RootIndex | null>>()
const pendingPersistence = new Set<RootIndex>()
let persistenceTimer: ReturnType<typeof setTimeout> | null = null

function normalizedRoot(root: string): string {
  return path.resolve(root)
}

function rootKey(root: string): string {
  return pathComparisonKey(normalizedRoot(root), configuredPlatform)
}

function indexFilePath(root: string): string | null {
  if (!indexDirectory) return null
  const hash = createHash('sha256').update(`${configuredPlatform}\0${normalizedRoot(root)}`).digest('hex')
  return path.join(indexDirectory, `${hash}.jsonl`)
}

function toStoredEntry(entry: ScanEntryV1): StoredEntry {
  return {
    type: 'entry',
    name: entry.name,
    path: entry.path,
    allocatedBytes: entry.allocatedBytes,
    sizeKB: entry.sizeKB,
    isDir: entry.isDir,
    device: entry.device,
    inode: entry.inode,
    hardlinkDuplicate: entry.hardlinkDuplicate,
  }
}

function isStoredHeader(value: unknown, expectedRoot: string): value is StoredHeader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<StoredHeader>
  return item.type === 'header'
    && item.version === INDEX_VERSION
    && item.root === expectedRoot
    && typeof item.createdAt === 'number'
    && Number.isFinite(item.createdAt)
    && (item.journalId === null || typeof item.journalId === 'string')
}

function isStoredEntry(value: unknown, root: string): value is StoredEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<StoredEntry>
  return item.type === 'entry'
    && typeof item.name === 'string'
    && typeof item.path === 'string'
    && isSameOrDescendantPath(item.path, root, configuredPlatform)
    && item.path !== root
    && typeof item.allocatedBytes === 'number'
    && Number.isFinite(item.allocatedBytes)
    && item.allocatedBytes >= 0
    && typeof item.sizeKB === 'number'
    && Number.isFinite(item.sizeKB)
    && item.sizeKB >= 0
    && typeof item.isDir === 'boolean'
    && (item.device === null || typeof item.device === 'string')
    && (item.inode === null || typeof item.inode === 'string')
    && typeof item.hardlinkDuplicate === 'boolean'
}

function isStoredFooter(value: unknown, expectedCount: number): value is StoredFooter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<StoredFooter>
  return item.type === 'footer' && item.entryCount === expectedCount
}

function finishValidation(index: RootIndex): void {
  if (index.validationTimer) clearTimeout(index.validationTimer)
  index.validationTimer = null
  index.resolveValidation?.()
  index.resolveValidation = null
}

function stopIndexWatcher(index: RootIndex): void {
  finishValidation(index)
  const stop = index.stopWatcher
  index.stopWatcher = null
  if (stop) void Promise.resolve(stop()).catch(() => {})
}

function markIndexDirty(index: RootIndex): void {
  index.dirty = true
  index.trusted = false
}

async function installFSEventsWatcher(index: RootIndex): Promise<boolean> {
  if (configuredPlatform !== 'macos' || !index.journalId || !watchersEnabled) return false
  const since = Number(index.journalId)
  if (!Number.isSafeInteger(since) || since < 0) return false

  try {
    // Keep the macOS-only optional dependency external so Windows builds can
    // omit it entirely while packaged Macs load the signed universal binary.
    const fsevents = requireFromMain('fsevents') as FSEventsModule
    const invalidationFlags = fsevents.constants.MustScanSubDirs
      | fsevents.constants.UserDropped
      | fsevents.constants.KernelDropped
      | fsevents.constants.EventIdsWrapped
      | fsevents.constants.RootChanged

    index.validation = new Promise<void>((resolve) => { index.resolveValidation = resolve })
    index.validationTimer = setTimeout(() => {
      markIndexDirty(index)
      finishValidation(index)
    }, WATCH_VALIDATION_TIMEOUT_MS)

    const stop = fsevents.watch(index.root, since, (_eventPath, flags) => {
      if (flags & invalidationFlags) markIndexDirty(index)
      else if (!(flags & fsevents.constants.HistoryDone)) markIndexDirty(index)

      if (flags & fsevents.constants.HistoryDone) {
        index.trusted = !index.dirty
        finishValidation(index)
      }
    })
    index.stopWatcher = stop
    return true
  } catch {
    finishValidation(index)
    return false
  }
}

function installSessionWatcher(index: RootIndex, trustCurrentBaseline: boolean): void {
  if (!watchersEnabled) {
    index.trusted = trustCurrentBaseline
    return
  }
  try {
    const watcher: FSWatcher = watchFileSystem(index.root, { recursive: true }, () => markIndexDirty(index))
    watcher.on('error', () => markIndexDirty(index))
    index.stopWatcher = () => watcher.close()
    index.trusted = trustCurrentBaseline
  } catch {
    index.trusted = false
  }
}

async function installWatcher(index: RootIndex, trustCurrentBaseline: boolean): Promise<void> {
  stopIndexWatcher(index)
  index.dirty = false
  index.trusted = false
  if (await installFSEventsWatcher(index)) return
  installSessionWatcher(index, trustCurrentBaseline)
}

async function loadIndex(root: string): Promise<RootIndex | null> {
  const normalized = normalizedRoot(root)
  const filePath = indexFilePath(normalized)
  if (!filePath) return null

  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_INDEX_BYTES) return null

    const lines = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity })
    let header: StoredHeader | null = null
    let footerSeen = false
    const entries: ScanEntryV1[] = []

    for await (const line of lines) {
      if (!line) continue
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { return null }

      if (!header) {
        if (!isStoredHeader(parsed, normalized)) return null
        header = parsed
        continue
      }
      if (isStoredFooter(parsed, entries.length)) {
        footerSeen = true
        continue
      }
      if (footerSeen || !isStoredEntry(parsed, normalized) || entries.length >= MAX_INDEX_ENTRIES) return null
      entries.push({
        protocolVersion: 1,
        event: 'entry',
        scanId: 'index',
        rootId: 'index',
        name: parsed.name,
        path: parsed.path,
        allocatedBytes: parsed.allocatedBytes,
        sizeKB: parsed.sizeKB,
        isDir: parsed.isDir,
        device: parsed.device,
        inode: parsed.inode,
        hardlinkDuplicate: parsed.hardlinkDuplicate,
      })
    }

    if (!header || !footerSeen) return null
    const index: RootIndex = {
      root: normalized,
      entries,
      journalId: header.journalId,
      trusted: false,
      dirty: false,
      lastUsedAt: Date.now(),
      stopWatcher: null,
      validation: null,
      resolveValidation: null,
      validationTimer: null,
    }
    indexes.set(rootKey(normalized), index)
    await installWatcher(index, false)
    return index
  } catch {
    return null
  }
}

async function writeLine(stream: ReturnType<typeof createWriteStream>, value: unknown): Promise<void> {
  if (stream.write(`${JSON.stringify(value)}\n`)) return
  await once(stream, 'drain')
}

async function persistIndex(index: RootIndex): Promise<void> {
  const filePath = indexFilePath(index.root)
  if (!filePath) return
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const stream = createWriteStream(tempPath, { encoding: 'utf8', flags: 'w', mode: 0o600 })
    await writeLine(stream, {
      type: 'header',
      version: INDEX_VERSION,
      root: index.root,
      createdAt: Date.now(),
      journalId: index.journalId,
    } satisfies StoredHeader)
    for (let offset = 0; offset < index.entries.length; offset += 1_000) {
      const end = Math.min(index.entries.length, offset + 1_000)
      for (let indexOffset = offset; indexOffset < end; indexOffset += 1) {
        await writeLine(stream, toStoredEntry(index.entries[indexOffset]))
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await writeLine(stream, { type: 'footer', entryCount: index.entries.length } satisfies StoredFooter)
    stream.end()
    await once(stream, 'finish')
    if (indexes.get(rootKey(index.root)) !== index || index.dirty) {
      await rm(tempPath, { force: true })
      return
    }
    await rename(tempPath, filePath)
    await prunePersistedIndexes(filePath)
  } catch {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

async function prunePersistedIndexes(currentFilePath: string): Promise<void> {
  if (!indexDirectory) return
  try {
    const names = (await readdir(indexDirectory)).filter((name) => name.endsWith('.jsonl'))
    const files = (await Promise.all(names.map(async (name) => {
      const filePath = path.join(indexDirectory as string, name)
      const info = await stat(filePath)
      return { filePath, size: info.size, modifiedAt: info.mtimeMs }
    }))).sort((a, b) => a.modifiedAt - b.modifiedAt)
    let totalBytes = files.reduce((total, file) => total + file.size, 0)
    let fileCount = files.length
    for (const file of files) {
      if (fileCount <= MAX_INDEX_FILES && totalBytes <= MAX_INDEX_DIRECTORY_BYTES) break
      if (file.filePath === currentFilePath) continue
      await rm(file.filePath, { force: true })
      totalBytes -= file.size
      fileCount -= 1
    }
  } catch {
    // Index retention is best-effort and never affects scan correctness.
  }
}

function evictIndexes(exceptKey: string): void {
  let residentEntries = [...indexes.values()].reduce((total, index) => total + index.entries.length, 0)
  if (residentEntries <= MAX_RESIDENT_ENTRIES) return
  const candidates = [...indexes.entries()]
    .filter(([key]) => key !== exceptKey)
    .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
  for (const [key, index] of candidates) {
    if (residentEntries <= MAX_RESIDENT_ENTRIES) break
    stopIndexWatcher(index)
    indexes.delete(key)
    residentEntries -= index.entries.length
  }
}

export function configureScanIndex(directory: string, options: { platform?: AppPlatform; enableWatchers?: boolean } = {}): void {
  indexDirectory = directory
  configuredPlatform = options.platform ?? (process.platform === 'win32' ? 'windows' : 'macos')
  watchersEnabled = options.enableWatchers ?? true
}

/**
 * Covers platforms/scanner fallbacks without a historical journal cursor. It
 * begins before traversal so a mutation racing with the scan prevents reuse.
 */
export function beginScanMutationGuard(root: string): ScanMutationGuard {
  if (!watchersEnabled) return { isStable: () => true, dispose: () => {} }
  let stable = true
  let watcher: FSWatcher | null = null
  try {
    watcher = watchFileSystem(normalizedRoot(root), { recursive: true }, () => { stable = false })
    watcher.on('error', () => { stable = false })
  } catch {
    stable = false
  }
  return {
    isStable: () => stable,
    dispose: () => {
      watcher?.close()
      watcher = null
    },
  }
}

export async function getVerifiedScanIndex(root: string): Promise<ReadonlyArray<ScanEntryV1> | null> {
  const normalized = normalizedRoot(root)
  const key = rootKey(normalized)
  let index = indexes.get(key) ?? null
  if (!index) {
    let load = pendingLoads.get(key)
    if (!load) {
      load = loadIndex(normalized).finally(() => pendingLoads.delete(key))
      pendingLoads.set(key, load)
    }
    index = await load
  }
  if (!index) return null
  if (index.validation) await index.validation
  if (!index.trusted || index.dirty) return null
  index.lastUsedAt = Date.now()
  return index.entries
}

export async function commitVerifiedScanIndex(root: string, entries: ScanEntryV1[], journalId: string | null): Promise<void> {
  const normalized = normalizedRoot(root)
  const key = rootKey(normalized)
  const previous = indexes.get(key)
  if (previous) stopIndexWatcher(previous)

  if (entries.length === 0 || entries.length > MAX_INDEX_ENTRIES) {
    indexes.delete(key)
    const filePath = indexFilePath(normalized)
    if (filePath) await rm(filePath, { force: true }).catch(() => {})
    return
  }

  const index: RootIndex = {
    root: normalized,
    entries: entries.slice(),
    journalId,
    trusted: false,
    dirty: false,
    lastUsedAt: Date.now(),
    stopWatcher: null,
    validation: null,
    resolveValidation: null,
    validationTimer: null,
  }
  indexes.set(key, index)
  await installWatcher(index, true)
  evictIndexes(key)
  pendingPersistence.add(index)
  scheduleScanIndexPersistence()
}

/** Delay index writes until the scanner has released the disk. */
export function scheduleScanIndexPersistence(delayMs = 60_000): void {
  if (persistenceTimer) clearTimeout(persistenceTimer)
  persistenceTimer = setTimeout(() => {
    persistenceTimer = null
    const pending = [...pendingPersistence]
    pendingPersistence.clear()
    void (async () => {
      for (const index of pending) {
        if (indexes.get(rootKey(index.root)) === index && !index.dirty) await persistIndex(index)
      }
    })()
  }, Math.max(0, delayMs))
}

export function invalidateScanIndexesForPaths(paths: readonly string[]): void {
  for (const index of indexes.values()) {
    if (paths.some((changedPath) => (
      isSameOrDescendantPath(changedPath, index.root, configuredPlatform)
      || isSameOrDescendantPath(index.root, changedPath, configuredPlatform)
    ))) markIndexDirty(index)
  }
}

export async function clearScanIndexes(): Promise<void> {
  if (persistenceTimer) clearTimeout(persistenceTimer)
  persistenceTimer = null
  pendingPersistence.clear()
  for (const index of indexes.values()) stopIndexWatcher(index)
  indexes.clear()
  pendingLoads.clear()
  if (indexDirectory) await rm(indexDirectory, { recursive: true, force: true }).catch(() => {})
}

export function disposeScanIndexes(): void {
  if (persistenceTimer) clearTimeout(persistenceTimer)
  persistenceTimer = null
  pendingPersistence.clear()
  for (const index of indexes.values()) stopIndexWatcher(index)
  indexes.clear()
  pendingLoads.clear()
}

export const scanIndexTesting = {
  indexFilePath,
  isStoredEntry,
  isStoredFooter,
  isStoredHeader,
  rootKey,
}
