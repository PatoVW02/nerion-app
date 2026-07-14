import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBufferedEventSender } from './scan-event-buffer'

afterEach(() => vi.useRealTimers())

describe('scan event buffering', () => {
  it('flushes at the batch limit and preserves event order', () => {
    const deliver = vi.fn()
    const sender = createBufferedEventSender(deliver, { maxBatchSize: 3, delayMs: 100 })
    sender.enqueue(1)
    sender.enqueue(2)
    sender.enqueue(3)
    expect(deliver).toHaveBeenCalledWith([1, 2, 3])
  })

  it('flushes a small batch after the delay', () => {
    vi.useFakeTimers()
    const deliver = vi.fn()
    const sender = createBufferedEventSender(deliver, { delayMs: 50 })
    sender.enqueue('entry')
    vi.advanceTimersByTime(49)
    expect(deliver).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(deliver).toHaveBeenCalledWith(['entry'])
  })

  it('drops pending stale events when disposed after cancellation', () => {
    vi.useFakeTimers()
    const deliver = vi.fn()
    const sender = createBufferedEventSender(deliver)
    sender.enqueue('stale')
    sender.dispose()
    vi.runAllTimers()
    expect(deliver).not.toHaveBeenCalled()
  })
})
