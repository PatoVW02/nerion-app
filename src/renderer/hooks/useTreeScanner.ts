import { useState, useEffect, useRef, useCallback } from 'react'
import { DiskEntry, type ScanIssue, type ScanSummaryV1, type SuspiciousFinding } from '../types'
import { isSameOrDescendantPath, normalizeUiPath, pathParent } from '../utils/path'
import { CANCELLED_SCAN_WARNING, resolveScanTargets, scanCompletionWarning } from '../utils/scan-state'

export type TreeMap = Map<string, DiskEntry[]>

export interface TreeScanState {
  tree: TreeMap
  scanning: boolean
  scannedCount: number
  error: string | null
  issues: ScanIssue[]
  summary: ScanSummaryV1 | null
  suspiciousFindings: SuspiciousFinding[]
  removeEntries: (paths: string[]) => void
  cancelScan: () => void
}

// Insert into a sorted-descending array without copying it
function insertSorted(arr: DiskEntry[], entry: DiskEntry): void {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid].sizeKB >= entry.sizeKB) lo = mid + 1
    else hi = mid
  }
  arr.splice(lo, 0, entry)
}

export function useTreeScanner(rootPath: string | null, scanTrigger: number, scanPaths?: string[] | null): TreeScanState {
  const internalTree = useRef<TreeMap>(new Map())
  const pendingCount = useRef(0)
  const dirtyParents = useRef(new Set<string>())
  const batchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeScanId = useRef<string | null>(null)
  const scanIssues = useRef<ScanIssue[]>([])
  const suspiciousFindings = useRef(new Map<string, SuspiciousFinding>())
  // Keep a ref so the effect always uses the latest scanPaths without adding it to deps
  const scanPathsRef = useRef<string[] | null>(scanPaths ?? null)
  scanPathsRef.current = scanPaths ?? null

  const [state, setState] = useState<Omit<TreeScanState, 'removeEntries' | 'cancelScan'>>({
    tree: new Map(),
    scanning: false,
    scannedCount: 0,
    error: null,
    issues: [],
    summary: null,
    suspiciousFindings: [],
  })

  const removeEntries = useCallback((paths: string[]) => {
    const pathSet = new Set(paths.map(normalizeUiPath))
    let changed = false

    // Remove entries that appear as children inside their parent bucket
    for (const [dirPath, entries] of internalTree.current) {
      const filtered = entries.filter(e => !pathSet.has(normalizeUiPath(e.path)))
      if (filtered.length !== entries.length) {
        internalTree.current.set(dirPath, filtered)
        changed = true
      }
    }

    // Also remove directory buckets for deleted paths and all their descendants.
    // Without this, deleting ".venv" leaves the ".venv" bucket (and sub-buckets)
    // in internalTree, so their children keep appearing in SmartClean / ReviewPanel.
    for (const dirPath of [...internalTree.current.keys()]) {
      const directoryKey = normalizeUiPath(dirPath)
      if ([...pathSet].some(p => isSameOrDescendantPath(directoryKey, p))) {
        internalTree.current.delete(dirPath)
        changed = true
      }
    }

    const previousFindingCount = suspiciousFindings.current.size
    for (const [id, finding] of suspiciousFindings.current) {
      if ([...pathSet].some((deletedPath) => isSameOrDescendantPath(normalizeUiPath(finding.path), deletedPath))) {
        suspiciousFindings.current.delete(id)
      }
    }

    if (changed || previousFindingCount !== suspiciousFindings.current.size) {
      setState(prev => ({
        ...prev,
        tree: new Map(internalTree.current),
        suspiciousFindings: [...suspiciousFindings.current.values()],
      }))
    }
  }, [])

  const cancelScan = useCallback(() => {
    // Stop the batch timer
    if (batchTimer.current) {
      clearTimeout(batchTimer.current)
      batchTimer.current = null
    }
    // Kill the scanner process in the main process
    window.electronAPI.cancelScan()
    window.electronAPI.removeScanListeners()
    activeScanId.current = null
    // Flush whatever partial results exist and mark scanning as done
    const newTree = new Map<string, DiskEntry[]>()
    for (const [k, v] of internalTree.current) {
      newTree.set(k, v.slice())
    }
    setState(prev => ({
      ...prev,
      tree: newTree,
      scanning: false,
      error: CANCELLED_SCAN_WARNING,
      suspiciousFindings: [...suspiciousFindings.current.values()],
    }))
  }, [])

  useEffect(() => {
    if (!rootPath) {
      setState({ tree: new Map(), scanning: false, scannedCount: 0, error: null, issues: [], summary: null, suspiciousFindings: [] })
      return
    }

    // Reset for new root
    internalTree.current = new Map()
    pendingCount.current = 0
    dirtyParents.current = new Set()
    scanIssues.current = []
    suspiciousFindings.current = new Map()
    if (batchTimer.current) clearTimeout(batchTimer.current)
    batchTimer.current = null

    setState({ tree: new Map(), scanning: true, scannedCount: 0, error: null, issues: [], summary: null, suspiciousFindings: [] })
    window.electronAPI.removeScanListeners()

    function flushBatch(finalScan: boolean, finalError: string | null = null, summary: ScanSummaryV1 | null = null) {
      batchTimer.current = null
      // Only clone buckets changed since the previous render. Copying every
      // directory on every progress tick becomes quadratic on large scans.
      const changedParents = [...dirtyParents.current]
      dirtyParents.current.clear()
      setState((previous) => {
        const newTree = new Map(previous.tree)
        for (const parent of changedParents) {
          const entries = internalTree.current.get(parent)
          if (entries) newTree.set(parent, entries.slice())
          else newTree.delete(parent)
        }
        return {
          tree: newTree,
          scanning: !finalScan,
          scannedCount: pendingCount.current,
          error: finalError,
          issues: [...scanIssues.current],
          summary,
          suspiciousFindings: [...suspiciousFindings.current.values()],
        }
      })
    }

    function scheduleBatch() {
      if (batchTimer.current) return
      batchTimer.current = setTimeout(() => flushBatch(false), 250)
    }

    const unsubscribe = window.electronAPI.onScanEvent((event) => {
      if (event.scanId !== activeScanId.current) return
      if (event.event === 'issue') {
        scanIssues.current.push(event.issue)
        scheduleBatch()
        return
      }
      if (event.event === 'summary') {
        if (batchTimer.current) clearTimeout(batchTimer.current)
        flushBatch(true, scanCompletionWarning(event), event)
        return
      }
      if (event.event === 'suspicious') {
        suspiciousFindings.current.set(event.finding.id, event.finding)
        scheduleBatch()
        return
      }

      const entry: DiskEntry = event
      const parent = pathParent(entry.path)
      let siblings = internalTree.current.get(parent)
      if (!siblings) {
        siblings = []
        internalTree.current.set(parent, siblings)
      }
      insertSorted(siblings, entry)
      dirtyParents.current.add(parent)
      pendingCount.current++
      scheduleBatch()
    })

    activeScanId.current = window.electronAPI.startScan(resolveScanTargets(rootPath, scanPathsRef.current))

    return () => {
      if (batchTimer.current) clearTimeout(batchTimer.current)
      activeScanId.current = null
      window.electronAPI.cancelScan()
      unsubscribe()
    }
  }, [rootPath, scanTrigger])

  return { ...state, removeEntries, cancelScan }
}
