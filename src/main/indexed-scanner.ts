import { performance } from 'node:perf_hooks'
import { SCAN_PROTOCOL_VERSION, type ScanEntryV1, type ScanEventV1, type ScanSummaryV1 } from '../shared/contracts'
import { beginScanMutationGuard, commitVerifiedScanIndex, getVerifiedScanIndex } from './scan-index'
import { recordLocalScanMetric } from './scan-performance'
import { scanDirectoryStreaming as scanFilesystemStreaming, type ScanCompletion, type ScanOptions } from './scanner'

const REPLAY_CHUNK_SIZE = 1_024
const MAX_CAPTURED_INDEX_ENTRIES = 250_000

function cancelledSummary(options: ScanOptions, entryCount: number, durationMs: number): ScanSummaryV1 {
  return {
    protocolVersion: SCAN_PROTOCOL_VERSION,
    event: 'summary',
    scanId: options.scanId,
    rootId: options.rootId,
    complete: false,
    cancelled: true,
    entryCount,
    issueCount: 0,
    rootsCompleted: 0,
    rootsRequested: 1,
    fatalError: null,
    securityAnalysis: 'disabled',
    suspiciousCount: 0,
    source: 'index',
    durationMs,
    journalId: null,
  }
}

/**
 * Reuses a persisted index only after OS change tracking proves that the root
 * has not changed. Any uncertainty takes the ordinary filesystem path.
 */
export function scanDirectoryIndexedStreaming(
  dirPath: string,
  options: ScanOptions,
  onEvent: (event: ScanEventV1) => void,
  onDone: (completion: ScanCompletion) => void,
): () => void {
  const startedAt = performance.now()
  const profile = options.profile ?? 'interactive'
  let cancelled = false
  let completed = false
  let rawCancel: (() => void) | null = null

  const finish = (summary: ScanSummaryV1) => {
    if (completed) return
    completed = true
    recordLocalScanMetric(profile, summary)
    onDone({ summary })
  }

  const runFilesystemScan = () => {
    const mutationGuard = beginScanMutationGuard(dirPath)
    const captured: ScanEntryV1[] = []
    let captureComplete = true
    rawCancel = scanFilesystemStreaming(
      dirPath,
      options,
      (event) => {
        if (event.event === 'entry') {
          if (captured.length < MAX_CAPTURED_INDEX_ENTRIES) captured.push(event)
          else captureComplete = false
        }
        onEvent(event)
      },
      ({ summary }) => {
        rawCancel = null
        const stableWithoutJournal = mutationGuard.isStable()
        mutationGuard.dispose()
        const finalSummary: ScanSummaryV1 = {
          ...summary,
          source: 'filesystem',
          durationMs: performance.now() - startedAt,
        }
        if (captureComplete
            && captured.length === finalSummary.entryCount
            && finalSummary.complete
            && !finalSummary.cancelled
            && finalSummary.issueCount === 0
            && !finalSummary.fatalError
            && (typeof finalSummary.journalId === 'string' || stableWithoutJournal)) {
          void commitVerifiedScanIndex(dirPath, captured, finalSummary.journalId ?? null)
        }
        finish(finalSummary)
      },
    )
  }

  void getVerifiedScanIndex(dirPath).then(async (cachedEntries) => {
    if (cancelled) {
      finish(cancelledSummary(options, 0, performance.now() - startedAt))
      return
    }
    if (!cachedEntries) {
      runFilesystemScan()
      return
    }

    let emitted = 0
    for (let offset = 0; offset < cachedEntries.length; offset += REPLAY_CHUNK_SIZE) {
      if (cancelled) {
        finish(cancelledSummary(options, emitted, performance.now() - startedAt))
        return
      }
      const end = Math.min(cachedEntries.length, offset + REPLAY_CHUNK_SIZE)
      for (let index = offset; index < end; index += 1) {
        onEvent({ ...cachedEntries[index], scanId: options.scanId, rootId: options.rootId })
        emitted += 1
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    finish({
      protocolVersion: SCAN_PROTOCOL_VERSION,
      event: 'summary',
      scanId: options.scanId,
      rootId: options.rootId,
      complete: true,
      cancelled: false,
      entryCount: emitted,
      issueCount: 0,
      rootsCompleted: 1,
      rootsRequested: 1,
      fatalError: null,
      securityAnalysis: 'disabled',
      suspiciousCount: 0,
      source: 'index',
      durationMs: performance.now() - startedAt,
      journalId: null,
    })
  }).catch(() => {
    if (cancelled) finish(cancelledSummary(options, 0, performance.now() - startedAt))
    else runFilesystemScan()
  })

  return () => {
    cancelled = true
    rawCancel?.()
  }
}
