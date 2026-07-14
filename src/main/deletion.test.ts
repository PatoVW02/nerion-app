import { existsSync, linkSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppPlatform } from '../shared/platform'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))

import { shell } from 'electron'
import { deleteRequestedPaths, isAlreadyInTrash } from './deletion'

let fixture = ''
const runtimePlatform: AppPlatform = process.platform === 'win32' ? 'windows' : 'macos'

function createFixture(): string {
  // Windows treats `/tmp/...` as drive-relative rather than absolute. Use its
  // native temporary directory and resolve any 8.3 alias so the symlink/junction
  // safety check compares the same canonical spelling returned by realpath.
  const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp'
  const created = mkdtempSync(join(temporaryRoot, 'nerion-delete-'))
  return process.platform === 'win32' ? realpathSync(created) : created
}

describe('structured deletion', () => {
  beforeEach(() => {
    fixture = createFixture()
    vi.mocked(shell.trashItem).mockReset()
  })

  afterEach(() => rmSync(fixture, { recursive: true, force: true }))

  it('continues after an independent failure and charges only successful top-level items', async () => {
    const first = join(fixture, 'first.bin')
    const second = join(fixture, 'second.bin')
    writeFileSync(first, Buffer.alloc(4096))
    writeFileSync(second, Buffer.alloc(4096))
    vi.mocked(shell.trashItem)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('permission denied'))

    const result = await deleteRequestedPaths([first, second], {
      deleteImmediately: false,
      premium: false,
      remainingQuota: 2,
    })

    expect(shell.trashItem).toHaveBeenCalledTimes(2)
    expect(result.successfulCount).toBe(1)
    expect(result.failedCount).toBe(1)
    expect(result.quotaUsed).toBe(1)
    expect(result.reclaimedBytes).toBe(0)
    expect(result.movedToTrashBytes).toBeGreaterThan(0)
    expect(result.error).toContain('permission denied')
  })

  it('uses quota only after success, so a failed item does not block the next request', async () => {
    const first = join(fixture, 'first.bin')
    const second = join(fixture, 'second.bin')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    vi.mocked(shell.trashItem)
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce()

    const result = await deleteRequestedPaths([first, second], {
      deleteImmediately: false,
      premium: false,
      remainingQuota: 1,
    })

    expect(shell.trashItem).toHaveBeenCalledTimes(2)
    expect(result.quotaUsed).toBe(1)
    expect(result.items.map((item) => item.status)).toEqual(['failed', 'moved-to-trash'])
  })

  it('collapses a selected child under its parent and charges one request', async () => {
    const parent = join(fixture, 'parent')
    const child = join(parent, 'child.bin')
    mkdirSync(parent)
    writeFileSync(child, 'fixture')
    vi.mocked(shell.trashItem).mockResolvedValue()

    const result = await deleteRequestedPaths([parent, child], {
      deleteImmediately: false,
      premium: false,
      remainingQuota: 2,
    })
    expect(shell.trashItem).toHaveBeenCalledTimes(1)
    expect(result.items.find((item) => item.requestedPath === child)?.status).toBe('skipped')
    expect(result.quotaUsed).toBe(1)
  })

  it('reports permanent deletion as reclaimed space', async () => {
    const file = join(fixture, 'remove-now.bin')
    writeFileSync(file, Buffer.alloc(8192))
    const result = await deleteRequestedPaths([file], {
      deleteImmediately: true,
      premium: true,
      remainingQuota: 0,
    })
    expect(result.items[0].status).toBe('permanently-removed')
    expect(result.reclaimedBytes).toBeGreaterThan(0)
    expect(result.movedToTrashBytes).toBe(0)
  })

  it('keeps an empty content-only root and does not consume quota', async () => {
    const desktop = join(fixture, 'Desktop')
    mkdirSync(desktop)

    const result = await deleteRequestedPaths([desktop], {
      deleteImmediately: false,
      premium: false,
      remainingQuota: 1,
      platform: runtimePlatform,
      homeDir: fixture,
    })

    expect(result.items[0].status).toBe('skipped')
    expect(result.quotaUsed).toBe(0)
    expect(existsSync(desktop)).toBe(true)
    expect(shell.trashItem).not.toHaveBeenCalled()
  })

  it('processes children while preserving a selected content-only root', async () => {
    const downloads = join(fixture, 'Downloads')
    const child = join(downloads, 'archive.zip')
    mkdirSync(downloads)
    writeFileSync(child, 'archive')
    vi.mocked(shell.trashItem).mockResolvedValue()

    const result = await deleteRequestedPaths([downloads], {
      deleteImmediately: false,
      premium: false,
      remainingQuota: 1,
      platform: runtimePlatform,
      homeDir: fixture,
    })

    expect(result.items[0].requestedPath).toBe(downloads)
    expect(result.items[0].operations[0].path).toBe(child)
    expect(shell.trashItem).toHaveBeenCalledWith(child)
    expect(shell.trashItem).not.toHaveBeenCalledWith(downloads)
    expect(result.quotaUsed).toBe(1)
  })

  it('counts hard-linked blocks only when the final link is permanently removed', async () => {
    const first = join(fixture, 'first-link.bin')
    const second = join(fixture, 'second-link.bin')
    writeFileSync(first, Buffer.alloc(8192, 1))
    linkSync(first, second)
    const stats = statSync(first)
    const allocated = stats.blocks > 0 ? stats.blocks * 512 : stats.size

    const result = await deleteRequestedPaths([first, second], {
      deleteImmediately: true,
      premium: true,
      remainingQuota: 0,
    })

    expect(result.reclaimedBytes).toBe(allocated)
    expect(readdirSync(fixture)).toEqual([])
  })

  it('counts a hard-linked allocation once when all links are inside one selected folder', async () => {
    const folder = join(fixture, 'linked-folder')
    const first = join(folder, 'first-link.bin')
    const second = join(folder, 'second-link.bin')
    mkdirSync(folder)
    writeFileSync(first, Buffer.alloc(8192, 1))
    linkSync(first, second)
    const stats = statSync(first)
    const allocated = typeof stats.blocks === 'number' ? stats.blocks * 512 : stats.size

    const result = await deleteRequestedPaths([folder], {
      deleteImmediately: true,
      premium: true,
      remainingQuota: 0,
    })

    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(allocated)
    expect(result.reclaimedBytes).toBeLessThan(allocated * 2 + 8192)
    expect(existsSync(folder)).toBe(false)
  })

  it('recognizes only the drive-root Windows Recycle Bin store', () => {
    expect(isAlreadyInTrash('D:\\$Recycle.Bin\\S-1-5-21\\deleted.bin', 'windows')).toBe(true)
    expect(isAlreadyInTrash('C:\\Users\\Pat\\Downloads\\$Recycle.Bin\\ordinary.bin', 'windows')).toBe(false)
  })

  it('rejects a request that reaches a protected location through an ancestor symlink', async () => {
    const protectedHome = join(fixture, 'home')
    const protectedDirectory = runtimePlatform === 'windows'
      ? join(protectedHome, 'AppData')
      : join(protectedHome, 'Library', 'Keychains')
    const secret = join(protectedDirectory, 'secret.db')
    const alias = join(fixture, 'alias-home')
    mkdirSync(protectedDirectory, { recursive: true })
    writeFileSync(secret, 'secret')
    symlinkSync(protectedHome, alias, runtimePlatform === 'windows' ? 'junction' : 'dir')

    const requestedPath = runtimePlatform === 'windows'
      ? join(alias, 'AppData')
      : join(alias, 'Library', 'Keychains', 'secret.db')

    const result = await deleteRequestedPaths([requestedPath], {
      deleteImmediately: true,
      premium: true,
      remainingQuota: 0,
      platform: runtimePlatform,
      homeDir: protectedHome,
    })

    expect(result.items[0].status).toBe('protected')
    expect(existsSync(secret)).toBe(true)
  })
})
