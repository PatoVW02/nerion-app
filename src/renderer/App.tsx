import { useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from 'react'
import { Toolbar } from './components/Toolbar'
import { BottomBar } from './components/BottomBar'
import { Breadcrumb } from './components/Breadcrumb'
import { TreemapView } from './components/TreemapView'
import { ContextMenu } from './components/ContextMenu'
import { SelectionBar } from './components/SelectionBar'
import { InfoPanel } from './components/InfoPanel'
import { SmartCleanPanel } from './components/SmartCleanPanel'
import { ReviewPanel } from './components/ReviewPanel'
import { useNavigation } from './hooks/useNavigation'
import { useTreeScanner } from './hooks/useTreeScanner'
import { isCleanable } from './utils/cleanable'
import { DiskEntry } from './types'

interface ContextMenuState {
  entry: DiskEntry
  x: number
  y: number
}

/** Mounts children and immediately plays a slide-up-from-bottom entrance. */
function SlideUpBar({ children }: { children: ReactNode }) {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])
  return (
    <div
      className="transition-transform duration-300 ease-out"
      style={{ transform: entered ? 'translateY(0)' : 'translateY(100%)' }}
    >
      {children}
    </div>
  )
}

const MIN_PANEL_WIDTH = 220
const MAX_PANEL_WIDTH = 600
const DEFAULT_PANEL_WIDTH = 288
// Split ratio: fraction of panel height given to InfoPanel (top). 0.5 = equal.
const DEFAULT_SPLIT = 0.5
const MIN_SPLIT = 0.2
const MAX_SPLIT = 0.8

