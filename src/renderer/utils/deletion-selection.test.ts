import { describe, expect, it } from 'vitest'
import type { DiskEntry } from '../types'
import { collapseOverlappingEntries, isCoveredByRemovedPath } from './deletion-selection'

function entry(path: string): DiskEntry {
  return {
    path,
    name: path.split('/').pop() ?? path,
    isDir: true,
    sizeKB: 1,
  }
}

describe('deletion selection accounting', () => {
  it('counts a selected parent and child as one top-level request', () => {
    const parent = entry('/Users/test/Downloads/archive')
    const child = entry('/Users/test/Downloads/archive/file.zip')
    expect(collapseOverlappingEntries([child, parent])).toEqual([parent])
  })

  it('does not collapse similar sibling prefixes', () => {
    const cache = entry('/Users/test/Library/Cache')
    const cacheBackup = entry('/Users/test/Library/Cache Backup')
    expect(collapseOverlappingEntries([cache, cacheBackup])).toEqual([cache, cacheBackup])
  })

  it('removes stale child selections after their parent is removed', () => {
    expect(isCoveredByRemovedPath('/Users/test/archive/file.zip', ['/Users/test/archive'])).toBe(true)
    expect(isCoveredByRemovedPath('/Users/test/archive-old/file.zip', ['/Users/test/archive'])).toBe(false)
  })

  it('uses case-insensitive comparison for Windows drive paths', () => {
    expect(isCoveredByRemovedPath('C:/Users/Test/Downloads/File.zip', ['c:/users/test/downloads'])).toBe(true)
  })
})
