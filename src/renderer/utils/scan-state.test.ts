import { describe, expect, it } from 'vitest'
import type { ScanSummaryV1 } from '../types'
import {
  CANCELLED_SCAN_WARNING,
  canStartFileScan,
  resolveScanTargets,
  scanCompletionWarning,
} from './scan-state'

function summary(overrides: Partial<ScanSummaryV1> = {}): ScanSummaryV1 {
  return {
    protocolVersion: 1,
    event: 'summary',
    scanId: 'scan-1',
    rootId: null,
    complete: true,
    cancelled: false,
    entryCount: 10,
    issueCount: 0,
    rootsCompleted: 1,
    rootsRequested: 1,
    fatalError: null,
    securityAnalysis: 'disabled',
    suspiciousCount: 0,
    ...overrides,
  }
}

describe('file scan readiness', () => {
  it('blocks scans before hydration and Quick Scan with no configured targets', () => {
    expect(canStartFileScan(false, 'deep', null)).toBe(false)
    expect(canStartFileScan(false, 'quick', ['/Users/test/Library/Caches'])).toBe(false)
    expect(canStartFileScan(true, 'quick', null)).toBe(false)
    expect(canStartFileScan(true, 'quick', [])).toBe(false)
  })

  it('allows hydrated deep scans and Quick Scan with at least one target', () => {
    expect(canStartFileScan(true, 'deep', null)).toBe(true)
    expect(canStartFileScan(true, 'quick', ['/Users/test/Library/Caches'])).toBe(true)
  })

  it('preserves an explicit empty target list instead of falling back to the root', () => {
    expect(resolveScanTargets('/Users/test/Library', [])).toEqual([])
    expect(resolveScanTargets('/Users/test/Library', null)).toBe('/Users/test/Library')
  })
})

describe('scan completion warnings', () => {
  it('describes cancelled and incomplete scans', () => {
    expect(scanCompletionWarning(summary({ complete: false, cancelled: true }))).toBe(CANCELLED_SCAN_WARNING)
    expect(scanCompletionWarning(summary({
      complete: false,
      rootsCompleted: 1,
      rootsRequested: 2,
      issueCount: 3,
    }))).toBe('Scan completed with limited results: 1 of 2 scan locations completed and 3 inaccessible paths.')
  })

  it('returns no warning for a complete scan and preserves fatal errors', () => {
    expect(scanCompletionWarning(summary())).toBeNull()
    expect(scanCompletionWarning(summary({ complete: false, fatalError: 'Scanner unavailable' }))).toBe('Scanner unavailable')
  })
})
