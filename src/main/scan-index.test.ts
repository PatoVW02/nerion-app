import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { ScanEntryV1 } from '../shared/contracts'
import type { AppPlatform } from '../shared/platform'
import {
  clearScanIndexes,
  commitVerifiedScanIndex,
  configureScanIndex,
  getVerifiedScanIndex,
  invalidateScanIndexesForPaths,
  scanIndexTesting,
} from './scan-index'

let testDirectory: string | null = null
const hostPlatform: AppPlatform = process.platform === 'win32' ? 'windows' : 'macos'

afterEach(async () => {
  await clearScanIndexes()
  testDirectory = null
})

function entry(root: string, relativePath: string): ScanEntryV1 {
  const itemPath = path.join(root, relativePath)
  return {
    protocolVersion: 1,
    event: 'entry',
    scanId: 'scan-a',
    rootId: 'root-0',
    name: path.basename(itemPath),
    path: itemPath,
    allocatedBytes: 4_096,
    sizeKB: 4,
    isDir: false,
    device: '1',
    inode: '2',
    hardlinkDuplicate: false,
  }
}

describe('verified scan index', () => {
  it('reuses a committed root until an overlapping filesystem path changes', async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), 'nerion-index-test-'))
    configureScanIndex(testDirectory, { platform: hostPlatform, enableWatchers: false })
    const root = path.join(testDirectory, 'root')
    const cachedEntry = entry(root, 'folder/file.bin')

    await commitVerifiedScanIndex(root, [cachedEntry], null)
    expect(await getVerifiedScanIndex(root)).toEqual([cachedEntry])

    invalidateScanIndexesForPaths([path.join(root, 'folder')])
    expect(await getVerifiedScanIndex(root)).toBeNull()
  })

  it('rejects persisted entries that escape their indexed root', async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), 'nerion-index-test-'))
    configureScanIndex(testDirectory, { platform: hostPlatform, enableWatchers: false })
    const root = path.join(testDirectory, 'root')
    expect(scanIndexTesting.isStoredEntry({
      ...entry(root, '../outside.bin'),
      type: 'entry',
    }, root)).toBe(false)
  })
})
