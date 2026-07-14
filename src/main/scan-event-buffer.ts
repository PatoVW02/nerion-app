export interface BufferedEventSender<T> {
  enqueue: (event: T) => void
  flush: () => void
  dispose: (flushPending?: boolean) => void
}

/** Reduces renderer IPC pressure without changing the public scan-event contract. */
export function createBufferedEventSender<T>(
  deliver: (events: T[]) => void,
  options: { maxBatchSize?: number; delayMs?: number } = {},
): BufferedEventSender<T> {
  const maxBatchSize = options.maxBatchSize ?? 256
  const delayMs = options.delayMs ?? 50
  let pending: T[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (disposed || pending.length === 0) return
    const batch = pending
    pending = []
    deliver(batch)
  }

  return {
    enqueue(event) {
      if (disposed) return
      pending.push(event)
      if (pending.length >= maxBatchSize) {
        flush()
      } else if (!timer) {
        timer = setTimeout(flush, delayMs)
      }
    },
    flush,
    dispose(flushPending = false) {
      if (flushPending) flush()
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
      pending = []
    },
  }
}
