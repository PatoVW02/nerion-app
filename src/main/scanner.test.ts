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
    const unusual = join(nested, 'unusual-ñame.txt')
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
    expect(linkedEntries.find((entry) => !entry.hardlinkDuplicate)?.allocatedBytes).toBeGreaterThan(0)
    expect(linkedEntries.find((entry) => entry.hardlinkDuplicate)?.allocatedBytes).toBe(0)
    expect(new Set(linkedEntries.map((entry) => `${entry.device}:${entry.inode}`)).size).toBe(1)
    expect(entries.some((entry) => entry.path.endsWith('ignored-symlink'))).toBe(false)
    const sparseStats = lstatSync(sparse)
    const expectedSparseBytes = process.platform === 'win32'
      ? Number(sparseStats.size)
      : typeof sparseStats.blocks === 'number' ? sparseStats.blocks * 512 : Number(sparseStats.size)
    expect(entries.find((entry) => entry.path === sparse)?.allocatedBytes).toBe(expectedSparseBytes)
  })

  it.skipIf(process.platform === 'win32')('preserves tabs and newlines in names on filesystems that support them', async () => {
    const root = fixture()
    const unusual = join(root, 'tab\tline\nname.txt')
    writeFileSync(unusual, 'fallback protocol fixture')

    const result = await scan(root)
    const entries = result.events.filter((event) => event.event === 'entry')

    expect(result.summary).toMatchObject({ complete: true, cancelled: false, issueCount: 0 })
    expect(entries).toContainEqual(expect.objectContaining({
      name: 'tab\tline\nname.txt',
      path: unusual,
    }))
  })

  it('rejects byte names that cannot round-trip through UTF-8', () => {
    expect(scannerTesting.decodeExactUtf8Name(Buffer.from('valid-unicode-ñ'))).toBe('valid-unicode-ñ')
    expect(scannerTesting.decodeExactUtf8Name(Buffer.from([0x69, 0x6e, 0x76, 0xff]))).toBeNull()
  })
})

describe('native scanner scheduling', () => {
  it('uses macOS disk throttling and a background QoS clamp for scheduled scans', () => {
    expect(scannerTesting.nativeScannerLaunch('/scanner', ['/root'], 'background', 'darwin')).toEqual({
      command: '/usr/sbin/taskpolicy',
      args: ['-d', 'throttle', '-c', 'background', '-b', '/scanner', '/root'],
    })
  })

  it('uses utility QoS interactively and launches the scanner directly on Windows', () => {
    expect(scannerTesting.nativeScannerLaunch('/scanner', ['/root'], 'interactive', 'darwin')).toEqual({
      command: '/usr/sbin/taskpolicy',
      args: ['-d', 'throttle', '-c', 'utility', '/scanner', '/root'],
    })
    expect(scannerTesting.nativeScannerLaunch('scanner.exe', ['C:\\Root'], 'interactive', 'win32')).toEqual({
      command: 'scanner.exe',
      args: ['C:\\Root'],
    })
  })
})
