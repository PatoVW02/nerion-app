import { contextBridge, ipcRenderer } from 'electron'
import type { UpdaterStatusEvent } from '../main/updater'
import type { PlatformInfo } from '../renderer/types'
import type { AiCapabilities, BackgroundScanRunOutcome, DeleteBatchResult, DeleteItemStatus, LeftoverScanResult, LicenseSnapshot, PlatformAppearance, ScanEventV1 } from '../shared/contracts'

// Single persistent listeners — callbacks are swapped, never re-registered.
const ollamaCallbacks: {
  model: ((model: string) => void) | null
  token: ((token: string) => void) | null
  done:  ((error: string | null) => void) | null
} = { model: null, token: null, done: null }

const updaterStatusCallbacks = new Set<(event: UpdaterStatusEvent) => void>()
const openSettingsTabCallbacks = new Set<(tab: 'general' | 'background' | 'ai' | 'scanning') => void>()
const licenseCallbacks = new Set<(snapshot: LicenseSnapshot) => void>()
const appearanceCallbacks = new Set<(appearance: PlatformAppearance) => void>()

ipcRenderer.on('ollama-model', (_e, model)  => ollamaCallbacks.model?.(model))
ipcRenderer.on('ollama-token', (_e, token)  => ollamaCallbacks.token?.(token))
ipcRenderer.on('ollama-done',  (_e, error)  => ollamaCallbacks.done?.(error))
ipcRenderer.on('updater-status', (_e, event) => {
  const payload = event as UpdaterStatusEvent
  updaterStatusCallbacks.forEach((cb) => cb(payload))
})
ipcRenderer.on('open-settings-tab', (_e, tab) => {
  const payload = tab as 'general' | 'background' | 'ai' | 'scanning'
  openSettingsTabCallbacks.forEach((cb) => cb(payload))
})
ipcRenderer.on('license:changed', (_event, snapshot: LicenseSnapshot) => {
  licenseCallbacks.forEach((callback) => callback(snapshot))
})
ipcRenderer.on('appearance:changed', (_event, appearance: PlatformAppearance) => {
  appearanceCallbacks.forEach((callback) => callback(appearance))
})

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Scanner ──────────────────────────────────────────────────────────────
  startScan: (pathOrPaths: string | string[]) => {
    const scanId = globalThis.crypto.randomUUID()
    ipcRenderer.send('scan-start', { scanId, paths: Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths] })
    return scanId
  },
  cancelScan: () => ipcRenderer.send('scan-cancel'),
  onScanEvent: (cb: (event: ScanEventV1) => void) => {
    const singleHandler = (_event: Electron.IpcRendererEvent, event: ScanEventV1) => cb(event)
    const batchHandler = (_event: Electron.IpcRendererEvent, events: ScanEventV1[]) => {
      for (const event of events) cb(event)
    }
    ipcRenderer.on('scan-event', singleHandler)
    ipcRenderer.on('scan-events', batchHandler)
    return () => {
      ipcRenderer.off('scan-event', singleHandler)
      ipcRenderer.off('scan-events', batchHandler)
    }
  },
  removeScanListeners: () => {
    ipcRenderer.removeAllListeners('scan-event')
    ipcRenderer.removeAllListeners('scan-events')
  },

  // ── File operations ───────────────────────────────────────────────────────
  openDirectory: () => ipcRenderer.invoke('open-directory'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  revealInFileManager: (path: string) => ipcRenderer.invoke('reveal-in-file-manager', path),
  trashEntries: (paths: string[]) => ipcRenderer.invoke('trash-entries', paths) as Promise<DeleteBatchResult>,
  onTrashProgress: (cb: (data: { requestedPath: string; path: string; status: DeleteItemStatus; error?: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { requestedPath: string; path: string; status: DeleteItemStatus; error?: string }) => cb(data)
    ipcRenderer.on('trash-progress', handler)
    return () => ipcRenderer.off('trash-progress', handler)
  },
  getItemStats: (path: string) => ipcRenderer.invoke('get-item-stats', path),

  // ── App leftover detection ────────────────────────────────────────────────
  findAppLeftovers: () => ipcRenderer.invoke('find-app-leftovers') as Promise<LeftoverScanResult>,

  // ── Ollama AI ─────────────────────────────────────────────────────────────
  // Listeners are registered once; only the callback reference is swapped.
  // This prevents duplicate listeners when effects re-run (e.g. React StrictMode).
  startOllamaAnalysis: (payload: {
    path: string
    name: string
    isDir: boolean
    sizeKB: number
  }) => ipcRenderer.send('ollama-start', payload),
  cancelOllamaAnalysis: () => ipcRenderer.send('ollama-cancel'),
  onOllamaModel: (cb: (model: string) => void) => { ollamaCallbacks.model = cb },
  onOllamaToken: (cb: (token: string) => void) => { ollamaCallbacks.token = cb },
  onOllamaDone:  (cb: (error: string | null) => void) => { ollamaCallbacks.done = cb },
  removeOllamaListeners: () => {
    ollamaCallbacks.model = null
    ollamaCallbacks.token = null
    ollamaCallbacks.done  = null
  },

  // ── Settings & background scan ────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getPlatformInfo: () => ipcRenderer.invoke('get-platform-info') as Promise<PlatformInfo>,
  getPlatformAppearance: () => ipcRenderer.invoke('appearance:get') as Promise<PlatformAppearance>,
  onPlatformAppearanceChanged: (cb: (appearance: PlatformAppearance) => void) => {
    appearanceCallbacks.add(cb)
    return () => appearanceCallbacks.delete(cb)
  },
  getHomeDir: () => ipcRenderer.invoke('get-home-dir') as Promise<string>,
  getAppVersion: () => ipcRenderer.invoke('get-app-version') as Promise<string>,
  getAppArch: () => ipcRenderer.invoke('get-app-arch') as Promise<string>,
  saveSettings: (settings: unknown) => ipcRenderer.invoke('save-settings', settings),
  runBgScanNow: () => ipcRenderer.invoke('run-bg-scan') as Promise<BackgroundScanRunOutcome>,
  updateLastScanPath: (path: string) => ipcRenderer.send('update-last-scan-path', path),
  notifyManualScanDone: (foundKB: number) => ipcRenderer.send('notify-manual-scan-done', foundKB),
  notifyCleaned: (cleanedKB: number) => ipcRenderer.send('notify-cleaned', cleanedKB),
  onBgCleanRequested: (cb: (entries: unknown[]) => void) => {
    ipcRenderer.on('bg-clean-requested', (_e, entries) => cb(entries))
  },
  removeBgCleanListeners: () => ipcRenderer.removeAllListeners('bg-clean-requested'),
  testNotification: () => ipcRenderer.invoke('test-notification'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdateNow: () => ipcRenderer.invoke('install-update-now') as Promise<boolean>,
  isUpdateReadyToInstall: () => ipcRenderer.invoke('is-update-ready-to-install') as Promise<boolean>,
  onUpdaterStatus: (cb: (event: UpdaterStatusEvent) => void) => {
    updaterStatusCallbacks.add(cb)
    return () => updaterStatusCallbacks.delete(cb)
  },
  removeUpdaterListeners: () => { updaterStatusCallbacks.clear() },
  onOpenSettingsTab: (cb: (tab: 'general' | 'background' | 'ai' | 'scanning') => void) => {
    openSettingsTabCallbacks.add(cb)
    return () => openSettingsTabCallbacks.delete(cb)
  },
  removeOpenSettingsTabListeners: () => { openSettingsTabCallbacks.clear() },
  requestNotificationPermission: () => ipcRenderer.invoke('request-notification-permission'),
  markOnboardingComplete: () => ipcRenderer.invoke('mark-onboarding-complete'),
  getLoginItem: () => ipcRenderer.invoke('get-login-item') as Promise<boolean>,
  setLoginItem: (enable: boolean) => ipcRenderer.invoke('set-login-item', enable),
  checkFullDiskAccess: () => ipcRenderer.invoke('check-full-disk-access') as Promise<boolean>,
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
  isDev: process.env.NODE_ENV === 'development',
  getElectronExePath: () => ipcRenderer.invoke('get-electron-exe-path') as Promise<string>,
  checkNotificationPermission: () => ipcRenderer.invoke('check-notification-permission') as Promise<boolean | null>,
  checkOllama: () => ipcRenderer.invoke('check-ollama') as Promise<{ installed: boolean; hasModels?: boolean }>,
  getOllamaModels: () => ipcRenderer.invoke('get-ollama-models') as Promise<{ ok: boolean; models: Array<{ name: string; size: number }> }>,
  pullModel: (name: string) => ipcRenderer.send('pull-model', name),
  cancelPull: () => ipcRenderer.send('cancel-pull'),
  onPullProgress: (cb: (data: { model: string; progress: number | null; status: string }) => void) => {
    ipcRenderer.on('pull-progress', (_e, data) => cb(data))
  },
  onPullDone: (cb: (data: { model: string; error: string | null }) => void) => {
    ipcRenderer.on('pull-done', (_e, data) => cb(data))
  },
  removePullListeners: () => {
    ipcRenderer.removeAllListeners('pull-progress')
    ipcRenderer.removeAllListeners('pull-done')
  },

  // ── License ────────────────────────────────────────────────────────────────
  getLicense: () => ipcRenderer.invoke('license:get') as Promise<import('../renderer/types').LicenseInfo>,
  activateLicense: (key: string) => ipcRenderer.invoke('license:activate', key),
  deactivateLicense: () => ipcRenderer.invoke('license:deactivate'),
  onLicenseChanged: (cb: (snapshot: LicenseSnapshot) => void) => {
    licenseCallbacks.add(cb)
    return () => licenseCallbacks.delete(cb)
  },

  // ── AI mode ───────────────────────────────────────────────────────────────
  getAiCapabilities: () => ipcRenderer.invoke('get-ai-capabilities') as Promise<AiCapabilities>,
  getAiMode: () => ipcRenderer.invoke('get-ai-mode') as Promise<'cloud' | 'ollama'>,
  setAiMode: (mode: 'cloud' | 'ollama') => ipcRenderer.invoke('set-ai-mode', mode) as Promise<'cloud' | 'ollama'>,
})
