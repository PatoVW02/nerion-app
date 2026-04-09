import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { DiskEntry } from '../types'
import { formatSize } from '../utils/format'
import { isCriticalPath } from '../utils/criticalPaths'

// ─── Animated checkmark ───────────────────────────────────────────────────────

function AnimatedCheckmark() {
  return (
    <>
      <style>{`
        @keyframes check-pop {
          0%   { transform: scale(0.4); opacity: 0; }
          60%  { transform: scale(1.08); opacity: 1; }
          100% { transform: scale(1);   opacity: 1; }
        }
        @keyframes circle-draw {
          to { stroke-dashoffset: 0; }
        }
        @keyframes path-draw {
          to { stroke-dashoffset: 0; }
        }
        .check-pop  { animation: check-pop  0.45s cubic-bezier(0.34,1.56,0.64,1) forwards; }
        .check-circle { stroke-dasharray: 163; stroke-dashoffset: 163;
                        animation: circle-draw 0.5s ease-out 0.1s forwards; }
        .check-path   { stroke-dasharray: 44;  stroke-dashoffset: 44;
                        animation: path-draw   0.35s ease-out 0.5s forwards; }
      `}</style>
      <div className="check-pop" style={{ opacity: 0 }}>
        <svg width="80" height="80" viewBox="0 0 54 54" fill="none">
          <circle className="check-circle" cx="27" cy="27" r="26"
            stroke="#22c55e" strokeWidth="2" />
          <path className="check-path" d="M15 27l9 9 16-17"
            stroke="#22c55e" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </>
  )
}

// ─── Done view ────────────────────────────────────────────────────────────────

function DoneView({ freedKB, onDone }: { freedKB: number; onDone: () => void }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => { const t = setTimeout(() => setVisible(true), 120); return () => clearTimeout(t) }, [])

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 px-8">
      <AnimatedCheckmark />
      <div className={[
        'text-center transition-all duration-500 ease-out',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
      ].join(' ')}>
        <p className="text-2xl font-semibold text-zinc-100 tabular-nums">
          {formatSize(freedKB)} freed
        </p>
        <p className="text-sm text-zinc-500 mt-1.5">Items have been moved to the Trash</p>
      </div>
      <button
        onClick={onDone}
        className={[
          'px-8 py-2 rounded-lg bg-white/8 hover:bg-white/12 text-sm text-zinc-300',
          'transition-all duration-500 ease-out delay-100',
          visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
        ].join(' ')}
      >
        Done
      </button>
    </div>
  )
}

// ─── Review row ───────────────────────────────────────────────────────────────

interface ReviewRowProps {
  entry: DiskEntry
  checked: boolean
  removing: boolean
  deleting: boolean
  onToggle: () => void
}

