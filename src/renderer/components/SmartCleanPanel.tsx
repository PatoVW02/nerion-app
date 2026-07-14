import { useState, useEffect, useMemo, useRef, useCallback, memo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DiskEntry, AppLeftover, type ScanSummaryV1, type SuspiciousFinding } from '../types'
import { isAppleMetadata, isCleanable, isDevDependency } from '../utils/cleanable'
import { formatSize } from '../utils/format'
import { buildCleanableTree, TreeNode } from '../utils/buildTree'
import { isCriticalPath, isContentOnlyProtectedRoot } from '../utils/criticalPaths'
import { normalizeUiPath, pathParent } from '../utils/path'

interface SmartCleanPanelProps {
  allCleanable: Map<string, DiskEntry>
  fullTree: Map<string, DiskEntry[]>
  suspiciousFindings: SuspiciousFinding[]
  securityAnalysis: ScanSummaryV1['securityAnalysis'] | null
  rootPath: string
  homeDir: string | null
  autoSelectDevDependencies: boolean
  onInfo: (entry: DiskEntry) => void
  onRevealInFinder: (path: string) => void
  /**
   * Called when the user clicks "Review" — receives every selected entry
   * (scan items + leftovers) so the parent can open the Review panel.
   */
  onReview: (entries: DiskEntry[]) => void
  /**
   * null  → first open this session.
   * Set   → restore this exact leftover selection (paths that no longer exist are ignored).
   */
  initialLeftoverSelection: Set<string> | null
  /** Called with the current leftover selection so the caller can persist it. */
  onClose: (leftoverSelection: Set<string>) => void
  /** Whether the user has an active license. False → preview mode (read-only). */
  isPremium: boolean
  /** Opens the upgrade/paywall modal. Called from the preview-mode footer CTA. */
  onUpgrade: () => void
  /** Paths confirmed deleted during an active deletion — used to update lists live. */
  confirmedDeletedPaths: Set<string>
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function FolderIcon({ className = 'w-3.5 h-3.5 text-blue-400 shrink-0' }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 20 20">
      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  )
}

function FileIcon({ className = 'w-3.5 h-3.5 text-zinc-400 shrink-0' }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
    </svg>
  )
}

function ProtectedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300 shrink-0">
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V8a4 4 0 118 0v3m-9 0h10a1 1 0 011 1v7a1 1 0 01-1 1H7a1 1 0 01-1-1v-7a1 1 0 011-1z" />
      </svg>
      <span>Protected</span>
    </span>
  )
}

// ─── Item context menu ────────────────────────────────────────────────────────

interface ItemCtxMenuProps {
  x: number
  y: number
  canSelect: boolean
  isSelected: boolean
  onToggle: () => void
  onInfo: () => void
  onReveal: () => void
  onClose: () => void
}

