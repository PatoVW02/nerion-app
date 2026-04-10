import { useRef, useState, useLayoutEffect, useMemo } from 'react'
import { DiskEntry } from '../types'
import { formatSize } from '../utils/format'
import { isCriticalPath, isContentOnlyProtectedRoot } from '../utils/criticalPaths'
import { EmptyState } from './EmptyState'
import { ScanningLoader } from './ScanningLoader'

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

function squarify(entries: DiskEntry[], rect: Rect): LayoutItem[] {
  if (entries.length === 0 || rect.w <= 0 || rect.h <= 0) return []

  const rawSizes = entries.map((e) => Math.max(e.sizeKB, 1))
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

  // Guarantee every entry is always visible regardless of size difference.
  //
  // Squarify lays out items by committing "rows" and then recursing into the
  // remaining strip. The last item(s) always end up in that leftover strip,
  // which can be just 3–4 px tall when a dominant item has consumed most of
  // the canvas. A minimum *area* doesn't help — what matters is the strip
  // HEIGHT. We fix this by giving every item at least 1/(N × VISIBILITY_FACTOR)
  // of the adjusted total, so the residual strip is always large enough to
  // produce a block that passes the render threshold. The constant 1/6 per N
  // means the floor never exceeds 1/6 of the total (the floor fraction × N
  // cancels), leaving 83 % of the layout purely proportional.
  const N = adjusted.length
  if (N > 1) {
    const adjTotal = adjusted.reduce((a, b) => a + b, 0)
    const minValue = adjTotal / (N * 6)
    adjusted = adjusted.map(v => Math.max(v, minValue))
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

  if (w < 6 || h < 6) return null

  const ratio = maxSizeKB > 0 ? entry.sizeKB / maxSizeKB : 0
  const { bg, border, ring } = blockStyles(entry, ratio, isSelected)

  const showLabel    = w >= 48 && h >= 22
  const showSize     = w >= 72 && h >= 44
  const critical     = isCriticalPath(entry.path)
  const selectableContentOnlyRoot = critical && isContentOnlyProtectedRoot(entry.path)
  const showCheckbox = (!critical || selectableContentOnlyRoot) && w >= 52 && h >= 26

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
        <div className="px-2 pt-1.5 flex flex-col gap-0.5 overflow-hidden">
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
}

function folderDisplayName(path: string): string {
  if (!path || path === '/') return 'root'
  return path.split('/').filter(Boolean).pop() ?? path
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
  onToggleSelect
}: TreemapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })

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

  const visibleEntries = useMemo(() => entries.filter(e => e.sizeKB > 0), [entries])

  const layout = useMemo(
    () => squarify(visibleEntries, { x: 0, y: 0, w: dims.w, h: dims.h }),
    [visibleEntries, dims]
  )

  const maxSizeKB = visibleEntries[0]?.sizeKB ?? 1
  const folderName = scanningPath ? folderDisplayName(scanningPath) : undefined

  return (
    <div className="flex flex-col w-full h-full overflow-hidden">

      {/* Treemap canvas */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 overflow-hidden ml-6 mt-6 p-3"
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
          layout.map(({ entry, rect }) => (
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
          ))
        )}
      </div>
    </div>
  )
}
