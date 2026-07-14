import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachBackgroundCancel,
  beginForegroundScan,
  cancelBackgroundScan,
  endBackgroundScan,
  endForegroundScan,
  isBackgroundScanActive,
  scanCoordinationTesting,
  tryBeginBackgroundScan,
} from './scan-coordination'

afterEach(() => scanCoordinationTesting.reset())

describe('scan coordination', () => {
  it('prevents a background scan from starting during foreground work', () => {
    beginForegroundScan('manual-1')
    expect(tryBeginBackgroundScan()).toBeNull()
    endForegroundScan('manual-1')
    expect(tryBeginBackgroundScan()).not.toBeNull()
  })

  it('preempts background work when a foreground scan begins', () => {
    const lease = tryBeginBackgroundScan()!
    const cancel = vi.fn()
    expect(attachBackgroundCancel(lease, cancel)).toBe(true)

    beginForegroundScan('manual-1')
    expect(cancel).toHaveBeenCalledOnce()
    expect(isBackgroundScanActive(lease)).toBe(false)
    endBackgroundScan(lease)
  })

  it('immediately cancels a late process attached to a cancelled lease', () => {
    const lease = tryBeginBackgroundScan()!
    expect(cancelBackgroundScan()).toBe(true)
    const cancel = vi.fn()
    expect(attachBackgroundCancel(lease, cancel)).toBe(false)
    expect(cancel).toHaveBeenCalledOnce()
  })
})
