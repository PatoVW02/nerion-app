import type { DiskEntry } from '../types'
import { isSameOrDescendantPath } from './path'

/**
 * Collapse overlapping UI selections for size and free-tier quota accounting.
 * The original list is still sent to main so every user selection receives a
 * structured result, including selections covered by a parent.
 */
export function collapseOverlappingEntries(entries: DiskEntry[]): DiskEntry[] {
  return entries.filter((entry) => !entries.some(
    (other) => other.path !== entry.path && isSameOrDescendantPath(entry.path, other.path),
  ))
}

/** A removed directory covers stale child selections as well as itself. */
export function isCoveredByRemovedPath(itemPath: string, removedPaths: string[]): boolean {
  return removedPaths.some((removedPath) => isSameOrDescendantPath(itemPath, removedPath))
}
