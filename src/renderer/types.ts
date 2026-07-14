import type {
  DeleteBatchResult,
  AiCapabilities,
  BackgroundScanRunOutcome,
  LeftoverGroup,
  LeftoverScanResult,
  LicenseSnapshot,
  PlatformAppearance,
  ScanEventV1,
  ScanIssue,
  ScanSummaryV1,
  SuspiciousFinding,
} from '../shared/contracts'

export type { AiCapabilities, BackgroundScanRunOutcome, DeleteBatchResult, LeftoverGroup, LeftoverScanResult, LicenseSnapshot, PlatformAppearance, ScanEventV1, ScanIssue, ScanSummaryV1, SuspiciousFinding }

export interface DiskEntry {
  name: string
  path: string
  sizeKB: number
  isDir: boolean
  allocatedBytes?: number
  scanId?: string
  rootId?: string
  device?: string | null
  inode?: string | null
  hardlinkDuplicate?: boolean
}

export type ScanResult =
  | { ok: true; entries: DiskEntry[] }
  | { ok: false; error: string }

export interface ItemStats {
  modified: string
  created: string
  sizeBytes: number
}

export type AppLeftover = LeftoverGroup

export interface BackgroundScanSettings {
  enabled: boolean
  intervalHours: number
  scanTimeHour: number
  lastScanPath: string | null
  lastScanTime: number | null
  lastScanResults: Array<{ path: string; name: string; sizeKB: number; isDir: boolean }>
  lastScanComplete: boolean | null
  lastScanIssueCount: number
  lastScanError: string | null
}

export interface OllamaModel {
  name: string
  size: number
}

export interface NerionSettings {
  backgroundScan: BackgroundScanSettings
  showMenuBarIcon: boolean
  autoUpdateEnabled: boolean
  lastAutoUpdateCheckTime: number | null
  deleteImmediately: boolean
  quickScanTrashConfigured: boolean
  preferredOllamaModel: string | null
  onboardingComplete: boolean
  showDevDependencies: boolean
  /** 'cloud' = runtime-configured OpenAI; 'ollama' = local Ollama */
  aiMode: 'cloud' | 'ollama'
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

export type LicenseInfo = LicenseSnapshot

export type UpdaterStatusEvent =
  | { type: 'checking' }
  | { type: 'update-available'; version: string }
  | { type: 'update-not-available'; version: string }
  | { type: 'download-progress'; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { type: 'update-downloaded'; version: string }
  | { type: 'error'; message: string }

export interface PlatformInfo {
  id: 'macos' | 'windows'
  fileManagerName: string
  revealActionLabel: string
  startupLabel: string
  startupDescription: string
  trayLabel: string
  trayDescription: string
  supportsFullDiskAccess: boolean
  fullDiskAccessLabel: string
  fullDiskAccessDescription: string
  notificationSettingsUrl: string | null
  fullDiskAccessSettingsUrl: string | null
  quickScanDefaults: string[]
  quickScanOptions: Array<{ name: string; desc: string }>
}

declare global {
  interface Window {
    electronAPI: {
      // Scanner
      startScan: (path: string | string[]) => string
      cancelScan: () => void
      onScanEvent: (cb: (event: ScanEventV1) => void) => () => void
      removeScanListeners: () => void

      // File operations
      openDirectory: () => Promise<string | null>
      revealInFileManager: (path: string) => Promise<void>
      trashEntries: (paths: string[]) => Promise<DeleteBatchResult>
      onTrashProgress: (cb: (data: { requestedPath: string; path: string; status: import('../shared/contracts').DeleteItemStatus; error?: string }) => void) => () => void
      getItemStats: (path: string) => Promise<ItemStats | { error: string }>

      // App leftover detection
      findAppLeftovers: () => Promise<LeftoverScanResult>

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
      getSettings: () => Promise<NerionSettings>
      getPlatformInfo: () => Promise<PlatformInfo>
      getPlatformAppearance: () => Promise<PlatformAppearance>
      onPlatformAppearanceChanged: (cb: (appearance: PlatformAppearance) => void) => () => void
      getHomeDir: () => Promise<string>
      getAppVersion: () => Promise<string>
      getAppArch: () => Promise<string>
      saveSettings: (settings: NerionSettings) => Promise<void>
      runBgScanNow: () => Promise<BackgroundScanRunOutcome>
      updateLastScanPath: (path: string) => void
      notifyManualScanDone: (foundKB: number) => void
      notifyCleaned: (cleanedKB: number) => void
      onBgCleanRequested: (cb: (entries: DiskEntry[]) => void) => void
      removeBgCleanListeners: () => void
      testNotification: () => Promise<void>
      checkForUpdates: () => Promise<boolean>
      installUpdateNow: () => Promise<boolean>
      isUpdateReadyToInstall: () => Promise<boolean>
      onUpdaterStatus: (cb: (event: UpdaterStatusEvent) => void) => () => void
      removeUpdaterListeners: () => void
      onOpenSettingsTab: (cb: (tab: 'general' | 'background' | 'ai' | 'scanning') => void) => () => void
      removeOpenSettingsTabListeners: () => void
      requestNotificationPermission: () => Promise<void>
      checkNotificationPermission: () => Promise<boolean | null>
      markOnboardingComplete: () => Promise<void>
      getLoginItem: () => Promise<boolean>
      setLoginItem: (enable: boolean) => Promise<void>
      checkFullDiskAccess: () => Promise<boolean>
      relaunchApp: () => Promise<void>
      isDev: boolean
      getElectronExePath: () => Promise<string>
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
      deactivateLicense: () => Promise<LicenseInfo>
      onLicenseChanged: (cb: (snapshot: LicenseInfo) => void) => () => void

      // AI mode
      getAiCapabilities: () => Promise<AiCapabilities>
      configureCloudAi: (apiKey: string) => Promise<AiCapabilities>
      removeCloudAiCredential: () => Promise<AiCapabilities>
      getAiMode: () => Promise<'cloud' | 'ollama'>
      setAiMode: (mode: 'cloud' | 'ollama') => Promise<'cloud' | 'ollama'>
    }
  }
}