export function App() {
  const [selectedPath, setSelectedPath] = useState('/')
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Map<string, DiskEntry>>(new Map())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [scanPhase, setScanPhase] = useState<'welcome' | 'departing' | 'active'>('welcome')
  const [scanTrigger, setScanTrigger] = useState(0)

  // Independent panel states — both can be open simultaneously
  const [infoPanelEntry, setInfoPanelEntry] = useState<DiskEntry | null>(null)
  const [smartCleanOpen, setSmartCleanOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)

  // Smart Clean session state — reset on every new scan
  const smartCleanEverOpened = useRef(false)
  const [savedLeftoverSelection, setSavedLeftoverSelection] = useState<Set<string> | null>(null)

  // Resizable right panel
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT)

  const draggingWidth = useRef(false)
  const draggingSplit = useRef(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const rightPanelRef = useRef<HTMLDivElement>(null)

  const panelVisible = infoPanelEntry !== null || smartCleanOpen
  const bothOpen = infoPanelEntry !== null && smartCleanOpen

  const { stack, currentPath, navigate, goTo, reset } = useNavigation()
  const { tree, scanning, scannedCount, removeEntries, cancelScan } = useTreeScanner(rootPath, scanTrigger)

  const currentEntries = (currentPath ? tree.get(currentPath) : undefined) ?? []

  const allCleanable = useMemo(() => {
    const result = new Map<string, DiskEntry>()
    for (const entries of tree.values()) {
      for (const entry of entries) {
        if (isCleanable(entry)) result.set(entry.path, entry)
      }
    }
    return result
  }, [tree])

  const cleanableCount = allCleanable.size

  // ── Panel drag handlers ────────────────────────────────────────────────────

  const handleWidthDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingWidth.current = true
    dragStartX.current = e.clientX
    dragStartWidth.current = panelWidth
  }, [panelWidth])

  const handleSplitDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingSplit.current = true
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingWidth.current) {
        const delta = dragStartX.current - e.clientX
        const next = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, dragStartWidth.current + delta))
        setPanelWidth(next)
      }
      if (draggingSplit.current && rightPanelRef.current) {
        const rect = rightPanelRef.current.getBoundingClientRect()
        const ratio = (e.clientY - rect.top) / rect.height
        setSplitRatio(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio)))
      }
    }
    const onUp = () => {
      draggingWidth.current = false
      draggingSplit.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // ── Scan ──────────────────────────────────────────────────────────────────

  const handleScan = useCallback(() => {
    reset()
    navigate(selectedPath)
    setRootPath(selectedPath)
    setScanTrigger(t => t + 1)
    setSelectedPaths(new Map())
    setContextMenu(null)
    setInfoPanelEntry(null)
    setSmartCleanOpen(false)
    smartCleanEverOpened.current = false
    setSavedLeftoverSelection(null)
  }, [selectedPath, navigate, reset])

  /** Triggered by the Scan button on the welcome screen — animates controls out then starts scan. */
  const handleScanFromWelcome = useCallback(() => {
    setScanPhase('departing')
    setTimeout(() => {
      setScanPhase('active')
      handleScan()
    }, 320)
  }, [handleScan])

  const handleChooseFolder = useCallback(async () => {
    const picked = await window.electronAPI.openDirectory()
    if (picked) setSelectedPath(picked)
  }, [])

  // ── Navigation ────────────────────────────────────────────────────────────

  const handleNavigate = useCallback(
    (entry: DiskEntry) => {
      if (entry.isDir) navigate(entry.path)
    },
    [navigate]
  )

  // ── Context menu ──────────────────────────────────────────────────────────

  const handleContextMenu = useCallback((entry: DiskEntry, x: number, y: number) => {
    setContextMenu({ entry, x, y })
  }, [])

  const handleRevealInFinder = useCallback(() => {
    if (!contextMenu) return
    window.electronAPI.revealInFinder(contextMenu.entry.path)
  }, [contextMenu])

  const handleToggleSelect = useCallback(() => {
    if (!contextMenu) return
    const { entry } = contextMenu
    setSelectedPaths((prev) => {
      const next = new Map(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.set(entry.path, entry)
      return next
    })
  }, [contextMenu])

  const handleSelectEntry = useCallback((entry: DiskEntry) => {
    setSelectedPaths((prev) => {
      const next = new Map(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.set(entry.path, entry)
      return next
    })
  }, [])

  const handleInfo = useCallback(() => {
    if (!contextMenu) return
    setInfoPanelEntry(contextMenu.entry)
  }, [contextMenu])

  // ── Smart clean ───────────────────────────────────────────────────────────

  const handleSmartClean = useCallback(() => {
    if (!smartCleanEverOpened.current) {
      // First open this scan session — pre-select all cleanable items
      setSelectedPaths((prev) => new Map([...prev, ...allCleanable]))
      smartCleanEverOpened.current = true
    }
    setSmartCleanOpen(true)
  }, [allCleanable])

  const handleSmartCleanToggle = useCallback((path: string, entry: DiskEntry) => {
    setSelectedPaths((prev) => {
      const next = new Map(prev)
      if (next.has(path)) next.delete(path)
      else next.set(path, entry)
      return next
    })
  }, [])

  const handleSmartCleanSelectAll = useCallback(() => {
    setSelectedPaths((prev) => new Map([...prev, ...allCleanable]))
  }, [allCleanable])

  const handleSmartCleanDeselectAll = useCallback(() => {
    setSelectedPaths((prev) => {
      const next = new Map(prev)
      for (const path of allCleanable.keys()) next.delete(path)
      return next
    })
  }, [allCleanable])

  /** Called by SmartCleanPanel to merge leftover DiskEntries into the main selection. */
  const handleAddLeftoversToSelection = useCallback((entries: DiskEntry[]) => {
    setSelectedPaths((prev) => {
      const next = new Map(prev)
      for (const entry of entries) next.set(entry.path, entry)
      return next
    })
  }, [])

  // ── Trash ─────────────────────────────────────────────────────────────────

  /** Called by ReviewPanel after the user confirms. Trashes only the paths they kept selected. */
  const handleConfirmTrash = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
    const err = await window.electronAPI.trashEntries(paths)
    if (!err) {
      removeEntries(paths)
      setSelectedPaths((prev) => {
        const next = new Map(prev)
        for (const p of paths) next.delete(p)
        return next
      })
    }
  }, [removeEntries])

  // ── Derived ───────────────────────────────────────────────────────────────

  const selectedEntries = [...selectedPaths.values()]
  const selectedPathsSet = new Set(selectedPaths.keys())
  const showSelectionBar = selectedEntries.length > 0 && !smartCleanOpen

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 select-none overflow-hidden">
      <Toolbar />

      {scanPhase === 'active' && stack.length > 0 && (
        <div className="border-b border-white/5">
          <Breadcrumb stack={stack} onNavigate={goTo} />
        </div>
      )}

      {/* Main content row */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="flex-1 min-w-0">
          {scanPhase === 'active' ? (
            <TreemapView
              entries={currentEntries}
              scanning={scanning}
              scannedCount={scannedCount}
              scanningPath={rootPath ?? undefined}
              error={null}
              selectedPaths={selectedPathsSet}
              onNavigate={handleNavigate}
              onContextMenu={handleContextMenu}
              onToggleSelect={handleSelectEntry}
            />
          ) : (
            /* Welcome screen — visible until the first scan animates it away */
            <div className="flex flex-col items-center justify-center h-full select-none">
              <div
                className="flex flex-col items-center gap-7 transition-all duration-300 ease-in"
                style={{
                  opacity: scanPhase === 'departing' ? 0 : 1,
                  transform: scanPhase === 'departing' ? 'translateY(28px)' : 'translateY(0)',
                }}
              >
                {/* Title + subtitle */}
                <div className="flex flex-col items-center gap-2">
                  <p className="text-2xl font-semibold tracking-tight text-zinc-200">Vectra</p>
                  <p className="text-sm text-zinc-500">Select a folder and scan to see what's taking up space.</p>
                </div>

                {/* Folder + action controls */}
                <div className="flex flex-col items-center gap-3">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                    <svg className="w-3.5 h-3.5 text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                    </svg>
                    <span
                      className="text-xs text-zinc-400 font-mono truncate max-w-[200px]"
                      title={selectedPath}
                    >
                      {selectedPath === '/' ? 'Root' : selectedPath}
                    </span>
                    <button
                      onClick={handleChooseFolder}
                      className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors ml-1 border-l border-white/10 pl-2"
                    >
                      Change
                    </button>
                  </div>

                  <button
                    onClick={handleScanFromWelcome}
                    className="px-8 py-2 rounded-md bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-sm font-medium text-white transition-colors"
                  >
                    Scan
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Resizable right panel */}
        {panelVisible && (
          <>
            {/* Horizontal drag handle (left edge of panel) */}
            <div
              onMouseDown={handleWidthDragStart}
              className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors border-l border-white/5"
            />

            <div
              ref={rightPanelRef}
              style={{ width: panelWidth }}
              className="shrink-0 flex flex-col h-full overflow-hidden"
            >
              {/* Info panel — always top slot; flex proportion changes when both are open */}
              {infoPanelEntry && (
                <div
                  className="min-h-0 overflow-hidden"
                  style={{ flex: bothOpen ? splitRatio : 1 }}
                >
                  <InfoPanel
                    entry={infoPanelEntry}
                    isSelected={selectedPaths.has(infoPanelEntry.path)}
                    onClose={() => setInfoPanelEntry(null)}
                    onToggleSelect={(entry) => {
                      setSelectedPaths((prev) => {
                        const next = new Map(prev)
                        if (next.has(entry.path)) next.delete(entry.path)
                        else next.set(entry.path, entry)
                        return next
                      })
                    }}
                  />
                </div>
              )}

              {/* Vertical drag handle — only when both are open */}
              {bothOpen && (
                <div
                  onMouseDown={handleSplitDragStart}
                  className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors border-t border-white/5"
                />
              )}

              {/* Smart Clean panel — always bottom slot */}
              {smartCleanOpen && (
                <div
                  className="min-h-0 overflow-hidden"
                  style={{ flex: bothOpen ? 1 - splitRatio : 1 }}
                >
                  <SmartCleanPanel
                    allCleanable={allCleanable}
                    selectedPaths={selectedPathsSet}
                    rootPath={rootPath ?? '/'}
                    onToggle={handleSmartCleanToggle}
                    onSelectAll={handleSmartCleanSelectAll}
                    onDeselectAll={handleSmartCleanDeselectAll}
                    onAddLeftoversToSelection={handleAddLeftoversToSelection}
                    onInfo={setInfoPanelEntry}
                    onRevealInFinder={(p) => window.electronAPI.revealInFinder(p)}
                    initialLeftoverSelection={savedLeftoverSelection}
                    onClose={(leftoverSel) => {
                      setSavedLeftoverSelection(leftoverSel)
                      setSmartCleanOpen(false)
                    }}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {showSelectionBar && (
        <SelectionBar
          selectedEntries={selectedEntries}
          onDeselect={() => setSelectedPaths(new Map())}
          onContinue={() => setReviewOpen(true)}
        />
      )}

      {reviewOpen && (
        <ReviewPanel
          entries={selectedEntries}
          onConfirm={handleConfirmTrash}
          onCancel={() => setReviewOpen(false)}
        />
      )}

      {scanPhase === 'active' && (
        <SlideUpBar>
          <BottomBar
            selectedPath={selectedPath}
            scanning={scanning}
            cleanableCount={cleanableCount}
            onScan={handleScan}
            onCancelScan={cancelScan}
            onChangeFolder={handleChooseFolder}
            onSmartClean={handleSmartClean}
          />
        </SlideUpBar>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isDir={contextMenu.entry.isDir}
          isSelected={selectedPaths.has(contextMenu.entry.path)}
          onRevealInFinder={handleRevealInFinder}
          onToggleSelect={handleToggleSelect}
          onInfo={handleInfo}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
