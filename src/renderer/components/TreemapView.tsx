import { useRef, useState, useLayoutEffect, useMemo, useEffect } from 'react'
import { DiskEntry } from '../types'
import { formatSize } from '../utils/format'
import { isCriticalPath, isContentOnlyProtectedRoot } from '../utils/criticalPaths'
import { EmptyState } from './EmptyState'
import { ScanningLoader } from './ScanningLoader'
import { SelectionBar } from './SelectionBar'

// ─── Squarify layout ────────────────────────────────────────────────────────

interface Rect { x: number; y: number; w: number; h: number }
interface LayoutItem { entry: DiskEntry; rect: Rect }

function worstRatio(row: number[], w: number): number {
  if (row.length === 0 || w === 0) return Infinity
  const s = row.reduce((a, b) => a + b, 0)
  if (s === 0) return Infinity
  const rmax = Math.max(...row)
  const rmin = Math.min(...row)
  return Math.max((w * w * rmax) / (s * s), (s * s) / (w * w * rmin))
}

function layoutItems(
  items: DiskEntry[],
  values: number[],
  rect: Rect,
  out: LayoutItem[]
): void {
  if (items.length === 0 || rect.w <= 0 || rect.h <= 0) return

  const horizontal = rect.w >= rect.h
  const rowLength = horizontal ? rect.h : rect.w

  const row: number[] = []
  const rowItems: DiskEntry[] = []
  let i = 0

  while (i < items.length) {
    const candidate = [...row, values[i]]
    if (row.length === 0 || worstRatio(candidate, rowLength) <= worstRatio(row, rowLength)) {
      row.push(values[i])
      rowItems.push(items[i])
      i++
    } else {
      break
    }
  }

  const rowSum = row.reduce((a, b) => a + b, 0)
  const thickness = rowSum / rowLength

  let offset = horizontal ? rect.y : rect.x
  for (let j = 0; j < row.length; j++) {
    const len = row[j] / thickness
    if (horizontal) {
      out.push({ entry: rowItems[j], rect: { x: rect.x, y: offset, w: thickness, h: len } })
    } else {
      out.push({ entry: rowItems[j], rect: { x: offset, y: rect.y, w: len, h: thickness } })
    }
    offset += len
  }

  const remaining: Rect = horizontal
    ? { x: rect.x + thickness, y: rect.y, w: rect.w - thickness, h: rect.h }
    : { x: rect.x, y: rect.y + thickness, w: rect.w, h: rect.h - thickness }

  layoutItems(items.slice(i), values.slice(i), remaining, out)
}

// Largest block is capped at this fraction of total area so one item never
// swamps the whole view. The remaining fraction is redistributed proportionally.
const MAX_DOMINANT_RATIO = 0.75
const MIN_STRIP_PX = 12
const MIN_PROTECTED_STRIP_PX = 22
const MIN_PROTECTED_BLOCK_AREA = 68 * 22

