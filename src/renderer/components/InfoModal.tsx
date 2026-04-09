import { useState, useEffect } from 'react'
import { DiskEntry, ItemStats } from '../types'
import { formatSize } from '../utils/format'

// ─── Icons ───────────────────────────────────────────────────────────────────

function FolderIcon() {
  return (
    <svg className="w-7 h-7 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg className="w-7 h-7 text-zinc-400" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
        clipRule="evenodd"
      />
    </svg>
  )
}

function SparkleIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-violet-400" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M5 2a1 1 0 011 1v1h1a1 1 0 010 2H6v1a1 1 0 01-2 0V6H3a1 1 0 010-2h1V3a1 1 0 011-1zm0 10a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1v-1a1 1 0 011-1zM12 2a1 1 0 01.967.744L14.146 7.2 17.5 9.134a1 1 0 010 1.732l-3.354 1.935-1.18 4.455a1 1 0 01-1.933 0L9.854 12.8 6.5 10.866a1 1 0 010-1.732l3.354-1.935 1.18-4.455A1 1 0 0112 2z"
        clipRule="evenodd"
      />
    </svg>
  )
}

// ─── Detail row ───────────────────────────────────────────────────────────────

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-4 px-4 py-2.5">
      <span className="text-xs text-zinc-500 w-20 shrink-0 pt-px">{label}</span>
      <span className={`text-xs text-zinc-300 break-all leading-relaxed ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface InfoModalProps {
  entry: DiskEntry
  onClose: () => void
  onTrash: (entry: DiskEntry) => void
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(iso))
}

function ollamaErrorMessage(raw: string): string {
  if (raw.includes('ECONNREFUSED') || raw.includes('fetch') || raw.includes('not running')) {
    return 'Ollama is not running. Start it with: ollama serve'
  }
  if (raw.includes('No models')) return raw
  return raw
}

export function InfoModal({ entry, onClose, onTrash }: InfoModalProps) {
  const [stats, setStats] = useState<ItemStats | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState('')
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [analysisComplete, setAnalysisComplete] = useState(false)

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Load stats + start AI stream
  useEffect(() => {
    window.electronAPI.getItemStats(entry.path).then((result) => {
      if (!('error' in result)) setStats(result)
    })

    window.electronAPI.removeOllamaListeners()
    window.electronAPI.onOllamaModel((m) => setModel(m))
    window.electronAPI.onOllamaToken((token) => setAnalysis((prev) => prev + token))
    window.electronAPI.onOllamaDone((err) => {
      setAnalysisComplete(true)
      if (err) setAnalysisError(err)
    })
    window.electronAPI.startOllamaAnalysis({
      path: entry.path,
      name: entry.name,
      isDir: entry.isDir,
      sizeKB: entry.sizeKB
    })

    return () => {
      window.electronAPI.cancelOllamaAnalysis()
      window.electronAPI.removeOllamaListeners()
    }
  }, [entry])

  // Parse the recommendation tag from the streamed text
  const upper = analysis.toUpperCase()
  const recommendation: 'KEEP' | 'DELETE' | null = upper.includes('RECOMMENDATION: DELETE')
    ? 'DELETE'
    : upper.includes('RECOMMENDATION: KEEP')
    ? 'KEEP'
    : null

  // Strip the recommendation line from the visible text
  const visibleText = analysis
    .replace(/\nRECOMMENDATION: (KEEP|DELETE)\s*$/i, '')
    .trim()

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-white/10 rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:w-[500px] sm:max-w-full max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-4 px-6 pt-6 pb-5">
          <div className="w-14 h-14 rounded-2xl bg-zinc-800 border border-white/5 flex items-center justify-center shrink-0">
            {entry.isDir ? <FolderIcon /> : <FileIcon />}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold text-zinc-100 truncate leading-tight">
              {entry.name}
            </h2>
            <p className="text-sm text-zinc-500 mt-1">
              {formatSize(entry.sizeKB)}
              <span className="mx-1.5 text-zinc-700">·</span>
              {entry.isDir ? 'Folder' : 'File'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-500 hover:text-zinc-200 transition-colors shrink-0"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto min-h-0 px-6 pb-2 flex flex-col gap-5">

          {/* Details */}
          <div className="rounded-xl border border-white/[0.06] divide-y divide-white/[0.06] overflow-hidden">
            <DetailRow label="Path" value={entry.path} mono />
            {stats ? (
              <>
                <DetailRow label="Modified" value={formatDate(stats.modified)} />
                <DetailRow label="Created"  value={formatDate(stats.created)} />
                <DetailRow
                  label="Size"
                  value={`${stats.sizeBytes.toLocaleString()} bytes`}
                />
              </>
            ) : (
              <div className="px-4 py-3 flex items-center gap-2 text-xs text-zinc-600">
                <div className="w-3 h-3 rounded-full border border-transparent border-t-zinc-600 animate-spin" />
                Loading…
              </div>
            )}
          </div>

          {/* AI Analysis */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <SparkleIcon />
              <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                AI Analysis
              </span>
              {model && (
                <span className="ml-auto text-xs text-zinc-600 font-mono">{model}</span>
              )}
            </div>

            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 min-h-[110px]">
              {!analysis && !analysisError && (
                <div className="flex items-center gap-2.5 text-sm text-zinc-500">
                  <div className="w-4 h-4 rounded-full border-2 border-transparent border-t-violet-500 animate-spin shrink-0" />
                  {model ? `Analyzing with ${model}…` : 'Connecting to Ollama…'}
                </div>
              )}

              {analysisError && (
                <p className="text-sm text-red-400/90 leading-relaxed">
                  {ollamaErrorMessage(analysisError)}
                </p>
              )}

              {visibleText && (
                <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
                  {visibleText}
                  {!analysisComplete && (
                    <span className="inline-block w-0.5 h-3.5 bg-zinc-400/70 ml-0.5 align-middle animate-pulse" />
                  )}
                </p>
              )}
            </div>

            {/* Recommendation badge */}
            {recommendation && (
              <div
                className={[
                  'mt-3 flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm font-medium border',
                  recommendation === 'DELETE'
                    ? 'bg-red-950/50 border-red-900/40 text-red-300'
                    : 'bg-green-950/50 border-green-900/40 text-green-300'
                ].join(' ')}
              >
                <span className="text-base leading-none">
                  {recommendation === 'DELETE' ? '✗' : '✓'}
                </span>
                AI recommends:{' '}
                <strong className="font-semibold">{recommendation}</strong>
              </div>
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 mt-2 border-t border-white/[0.06]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-sm text-zinc-300 transition-colors"
          >
            Keep
          </button>
          <button
            onClick={() => { onTrash(entry); onClose() }}
            className="px-4 py-2 rounded-lg bg-red-600/80 hover:bg-red-600 text-sm text-white font-medium transition-colors"
          >
            Move to Trash
          </button>
        </div>
      </div>
    </div>
  )
}
