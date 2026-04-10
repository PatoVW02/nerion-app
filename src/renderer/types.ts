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

export interface BackgroundScanSettings {
  enabled: boolean
  intervalHours: number
  scanTimeHour: number
  lastScanPath: string | null
  lastScanTime: number | null
  lastScanResults: Array<{ path: string; name: string; sizeKB: number; isDir: boolean }>
}

export interface OllamaModel {
  name: string
  size: number
}

export interface VectraSettings {
  backgroundScan: BackgroundScanSettings
  showMenuBarIcon: boolean
  autoUpdateEnabled: boolean
  preferredOllamaModel: string | null
  onboardingComplete: boolean
  showDevDependencies: boolean
  /** Folder names (relative to ~/Library) included in Quick Scan mode. */
  quickScanFolders: string[]
  /** Absolute paths the user has added via the folder picker. */
  customQuickScanFolders: string[]
  lastManualScanTime: number | null
  lastManualScanFoundKB: number
  lastCleanedTime: number | null
  lastCleanedKB: number
  deleteQuota: {
    monthKey: string
    used: number
  }
}

export interface LicenseInfo {
  active: boolean
  licenseType: 'subscription' | 'lifetime' | null
  maskedKey: string | null
  customerEmail: string | null
  expiresAt: string | null
  lastValidated: string | null
}

declare global {
  interface Window {
    electronAPI: {
      // Scanner
      startScan: (path: string | string[]) => void
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

      // File system
      openExternal: (url: string) => Promise<void>

      // Settings & background scan
      getSettings: () => Promise<VectraSettings>
      getHomeDir: () => Promise<string>
      getAppVersion: () => Promise<string>
      saveSettings: (settings: VectraSettings) => Promise<void>
      runBgScanNow: () => Promise<void>
      updateLastScanPath: (path: string) => void
      notifyManualScanDone: (foundKB: number) => void
      notifyCleaned: (cleanedKB: number) => void
      onBgCleanRequested: (cb: (entries: DiskEntry[]) => void) => void
      removeBgCleanListeners: () => void
      testNotification: () => Promise<void>
      checkForUpdates: () => Promise<boolean>
      requestNotificationPermission: () => Promise<void>
      markOnboardingComplete: () => Promise<void>
      getLoginItem: () => Promise<boolean>
      setLoginItem: (enable: boolean) => Promise<void>
      checkOllama: () => Promise<{ installed: boolean; hasModels?: boolean }>
      getOllamaModels: () => Promise<{ ok: boolean; models: OllamaModel[] }>
      pullModel: (name: string) => void
      cancelPull: () => void
      onPullProgress: (cb: (data: { model: string; progress: number | null; status: string }) => void) => void
      onPullDone: (cb: (data: { model: string; error: string | null }) => void) => void
      removePullListeners: () => void

      // License
      getLicense: () => Promise<LicenseInfo>
      activateLicense: (key: string) => Promise<{ ok: true; info: LicenseInfo } | { ok: false; error: string }>
      deactivateLicense: () => Promise<void>
    }
  }
}
