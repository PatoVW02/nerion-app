import { useState, useCallback, useEffect, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import { DiskEntry } from '../types'
import { formatSize } from '../utils/format'
import { isCriticalPath, isContentOnlyProtectedRoot } from '../utils/criticalPaths'
import { buildCleanableTree, TreeNode } from '../utils/buildTree'
import { HeaderFrame } from './HeaderFrame'

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

// ─── Tree helpers ─────────────────────────────────────────────────────────────

/** Collect paths of all selectable (cleanable) leaf entries under a node. */
function getSelectableDescendants(node: TreeNode): string[] {
  const result: string[] = []
  if (node.isCleanable && node.entry) result.push(node.path)
  for (const child of node.children) result.push(...getSelectableDescendants(child))
  return result
}

/** Returns true when every selectable item under this node is animating out or confirmed deleted. */
function allNodeRemoving(node: TreeNode, removingOrConfirmed: Set<string>): boolean {
  if (node.isCleanable && node.entry) return removingOrConfirmed.has(node.path)
  if (node.children.length === 0) return false
  return node.children.every(c => allNodeRemoving(c, removingOrConfirmed))
}

// ─── Tree item (recursive, mirrors SmartCleanPanel's TreeItem) ────────────────

interface ReviewTreeItemProps {
  node: TreeNode
  depth: number
  homeDir: string
  selected: Set<string>
  removingPaths: Set<string>
  confirmedDeletedPaths: Set<string>
  deleting: boolean
  onToggle: (path: string) => void
  /** Incremented to trigger a global expand (expanded=true) or collapse (expanded=false). */
  expandKey: { seq: number; expanded: boolean }
}

const ReviewTreeItem = memo(function ReviewTreeItem({
  node, depth, homeDir, selected, removingPaths, confirmedDeletedPaths, deleting, onToggle, expandKey,
}: ReviewTreeItemProps) {
  const [expanded, setExpanded] = useState(true)

  const hasChildren = node.children.length > 0

  // Respond to global expand / collapse — fires only when seq changes, then local state takes over
  useEffect(() => {
    if (!hasChildren) return
    setExpanded(expandKey.expanded)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandKey.seq])
  const isDir = node.entry ? node.entry.isDir : true
  const critical = isCriticalPath(node.path)
  const contentOnlyProtectedRoot = critical && isDir && isContentOnlyProtectedRoot(node.path)

  const selectableDescendants = useMemo(
    () => (hasChildren ? getSelectableDescendants(node) : null),
    // node identity is stable from buildCleanableTree memoisation
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node],
  )

  // Protected folders can still be used as a fast "select contents" toggle,
  // but the protected folder path itself must never be selected for deletion.
  const protectedContentsTargets = useMemo(() => {
    if (!critical || !isDir) return null
    const all = getSelectableDescendants(node)
    return all.filter(p => p !== node.path)
  }, [critical, isDir, node])

  const checkboxTargets = useMemo(() => {
    // Protected folder row toggles only descendants (contents), not itself.
    if (protectedContentsTargets && protectedContentsTargets.length > 0) return protectedContentsTargets
    // If a protected home root appears as a leaf in review, selecting it is safe:
    // main-process deletion expands it to children and keeps the root folder.
    if (contentOnlyProtectedRoot && node.isCleanable && node.entry) return [node.path]
    // Regular selectable leaf.
    if (node.isCleanable && node.entry) return [node.path]
    // Intermediate folder toggles all selectable descendants.
    return selectableDescendants ?? []
  }, [protectedContentsTargets, contentOnlyProtectedRoot, node, selectableDescendants])

  const allTargetsSelected =
    checkboxTargets.length > 0 && checkboxTargets.every(p => selected.has(p))
  const someTargetsSelected =
    checkboxTargets.some(p => selected.has(p))

  const batchToggle = useCallback(() => {
    if (checkboxTargets.length === 0) return
    const allSelected = checkboxTargets.every(p => selected.has(p))
    for (const p of checkboxTargets) {
      if (allSelected ? selected.has(p) : !selected.has(p)) onToggle(p)
    }
  }, [checkboxTargets, selected, onToggle])

  // Fade-out animation for leaf items being deleted
  const removing = node.isCleanable && !!node.entry && removingPaths.has(node.path)
  // Confirmed deleted: already gone — collapse instantly with no animation
  const confirmed = node.isCleanable && !!node.entry && confirmedDeletedPaths.has(node.path)

  // Hide entire subtree once all its selectable items are animating out or confirmed deleted
  const removingOrConfirmed = useMemo(
    () => new Set([...removingPaths, ...confirmedDeletedPaths]),
    [removingPaths, confirmedDeletedPaths]
  )
  if (!node.isCleanable && node.children.length > 0 && allNodeRemoving(node, removingOrConfirmed)) {
    return null
  }

  return (
    <>
      <div
        className={[
          'flex items-center gap-1.5 py-2 hover:bg-white/[0.04] transition-colors',
          confirmed
            ? 'hidden'
            : removing
            ? 'opacity-0 overflow-hidden max-h-0 py-0 pointer-events-none transition-all duration-300 ease-out'
            : '',
        ].filter(Boolean).join(' ')}
        style={{ paddingLeft: 12 + depth * 16, paddingRight: 12 }}
      >
        {/* Expand/collapse chevron — invisible spacer for leaves */}
        <button
          onClick={() => hasChildren && setExpanded(v => !v)}
          className={[
            'w-4 h-4 flex items-center justify-center shrink-0 rounded text-zinc-500 hover:text-zinc-300 transition-colors',
            !hasChildren && 'invisible',
          ].filter(Boolean).join(' ')}
        >
          <svg
            className={['w-3 h-3 transition-transform', expanded ? 'rotate-90' : ''].join(' ')}
            fill="currentColor" viewBox="0 0 20 20"
          >
            <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
          </svg>
        </button>

        {/* Checkbox */}
        {checkboxTargets.length > 0 ? (
          // Selectable row (leaf, intermediate folder, or protected-folder contents selector)
          <button
            onClick={batchToggle}
            disabled={deleting}
            className={[
              'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
              'disabled:cursor-not-allowed',
              critical
                ? allTargetsSelected
                  ? 'bg-amber-600/90 border-amber-500'
                  : someTargetsSelected
                  ? 'bg-amber-900/60 border-amber-500'
                  : 'border-amber-700/60 bg-transparent'
                : allTargetsSelected
                ? 'bg-blue-600 border-blue-600'
                : someTargetsSelected
                ? 'bg-blue-900/60 border-blue-500'
                : 'border-zinc-600 bg-transparent',
            ].join(' ')}
          >
            {allTargetsSelected && (
              <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {!allTargetsSelected && someTargetsSelected && (
              <svg className="w-2.5 h-2.5 text-blue-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 12h14" />
              </svg>
            )}
          </button>
        ) : (
          <div className="w-4 h-4 shrink-0" />
        )}

        {/* Folder / file icon — dimmed for intermediate nodes */}
        {isDir
          ? <svg
              className={['w-3.5 h-3.5 shrink-0', node.isCleanable ? 'text-blue-400' : 'text-zinc-600'].join(' ')}
              fill="currentColor" viewBox="0 0 20 20"
            >
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
          : <svg
              className={['w-3.5 h-3.5 shrink-0', node.isCleanable ? 'text-zinc-300' : 'text-zinc-600'].join(' ')}
              fill="currentColor" viewBox="0 0 20 20"
            >
              <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
            </svg>
        }

        {/* Label + size */}
        <button
          onClick={() => {
            if (checkboxTargets.length === 0) return
            batchToggle()
          }}
          className="flex-1 min-w-0 flex items-center justify-between gap-1 text-left min-w-0"
        >
          <span className={[
            'text-xs truncate leading-snug',
            critical
              ? 'text-zinc-500'
              : node.isCleanable
              ? 'text-zinc-200 font-medium'
              : 'text-zinc-500',
          ].join(' ')}>
            {node.label}
          </span>
          {node.totalKB > 0 && (
            <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">
              {formatSize(node.totalKB)}
            </span>
          )}
        </button>

        {/* Protected badge */}
        {critical && (
          <span className="text-[10px] text-amber-500 shrink-0 border border-amber-500/30 rounded px-1.5 py-0.5">
            Protected
          </span>
        )}
      </div>

      {/* Recurse into children */}
      {expanded && hasChildren && node.children.map(child => (
        <ReviewTreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          homeDir={homeDir}
          selected={selected}
          removingPaths={removingPaths}
          confirmedDeletedPaths={confirmedDeletedPaths}
          deleting={deleting}
          onToggle={onToggle}
          expandKey={expandKey}
        />
      ))}
    </>
  )
})

// ─── Main component ───────────────────────────────────────────────────────────

interface ReviewPanelProps {
  entries: DiskEntry[]
  isPremium: boolean
  remainingQuota: number
  /** Paths confirmed actually deleted so far — used to update the tree live during deletion. */
  confirmedDeletedPaths: Set<string>
  onConfirm: (paths: string[], totalKB: number) => Promise<string | null>
  onCancel: () => void
  onDone: () => void
  onUpgradeClick: () => void
}

export function ReviewPanel({ entries, isPremium, remainingQuota, confirmedDeletedPaths, onConfirm, onCancel, onDone, onUpgradeClick }: ReviewPanelProps) {
  const selectableInReview = entries.filter(
    (e) => !isCriticalPath(e.path) || isContentOnlyProtectedRoot(e.path),
  )

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(selectableInReview.map(e => e.path)),
  )
  const [phase, setPhase] = useState<'review' | 'deleting' | 'done'>('review')
  const [removingPaths, setRemovingPaths] = useState<Set<string>>(new Set())
  const [freedKB, setFreedKB] = useState(0)
  const [mounted, setMounted] = useState(false)
  const [homeDir, setHomeDir] = useState('')
  const [expandKey, setExpandKey] = useState({ seq: 0, expanded: true })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { requestAnimationFrame(() => setMounted(true)) }, [])
  useEffect(() => { window.electronAPI.getHomeDir().then(setHomeDir) }, [])

  // All entries are selectable in ReviewPanel — pass them all as selectablePaths so
  // buildCleanableTree marks each one as isCleanable regardless of file-type heuristics.
  const selectablePaths = useMemo(
    () => new Set(entries.map(e => e.path)),
    [entries],
  )

  // Full recursive directory tree, identical structure to SmartCleanPanel's tree.
  const treeNodes = useMemo(() => {
    if (!homeDir) return []
    return buildCleanableTree(entries, homeDir, selectablePaths)
  }, [entries, homeDir, selectablePaths])

  const toggle = useCallback((path: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }, [])

  const hasCriticalEntries = entries.some(e => isCriticalPath(e.path))
  const allChecked = selectableInReview.length > 0 && selectableInReview.every(e => selected.has(e.path))
  const someChecked = selectableInReview.some(e => selected.has(e.path))

  const toggleAll = useCallback(() => {
    setSelected(allChecked
      ? new Set()
      : new Set(selectableInReview.map(e => e.path)),
    )
  }, [allChecked, selectableInReview])

  const selectedEntries = entries.filter(e => selected.has(e.path))
  // Deduplicate sizes: if both a parent folder and a child are selected,
  // the parent's sizeKB already includes the child — only count the parent.
  const selectedEntriesDeduped = selectedEntries.filter(
    e => !selectedEntries.some(other => other.path !== e.path && e.path.startsWith(other.path + '/'))
  )
  const totalSelectedKB = selectedEntriesDeduped.reduce((s, e) => s + e.sizeKB, 0)
  const exceedsRemainingQuota = !isPremium && selectedEntries.length > remainingQuota
  const freeTierOverLimitMessage = exceedsRemainingQuota
    ? `You have ${remainingQuota} ${remainingQuota === 1 ? 'delete' : 'deletes'} remaining this month. Deselect ${selectedEntries.length - remainingQuota} item${selectedEntries.length - remainingQuota === 1 ? '' : 's'} to continue, or upgrade for unlimited deletes.`
    : null

  const handleConfirm = useCallback(async () => {
    if (phase !== 'review' || selectedEntries.length === 0) return
    
    // If free-tier user is over limit, open upgrade modal instead
    if (freeTierOverLimitMessage) {
      onUpgradeClick()
      return
    }
    
    const toDelete = [...selectedEntries]
    setError(null)
    setFreedKB(selectedEntriesDeduped.reduce((s, e) => s + e.sizeKB, 0))
    setPhase('deleting')

    // Stagger items out: cap total animation at 700 ms
    const stagger = Math.min(55, 700 / Math.max(toDelete.length, 1))
    const animationTimers: number[] = []
    toDelete.forEach((entry, i) => {
      const timer = window.setTimeout(() => {
        setRemovingPaths(prev => new Set([...prev, entry.path]))
      }, i * stagger)
      animationTimers.push(timer)
    })

    // Run deletion in parallel with animation
    const confirmError = await onConfirm(
      toDelete.map(e => e.path),
      toDelete.reduce((s, e) => s + e.sizeKB, 0),
    )

    if (confirmError) {
      animationTimers.forEach((timer) => window.clearTimeout(timer))
      setRemovingPaths(new Set())
      setPhase('review')
      setError(confirmError)
      return
    }

    // Show done state after last animation finishes
    setTimeout(() => setPhase('done'), toDelete.length * stagger + 380)
  }, [phase, selectedEntries, selectedEntriesDeduped, freeTierOverLimitMessage, onConfirm, onUpgradeClick])

  return createPortal(
    <div
      className={[
        'fixed inset-0 z-50 flex flex-col bg-zinc-950',
        'transition-opacity duration-200 ease-out',
        mounted ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {phase === 'done' ? (
        <>
          {/* Shared header shell keeps spacing/separator consistent with the app layout. */}
          <HeaderFrame>
            <span className="opacity-0 select-none">Review</span>
          </HeaderFrame>
          <DoneView freedKB={freedKB} onDone={onDone} />
        </>
      ) : (
        <>
          <HeaderFrame>
            <button
              onClick={onCancel}
              disabled={phase === 'deleting'}
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-500 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h2 className="text-zinc-500 text-xs font-medium tracking-widest uppercase select-none">
              Review Deletion
            </h2>
            <span className="ml-auto text-xs text-zinc-600 w-16 text-right tabular-nums">
              {selectedEntries.length} of {entries.length}
            </span>
          </HeaderFrame>

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

          {hasCriticalEntries && (
            <div className="shrink-0 px-6 py-2 border-b border-amber-900/20 bg-amber-950/10">
              <p className="text-[11px] text-amber-400 leading-relaxed">
                Protected folders are cleaned by removing their contents only; the folder itself is kept.
              </p>
            </div>
          )}

          {/* Select-all + expand/collapse toolbar */}
          <div className="shrink-0 flex items-center gap-3 px-6 py-2.5 border-b border-white/5">
            {selectableInReview.length > 1 && (
              <>
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
                      : 'border-zinc-600 bg-transparent',
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
              </>
            )}
            <button
              onClick={() => setExpandKey(prev => ({ seq: prev.seq + 1, expanded: !prev.expanded }))}
              className="ml-auto text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors select-none"
            >
              {expandKey.expanded ? 'Collapse all' : 'Expand all'}
            </button>
          </div>

          {/* Recursive directory tree */}
          <div className="scrollbar-dark flex-1 overflow-y-auto min-h-0">
            {treeNodes.map(node => (
              <ReviewTreeItem
                key={node.path}
                node={node}
                depth={0}
                homeDir={homeDir}
                selected={selected}
                removingPaths={removingPaths}
                confirmedDeletedPaths={confirmedDeletedPaths}
                deleting={phase === 'deleting'}
                onToggle={toggle}
                expandKey={expandKey}
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
            <div className="flex-1 flex flex-col items-end gap-2">
              {freeTierOverLimitMessage && (
                <p className="w-full text-right text-[11px] text-amber-400 leading-relaxed">
                  {freeTierOverLimitMessage}
                </p>
              )}
              {error && (
                <p className="w-full text-right text-[11px] text-amber-400 leading-relaxed">
                  {error}
                </p>
              )}
              <button
                onClick={handleConfirm}
                disabled={selectedEntries.length === 0 || phase === 'deleting'}
                className="w-full py-2 rounded-lg bg-red-600/80 hover:bg-red-600 disabled:opacity-30 disabled:cursor-not-allowed text-xs text-white font-medium transition-colors flex items-center justify-center gap-2"
              >
                {phase === 'deleting' ? (() => {
                  const remaining = selectedEntries.length - confirmedDeletedPaths.size
                  return (
                    <>
                      <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      {remaining > 0
                        ? `Moving to Trash… ${confirmedDeletedPaths.size} of ${selectedEntries.length}`
                        : 'Finishing up…'}
                    </>
                  )
                })() : (
                  `Move ${selectedEntries.length} ${selectedEntries.length === 1 ? 'item' : 'items'} to Trash · ${formatSize(totalSelectedKB)}`
                )}
              </button>
            </div>
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}