// sizePower < 1 compresses the range between large and small items.
// At 1.0 sizes are proportional; at ~0.15 all items are nearly equal.
function squarify(entries: DiskEntry[], rect: Rect, sizePower = 1): LayoutItem[] {
  if (entries.length === 0 || rect.w <= 0 || rect.h <= 0) return []

  const rawSizes = entries.map((e) => Math.pow(Math.max(e.sizeKB, 1), sizePower))
  const totalRaw = rawSizes.reduce((a, b) => a + b, 0)

  // If the largest item would occupy more than MAX_DOMINANT_RATIO of the area,
  // cap it and scale the rest up proportionally so they fill the remainder.
  let adjusted = rawSizes
  if (entries.length > 1 && rawSizes[0] / totalRaw > MAX_DOMINANT_RATIO) {
    const cappedFirst = totalRaw * MAX_DOMINANT_RATIO
    const restRaw = totalRaw - rawSizes[0]
    const restTarget = totalRaw - cappedFirst            // = totalRaw * (1 - MAX_DOMINANT_RATIO)
    const scale = restRaw > 0 ? restTarget / restRaw : 0
    adjusted = [cappedFirst, ...rawSizes.slice(1).map((s) => s * scale)]
  }

  // Guarantee every block is always visible regardless of size difference or
  // window size. Squarify commits "rows" then recurses into a remaining strip;
  // the last items end up in that strip whose thickness can be just a few px
  // when a dominant item has consumed most of the canvas.
  //
  // We use two floors — whichever is larger wins:
  //   1. Area floor: each item gets ≥ 1/(N×6) of total — classic proportional floor.
  //   2. Strip-thickness floor: ensures the minimum strip thickness ≥ MIN_STRIP_PX
  //      so blocks never fall below the render threshold regardless of canvas size.
  //      Derived from: thickness = value/rowLength ≥ MIN_STRIP_PX
  //      ⟹ value ≥ MIN_STRIP_PX × max(W,H) as fraction of total.
  const N = adjusted.length
  if (N > 1) {
    const adjTotal = adjusted.reduce((a, b) => a + b, 0)
    const areaFloor = adjTotal / (N * 6)
    const stripFloor = (MIN_STRIP_PX / Math.max(rect.w, rect.h)) * adjTotal
    const minValue = Math.max(areaFloor, stripFloor)
    const protectedStripFloor = (MIN_PROTECTED_STRIP_PX / Math.max(rect.w, rect.h)) * adjTotal
    const protectedAreaFloor = (MIN_PROTECTED_BLOCK_AREA / Math.max(rect.w * rect.h, 1)) * adjTotal
    const protectedMinValue = Math.max(minValue, protectedStripFloor, protectedAreaFloor)
    adjusted = adjusted.map((v, i) =>
      Math.max(v, isCriticalPath(entries[i].path) ? protectedMinValue : minValue)
    )
  }

  const area = rect.w * rect.h
  const total = adjusted.reduce((a, b) => a + b, 0)
  const values = adjusted.map((v) => (v / total) * area)

  const result: LayoutItem[] = []
  layoutItems(entries, values, rect, result)
  return result
}

// ─── Block visuals ───────────────────────────────────────────────────────────

function blockStyles(
  entry: DiskEntry,
  ratio: number,
  isSelected: boolean
): { bg: string; border: string; ring: string } {
  if (isSelected) {
    return {
      bg: 'bg-blue-500/30 hover:bg-blue-500/40',
      border: 'border-blue-400/60',
      ring: 'ring-1 ring-blue-400/50 ring-inset'
    }
  }
  if (!entry.isDir) {
    return {
      bg: 'bg-zinc-800/80 hover:bg-zinc-700/80',
      border: 'border-zinc-600/15',
      ring: ''
    }
  }
  // Colour directories by relative size: largest = most saturated
  if (ratio > 0.35) {
    return {
      bg: 'bg-blue-800/65 hover:bg-blue-700/70',
      border: 'border-blue-600/30',
      ring: ''
    }
  }
  if (ratio > 0.12) {
    return {
      bg: 'bg-blue-900/65 hover:bg-blue-800/70',
      border: 'border-blue-700/25',
      ring: ''
    }
  }
  if (ratio > 0.03) {
    return {
      bg: 'bg-blue-950/75 hover:bg-blue-900/75',
      border: 'border-blue-800/20',
      ring: ''
    }
  }
  return {
    bg: 'bg-slate-900/75 hover:bg-slate-800/75',
    border: 'border-slate-700/20',
    ring: ''
  }
}

// ─── Block component ─────────────────────────────────────────────────────────

const GAP = 4

function FolderIcon() {
  return (
    <svg className="w-3 h-3 shrink-0 opacity-60" fill="currentColor" viewBox="0 0 20 20">
      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  )
}

