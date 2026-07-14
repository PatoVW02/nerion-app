import { describe, expect, it } from 'vitest'
import { collapseOverlappingPaths, isSameOrDescendantPath, pathComparisonKey } from './path-utils'

describe('path-utils', () => {
  it('preserves case on macOS and folds it only for Windows comparisons', () => {
    expect(pathComparisonKey('/Users/Pat/Folder', 'macos')).toBe('/Users/Pat/Folder')
    expect(pathComparisonKey('C:\\Users\\Pat\\Folder', 'windows')).toBe('c:\\users\\pat\\folder')
  })

  it('uses separator boundaries for ancestry', () => {
    expect(isSameOrDescendantPath('/Users/pat/Downloads/file.zip', '/Users/pat/Downloads', 'macos')).toBe(true)
    expect(isSameOrDescendantPath('/Users/pat/Downloads-old', '/Users/pat/Downloads', 'macos')).toBe(false)
    expect(isSameOrDescendantPath('C:\\Temp\\One', 'c:\\temp', 'windows')).toBe(true)
    expect(isSameOrDescendantPath('C:\\Temp\\..\\Windows\\System32', 'c:\\windows', 'windows')).toBe(true)
  })

  it('preserves UNC roots while normalizing Windows dot segments on macOS hosts', () => {
    expect(pathComparisonKey('\\\\Server\\Share\\Folder\\..\\File', 'windows')).toBe('\\\\server\\share\\file')
  })

  it('collapses duplicates and descendants while preserving native root paths', () => {
    expect(collapseOverlappingPaths([
      '/Users/pat/Library',
      '/Users/pat/Library/Caches',
      '/Users/pat/Downloads',
      '/Users/pat/Library',
    ], 'macos')).toEqual(['/Users/pat/Library', '/Users/pat/Downloads'])
  })
})
