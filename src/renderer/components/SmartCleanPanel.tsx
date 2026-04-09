import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { DiskEntry, AppLeftover } from '../types'
import { formatSize } from '../utils/format'
import { buildCleanableTree, TreeNode } from '../utils/buildTree'
import { isCriticalPath } from '../utils/criticalPaths'

interface SmartCleanPanelProps {
  allCleanable: Map<string, DiskEntry>
  selectedPaths: Set<string>
  rootPath: string
  onToggle: (path: string, entry: DiskEntry) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  /** Add leftover DiskEntries to the main selection and close the panel. */
  onAddLeftoversToSelection: (entries: DiskEntry[]) => void
  onInfo: (entry: DiskEntry) => void
  onRevealInFinder: (path: string) => void
  /**
   * null  → first open this session; auto-select all leftovers.
   * Set   → restore this exact selection (paths that no longer exist are ignored).
   */
  initialLeftoverSelection: Set<string> | null
  /** Called with the current leftover selection so the caller can persist it. */
  onClose: (leftoverSelection: Set<string>) => void
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
      className="min-w-[160px] rounded-lg bg-zinc-900 border border-white/10 shadow-xl py-1 text-xs"
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
        Show in Finder
      </button>
    </div>,
    document.body
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
}

function TreeItem({ node, depth, selectedPaths, onToggle, onInfo, onRevealInFinder }: TreeItemProps) {
  const [expanded, setExpanded] = useState(true)
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null)

  const hasChildren = node.children.length > 0
  const isDir = node.entry ? node.entry.isDir : true  // intermediate nodes are always dirs
  const checked = node.isCleanable && node.entry ? selectedPaths.has(node.path) : false

  // For non-cleanable intermediate nodes: batch select/deselect their descendants
  const cleanableDescendants = !node.isCleanable && hasChildren
    ? getCleanableDescendants(node)
    : null
  const allDescendantsSelected = cleanableDescendants !== null
    && cleanableDescendants.length > 0
    && cleanableDescendants.every((d) => selectedPaths.has(d.path))

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
            onClick={() => onToggle(node.path, node.entry!)}
            className={[
              'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
              checked ? 'bg-blue-600 border-blue-600' : 'border-zinc-600 bg-transparent'
            ].join(' ')}
          >
            {checked && (
              <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        ) : cleanableDescendants && cleanableDescendants.length > 0 ? (
          <button
            onClick={handleBatchToggle}
            className={[
              'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
              allDescendantsSelected
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
          onClick={() => node.isCleanable && node.entry && onToggle(node.path, node.entry)}
          className="flex-1 min-w-0 flex items-center justify-between gap-1 text-left min-w-0"
        >
          <span className={[
            'text-xs truncate leading-snug',
            node.isCleanable ? 'text-zinc-200 font-medium' : 'text-zinc-500'
          ].join(' ')}>
            {node.label}
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
        />
      ))}

      {ctx && (() => {
        const hasCleanableContent = (node.isCleanable && !!node.entry) ||
          (cleanableDescendants !== null && cleanableDescendants.length > 0)
        const ctxIsSelected = node.isCleanable ? checked : allDescendantsSelected
        const ctxToggle = node.isCleanable && node.entry
          ? () => onToggle(node.path, node.entry!)
          : batchToggle
        return (
          <ItemCtxMenu
            x={ctx.x}
            y={ctx.y}
            canSelect={hasCleanableContent && !isCriticalPath(node.path)}
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
}

// ─── Leftover row ─────────────────────────────────────────────────────────────

interface LeftoverRowProps {
  item: AppLeftover
  checked: boolean
  onToggle: () => void
  onReveal: () => void
  onInfo: (entry: DiskEntry) => void
}

function LeftoverRow({ item, checked, onToggle, onReveal, onInfo }: LeftoverRowProps) {
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null)
  const isDir = !item.name.endsWith('.plist')

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
          onClick={onToggle}
          className={[
            'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
            checked ? 'bg-blue-600 border-blue-600' : 'border-zinc-600 bg-transparent'
          ].join(' ')}
        >
          {checked && (
            <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>

        {isDir ? <FolderIcon /> : <FileIcon />}

        <button onClick={onToggle} className="flex-1 min-w-0 text-left">
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-medium text-zinc-200 truncate">{item.name}</span>
            <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">{formatSize(item.sizeKB)}</span>
          </div>
          <span className="text-[10px] text-zinc-600 font-mono truncate block mt-0.5">{item.location}</span>
        </button>
      </div>

      {ctx && (
        <ItemCtxMenu
          x={ctx.x}
          y={ctx.y}
          canSelect={!isCriticalPath(item.path)}
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

// ─── Main component ───────────────────────────────────────────────────────────

export function SmartCleanPanel({
  allCleanable,
  selectedPaths,
  rootPath,
  onToggle,
  onSelectAll,
  onDeselectAll,
  onAddLeftoversToSelection,
  onInfo,
  onRevealInFinder,
  initialLeftoverSelection,
  onClose
}: SmartCleanPanelProps) {
  const [mounted, setMounted] = useState(false)

  // App leftovers
  const [leftovers, setLeftovers] = useState<AppLeftover[]>([])
  const [leftoversLoading, setLeftoversLoading] = useState(true)
  const [selectedLeftovers, setSelectedLeftovers] = useState<Set<string>>(new Set())

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(selectedLeftovers) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, selectedLeftovers])

  // Fetch leftovers on mount
  useEffect(() => {
    setLeftoversLoading(true)
    window.electronAPI.findAppLeftovers()
      .then((items) => {
        setLeftovers(items)
        if (initialLeftoverSelection === null) {
          // First open this session — select everything
          setSelectedLeftovers(new Set(items.map((i) => i.path)))
        } else {
          // Restore previous selection, keeping only paths that still exist
          const existing = new Set(items.map((i) => i.path))
          setSelectedLeftovers(new Set([...initialLeftoverSelection].filter((p) => existing.has(p))))
        }
      })
      .catch(() => setLeftovers([]))
      .finally(() => setLeftoversLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentionally run once on mount; initialLeftoverSelection captured at open time

  const allEntries = useMemo(() => [...allCleanable.values()].filter((e) => e.sizeKB > 0), [allCleanable])

  const tree = useMemo(
    () => buildCleanableTree(allEntries, rootPath),
    [allEntries, rootPath]
  )

  const selectedScanItems = allEntries.filter((e) => selectedPaths.has(e.path))
  const selectedLeftoverItems = leftovers.filter((l) => selectedLeftovers.has(l.path))
  const totalSelectedKB =
    selectedScanItems.reduce((s, e) => s + e.sizeKB, 0) +
    selectedLeftoverItems.reduce((s, l) => s + l.sizeKB, 0)
  const totalSelectedCount = selectedScanItems.length + selectedLeftoverItems.length

  const allScanSelected = allEntries.length > 0 && allEntries.every((e) => selectedPaths.has(e.path))
  const allLeftoversSelected = leftovers.length > 0 && leftovers.every((l) => selectedLeftovers.has(l.path))

  const toggleLeftover = useCallback((path: string) => {
    setSelectedLeftovers((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleAddToSelection = useCallback(() => {
    // Scan items are already in selectedPaths via onToggle — just add leftovers
    if (selectedLeftoverItems.length > 0) {
      const entries: DiskEntry[] = selectedLeftoverItems.map((l) => ({
        name: l.name,
        path: l.path,
        sizeKB: l.sizeKB,
        isDir: !l.name.endsWith('.plist'),
      }))
      onAddLeftoversToSelection(entries)
    }
    onClose(selectedLeftovers)
  }, [selectedLeftoverItems, selectedLeftovers, onAddLeftoversToSelection, onClose])

  return (
    <div
      className={[
        'flex flex-col h-full bg-zinc-950',
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
          <span className="text-xs text-zinc-500">
            {totalSelectedCount > 0
              ? `${totalSelectedCount} selected · ${formatSize(totalSelectedKB)}`
              : 'Nothing selected'}
          </span>
          <button
            onClick={() => {
              if (allScanSelected && allLeftoversSelected) {
                onDeselectAll()
                setSelectedLeftovers(new Set())
              } else {
                onSelectAll()
                setSelectedLeftovers(new Set(leftovers.map((l) => l.path)))
              }
            }}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            {(allScanSelected && allLeftoversSelected) ? 'Deselect All' : 'Select All'}
          </button>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto min-h-0">

        {/* ── Scan-tree section ── */}
        {tree.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-3 pt-3 pb-1">
              <span className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest">
                Caches &amp; Temp
              </span>
              <button
                onClick={allScanSelected ? onDeselectAll : onSelectAll}
                className="text-[10px] text-blue-500 hover:text-blue-400 transition-colors"
              >
                {allScanSelected ? 'Deselect' : 'Select all'}
              </button>
            </div>
            {tree.map((node) => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                selectedPaths={selectedPaths}
                onToggle={onToggle}
                onInfo={onInfo}
                onRevealInFinder={onRevealInFinder}
              />
            ))}
          </div>
        )}

        {/* ── App leftovers section ── */}
        <div>
          <div className="flex items-center justify-between px-3 pt-3 pb-1">
            <span className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest">
              App Leftovers
            </span>
            {!leftoversLoading && leftovers.length > 0 && (
              <button
                onClick={() => {
                  if (allLeftoversSelected) setSelectedLeftovers(new Set())
                  else setSelectedLeftovers(new Set(leftovers.map((l) => l.path)))
                }}
                className="text-[10px] text-blue-500 hover:text-blue-400 transition-colors"
              >
                {allLeftoversSelected ? 'Deselect' : 'Select all'}
              </button>
            )}
          </div>

          {leftoversLoading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-zinc-600">
              <div className="w-3 h-3 rounded-full border border-transparent border-t-zinc-500 animate-spin shrink-0" />
              Scanning for app leftovers…
            </div>
          ) : leftovers.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-700">
              No leftover data found.
            </div>
          ) : (
            leftovers.map((item) => (
              <LeftoverRow
                key={item.path}
                item={item}
                checked={selectedLeftovers.has(item.path)}
                onToggle={() => toggleLeftover(item.path)}
                onReveal={() => window.electronAPI.revealInFinder(item.path)}
                onInfo={onInfo}
              />
            ))
          )}
        </div>

        {tree.length === 0 && !leftoversLoading && leftovers.length === 0 && (
          <div className="flex items-center justify-center h-24 text-xs text-zinc-600 px-4 text-center">
            Nothing to clean up.
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-white/5 px-4 py-3 flex flex-col gap-2">
        <button
          onClick={handleAddToSelection}
          disabled={totalSelectedCount === 0}
          className="w-full py-2 rounded-lg bg-blue-600/80 hover:bg-blue-600 disabled:opacity-30 disabled:cursor-not-allowed text-xs text-white font-medium transition-colors"
        >
          {totalSelectedCount > 0
            ? `Add ${totalSelectedCount} ${totalSelectedCount === 1 ? 'item' : 'items'} to Selection`
            : 'Add to Selection'}
        </button>
        <button
          onClick={() => onClose(selectedLeftovers)}
          className="w-full py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-zinc-400 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
