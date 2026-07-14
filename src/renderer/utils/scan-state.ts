import type { ScanSummaryV1 } from '../types'

export type FileScanMode = 'quick' | 'deep'

export const CANCELLED_SCAN_WARNING = 'Scan cancelled. The results shown are partial.'

/**
 * Quick Scan must never fall back to a broad root while its configured targets
 * are still loading or when the user has selected no folders.
 */
export function canStartFileScan(
  hydrated: boolean,
  mode: FileScanMode,
  quickScanPaths: string[] | null,
): boolean {
  if (!hydrated) return false
  return mode === 'deep' || (quickScanPaths !== null && quickScanPaths.length > 0)
}

/** Preserve an explicit empty multi-root request instead of replacing it with rootPath. */
export function resolveScanTargets(rootPath: string, scanPaths: string[] | null | undefined): string | string[] {
  return scanPaths === null || scanPaths === undefined ? rootPath : scanPaths
}

export function scanCompletionWarning(summary: ScanSummaryV1): string | null {
  if (summary.fatalError) return summary.fatalError
  if (summary.cancelled) return CANCELLED_SCAN_WARNING
  if (summary.complete) return null

  const details: string[] = []
  if (summary.rootsCompleted < summary.rootsRequested) {
    details.push(`${summary.rootsCompleted} of ${summary.rootsRequested} scan locations completed`)
  }
  if (summary.issueCount > 0) {
    details.push(`${summary.issueCount} inaccessible ${summary.issueCount === 1 ? 'path' : 'paths'}`)
  }

  return details.length > 0
    ? `Scan completed with limited results: ${details.join(' and ')}.`
    : 'Scan completed with limited results. Some files or folders may be missing.'
}