function ItemCtxMenu({ x, y, canSelect, isSelected, onToggle, onInfo, onReveal, onClose }: ItemCtxMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      style={{ position: 'fixed', top: y, left: x, zIndex: 9999 }}
      className="glass-popover min-w-[160px] rounded-lg border py-1 text-xs"
    >
      {canSelect && (
        <button
          onClick={() => { onToggle(); onClose() }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 text-zinc-200 hover:bg-white/[0.06] transition-colors text-left"
        >
          <svg className="w-3.5 h-3.5 text-zinc-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {isSelected
              ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />}
          </svg>
          {isSelected ? 'Deselect' : 'Select'}
        </button>
      )}

      <button
        onClick={() => { onInfo(); onClose() }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-zinc-200 hover:bg-white/[0.06] transition-colors text-left"
      >
        <svg className="w-3.5 h-3.5 text-violet-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M5 2a1 1 0 011 1v1h1a1 1 0 010 2H6v1a1 1 0 01-2 0V6H3a1 1 0 010-2h1V3a1 1 0 011-1zm0 10a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1v-1a1 1 0 011-1zM12 2a1 1 0 01.967.744L14.146 7.2 17.5 9.134a1 1 0 010 1.732l-3.354 1.935-1.18 4.455a1 1 0 01-1.933 0L9.854 12.8 6.5 10.866a1 1 0 010-1.732l3.354-1.935 1.18-4.455A1 1 0 0112 2z" clipRule="evenodd" />
        </svg>
        Info
      </button>

      <div className="my-1 border-t border-white/5" />

      <button
        onClick={() => { onReveal(); onClose() }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-zinc-200 hover:bg-white/[0.06] transition-colors text-left"
      >
        <svg className="w-3.5 h-3.5 text-zinc-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        Show in File Manager
      </button>
    </div>,
    document.body
  )
}

// ─── Section block ────────────────────────────────────────────────────────────

interface SectionBlockProps {
  title: string
  collapsed: boolean
  onToggleCollapse: () => void
  selectLabel?: string
  onSelect?: () => void
  children: ReactNode
}

function SectionBlock({ title, collapsed, onToggleCollapse, selectLabel, onSelect, children }: SectionBlockProps) {
  return (
    <div>
      <div className="flex items-center gap-1 px-3 pt-3 pb-1">
        {/* Collapse / expand chevron */}
        <button
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 flex-1 min-w-0 group"
        >
          <svg
            className={['w-2.5 h-2.5 text-zinc-600 group-hover:text-zinc-400 shrink-0 transition-transform duration-150', collapsed ? '' : 'rotate-90'].join(' ')}
            fill="currentColor" viewBox="0 0 20 20"
          >
            <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
          </svg>
          <span className="text-[10px] font-semibold text-zinc-600 group-hover:text-zinc-400 uppercase tracking-widest transition-colors truncate">
            {title}
          </span>
        </button>
        {/* Select / deselect shortcut */}
        {onSelect && selectLabel && !collapsed && (
          <button
            onClick={onSelect}
            className="text-[10px] text-blue-500 hover:text-blue-400 transition-colors shrink-0"
          >
            {selectLabel}
          </button>
        )}
      </div>
      {!collapsed && children}
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCleanableDescendants(node: TreeNode): Array<{ path: string; entry: DiskEntry }> {
  const result: Array<{ path: string; entry: DiskEntry }> = []
  if (node.isCleanable && node.entry) result.push({ path: node.path, entry: node.entry })
  for (const child of node.children) result.push(...getCleanableDescendants(child))
  return result
}


// ─── Tree item (scan-tree section) ────────────────────────────────────────────

interface TreeItemProps {
  node: TreeNode
  depth: number
  selectedPaths: Set<string>
  onToggle: (path: string, entry: DiskEntry) => void
  onInfo: (entry: DiskEntry) => void
  onRevealInFinder: (path: string) => void
  /** True when an ancestor cleanable node is already selected — this node is implicitly covered. */
  parentSelected?: boolean
  /** Preview mode: show items but block all selection interactions. */
  disabled?: boolean
}

const TreeItem = memo(function TreeItem({ node, depth, selectedPaths, onToggle, onInfo, onRevealInFinder, parentSelected, disabled }: TreeItemProps) {
  const [expanded, setExpanded] = useState(depth === 0 && node.children.length <= 8)
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null)

  const hasChildren = node.children.length > 0
  const isDir = node.entry ? node.entry.isDir : true  // intermediate nodes are always dirs
  const critical = isCriticalPath(node.path)

  // directlyChecked: this node is explicitly in selectedPaths
  // checked: also true when an ancestor is selected (parent covers this node for deletion)
  const directlyChecked = node.isCleanable && !!node.entry && selectedPaths.has(node.path)
  const checked = directlyChecked || (parentSelected ?? false)

  // Cleanable descendants for all nodes with children — used for cascading selection.
  // Memoized so the recursive walk doesn't re-run on every render.
  const cleanableDescendants = useMemo(
    () => (hasChildren ? getCleanableDescendants(node) : null),
    // node.children identity is stable from buildCleanableTree
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node]
  )

  // For intermediate (non-cleanable) nodes: are ALL descendants selected?
  const allDescendantsSelected = !node.isCleanable
    && cleanableDescendants !== null
    && cleanableDescendants.length > 0
    && cleanableDescendants.every((d) => selectedPaths.has(d.path))

  // A cleanable node is "fully selected" when it itself is checked (directly or implied).
  // Selecting the parent already covers all children, so we don't require children to be
  // individually in selectedPaths — just show the full checkmark.
  const allSelfAndDescendantsSelected = node.isCleanable && checked

  const someSelfOrDescendantsSelected = node.isCleanable
    && (checked || (cleanableDescendants?.some(d => selectedPaths.has(d.path)) ?? false))

  const batchToggle = useCallback(() => {
    if (!cleanableDescendants) return
    if (allDescendantsSelected) {
      for (const d of cleanableDescendants) {
        if (selectedPaths.has(d.path)) onToggle(d.path, d.entry)
      }
    } else {
      for (const d of cleanableDescendants) {
        if (!selectedPaths.has(d.path)) onToggle(d.path, d.entry)
      }
    }
  }, [cleanableDescendants, allDescendantsSelected, selectedPaths, onToggle])

  // Toggle a cleanable node that has visible children: cascade to all descendants too.
  const handleCleanableToggle = useCallback(() => {
    if (!node.entry) return
    const selecting = !allSelfAndDescendantsSelected
    // Toggle self based on directly-checked state (not the inherited parentSelected state)
    if (selecting !== directlyChecked) onToggle(node.path, node.entry)
    // Cascade to descendants — skip self (getCleanableDescendants includes the node itself)
    if (cleanableDescendants && cleanableDescendants.length > 0) {
      for (const d of cleanableDescendants) {
        if (d.path === node.path) continue  // self handled above; avoid double-toggle
        if (selecting !== selectedPaths.has(d.path)) onToggle(d.path, d.entry)
      }
    }
  }, [node, directlyChecked, allSelfAndDescendantsSelected, cleanableDescendants, selectedPaths, onToggle])

  const handleBatchToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    batchToggle()
  }, [batchToggle])

  const handleCtxMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY })
  }, [])

  return (
    <>
      <div
        className="flex items-center gap-1.5 py-2 hover:bg-white/[0.04] transition-colors"
        style={{ paddingLeft: 12 + depth * 16, paddingRight: 12 }}
        onContextMenu={handleCtxMenu}
      >
        {/* Expand/collapse chevron */}
        <button
          onClick={() => hasChildren && setExpanded((v) => !v)}
          className={[
            'w-4 h-4 flex items-center justify-center shrink-0 rounded text-zinc-500 hover:text-zinc-300 transition-colors',
            !hasChildren && 'invisible'
          ].filter(Boolean).join(' ')}
        >
          <svg className={['w-3 h-3 transition-transform', expanded ? 'rotate-90' : ''].join(' ')} fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
          </svg>
        </button>

        {/* Checkbox — cleanable leaf OR batch-select for intermediate nodes */}
        {node.isCleanable && node.entry ? (
          <button
            onClick={disabled ? undefined : (hasChildren ? handleCleanableToggle : () => onToggle(node.path, node.entry!))}
            className={[
              'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
              disabled
                ? 'border-zinc-700 bg-transparent opacity-40 cursor-not-allowed'
                : allSelfAndDescendantsSelected
                ? 'bg-blue-600 border-blue-600'
                : someSelfOrDescendantsSelected
                ? 'bg-blue-900/60 border-blue-500'
                : 'border-zinc-600 bg-transparent'
            ].join(' ')}
          >
            {allSelfAndDescendantsSelected && (
              <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {!allSelfAndDescendantsSelected && someSelfOrDescendantsSelected && (
              <svg className="w-2.5 h-2.5 text-blue-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 12h14" />
              </svg>
            )}
          </button>
        ) : cleanableDescendants && cleanableDescendants.length > 0 ? (
          <button
            onClick={disabled ? undefined : handleBatchToggle}
            className={[
              'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
              disabled
                ? 'border-zinc-700 bg-transparent opacity-40 cursor-not-allowed'
                : allDescendantsSelected
                ? 'bg-blue-600 border-blue-600'
                : cleanableDescendants.some((d) => selectedPaths.has(d.path))
                ? 'bg-blue-900/60 border-blue-500'
                : 'border-zinc-600 bg-transparent'
            ].join(' ')}
          >
            {allDescendantsSelected && (
              <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {!allDescendantsSelected && cleanableDescendants.some((d) => selectedPaths.has(d.path)) && (
              <svg className="w-2.5 h-2.5 text-blue-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 12h14" />
              </svg>
            )}
          </button>
        ) : (
          <div className="w-4 h-4 shrink-0" />
        )}

        {/* Folder / file icon */}
        {isDir
          ? <FolderIcon className={node.isCleanable ? 'w-3.5 h-3.5 text-blue-400 shrink-0' : 'w-3.5 h-3.5 text-zinc-600 shrink-0'} />
          : <FileIcon  className={node.isCleanable ? 'w-3.5 h-3.5 text-zinc-300 shrink-0' : 'w-3.5 h-3.5 text-zinc-600 shrink-0'} />
        }

        {/* Label + size */}
        <button
          onClick={disabled ? undefined : () => {
            if (!node.isCleanable || !node.entry) return
            if (hasChildren) handleCleanableToggle()
            else onToggle(node.path, node.entry)
          }}
          className="flex-1 min-w-0 flex items-center justify-between gap-1 text-left min-w-0"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={[
              'text-xs truncate leading-snug',
              node.isCleanable ? 'text-zinc-200 font-medium' : 'text-zinc-500'
            ].join(' ')}>
              {node.label}
            </span>
            {critical && <ProtectedBadge />}
          </span>
          <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">
            {formatSize(node.totalKB)}
          </span>
        </button>

      </div>

      {expanded && hasChildren && node.children.map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPaths={selectedPaths}
          onToggle={onToggle}
          onInfo={onInfo}
          onRevealInFinder={onRevealInFinder}
          parentSelected={checked || undefined}
          disabled={disabled}
        />
      ))}

      {ctx && (() => {
        const hasCleanableContent = (node.isCleanable && !!node.entry) ||
          (cleanableDescendants !== null && cleanableDescendants.length > 0)
        const ctxIsSelected = node.isCleanable ? allSelfAndDescendantsSelected : allDescendantsSelected
        const ctxToggle = node.isCleanable && node.entry
          ? (hasChildren ? handleCleanableToggle : () => onToggle(node.path, node.entry!))
          : batchToggle
        return (
          <ItemCtxMenu
            x={ctx.x}
            y={ctx.y}
            canSelect={hasCleanableContent && (!isCriticalPath(node.path) || isContentOnlyProtectedRoot(node.path))}
            isSelected={ctxIsSelected}
            onToggle={ctxToggle}
            onInfo={() => node.entry && onInfo(node.entry)}
            onReveal={() => onRevealInFinder(node.path)}
            onClose={() => setCtx(null)}
          />
        )
      })()}
    </>
  )
})

