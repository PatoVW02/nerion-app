export interface DiskEntry {
  name: string
  path: string
  sizeKB: number
  isDir: boolean
}

export type ScanResult =
  | { ok: true; entries: DiskEntry[] }
  | { ok: false; error: string }

export interface ItemStats {
  modified: string
  created: string
  sizeBytes: number
}

export interface AppLeftover {
  path: string
  name: string
  sizeKB: number
  location: string  // e.g. "Application Support", "Caches"
}

declare global {
  interface Window {
    electronAPI: {
      // Scanner
      startScan: (path: string) => void
      cancelScan: () => void
      onScanEntry: (cb: (entry: DiskEntry) => void) => void
      onScanDone: (cb: (error: string | null) => void) => void
      removeScanListeners: () => void

      // File operations
      openDirectory: () => Promise<string | null>
      revealInFinder: (path: string) => Promise<void>
      trashEntries: (paths: string[]) => Promise<string | null>
      getItemStats: (path: string) => Promise<ItemStats | { error: string }>

      // App leftover detection
      findAppLeftovers: () => Promise<AppLeftover[]>

      // Ollama AI
      startOllamaAnalysis: (payload: {
        path: string
        name: string
        isDir: boolean
        sizeKB: number
      }) => void
      cancelOllamaAnalysis: () => void
      onOllamaModel: (cb: (model: string) => void) => void
      onOllamaToken: (cb: (token: string) => void) => void
      onOllamaDone: (cb: (error: string | null) => void) => void
      removeOllamaListeners: () => void
    }
  }
}
