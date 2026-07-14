import { app } from 'electron'
import { appendFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { ScanSummaryV1 } from '../shared/contracts'
import { loadSettings } from './settings'

const METRICS_VERSION = 1
const MAX_METRICS_BYTES = 256 * 1024
const RETAINED_METRICS = 256

export interface LocalScanMetric {
  version: typeof METRICS_VERSION
  recordedAt: string
  platform: NodeJS.Platform
  profile: 'interactive' | 'background'
  source: 'filesystem' | 'index'
  durationMs: number
  entryCount: number
  issueCount: number
  complete: boolean
  cancelled: boolean
}

export function buildLocalScanMetric(
  profile: 'interactive' | 'background',
  summary: ScanSummaryV1,
): LocalScanMetric {
  return {
    version: METRICS_VERSION,
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    profile,
    source: summary.source ?? 'filesystem',
    durationMs: Math.max(0, Math.round(summary.durationMs ?? 0)),
    entryCount: Math.max(0, Math.round(summary.entryCount)),
    issueCount: Math.max(0, Math.round(summary.issueCount)),
    complete: summary.complete,
    cancelled: summary.cancelled,
  }
}

async function rotateIfNeeded(filePath: string): Promise<void> {
  try {
    const info = await stat(filePath)
    if (info.size <= MAX_METRICS_BYTES) return
    const contents = await readFile(filePath, 'utf8')
    const lines = contents.split(/\r?\n/).filter(Boolean).slice(-RETAINED_METRICS)
    const tempPath = `${filePath}.${process.pid}.tmp`
    await writeFile(tempPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tempPath, filePath)
  } catch {
    // Diagnostics are best-effort and must never make a scan fail.
  }
}

export function recordLocalScanMetric(profile: 'interactive' | 'background', summary: ScanSummaryV1): void {
  let enabled = false
  try { enabled = loadSettings().localPerformanceDiagnostics === true } catch { return }
  if (!enabled) return

  const filePath = path.join(app.getPath('userData'), 'scan-performance.jsonl')
  const line = `${JSON.stringify(buildLocalScanMetric(profile, summary))}\n`
  void appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 })
    .then(() => rotateIfNeeded(filePath))
    .catch(() => {})
}

export function clearLocalScanMetrics(): void {
  const filePath = path.join(app.getPath('userData'), 'scan-performance.jsonl')
  void rm(filePath, { force: true }).catch(() => {})
}
