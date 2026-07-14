import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScanEventV1, ScanSummaryV1 } from '../shared/contracts'

vi.mock('./platform', () => ({
  getAppPlatform: () => process.platform === 'win32' ? 'windows' : 'macos',
  resolveScannerBinaryPath: () => null,
}))

import { scannerTesting } from './scanner'

const fixtures: string[] = []

function fixture(): string {
  const value = mkdtempSync(join(tmpdir(), 'nerion-node-scanner-'))
  fixtures.push(value)
  return value
}

function scan(root: string): Promise<{ events: ScanEventV1[]; summary: ScanSummaryV1 }> {
  return new Promise((resolve) => {
    const events: ScanEventV1[] = []
    scannerTesting.spawnNodeFallback(
      root,
      { scanId: 'fallback-test', rootId: 'root-test' },
      (event) => events.push(event),
      ({ summary }) => resolve({ events, summary }),
    )
  })
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Node scanner fallback', () => {
  it('preserves unusual Unicode names, allocated bytes, and hard-link identity without following symlinks', async () => {
    const root = fixture()
    const nested = join(root, 'unicode-ñ')
    mkdirSync(nested)
    const unusual = join(nested, 'tab\tline\nname.txt')
    const hardlink = join(nested, 'hardlink.txt')
    const sparse = join(nested, 'sparse.bin')
    writeFileSync(unusual, 'fallback protocol fixture')
    linkSync(unusual, hardlink)
    writeFileSync(sparse, '')
    truncateSync(sparse, 16 * 1024 * 1024)
    if (process.platform !== 'win32') symlinkSync(unusual, join(nested, 'ignored-symlink'))

    const result = await scan(root)
    const entries = result.events.filter((event) => event.event === 'entry')
    const linkedEntries = entries.filter((entry) => entry.path === unusual || entry.path === hardlink)

    expect(result.summary).toMatchObject({ complete: true, cancelled: false, issueCount: 0 })
    expect(entries.some((entry) => entry.path === unusual)).toBe(true)
    expect(linkedEntries).toHaveLength(2)
    expect(linkedEntries.filter((entry) => entry.hardlinkDuplicate)).toHaveLength(1)
    expect(linkedEntries.find((entry) => entry.hardlinkDuplicate)?.allocatedBytes).toBe(0)
    expect(new Set(linkedEntries.map((entry) => `${entry.device}:${entry.inode}`)).size).toBe(1)
    expect(entries.some((entry) => entry.path.endsWith('ignored-symlink'))).toBe(false)
    expect(entries.find((entry) => entry.path === sparse)?.allocatedBytes).toBe(lstatSync(sparse).blocks * 512)
  })

  it('rejects byte names that cannot round-trip through UTF-8', () => {
    expect(scannerTesting.decodeExactUtf8Name(Buffer.from('valid-unicode-ñ'))).toBe('valid-unicode-ñ')
    expect(scannerTesting.decodeExactUtf8Name(Buffer.from([0x69, 0x6e, 0x76, 0xff]))).toBeNull()
  })
})