function ProtectedBadge({ compact = false, iconOnly = false }: { compact?: boolean; iconOnly?: boolean }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full border border-amber-400/20 bg-amber-500/10 text-amber-300 shrink-0',
        compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-1.5 py-0.5 text-[10px]'
      ].join(' ')}
    >
      <svg className={compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V8a4 4 0 118 0v3m-9 0h10a1 1 0 011 1v7a1 1 0 01-1 1H7a1 1 0 01-1-1v-7a1 1 0 011-1z" />
      </svg>
      {!iconOnly && <span>Protected</span>}
    </span>
  )
}

function TreemapBlock({
  entry,
  rect,
  maxSizeKB,
  isSelected,
  onNavigate,
  onContextMenu,
  onToggleSelect
}: {
  entry: DiskEntry
  rect: Rect
  maxSizeKB: number
  isSelected: boolean
  onNavigate: (e: DiskEntry) => void
  onContextMenu: (e: DiskEntry, x: number, y: number) => void
  onToggleSelect: (e: DiskEntry) => void
}) {
  const g = GAP / 2
  const x = rect.x + g
  const y = rect.y + g
  const w = rect.w - GAP
  const h = rect.h - GAP

  if (w < 2 || h < 2) return null

  const ratio = maxSizeKB > 0 ? entry.sizeKB / maxSizeKB : 0
  const { bg, border, ring } = blockStyles(entry, ratio, isSelected)

  const showLabel    = w >= 48 && h >= 22
  const showSize     = w >= 72 && h >= 44
  const critical     = isCriticalPath(entry.path)
  const selectableContentOnlyRoot = critical && isContentOnlyProtectedRoot(entry.path)
  const showCheckbox = (!critical || selectableContentOnlyRoot) && w >= 52 && h >= 26
  const showProtectedBadge = critical && w >= 52 && h >= 40
  const protectedBadgeIconOnly = w < 128

  return (
    <div
      style={{ position: 'absolute', left: x, top: y, width: w, height: h }}
      title={`${entry.path}\n${formatSize(entry.sizeKB)}`}
      className={[
        'group border rounded-lg overflow-hidden transition-colors duration-100',
        bg, border, ring,
        entry.isDir ? 'cursor-pointer' : 'cursor-default'
      ].join(' ')}
      onClick={() => { if (entry.isDir) onNavigate(entry) }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(entry, e.clientX, e.clientY)
      }}
    >
      {showLabel && (
        <div
          className="px-2 pt-1.5 flex flex-col gap-0.5 overflow-hidden"
          style={{
            paddingRight: showCheckbox ? 32 : 8,
          }}
        >
          <div className="flex items-center gap-1 text-zinc-200 min-w-0">
            {entry.isDir && <FolderIcon />}
            <span className="text-xs font-medium truncate leading-snug">
              {entry.name}
            </span>
          </div>
          {showSize && (
            <span className="text-[11px] text-zinc-500 tabular-nums leading-tight">
              {formatSize(entry.sizeKB)}
            </span>
          )}
        </div>
      )}

      {showProtectedBadge && (
        <div style={{ position: 'absolute', right: 8, bottom: 8, zIndex: 1 }}>
          <ProtectedBadge compact iconOnly={protectedBadgeIconOnly} />
        </div>
      )}

      {/* Selection checkbox — top-right corner, visible on block hover or when selected */}
      {showCheckbox && (
        <div
          style={{ position: 'absolute', top: 5, right: 5 }}
          onClick={(e) => { e.stopPropagation(); onToggleSelect(entry) }}
        >
          <div className={[
            'w-4 h-4 rounded border flex items-center justify-center transition-all duration-100',
            isSelected
              ? 'bg-blue-500 border-blue-400 opacity-100'
              : 'bg-black/30 border-white/25 opacity-0 group-hover:opacity-100'
          ].join(' ')}>
            {isSelected && (
              <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

interface TreemapViewProps {
  entries: DiskEntry[]
  scanning: boolean
  scannedCount: number
  scanningPath?: string
  error: string | null
  selectedPaths: Set<string>
  onNavigate: (entry: DiskEntry) => void
  onContextMenu: (entry: DiskEntry, x: number, y: number) => void
  onToggleSelect: (entry: DiskEntry) => void
  /** Add (select=true) or remove (select=false) a batch of entries from the selection */
  onBatchToggle: (entries: DiskEntry[], select: boolean) => void
  /** All currently selected entries — drives the compact selection bar */
  selectedEntries: DiskEntry[]
  onDeselect: () => void
  onContinue: () => void
}

function folderDisplayName(path: string): string {
  if (!path || path === '/') return 'root'
  return path.split('/').filter(Boolean).pop() ?? path
}

// Zoom is offered when the largest item is at least 8× the smallest,
// meaning the size spread is wide enough that smaller blocks are hard to read.
const ZOOM_SIZE_RATIO = 8

type SortField = 'name' | 'size' | 'created'
type SortDir   = 'asc' | 'desc'

function fmtDate(iso: string | undefined): string {
  if (!iso) return '–'
  try {
    const d = new Date(iso)
    const now = new Date()
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
  } catch { return '–' }
}

function SortIcon({ field, active, dir }: { field: string; active: boolean; dir: SortDir }) {
  if (!active) return (
    <svg className="w-2.5 h-2.5 opacity-25" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M8 9l4-4 4 4M16 15l-4 4-4-4" />
    </svg>
  )
  return dir === 'asc'
    ? <svg className="w-2.5 h-2.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
      </svg>
    : <svg className="w-2.5 h-2.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
      </svg>
}

const PANEL_MIN_W = 200
const PANEL_DEFAULT_W = 360
const PANEL_MAX_RATIO = 0.75
const TREEMAP_MIN_W = 260

function getPanelMaxWidth(): number {
  if (typeof window === 'undefined') return PANEL_DEFAULT_W
  return Math.max(PANEL_MIN_W, Math.floor(window.innerWidth * PANEL_MAX_RATIO) - TREEMAP_MIN_W)
}

export function TreemapView({
  entries,
  scanning,
  scannedCount,
  scanningPath,
  error,
  selectedPaths,
  onNavigate,
  onContextMenu,
  onToggleSelect,
  onBatchToggle,
  selectedEntries,
  onDeselect,
  onContinue,
}: TreemapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [zoomLevel, setZoomLevel] = useState(0)

  // ── Panel resize ───────────────────────────────────────────────────────────
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_W)
  const isDragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartW = useRef(0)

  function onResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    isDragging.current = true
    dragStartX.current = e.clientX
    dragStartW.current = panelWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isDragging.current) return
      const delta = e.clientX - dragStartX.current
      const next = Math.max(PANEL_MIN_W, Math.min(getPanelMaxWidth(), dragStartW.current + delta))
      setPanelWidth(next)
    }
    function onMouseUp() {
      if (!isDragging.current) return
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  useEffect(() => {
    function syncPanelWidthToViewport() {
      setPanelWidth((prev) => Math.max(PANEL_MIN_W, Math.min(getPanelMaxWidth(), prev)))
    }

    syncPanelWidthToViewport()
    window.addEventListener('resize', syncPanelWidthToViewport)
    return () => window.removeEventListener('resize', syncPanelWidthToViewport)
  }, [])

  // ── List panel sort state ──────────────────────────────────────────────────
  const [sortField, setSortField] = useState<SortField>('size')
  const [sortDir,   setSortDir]   = useState<SortDir>('desc')

  // Created dates loaded lazily after each scan completes (path → ISO string)
  const [itemDates, setItemDates] = useState<Record<string, string>>({})

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((obs) => {
      const { width, height } = obs[0].contentRect
      setDims({ w: width, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const firstEntryPath = entries[0]?.path ?? ''

  // Reset zoom on navigation
  useEffect(() => { setZoomLevel(0) }, [firstEntryPath])

  // Load created dates once the scan for the current folder is done
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scanKey = `${firstEntryPath}:${scanning ? 'scanning' : 'done'}`
  useEffect(() => {
    if (scanning || entries.length === 0) { setItemDates({}); return }

    let cancelled = false
    setItemDates({})
    const batch: Record<string, string> = {}
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    function flush() {
      if (cancelled) return
      setItemDates({ ...batch })
      flushTimer = null
    }

    Promise.all(
      entries.map(async (e) => {
        const stats = await window.electronAPI.getItemStats(e.path)
        if (cancelled) return
        if ('created' in stats && stats.created) {
          batch[e.path] = stats.created
          if (!flushTimer) flushTimer = setTimeout(flush, 200)
        }
      })
    ).then(() => {
      if (flushTimer) clearTimeout(flushTimer)
      flush()
    })

    return () => {
      cancelled = true
      if (flushTimer) clearTimeout(flushTimer)
    }
  // scanKey captures both firstEntryPath and scanning — intentional narrow dep
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey])

  const visibleEntries = useMemo(() => entries.filter(e => e.sizeKB > 0), [entries])

  // ── List panel — sorted entries ────────────────────────────────────────────
  const sortedEntries = useMemo(() => {
    const arr = [...visibleEntries]
    arr.sort((a, b) => {
      let cmp = 0
      if (sortField === 'name') {
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      } else if (sortField === 'size') {
        cmp = a.sizeKB - b.sizeKB
      } else {
        const da = itemDates[a.path] ?? ''
        const db = itemDates[b.path] ?? ''
        cmp = da < db ? -1 : da > db ? 1 : 0
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [visibleEntries, sortField, sortDir, itemDates])

  function handleSortClick(field: SortField) {
    if (field === sortField) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir(field === 'name' ? 'asc' : 'desc')
    }
  }

  // ── Selection helpers ──────────────────────────────────────────────────────
  // Only entries that aren't critical paths (or are selectable content roots) can be toggled
  const selectableEntries = useMemo(
    () => visibleEntries.filter(e => !isCriticalPath(e.path) || isContentOnlyProtectedRoot(e.path)),
    [visibleEntries]
  )
  const selectedCount   = selectableEntries.filter(e => selectedPaths.has(e.path)).length
  const allSelected     = selectableEntries.length > 0 && selectedCount === selectableEntries.length
  const someSelected    = selectedCount > 0 && !allSelected


  function handleSelectAll() {
    if (allSelected || someSelected) {
      onBatchToggle(selectableEntries, false)
    } else {
      onBatchToggle(selectableEntries, true)
    }
  }

  // ── Zoom ───────────────────────────────────────────────────────────────────
  const canZoom = useMemo(() => {
    if (visibleEntries.length < 3) return false
    const largest  = visibleEntries[0]?.sizeKB ?? 0
    const smallest = visibleEntries[visibleEntries.length - 1]?.sizeKB ?? 0
    return smallest > 0 && largest / smallest >= ZOOM_SIZE_RATIO
  }, [visibleEntries])

  const minSizePower = useMemo(() => {
    const largest  = visibleEntries[0]?.sizeKB ?? 1
    const smallest = visibleEntries[visibleEntries.length - 1]?.sizeKB ?? 1
    const ratio = largest / Math.max(smallest, 1)
    if (ratio <= 1) return 1
    const p = Math.log(4) / Math.log(ratio)
    return Math.max(0.05, Math.min(1, p))
  }, [visibleEntries])

  const sizePower = 1 - zoomLevel * (1 - minSizePower)

  const layout = useMemo(
    () => squarify(visibleEntries, { x: 0, y: 0, w: dims.w, h: dims.h }, sizePower),
    [visibleEntries, dims, sizePower]
  )

  const maxSizeKB = visibleEntries[0]?.sizeKB ?? 1
  const folderName = scanningPath ? folderDisplayName(scanningPath) : undefined

  function stepZoom(delta: number) {
    setZoomLevel(l => Math.max(0, Math.min(1, parseFloat((l + delta).toFixed(2)))))
  }

  const hasEntries = visibleEntries.length > 0

  return (
    <div className="flex flex-row w-full h-full overflow-hidden">

      {/* ── Left list panel ─────────────────────────────────────────────────── */}
      <div
        className="flex flex-col shrink-0 overflow-hidden relative"
        style={{ width: panelWidth }}
      >

        {/* Drag handle — right edge */}
        <div
          onMouseDown={onResizeMouseDown}
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize z-20 group"
        >
          <div className="w-px h-full bg-white/[0.06] group-hover:bg-white/20 transition-colors" />
        </div>

        {/* Column headers */}
        <div className="flex items-center gap-0 px-3 py-2 border-b border-white/[0.06] shrink-0">
          {/* Select-all checkbox */}
          <div
            onClick={handleSelectAll}
            title={allSelected || someSelected ? 'Deselect all' : 'Select all'}
            className={[
              'shrink-0 w-4 h-4 mr-2 rounded border flex items-center justify-center transition-all duration-100 cursor-pointer',
              allSelected || someSelected
                ? 'bg-blue-500 border-blue-400'
                : 'bg-black/30 border-white/25 hover:border-white/50'
            ].join(' ')}
          >
            {allSelected && (
              <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {someSelected && (
              <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 12h14" />
              </svg>
            )}
          </div>
          <button
            onClick={() => handleSortClick('name')}
            className={[
              'flex items-center gap-1 flex-1 min-w-0 text-left text-[11px] font-medium transition-colors',
              sortField === 'name' ? 'text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
            ].join(' ')}
          >
            <span>Name</span>
            <SortIcon field="name" active={sortField === 'name'} dir={sortDir} />
          </button>
          <button
            onClick={() => handleSortClick('size')}
            className={[
              'flex items-center justify-end gap-1 w-14 shrink-0 text-[11px] font-medium transition-colors',
              sortField === 'size' ? 'text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
            ].join(' ')}
          >
            <SortIcon field="size" active={sortField === 'size'} dir={sortDir} />
            <span>Size</span>
          </button>
          <button
            onClick={() => handleSortClick('created')}
            className={[
              'flex items-center justify-end gap-1 w-16 shrink-0 text-[11px] font-medium transition-colors',
              sortField === 'created' ? 'text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
            ].join(' ')}
          >
            <SortIcon field="created" active={sortField === 'created'} dir={sortDir} />
            <span>Created</span>
          </button>
        </div>

        {/* Rows */}
        <div className="flex-1 overflow-y-auto min-h-0 scrollbar-dark">
          {!hasEntries && !scanning ? (
            <p className="text-[11px] text-zinc-600 text-center mt-8">No items</p>
          ) : (
            sortedEntries.map((entry) => {
              const isSelected  = selectedPaths.has(entry.path)
              const isCritical  = isCriticalPath(entry.path)
              const canSelect   = !isCritical || isContentOnlyProtectedRoot(entry.path)
              return (
                <div
                  key={entry.path}
                  onClick={() => { if (entry.isDir) onNavigate(entry) }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onContextMenu(entry, e.clientX, e.clientY)
                  }}
                  className={[
                    'group flex items-center gap-0 px-3 py-1.5 border-b border-white/[0.03] transition-colors',
                    entry.isDir ? 'cursor-pointer' : 'cursor-default',
                    isSelected
                      ? 'bg-blue-500/15'
                      : entry.isDir
                        ? 'hover:bg-white/[0.04]'
                        : 'hover:bg-white/[0.02]'
                  ].join(' ')}
                >
                  {/* Per-row checkbox — matches the block checkbox style */}
                  <div
                    onClick={(e) => { e.stopPropagation(); if (canSelect) onToggleSelect(entry) }}
                    className={[
                      'shrink-0 w-4 h-4 mr-2 rounded border flex items-center justify-center transition-all duration-100',
                      !canSelect
                        ? 'bg-black/30 border-white/25 opacity-20 cursor-default'
                        : isSelected
                          ? 'bg-blue-500 border-blue-400 opacity-100 cursor-pointer'
                          : 'bg-black/30 border-white/25 opacity-0 group-hover:opacity-100 cursor-pointer'
                    ].join(' ')}
                  >
                    {isSelected && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>

                  {/* Icon */}
                  <span className="shrink-0 mr-1.5 text-zinc-500">
                    {entry.isDir
                      ? <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                        </svg>
                      : <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                    }
                  </span>

                  {/* Name — truncated, full name on hover via title */}
                  <span
                    title={entry.name}
                    className="flex-1 min-w-0 truncate text-[11px] text-zinc-300 leading-none"
                  >
                    <span className="inline-flex max-w-full items-center gap-1.5">
                      <span className="truncate">{entry.name}</span>
                      {isCritical && <ProtectedBadge />}
                    </span>
                  </span>

                  {/* Size */}
                  <span className="w-14 shrink-0 text-right text-[11px] text-zinc-500 tabular-nums leading-none">
                    {formatSize(entry.sizeKB)}
                  </span>

                  {/* Created date */}
                  <span className="w-16 shrink-0 text-right text-[11px] text-zinc-600 tabular-nums leading-none">
                    {fmtDate(itemDates[entry.path])}
                  </span>
                </div>
              )
            })
          )}
        </div>

        {/* Compact selection bar — pinned to the bottom of the panel */}
        {selectedEntries.length > 0 && (
          <SelectionBar
            compact
            selectedEntries={selectedEntries}
            onDeselect={onDeselect}
            onContinue={onContinue}
          />
        )}
      </div>

      {/* ── Treemap canvas ───────────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 overflow-hidden mt-6 mr-6 p-3"
      >
        {visibleEntries.length === 0 ? (
          scanning ? (
            <ScanningLoader scannedCount={scannedCount} folderName={folderName} />
          ) : error ? (
            <EmptyState type="error" error={error} />
          ) : (
            <EmptyState type="empty" />
          )
        ) : (
          <>
            {layout.map(({ entry, rect }) => (
              <TreemapBlock
                key={entry.path}
                entry={entry}
                rect={rect}
                maxSizeKB={maxSizeKB}
                isSelected={selectedPaths.has(entry.path)}
                onNavigate={onNavigate}
                onContextMenu={onContextMenu}
                onToggleSelect={onToggleSelect}
              />
            ))}

            {/* Zoom control — bottom-right corner */}
            {canZoom && !scanning && (
              <div className="absolute bottom-4 right-3 z-10 flex flex-col items-center gap-1.5">
                <button
                  onClick={() => stepZoom(0.1)}
                  disabled={zoomLevel >= 1}
                  title="Zoom in — make small items larger"
                  className="w-7 h-7 flex items-center justify-center rounded-lg bg-zinc-800/90 border border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/90 disabled:opacity-30 disabled:cursor-default transition-colors backdrop-blur-sm"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <circle cx="11" cy="11" r="7" strokeWidth={2} />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-3.5-3.5M8 11h6M11 8v6" />
                  </svg>
                </button>
                <div className="relative flex items-center justify-center" style={{ height: 96 }}>
                  <input
                    type="range"
                    min={0} max={1} step={0.01}
                    value={zoomLevel}
                    onChange={e => setZoomLevel(Number(e.target.value))}
                    style={{
                      writingMode: 'vertical-lr' as const,
                      direction: 'rtl' as const,
                      width: 4,
                      height: 96,
                      appearance: 'slider-vertical' as unknown as undefined,
                      WebkitAppearance: 'slider-vertical' as unknown as undefined,
                      cursor: 'pointer',
                      accentColor: zoomLevel > 0 ? '#3b82f6' : '#52525b',
                    }}
                  />
                </div>
                <button
                  onClick={() => stepZoom(-0.1)}
                  disabled={zoomLevel <= 0}
                  title="Zoom out — restore proportional sizes"
                  className="w-7 h-7 flex items-center justify-center rounded-lg bg-zinc-800/90 border border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/90 disabled:opacity-30 disabled:cursor-default transition-colors backdrop-blur-sm"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <circle cx="11" cy="11" r="7" strokeWidth={2} />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-3.5-3.5M8 11h6" />
                  </svg>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
