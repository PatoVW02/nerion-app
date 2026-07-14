export interface BackgroundScanLease {
  id: number
}

interface BackgroundScanState {
  lease: BackgroundScanLease
  cancel: (() => void) | null
  cancelled: boolean
}

let foregroundScanId: string | null = null
let backgroundScan: BackgroundScanState | null = null
let nextBackgroundLeaseId = 1

/** Foreground work always wins and immediately preempts lower-priority work. */
export function beginForegroundScan(scanId: string): void {
  foregroundScanId = scanId
  cancelBackgroundScan()
}

export function endForegroundScan(scanId: string): void {
  if (foregroundScanId === scanId) foregroundScanId = null
}

export function tryBeginBackgroundScan(): BackgroundScanLease | null {
  if (foregroundScanId !== null || backgroundScan !== null) return null
  const lease = { id: nextBackgroundLeaseId++ }
  backgroundScan = { lease, cancel: null, cancelled: false }
  return lease
}

export function attachBackgroundCancel(lease: BackgroundScanLease, cancel: () => void): boolean {
  if (backgroundScan?.lease !== lease || backgroundScan.cancelled) {
    cancel()
    return false
  }
  backgroundScan.cancel = cancel
  return true
}

export function detachBackgroundCancel(lease: BackgroundScanLease, cancel: () => void): void {
  if (backgroundScan?.lease === lease && backgroundScan.cancel === cancel) {
    backgroundScan.cancel = null
  }
}

export function isBackgroundScanActive(lease: BackgroundScanLease): boolean {
  return backgroundScan?.lease === lease && !backgroundScan.cancelled
}

export function cancelBackgroundScan(): boolean {
  if (!backgroundScan) return false
  backgroundScan.cancelled = true
  const cancel = backgroundScan.cancel
  backgroundScan.cancel = null
  cancel?.()
  return true
}

export function endBackgroundScan(lease: BackgroundScanLease): void {
  if (backgroundScan?.lease === lease) backgroundScan = null
}

export const scanCoordinationTesting = {
  reset(): void {
    foregroundScanId = null
    backgroundScan = null
    nextBackgroundLeaseId = 1
  },
}
