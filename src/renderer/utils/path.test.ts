import { describe, expect, it } from 'vitest'
import type { DiskEntry } from '../types'
import { buildCleanableTree } from './buildTree'
import { isAbsoluteUiPath, isSameOrDescendantPath, normalizeUiPath, pathParent, pathsEqual } from './path'

describe('renderer path handling', () => {
  it('compares Windows native and UI paths without prefix collisions', () => {
    expect(pathsEqual('C:\\Users\\Pat\\Downloads', 'c:/users/pat/downloads')).toBe(true)
    expect(isSameOrDescendantPath('C:\\Users\\Pat\\Downloads\\archive.zip', 'c:/users/pat/downloads')).toBe(true)
    expect(isSameOrDescendantPath('C:\\Users\\Pat\\Downloads-old', 'c:/users/pat/downloads')).toBe(false)
  })

  it('keeps the native path on selectable tree entries', () => {
    const entry: DiskEntry = {
      name: 'Cache',
      path: 'C:\\Users\\Pat\\AppData\\Local\\Cache',
      sizeKB: 12,
      isDir: true,
    }

    const tree = buildCleanableTree(
      [entry],
      'C:/Users/Pat',
      new Set([entry.path]),
    )

    expect(tree).toHaveLength(1)
    const selectableNode = tree[0].children[0]
    expect(selectableNode.path).toBe(entry.path)
    expect(selectableNode.entry?.path).toBe(entry.path)
  })

  it('preserves the UNC root marker in comparison keys', () => {
    expect(normalizeUiPath('\\\\Server\\Share\\Folder')).toBe('//server/share/folder')
    expect(isAbsoluteUiPath('\\\\Server\\Share\\Folder')).toBe(true)
    expect(pathParent('\\\\Server\\Share')).toBe('//server/share')
    expect(pathsEqual('\\\\Server\\Share\\Folder', '//server/share/folder')).toBe(true)
  })
})