// ─── Leftover row ─────────────────────────────────────────────────────────────

interface LeftoverRowProps {
  item: AppLeftover
  checked: boolean
  onToggle: () => void
  onReveal: () => void
  onInfo: (entry: DiskEntry) => void
  disabled?: boolean
}

function LeftoverRow({ item, checked, onToggle, onReveal, onInfo, disabled }: LeftoverRowProps) {
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null)
  const isDir = item.artifacts[0]?.isDir ?? true
  const critical = isCriticalPath(item.path)

  // Construct a DiskEntry so the InfoPanel can display AI analysis for leftovers
  const asDiskEntry: DiskEntry = {
    name: item.name,
    path: item.path,
    sizeKB: item.sizeKB,
    isDir
  }

  return (
    <>
      <div
        className="flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors"
        onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY }) }}
      >
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          aria-label={`${checked ? 'Deselect' : 'Select'} ${item.name}`}
          className={[
            'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
            disabled
              ? 'border-zinc-700 bg-transparent opacity-40 cursor-not-allowed'
              : checked ? 'bg-blue-600 border-blue-600' : 'border-zinc-600 bg-transparent'
          ].join(' ')}
        >
          {!disabled && checked && (
            <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>

        {isDir ? <FolderIcon /> : <FileIcon />}

        <button type="button" onClick={onToggle} disabled={disabled} className="flex-1 min-w-0 text-left disabled:cursor-default">
          <div className="flex items-center justify-between gap-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="text-xs font-medium text-zinc-200 truncate">{item.name}</span>
              <span className={[
                'rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wide',
                item.confidence === 'recommended'
                  ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-500/25 bg-amber-500/10 text-amber-300',
              ].join(' ')}>
                {item.confidence === 'recommended' ? 'Recommended' : 'Review'}
              </span>
              {critical && <ProtectedBadge />}
            </span>
            <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">{item.complete ? '' : '~'}{formatSize(item.sizeKB)}</span>
          </div>
          <span className="text-[10px] text-zinc-600 font-mono truncate block mt-0.5">{item.location}</span>
        </button>
      </div>

      {ctx && (
        <ItemCtxMenu
          x={ctx.x}
          y={ctx.y}
          canSelect={!disabled && (!isCriticalPath(item.path) || isContentOnlyProtectedRoot(item.path))}
          isSelected={checked}
          onToggle={() => { onToggle(); setCtx(null) }}
          onInfo={() => { onInfo(asDiskEntry); setCtx(null) }}
          onReveal={() => { onReveal(); setCtx(null) }}
          onClose={() => setCtx(null)}
        />
      )}
    </>
  )
}

