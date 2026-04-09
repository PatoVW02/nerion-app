import { useState, useEffect, useRef, useCallback } from 'react'
import { DiskEntry } from '../types'

export type TreeMap = Map<string, DiskEntry[]>

export interface TreeScanState {
  tree: TreeMap
  scanning: boolean
  scannedCount: number
  removeEntries: (paths: string[]) => void
  cancelScan: () => void
}

function parentPath(p: string): string {
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p
  const lastSlash = trimmed.lastIndexOf('/')
  if (lastSlash <= 0) return '/'
  return trimmed.slice(0, lastSlash)
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

export function useTreeScanner(rootPath: string | null, scanTrigger: number): TreeScanState {
  const internalTree = useRef<TreeMap>(new Map())
  const pendingCount = useRef(0)
  const batchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [state, setState] = useState<Omit<TreeScanState, 'removeEntries'>>({
    tree: new Map(),
    scanning: false,
    scannedCount: 0
  })

  const removeEntries = useCallback((paths: string[]) => {
    const pathSet = new Set(paths)
    let changed = false
    for (const [dirPath, entries] of internalTree.current) {
      const filtered = entries.filter(e => !pathSet.has(e.path))
      if (filtered.length !== entries.length) {
        internalTree.current.set(dirPath, filtered)
        changed = true
      }
    }
    if (changed) {
      setState(prev => ({ ...prev, tree: new Map(internalTree.current) }))
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
    // Flush whatever partial results exist and mark scanning as done
    const newTree = new Map<string, DiskEntry[]>()
    for (const [k, v] of internalTree.current) {
      newTree.set(k, v.slice())
    }
    setState(prev => ({ ...prev, tree: newTree, scanning: false }))
  }, [])

  useEffect(() => {
    if (!rootPath) {
      setState({ tree: new Map(), scanning: false, scannedCount: 0 })
      return
    }

    // Reset for new root
    internalTree.current = new Map()
    pendingCount.current = 0
    if (batchTimer.current) clearTimeout(batchTimer.current)
    batchTimer.current = null

    setState({ tree: new Map(), scanning: true, scannedCount: 0 })
    window.electronAPI.removeScanListeners()

    function flushBatch(finalScan: boolean) {
      batchTimer.current = null
      // Copy each directory's array so React sees new references and
      // useMemo in TreemapView recomputes the layout. Without this,
      // insertSorted mutates arrays in-place and useMemo bails out.
      const newTree = new Map<string, DiskEntry[]>()
      for (const [k, v] of internalTree.current) {
        newTree.set(k, v.slice())
      }
      setState({
        tree: newTree,
        scanning: !finalScan,
        scannedCount: pendingCount.current
      })
    }

    function scheduleBatch() {
      if (batchTimer.current) return
      batchTimer.current = setTimeout(() => flushBatch(false), 150)
    }

    window.electronAPI.onScanEntry((entry) => {
      const parent = parentPath(entry.path)
      let siblings = internalTree.current.get(parent)
      if (!siblings) {
        siblings = []
        internalTree.current.set(parent, siblings)
      }
      insertSorted(siblings, entry)
      pendingCount.current++
      scheduleBatch()
    })

    window.electronAPI.onScanDone(() => {
      if (batchTimer.current) {
        clearTimeout(batchTimer.current)
      }
      flushBatch(true)
    })

    window.electronAPI.startScan(rootPath)

    return () => {
      if (batchTimer.current) clearTimeout(batchTimer.current)
      window.electronAPI.cancelScan()
      window.electronAPI.removeScanListeners()
    }
  }, [rootPath, scanTrigger])

  return { ...state, removeEntries, cancelScan }
}
