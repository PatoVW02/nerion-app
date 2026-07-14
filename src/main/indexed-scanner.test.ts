import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { ScanEventV1, ScanSummaryV1 } from '../shared/contracts'
import type { AppPlatform } from '../shared/platform'

vi.mock('./platform', () => ({
  getAppPlatform: () => process.platform === 'win32' ? 'windows' : 'macos',
  resolveScannerBinaryPath: () => null,
}))
vi.mock('./scan-performance', () => ({ recordLocalScanMetric: vi.fn() }))

import { clearScanIndexes, configureScanIndex, getVerifiedScanIndex, invalidateScanIndexesForPaths } from './scan-index'
import { scanDirectoryIndexedStreaming } from './indexed-scanner'

let fixtureDirectory: string | null = null
const hostPlatform: AppPlatform = process.platform === 'win32' ? 'windows' : 'macos'

afterEach(async () => {
  await clearScanIndexes()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
  fixtureDirectory = null
})

function scan(root: string, scanId: string): Promise<{ events: ScanEventV1[]; summary: ScanSummaryV1 }> {
  return new Promise((resolve) => {
    const events: ScanEventV1[] = []
    scanDirectoryIndexedStreaming(
      root,
      { scanId, rootId: 'root-0', profile: 'interactive' },
      (event) => events.push(event),
      ({ summary }) => resolve({ events, summary }),
    )
  })
}

async function waitForIndex(root: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await getVerifiedScanIndex(root)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the scan index')
}

describe('indexed scanner', () => {
  it('replays an unchanged root and falls back after explicit invalidation', async () => {
    fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'nerion-indexed-scan-'))
    const root = path.join(fixtureDirectory, 'root')
    const indexDirectory = path.join(fixtureDirectory, 'index')
    await mkdir(path.join(root, 'folder'), { recursive: true })
    await writeFile(path.join(root, 'folder', 'one.txt'), 'one')
    configureScanIndex(indexDirectory, { platform: hostPlatform, enableWatchers: false })

    const first = await scan(root, 'scan-1')
    expect(first.summary.source).toBe('filesystem')
    expect(first.summary.complete).toBe(true)
    await waitForIndex(root)

    const second = await scan(root, 'scan-2')
    expect(second.summary.source).toBe('index')
    expect(second.events.filter((event) => event.event === 'entry')).toHaveLength(first.summary.entryCount)
    expect(second.events.every((event) => event.scanId === 'scan-2')).toBe(true)

    invalidateScanIndexesForPaths([path.join(root, 'folder', 'one.txt')])
    const third = await scan(root, 'scan-3')
    expect(third.summary.source).toBe('filesystem')
  })
})