// ─── Security review row ──────────────────────────────────────────────────────

interface SuspiciousRowProps {
  item: SuspiciousFinding
  checked: boolean
  onToggle: () => void
  onReveal: () => void
}

function SuspiciousRow({ item, checked, onToggle, onReveal }: SuspiciousRowProps) {
  return (
    <div className="border-b border-white/[0.035] px-3 py-2.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <button
          onClick={onToggle}
          role="checkbox"
          aria-checked={checked}
          aria-label={`${checked ? 'Deselect' : 'Select'} ${item.name}`}
          className={[
            'mt-0.5 w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
            checked ? 'bg-blue-600 border-blue-600' : 'border-zinc-600 bg-transparent hover:border-zinc-500',
          ].join(' ')}
        >
          {checked && (
            <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>

        <svg
          className={['mt-0.5 w-3.5 h-3.5 shrink-0', item.risk === 'elevated' ? 'text-amber-400' : 'text-blue-400'].join(' ')}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 3l7 3v5c0 4.4-2.8 8.2-7 10-4.2-1.8-7-5.6-7-10V6l7-3z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 8v4m0 4h.01" />
        </svg>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-zinc-200">{item.name}</span>
            <span className={[
              'shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wide',
              item.risk === 'elevated'
                ? 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                : 'border-blue-500/25 bg-blue-500/10 text-blue-300',
            ].join(' ')}>
              {item.risk === 'elevated' ? 'Elevated' : 'Review'}
            </span>
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-zinc-600">{formatSize(item.sizeKB)}</span>
          </div>
          <p className="mt-0.5 text-[10px] leading-relaxed text-zinc-500">{item.summary}</p>
          {item.targetPath && (
            <p className="mt-1 truncate font-mono text-[9px] text-zinc-600" title={item.targetPath}>
              Starts: {item.targetPath}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {item.evidence.slice(0, 3).map((entry) => (
              <span
                key={`${entry.code}:${entry.label}`}
                title={entry.detail ?? entry.label}
                className="rounded border border-white/[0.06] bg-white/[0.035] px-1.5 py-0.5 text-[9px] text-zinc-500"
              >
                {entry.label}
              </span>
            ))}
            <button
              onClick={onReveal}
              aria-label={`Reveal ${item.name} in the file manager`}
              className="ml-auto text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              Reveal
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SmartCleanPanel({
  allCleanable,
  fullTree,
  suspiciousFindings,
  securityAnalysis,
  rootPath,
  homeDir,
  autoSelectDevDependencies,
  onInfo,
  onRevealInFinder,
  onReview,
  initialLeftoverSelection,
  onClose,
  isPremium,
  onUpgrade,
  confirmedDeletedPaths,
}: SmartCleanPanelProps) {
  const [mounted, setMounted] = useState(false)

  // Section collapse state
  const [cachesCollapsed, setCachesCollapsed] = useState(false)
  const [devCollapsed, setDevCollapsed] = useState(false)
  const [leftoversCollapsed, setLeftoversCollapsed] = useState(false)
  const [securityCollapsed, setSecurityCollapsed] = useState(false)

  // SmartClean manages its own selection — completely independent of the treemap /
  // Review panel. Items are sent to the Review panel only when the user clicks "Review".
  const [selectedScanPaths, setSelectedScanPaths] = useState<Set<string>>(new Set())

  // App leftovers
  const [leftovers, setLeftovers] = useState<AppLeftover[]>([])
  const [leftoversLoading, setLeftoversLoading] = useState(true)
  const [leftoversIncomplete, setLeftoversIncomplete] = useState(false)
  const [selectedLeftovers, setSelectedLeftovers] = useState<Set<string>>(new Set())
  // Security findings are deliberately opt-in and never auto-selected.
  const [selectedSuspicious, setSelectedSuspicious] = useState<Set<string>>(new Set())

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    if (securityAnalysis === null) setSelectedSuspicious(new Set())
  }, [securityAnalysis])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(selectedLeftovers) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, selectedLeftovers])

  // Strip confirmed-deleted paths from all selections as deletions happen live
  useEffect(() => {
    if (confirmedDeletedPaths.size === 0) return
    setLeftovers(prev => prev.filter(l => !confirmedDeletedPaths.has(l.path)))
    setSelectedLeftovers(prev => {
      const next = new Set(prev)
      for (const p of confirmedDeletedPaths) next.delete(p)
      return next
    })
    setSelectedScanPaths(prev => {
      const next = new Set(prev)
      for (const p of confirmedDeletedPaths) next.delete(p)
      return next
    })
    setSelectedSuspicious(prev => {
      const next = new Set(prev)
      for (const p of confirmedDeletedPaths) next.delete(p)
      return next
    })
  }, [confirmedDeletedPaths])

  const visibleSuspicious = useMemo(
    () => suspiciousFindings.filter((finding) => !confirmedDeletedPaths.has(finding.path)),
    [suspiciousFindings, confirmedDeletedPaths],
  )

  // Fetch leftovers on mount
  useEffect(() => {
    let acceptResult = true
    setLeftoversLoading(true)
    const timeout = window.setTimeout(() => {
      acceptResult = false
      setLeftovers([])
      setLeftoversIncomplete(true)
      setLeftoversLoading(false)
    }, 35_000)

    window.electronAPI.findAppLeftovers()
      .then((result) => {
        if (!acceptResult) return
        const items = result.groups
        setLeftoversIncomplete(!result.complete)
        const filteredItems = items.filter((item) => !confirmedDeletedPaths.has(item.path))
        setLeftovers(filteredItems)
        if (initialLeftoverSelection === null) {
          // First open this session — start with nothing selected (user opts in)
          setSelectedLeftovers(new Set())
        } else {
          // Restore previous selection, keeping only paths that still exist
          const existing = new Set(filteredItems
            .filter((item) => item.confidence === 'recommended')
            .map((item) => item.path))
          setSelectedLeftovers(new Set([...initialLeftoverSelection].filter((p) => existing.has(p))))
        }
      })
      .catch(() => {
        if (!acceptResult) return
        setLeftovers([])
        setLeftoversIncomplete(true)
      })
      .finally(() => {
        if (!acceptResult) return
        window.clearTimeout(timeout)
        setLeftoversLoading(false)
      })
    return () => {
      acceptResult = false
      window.clearTimeout(timeout)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentionally run once on mount; initialLeftoverSelection captured at open time

  // Split cleanable entries into system (Caches, Logs, …) and dev (node_modules, venv, …).
  // We build two completely separate trees so intermediate ancestor nodes never mix
  // system and dev content — which would cause everything to collapse into one section.
  const systemEntries = useMemo(
    () => [...allCleanable.values()].filter(
      (e) => {
        if (e.sizeKB <= 0 || isDevDependency(e) || confirmedDeletedPaths.has(e.path)) return false
        if (!e.isDir) return true
        const children = fullTree.get(normalizeUiPath(e.path)) ?? []
        return children.length > 0
      }
    ),
    [allCleanable, confirmedDeletedPaths, fullTree]
  )
  const devEntries = useMemo(
    () => [...allCleanable.values()].filter(
      (e) => {
        if (e.sizeKB <= 0 || !isDevDependency(e) || confirmedDeletedPaths.has(e.path)) return false
        if (!e.isDir) return true
        const children = fullTree.get(normalizeUiPath(e.path)) ?? []
        return children.length > 0
      }
    ),
    [allCleanable, confirmedDeletedPaths, fullTree]
  )

  // Auto-select system scan items on first open, and dev dependencies only when
  // the corresponding setting is enabled. Downloads items are handled separately
  // by the age-based effect below.
  const scanAutoSelectedRef = useRef(false)
  useEffect(() => {
    if (scanAutoSelectedRef.current) return
    if (systemEntries.length === 0 && devEntries.length === 0) return // wait for data
    scanAutoSelectedRef.current = true

    // pathParent returns the renderer comparison form. Build the Downloads key
    // through the same normalizer so Windows casing cannot bypass the age gate.
    const downloadsRoot = homeDir ? normalizeUiPath(`${homeDir}/Downloads`) : null
    const initial = new Set<string>()
    for (const e of systemEntries) {
      // Skip Downloads items — age-based logic handles them below
      if (downloadsRoot) {
        const parent = pathParent(e.path)
        if (parent === downloadsRoot) continue
      }
      initial.add(e.path)
    }
    if (autoSelectDevDependencies) {
      for (const e of devEntries) initial.add(e.path)
    }
    setSelectedScanPaths(initial)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemEntries, devEntries, homeDir, autoSelectDevDependencies])

  // Auto-select Downloads items older than 7 days (by last-modified date).
  // Runs once after scan data is ready (guarded by ref).
  const downloadsAutoSelectedRef = useRef(false)
  useEffect(() => {
    if (downloadsAutoSelectedRef.current || !homeDir || systemEntries.length === 0) return
    downloadsAutoSelectedRef.current = true

    const downloadsRoot = normalizeUiPath(`${homeDir}/Downloads`)
    const downloadItems = systemEntries.filter((e) => {
      const parent = pathParent(e.path)
      return parent === downloadsRoot
    })
    if (downloadItems.length === 0) return

    const AGE_MS = 7 * 24 * 60 * 60 * 1000
    const now = Date.now()

    Promise.allSettled(
      downloadItems.map(async (entry) => {
        const stats = await window.electronAPI.getItemStats(entry.path)
        if ('error' in stats) return
        const mostRecent = Math.max(
          new Date(stats.modified).getTime(),
          new Date(stats.created).getTime(),
        )
        if (now - mostRecent > AGE_MS) {
          setSelectedScanPaths(prev => new Set([...prev, entry.path]))
        }
      })
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemEntries, homeDir])

  // Direct children of system cleanable dirs — individually selectable sub-items.
  const { systemChildEntries, systemChildPaths } = useMemo(() => {
    const extra: DiskEntry[] = []
    const extraPaths = new Set<string>()
    const expandableRoots = new Set<string>()
    for (const entry of systemEntries) {
      if (entry.isDir) expandableRoots.add(entry.path)
    }
    for (const dirPath of fullTree.keys()) {
      if (isContentOnlyProtectedRoot(dirPath, homeDir)) expandableRoots.add(dirPath)
    }

    for (const dirPath of expandableRoots) {
      for (const child of fullTree.get(normalizeUiPath(dirPath)) ?? []) {
        if (
          !allCleanable.has(child.path) &&
          child.sizeKB > 0 &&
          !confirmedDeletedPaths.has(child.path) &&
          !isCriticalPath(child.path) &&
          !isAppleMetadata(child)
        ) {
          extra.push(child)
          extraPaths.add(child.path)
        }
      }
    }
    return { systemChildEntries: extra, systemChildPaths: extraPaths }
  }, [systemEntries, fullTree, allCleanable, confirmedDeletedPaths, homeDir])

  // Dev dep entries aren't recognised by isCleanable() so pass their paths explicitly.
  const devSelectablePaths = useMemo(
    () => new Set(devEntries.map(e => e.path)),
    [devEntries]
  )

  // System entries that aren't flagged by isCleanable() (e.g. Downloads files/folders)
  // must be included in selectablePaths so buildCleanableTree marks them as selectable.
  const systemSelectablePaths = useMemo(() => {
    const paths = new Set<string>(systemChildPaths)
    for (const e of systemEntries) {
      if (!isCleanable(e)) paths.add(e.path)
    }
    return paths
  }, [systemEntries, systemChildPaths])

  // One tree per section — no shared ancestors that could merge the two groups.
  const systemTree = useMemo(
    () => buildCleanableTree([...systemEntries, ...systemChildEntries], rootPath, systemSelectablePaths),
    [systemEntries, systemChildEntries, rootPath, systemSelectablePaths]
  )
  const devTree = useMemo(
    () => buildCleanableTree(devEntries, rootPath, devSelectablePaths),
    [devEntries, rootPath, devSelectablePaths]
  )

  // All entries for selection counting
  const allEntries = useMemo(
    () => [...systemEntries, ...devEntries],
    [systemEntries, devEntries]
  )
  const treeEntries = useMemo(
    () => [...systemEntries, ...systemChildEntries, ...devEntries],
    [systemEntries, systemChildEntries, devEntries]
  )
  const selectableLeftovers = useMemo(
    () => leftovers.filter((item) => item.confidence === 'recommended'),
    [leftovers],
  )

  const { totalSelectedKB, totalSelectedCount } = useMemo(() => {
    let kb = 0, count = 0
    for (const e of treeEntries) { if (selectedScanPaths.has(e.path)) { kb += e.sizeKB; count++ } }
    for (const l of leftovers)   { if (selectedLeftovers.has(l.path)) { kb += l.sizeKB; count++ } }
    for (const finding of visibleSuspicious) {
      if (selectedSuspicious.has(finding.path)) { kb += finding.sizeKB; count++ }
    }
    return { totalSelectedKB: kb, totalSelectedCount: count }
  }, [treeEntries, selectedScanPaths, leftovers, selectedLeftovers, visibleSuspicious, selectedSuspicious])

  // Preview mode: total of every top-level item in the panel (what "Select All" would give).
  const { totalAvailableKB, totalAvailableCount } = useMemo(() => {
    let kb = 0, count = 0
    for (const e of allEntries) { kb += e.sizeKB; count++ }
    for (const l of selectableLeftovers)  { kb += l.sizeKB; count++ }
    return { totalAvailableKB: kb, totalAvailableCount: count }
  }, [allEntries, selectableLeftovers])

  // Per-section "all selected" state
  const allSystemSelected = useMemo(
    () => systemEntries.length > 0 && systemEntries.every(e => selectedScanPaths.has(e.path)),
    [systemEntries, selectedScanPaths]
  )
  const allDevSelected = useMemo(
    () => devEntries.length > 0 && devEntries.every(e => selectedScanPaths.has(e.path)),
    [devEntries, selectedScanPaths]
  )
  const allScanSelected = useMemo(
    () => allEntries.length > 0 && allEntries.every(e => selectedScanPaths.has(e.path)),
    [allEntries, selectedScanPaths]
  )
  const allLeftoversSelected = useMemo(
    () => selectableLeftovers.length > 0 && selectableLeftovers.every(l => selectedLeftovers.has(l.path)),
    [selectableLeftovers, selectedLeftovers]
  )
  const allCleanupSelected = (allEntries.length === 0 || allScanSelected)
    && (selectableLeftovers.length === 0 || allLeftoversSelected)
    && (allEntries.length + selectableLeftovers.length > 0)
  const allSuspiciousSelected = useMemo(
    () => visibleSuspicious.length > 0 && visibleSuspicious.every((finding) => selectedSuspicious.has(finding.path)),
    [visibleSuspicious, selectedSuspicious],
  )

  const toggleScanEntry = useCallback((p: string) => {
    setSelectedScanPaths(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }, [])

  const selectAllSystem = useCallback(() => {
    setSelectedScanPaths(prev => { const n = new Set(prev); systemEntries.forEach(e => n.add(e.path)); return n })
  }, [systemEntries])

  const deselectAllSystem = useCallback(() => {
    setSelectedScanPaths(prev => { const n = new Set(prev); systemEntries.forEach(e => n.delete(e.path)); return n })
  }, [systemEntries])

  const selectAllDev = useCallback(() => {
    setSelectedScanPaths(prev => { const n = new Set(prev); devEntries.forEach(e => n.add(e.path)); return n })
  }, [devEntries])

  const deselectAllDev = useCallback(() => {
    setSelectedScanPaths(prev => { const n = new Set(prev); devEntries.forEach(e => n.delete(e.path)); return n })
  }, [devEntries])

  const toggleLeftover = useCallback((path: string) => {
    setSelectedLeftovers(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const toggleSuspicious = useCallback((itemPath: string) => {
    setSelectedSuspicious(prev => {
      const next = new Set(prev)
      if (next.has(itemPath)) next.delete(itemPath)
      else next.add(itemPath)
      return next
    })
  }, [])

  // Assemble all selected items and hand them to the parent to open Review.
  const handleReview = useCallback(() => {
    // Build a lookup from path → DiskEntry for all scan entries
    const entryMap = new Map<string, DiskEntry>()
    for (const e of [...systemEntries, ...systemChildEntries, ...devEntries]) entryMap.set(e.path, e)

    const scanSelected: DiskEntry[] = []
    for (const p of selectedScanPaths) {
      const entry = entryMap.get(p)
      if (entry) scanSelected.push(entry)
    }
    const leftoverSelected: DiskEntry[] = leftovers
      .filter(l => selectedLeftovers.has(l.path))
      .flatMap(l => l.artifacts.map((artifact) => ({
        name: artifact.name,
        path: artifact.path,
        sizeKB: artifact.sizeKB,
        allocatedBytes: artifact.allocatedBytes,
        isDir: artifact.isDir,
      })))
    const suspiciousSelected: DiskEntry[] = visibleSuspicious
      .filter((finding) => selectedSuspicious.has(finding.path))
      .map((finding) => ({
        name: finding.name,
        path: finding.path,
        sizeKB: finding.sizeKB,
        allocatedBytes: finding.allocatedBytes,
        isDir: finding.isDir,
      }))

    onReview([...scanSelected, ...leftoverSelected, ...suspiciousSelected])
    onClose(selectedLeftovers)
  }, [selectedScanPaths, selectedLeftovers, selectedSuspicious, systemEntries, systemChildEntries, devEntries, leftovers, visibleSuspicious, onReview, onClose])

  return (
    <div
      className={[
        'glass-panel flex flex-col h-full',
        'transition-opacity duration-150 ease-out',
        mounted ? 'opacity-100' : 'opacity-0'
      ].join(' ')}
    >
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-violet-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M5 2a1 1 0 011 1v1h1a1 1 0 010 2H6v1a1 1 0 01-2 0V6H3a1 1 0 010-2h1V3a1 1 0 011-1zm0 10a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1v-1a1 1 0 011-1zM12 2a1 1 0 01.967.744L14.146 7.2 17.5 9.134a1 1 0 010 1.732l-3.354 1.935-1.18 4.455a1 1 0 01-1.933 0L9.854 12.8 6.5 10.866a1 1 0 010-1.732l3.354-1.935 1.18-4.455A1 1 0 0112 2z" clipRule="evenodd" />
          </svg>
          <span className="text-sm font-medium text-zinc-100 flex-1">Smart Clean</span>
          <button
            onClick={() => onClose(selectedLeftovers)}
            className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex items-center justify-between mt-2.5">
          {isPremium ? (
            <span className="text-xs text-zinc-500">
              {totalSelectedCount > 0
                ? `${totalSelectedCount} selected · ${formatSize(totalSelectedKB)}`
                : 'Nothing selected'}
            </span>
          ) : (
            <span className="text-xs text-zinc-500">
              {totalAvailableCount > 0
                ? `${totalAvailableCount} ${totalAvailableCount === 1 ? 'item' : 'items'} · ${formatSize(totalAvailableKB)} available`
                : leftoversLoading ? 'Scanning…' : 'Nothing to clean'}
            </span>
          )}
          {isPremium ? (
            <button
              onClick={() => {
                if (allCleanupSelected) {
                  setSelectedScanPaths(new Set())
                  setSelectedLeftovers(new Set())
                } else {
                  setSelectedScanPaths(new Set(allEntries.map(e => e.path)))
                  setSelectedLeftovers(new Set(selectableLeftovers.map(l => l.path)))
                }
              }}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              {allCleanupSelected ? 'Deselect Cleanup' : 'Select Cleanup'}
            </button>
          ) : (
            <span className="flex items-center gap-1 text-xs text-zinc-600">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
              Preview
            </span>
          )}
        </div>
      </div>

      {/* Scrollable body */}
      <div className="scrollbar-dark flex-1 overflow-y-auto min-h-0">

        {/* ── Caches & Temp ── */}
        {systemTree.length > 0 && (
          <SectionBlock
            title="Caches & Temp"
            collapsed={cachesCollapsed}
            onToggleCollapse={() => setCachesCollapsed(v => !v)}
            selectLabel={isPremium ? (allSystemSelected ? 'Deselect' : 'Select all') : undefined}
            onSelect={isPremium ? (allSystemSelected ? deselectAllSystem : selectAllSystem) : undefined}
          >
            {systemTree.map((node) => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                selectedPaths={selectedScanPaths}
                onToggle={(p) => toggleScanEntry(p)}
                onInfo={onInfo}
                onRevealInFinder={onRevealInFinder}
                disabled={!isPremium}
              />
            ))}
          </SectionBlock>
        )}

        {/* ── Dev Dependencies ── */}
        {devTree.length > 0 && (
          <SectionBlock
            title="Dev Dependencies"
            collapsed={devCollapsed}
            onToggleCollapse={() => setDevCollapsed(v => !v)}
            selectLabel={isPremium ? (allDevSelected ? 'Deselect' : 'Select all') : undefined}
            onSelect={isPremium ? (allDevSelected ? deselectAllDev : selectAllDev) : undefined}
          >
            {devTree.map((node) => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                selectedPaths={selectedScanPaths}
                onToggle={(p) => toggleScanEntry(p)}
                onInfo={onInfo}
                onRevealInFinder={onRevealInFinder}
                disabled={!isPremium}
              />
            ))}
          </SectionBlock>
        )}

        {/* ── Local security review (paid) ── */}
        <SectionBlock
          title="Security Review"
          collapsed={securityCollapsed}
          onToggleCollapse={() => setSecurityCollapsed((value) => !value)}
          selectLabel={isPremium && visibleSuspicious.length > 0 ? (allSuspiciousSelected ? 'Deselect' : 'Select all') : undefined}
          onSelect={isPremium && visibleSuspicious.length > 0 ? () => {
            if (allSuspiciousSelected) setSelectedSuspicious(new Set())
            else setSelectedSuspicious(new Set(visibleSuspicious.map((finding) => finding.path)))
          } : undefined}
        >
          {!isPremium ? (
            <div className="mx-3 my-2 rounded-lg border border-violet-400/15 bg-violet-500/[0.06] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
              <div className="flex items-start gap-2.5">
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 11V8a4 4 0 118 0v3m-9 0h10a1 1 0 011 1v7a1 1 0 01-1 1H7a1 1 0 01-1-1v-7a1 1 0 011-1z" />
                </svg>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-zinc-200">Paid · Local background-item review</div>
                  <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                    Reviews startup registrations and high-signal disguised executable names on this device. No files or metadata leave your computer.
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
                    This is a cleanup aid, not antivirus protection.
                  </p>
                  <button onClick={onUpgrade} className="mt-2 text-[10px] font-medium text-violet-300 hover:text-violet-200 transition-colors">
                    Unlock Security Review
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="mx-3 mb-1 mt-1.5 rounded-md border border-white/[0.05] bg-white/[0.025] px-2.5 py-2 text-[10px] leading-relaxed text-zinc-600">
                Evidence-based local review only — a finding does not mean malware. Security items are never selected automatically.
              </div>
              {securityAnalysis === 'partial' && (
                <div className="mx-3 mb-1 rounded-md border border-amber-500/20 bg-amber-500/[0.08] px-2.5 py-2 text-[10px] leading-relaxed text-amber-300/80">
                  Some scan or startup locations were inaccessible, so this review may be incomplete.
                </div>
              )}
              {visibleSuspicious.length > 0 ? (
                visibleSuspicious.map((finding) => (
                  <SuspiciousRow
                    key={finding.id}
                    item={finding}
                    checked={selectedSuspicious.has(finding.path)}
                    onToggle={() => toggleSuspicious(finding.path)}
                    onReveal={() => onRevealInFinder(finding.path)}
                  />
                ))
              ) : (
                <div className="px-3 py-2 text-xs text-zinc-700">
                  {securityAnalysis === 'disabled'
                    ? 'Run the file scan again to enable Security Review for this license.'
                    : securityAnalysis === null
                    ? 'Security review finishes with the current file scan…'
                    : 'No high-signal items found in the scanned and startup locations.'}
                </div>
              )}
              {visibleSuspicious.some((finding) => finding.category === 'background-item') && (
                <div className="mx-3 my-2 text-[9px] leading-relaxed text-zinc-700">
                  Removing a startup registration prevents future launches; it does not stop a process that is already running.
                </div>
              )}
            </>
          )}
        </SectionBlock>

        {/* ── App Leftovers ── */}
        <SectionBlock
          title="App Leftovers"
          collapsed={leftoversCollapsed}
          onToggleCollapse={() => setLeftoversCollapsed(v => !v)}
          selectLabel={isPremium && !leftoversLoading && selectableLeftovers.length > 0 ? (allLeftoversSelected ? 'Deselect' : 'Select recommended') : undefined}
          onSelect={isPremium && !leftoversLoading && selectableLeftovers.length > 0 ? () => {
            if (allLeftoversSelected) setSelectedLeftovers(new Set())
            else setSelectedLeftovers(new Set(selectableLeftovers.map((l) => l.path)))
          } : undefined}
        >
          {leftoversLoading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-zinc-600">
              <div className="w-3 h-3 rounded-full border border-transparent border-t-zinc-500 animate-spin shrink-0" />
              Scanning for app leftovers…
            </div>
          ) : leftovers.length === 0 ? (
            <div className={[
              'mx-3 mb-1 rounded-md px-2.5 py-2 text-[10px] leading-relaxed',
              leftoversIncomplete
                ? 'border border-amber-500/20 bg-amber-500/[0.08] text-amber-300/80'
                : 'text-zinc-700',
            ].join(' ')}>
              {leftoversIncomplete
                ? 'The leftover scan could not finish. No complete result is available yet.'
                : 'No leftover data found.'}
            </div>
          ) : (
            <>
              {leftoversIncomplete && (
                <div className="mx-3 mb-1 rounded-md border border-amber-500/20 bg-amber-500/[0.08] px-2.5 py-2 text-[10px] leading-relaxed text-amber-300/80">
                  Some protected locations could not be read, so this list may be incomplete.
                </div>
              )}
              {leftovers.map((item) => (
                <LeftoverRow
                  key={item.id}
                  item={item}
                  checked={selectedLeftovers.has(item.path)}
                  onToggle={() => toggleLeftover(item.path)}
                  onReveal={() => window.electronAPI.revealInFileManager(item.path)}
                  onInfo={onInfo}
                  disabled={!isPremium || item.confidence !== 'recommended'}
                />
              ))}
            </>
          )}
        </SectionBlock>

        {systemTree.length === 0 && devTree.length === 0 && visibleSuspicious.length === 0 && !leftoversLoading && leftovers.length === 0 && !leftoversIncomplete && (
          <div className="flex items-center justify-center h-24 text-xs text-zinc-600 px-4 text-center">
            Nothing to clean up.
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-white/5 px-4 py-3 flex flex-col gap-2">
        {isPremium ? (
          <button
            onClick={handleReview}
            disabled={totalSelectedCount === 0}
            className="w-full py-2 rounded-lg bg-blue-600/80 hover:bg-blue-600 disabled:opacity-30 disabled:cursor-not-allowed text-xs text-white font-medium transition-colors"
          >
            {totalSelectedCount > 0
              ? `Review ${totalSelectedCount} ${totalSelectedCount === 1 ? 'Item' : 'Items'} · ${formatSize(totalSelectedKB)}`
              : 'Review Items'}
          </button>
        ) : (
          <button
            onClick={onUpgrade}
            className="w-full py-2 rounded-lg bg-violet-600/80 hover:bg-violet-600 text-xs text-white font-medium transition-colors flex items-center justify-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
            Unlock to Clean {totalAvailableCount > 0 ? `${totalAvailableCount} ${totalAvailableCount === 1 ? 'Item' : 'Items'}` : ''}
          </button>
        )}
        <button
          onClick={() => onClose(selectedLeftovers)}
          className="w-full py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-zinc-400 transition-colors"
        >
          {isPremium ? 'Cancel' : 'Close'}
        </button>
      </div>
    </div>
  )
}
