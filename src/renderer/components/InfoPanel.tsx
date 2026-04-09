import { useState, useEffect } from 'react'
import { DiskEntry, ItemStats } from '../types'
import { formatSize } from '../utils/format'
import { isCriticalPath } from '../utils/criticalPaths'

// ─── Icons ────────────────────────────────────────────────────────────────────

function FolderIcon() {
  return (
    <svg className="w-5 h-5 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg className="w-5 h-5 text-zinc-400" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
        clipRule="evenodd"
      />
    </svg>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  }).format(new Date(iso))
}

function isOllamaNotFound(raw: string): boolean {
  return raw.includes('ECONNREFUSED') || raw.includes('ENOENT') ||
    raw.includes('fetch') || raw.includes('not running') || raw.includes('Failed to fetch')
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="text-xs text-zinc-500 w-16 shrink-0 pt-px leading-tight">{label}</span>
      <span className={`text-xs text-zinc-300 break-all leading-relaxed ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface InfoPanelProps {
  entry: DiskEntry
  isSelected: boolean
  onClose: () => void
  onToggleSelect: (entry: DiskEntry) => void
}

export function InfoPanel({ entry, isSelected, onClose, onToggleSelect }: InfoPanelProps) {
  const [mounted, setMounted] = useState(false)
  const [stats, setStats] = useState<ItemStats | null>(null)
  const [statsError, setStatsError] = useState(false)
  const [model, setModel] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState('')
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [analysisComplete, setAnalysisComplete] = useState(false)
  const [aiHidden, setAiHidden] = useState(() => localStorage.getItem('vectra:aiHidden') === 'true')

  // Trigger slide-in on mount
  useEffect(() => { setMounted(true) }, [])

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Load stats + start AI stream
  useEffect(() => {
    setStats(null)
    setStatsError(false)
    setModel(null)
    setAnalysis('')
    setAnalysisError(null)
    setAnalysisComplete(false)

    window.electronAPI.getItemStats(entry.path).then((result) => {
      if ('error' in result) setStatsError(true)
      else setStats(result)
    }).catch(() => setStatsError(true))

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

  const upper = analysis.toUpperCase()
  const recommendation: 'KEEP' | 'DELETE' | null = upper.includes('RECOMMENDATION: DELETE')
    ? 'DELETE'
    : upper.includes('RECOMMENDATION: KEEP')
    ? 'KEEP'
    : null

  const visibleText = analysis.replace(/\nRECOMMENDATION: (KEEP|DELETE)\s*$/i, '').trim()

  return (
    <div
      className={[
        'flex flex-col h-full bg-zinc-950',
        'transition-opacity duration-150 ease-out',
        mounted ? 'opacity-100' : 'opacity-0'
      ].join(' ')}
    >
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-white/5">
        <div className="w-9 h-9 rounded-lg bg-zinc-900 border border-white/5 flex items-center justify-center shrink-0">
          {entry.isDir ? <FolderIcon /> : <FileIcon />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-zinc-100 truncate leading-tight">{entry.name}</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            {formatSize(entry.sizeKB)}
            <span className="mx-1 text-zinc-700">·</span>
            {entry.isDir ? 'Folder' : 'File'}
          </p>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-500 hover:text-zinc-200 transition-colors shrink-0"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 flex flex-col gap-4">

        {/* Details */}
        <section>
          <h3 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-1">
            Details
          </h3>
          <div className="divide-y divide-white/[0.04]">
            <Row label="Path" value={entry.path} mono />
            {stats ? (
              <>
                <Row label="Modified" value={formatDate(stats.modified)} />
                <Row label="Created"  value={formatDate(stats.created)} />
                <Row label="On disk"  value={`${stats.sizeBytes.toLocaleString()} B`} />
              </>
            ) : statsError ? (
              <div className="py-2 text-xs text-zinc-600">Unable to read file metadata.</div>
            ) : (
              <div className="py-2 flex items-center gap-2 text-xs text-zinc-600">
                <div className="w-3 h-3 rounded-full border border-transparent border-t-zinc-600 animate-spin shrink-0" />
                Loading…
              </div>
            )}
          </div>
        </section>

        {/* AI Analysis */}
        {aiHidden ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-700">AI analysis hidden</span>
            <button
              onClick={() => { localStorage.removeItem('vectra:aiHidden'); setAiHidden(false) }}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors underline"
            >
              Enable
            </button>
          </div>
        ) : (
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <svg className="w-3 h-3 text-violet-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 2a1 1 0 011 1v1h1a1 1 0 010 2H6v1a1 1 0 01-2 0V6H3a1 1 0 010-2h1V3a1 1 0 011-1zm0 10a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1v-1a1 1 0 011-1zM12 2a1 1 0 01.967.744L14.146 7.2 17.5 9.134a1 1 0 010 1.732l-3.354 1.935-1.18 4.455a1 1 0 01-1.933 0L9.854 12.8 6.5 10.866a1 1 0 010-1.732l3.354-1.935 1.18-4.455A1 1 0 0112 2z" clipRule="evenodd" />
              </svg>
              <h3 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest">
                AI Analysis
              </h3>
              {model && (
                <span className="ml-auto text-[10px] text-zinc-700 font-mono truncate">{model}</span>
              )}
            </div>

            <div className="rounded-lg bg-white/[0.03] border border-white/[0.05] p-3 min-h-[80px]">
              {/* Ollama not found */}
              {analysisError && isOllamaNotFound(analysisError) ? (
                <div className="flex flex-col gap-3">
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    AI analysis requires <span className="text-zinc-200 font-medium">Ollama</span> — a free local AI runtime.
                  </p>
                  <div className="flex items-center gap-2.5">
                    <button
                      onClick={() => window.electronAPI.openExternal('https://ollama.com/download')}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-violet-600/70 hover:bg-violet-600 text-[11px] text-white font-medium transition-colors"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Download Ollama
                    </button>
                    <button
                      onClick={() => { localStorage.setItem('vectra:aiHidden', 'true'); setAiHidden(true) }}
                      className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
                    >
                      Don't show this
                    </button>
                  </div>
                </div>
              ) : analysisError ? (
                <p className="text-xs text-red-400/80 leading-relaxed whitespace-pre-line">{analysisError}</p>
              ) : !analysis ? (
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-transparent border-t-violet-500 animate-spin shrink-0" />
                  {model ? 'Analyzing…' : 'Connecting to Ollama…'}
                </div>
              ) : (
                <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">
                  {visibleText}
                  {!analysisComplete && (
                    <span className="inline-block w-0.5 h-3 bg-zinc-400/70 ml-0.5 align-middle animate-pulse" />
                  )}
                </p>
              )}
            </div>

            {recommendation && (
              <div className={[
                'flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border',
                recommendation === 'DELETE'
                  ? 'bg-red-950/40 border-red-900/30 text-red-300'
                  : 'bg-green-950/40 border-green-900/30 text-green-300'
              ].join(' ')}>
                <span>{recommendation === 'DELETE' ? '✗' : '✓'}</span>
                AI recommends: <strong>{recommendation}</strong>
              </div>
            )}
          </section>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-white/5 px-4 py-3 flex flex-col gap-2">
        {isCriticalPath(entry.path) && (
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <svg className="w-3 h-3 text-amber-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <span className="text-[10px] text-amber-400 leading-snug">This is a protected system location and cannot be added to selection.</span>
          </div>
        )}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-zinc-300 transition-colors"
          >
            Close
          </button>
          <button
            onClick={() => onToggleSelect(entry)}
            disabled={isCriticalPath(entry.path)}
            className={[
              'flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors',
              'disabled:opacity-30 disabled:cursor-not-allowed',
              isSelected
                ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
                : 'bg-blue-600/80 hover:bg-blue-600 text-white'
            ].join(' ')}
          >
            {isSelected ? 'Remove from Selection' : 'Add to Selection'}
          </button>
        </div>
      </div>
    </div>
  )
}