function ReviewRow({ entry, checked, removing, deleting, onToggle }: ReviewRowProps) {
  const critical = isCriticalPath(entry.path)
  const parentPath = entry.path.replace(/\/[^/]+$/, '') || '/'

  return (
    <div className={[
      'flex items-center gap-3 px-6 border-b border-white/[0.04] overflow-hidden',
      'transition-all duration-300 ease-out',
      removing
        ? 'max-h-0 opacity-0 -translate-x-6 py-0 border-transparent'
        : 'max-h-[72px] opacity-100 translate-x-0 py-3'
    ].join(' ')}>

      {/* Checkbox */}
      <button
        onClick={onToggle}
        disabled={deleting || critical}
        className={[
          'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
          'disabled:cursor-not-allowed',
          critical
            ? 'border-zinc-700 bg-transparent opacity-30'
            : checked
            ? 'bg-blue-600 border-blue-600'
            : 'border-zinc-600 bg-transparent'
        ].join(' ')}
      >
        {checked && !critical && (
          <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </button>

      {/* Icon */}
      {entry.isDir ? (
        <svg className="w-4 h-4 text-blue-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        </svg>
      ) : (
        <svg className="w-4 h-4 text-zinc-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
        </svg>
      )}

      {/* Name + path */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className={[
            'text-sm truncate leading-snug',
            critical ? 'text-zinc-500' : 'text-zinc-200'
          ].join(' ')}>
            {entry.name}
          </span>
          <span className="text-xs text-zinc-500 tabular-nums shrink-0">{formatSize(entry.sizeKB)}</span>
        </div>
        <span className="text-[11px] text-zinc-600 font-mono truncate block mt-0.5">{parentPath}</span>
      </div>

      {/* Protected badge */}
      {critical && (
        <span className="text-[10px] text-amber-500 shrink-0 border border-amber-500/30 rounded px-1.5 py-0.5">
          Protected
        </span>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface ReviewPanelProps {
  entries: DiskEntry[]
  onConfirm: (paths: string[]) => Promise<void>
  onCancel: () => void
}

export function ReviewPanel({ entries, onConfirm, onCancel }: ReviewPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(entries.filter(e => !isCriticalPath(e.path)).map(e => e.path))
  )
  const [phase, setPhase] = useState<'review' | 'deleting' | 'done'>('review')
  const [removingPaths, setRemovingPaths] = useState<Set<string>>(new Set())
  const [freedKB, setFreedKB] = useState(0)
  const [mounted, setMounted] = useState(false)

  useEffect(() => { requestAnimationFrame(() => setMounted(true)) }, [])

  const toggle = useCallback((path: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }, [])

  const nonCritical = entries.filter(e => !isCriticalPath(e.path))
  const allChecked = nonCritical.length > 0 && nonCritical.every(e => selected.has(e.path))
  const someChecked = nonCritical.some(e => selected.has(e.path))

  const toggleAll = useCallback(() => {
    setSelected(allChecked
      ? new Set()
      : new Set(nonCritical.map(e => e.path))
    )
  }, [allChecked, nonCritical])

  const selectedEntries = entries.filter(e => selected.has(e.path))
  const totalSelectedKB = selectedEntries.reduce((s, e) => s + e.sizeKB, 0)

  const handleConfirm = useCallback(async () => {
    if (phase !== 'review' || selectedEntries.length === 0) return
    const toDelete = [...selectedEntries]
    setFreedKB(toDelete.reduce((s, e) => s + e.sizeKB, 0))
    setPhase('deleting')

    // Stagger items out: cap total animation at 700ms
    const stagger = Math.min(55, 700 / Math.max(toDelete.length, 1))
    toDelete.forEach((entry, i) => {
      setTimeout(() => {
        setRemovingPaths(prev => new Set([...prev, entry.path]))
      }, i * stagger)
    })

    // Run deletion in parallel with animation
    await onConfirm(toDelete.map(e => e.path))

    // Show done state after last animation finishes
    setTimeout(() => setPhase('done'), toDelete.length * stagger + 380)
  }, [phase, selectedEntries, onConfirm])

  return createPortal(
    <div
      className={[
        'fixed inset-0 z-50 flex flex-col bg-zinc-950',
        'transition-opacity duration-200 ease-out',
        mounted ? 'opacity-100' : 'opacity-0'
      ].join(' ')}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >

      {phase === 'done' ? (
        <>
          {/* Spacer matching header height so done view is vertically centred below traffic lights */}
          <div
            className="shrink-0 border-b border-white/5"
            style={{ paddingTop: '36px' } as React.CSSProperties}
          />
          <DoneView freedKB={freedKB} onDone={onCancel} />
        </>
      ) : (
        <>
          {/* Header — padded top to clear macOS traffic lights */}
          <div
            className="shrink-0 flex items-center gap-3 px-6 pb-4 border-b border-white/5"
            style={{ paddingTop: '36px' } as React.CSSProperties}
          >
            <button
              onClick={onCancel}
              disabled={phase === 'deleting'}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
            <h2 className="flex-1 text-center text-sm font-semibold text-zinc-100">
              Review Deletion
            </h2>
            <span className="text-xs text-zinc-600 w-16 text-right tabular-nums">
              {selectedEntries.length} of {entries.length}
            </span>
          </div>

          {/* Summary strip */}
          <div className="shrink-0 flex items-center justify-between px-6 py-2.5 bg-red-950/20 border-b border-red-900/20">
            <span className="text-xs text-red-400">
              {selectedEntries.length === 0
                ? 'Nothing selected'
                : `${selectedEntries.length} ${selectedEntries.length === 1 ? 'item' : 'items'} will be moved to Trash`}
            </span>
            {selectedEntries.length > 0 && (
              <span className="text-xs font-medium text-red-300 tabular-nums">
                {formatSize(totalSelectedKB)}
              </span>
            )}
          </div>

          {/* Select-all row */}
          {nonCritical.length > 1 && (
            <div className="shrink-0 flex items-center gap-3 px-6 py-2.5 border-b border-white/5">
              <button
                onClick={toggleAll}
                disabled={phase === 'deleting'}
                className={[
                  'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
                  'disabled:cursor-not-allowed',
                  allChecked
                    ? 'bg-blue-600 border-blue-600'
                    : someChecked
                    ? 'bg-blue-900/60 border-blue-500'
                    : 'border-zinc-600 bg-transparent'
                ].join(' ')}
              >
                {allChecked && (
                  <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {!allChecked && someChecked && (
                  <svg className="w-2.5 h-2.5 text-blue-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 12h14" />
                  </svg>
                )}
              </button>
              <span className="text-xs text-zinc-500 select-none">
                {allChecked ? 'Deselect all' : 'Select all'}
              </span>
            </div>
          )}

          {/* List */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {entries.map(entry => (
              <ReviewRow
                key={entry.path}
                entry={entry}
                checked={selected.has(entry.path)}
                removing={removingPaths.has(entry.path)}
                deleting={phase === 'deleting'}
                onToggle={() => toggle(entry.path)}
              />
            ))}
          </div>

          {/* Footer */}
          <div className="shrink-0 border-t border-white/5 px-6 py-4 flex gap-3">
            <button
              onClick={onCancel}
              disabled={phase === 'deleting'}
              className="px-5 py-2 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed text-xs text-zinc-300 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={selectedEntries.length === 0 || phase === 'deleting'}
              className="flex-1 py-2 rounded-lg bg-red-600/80 hover:bg-red-600 disabled:opacity-30 disabled:cursor-not-allowed text-xs text-white font-medium transition-colors flex items-center justify-center gap-2"
            >
              {phase === 'deleting' ? (
                <>
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Moving to Trash…
                </>
              ) : (
                `Move ${selectedEntries.length} ${selectedEntries.length === 1 ? 'item' : 'items'} to Trash · ${formatSize(totalSelectedKB)}`
              )}
            </button>
          </div>
        </>
      )}
    </div>,
    document.body
  )
}
