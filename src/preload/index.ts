import { contextBridge, ipcRenderer } from 'electron'
import type { DiskEntry } from '../main/scanner'
import type { UpdaterStatusEvent } from '../main/updater'

// Single persistent listeners — callbacks are swapped, never re-registered.
const ollamaCallbacks: {
  model: ((model: string) => void) | null
  token: ((token: string) => void) | null
  done:  ((error: string | null) => void) | null
} = { model: null, token: null, done: null }

const updaterCallbacks: {
  status: ((event: UpdaterStatusEvent) => void) | null
} = { status: null }

ipcRenderer.on('ollama-model', (_e, model)  => ollamaCallbacks.model?.(model))
ipcRenderer.on('ollama-token', (_e, token)  => ollamaCallbacks.token?.(token))
ipcRenderer.on('ollama-done',  (_e, error)  => ollamaCallbacks.done?.(error))
ipcRenderer.on('updater-status', (_e, event) => updaterCallbacks.status?.(event as UpdaterStatusEvent))

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Scanner ──────────────────────────────────────────────────────────────
  startScan: (path: string | string[]) => ipcRenderer.send('scan-start', path),
  cancelScan: () => ipcRenderer.send('scan-cancel'),
  onScanEntry: (cb: (entry: DiskEntry) => void) => {
    ipcRenderer.on('scan-entry', (_e, entry) => cb(entry))
  },
  onScanDone: (cb: (error: string | null) => void) => {
    ipcRenderer.on('scan-done', (_e, error) => cb(error))
  },
  removeScanListeners: () => {
    ipcRenderer.removeAllListeners('scan-entry')
    ipcRenderer.removeAllListeners('scan-done')
  },

  // ── File operations ───────────────────────────────────────────────────────
  openDirectory: () => ipcRenderer.invoke('open-directory'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  revealInFinder: (path: string) => ipcRenderer.invoke('reveal-in-finder', path),
  trashEntries: (paths: string[]) => ipcRenderer.invoke('trash-entries', paths),
  onTrashProgress: (cb: (data: { path: string; success: boolean; error?: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: { path: string; success: boolean; error?: string }) => cb(data)
    ipcRenderer.on('trash-progress', handler)
    return () => ipcRenderer.off('trash-progress', handler)
  },
  getItemStats: (path: string) => ipcRenderer.invoke('get-item-stats', path),

  // ── App leftover detection ────────────────────────────────────────────────
  findAppLeftovers: () => ipcRenderer.invoke('find-app-leftovers'),

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
  getHomeDir: () => ipcRenderer.invoke('get-home-dir') as Promise<string>,
  getAppVersion: () => ipcRenderer.invoke('get-app-version') as Promise<string>,
  getAppArch: () => ipcRenderer.invoke('get-app-arch') as Promise<string>,
  saveSettings: (settings: unknown) => ipcRenderer.invoke('save-settings', settings),
  runBgScanNow: () => ipcRenderer.invoke('run-bg-scan'),
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
  onUpdaterStatus: (cb: (event: UpdaterStatusEvent) => void) => { updaterCallbacks.status = cb },
  removeUpdaterListeners: () => { updaterCallbacks.status = null },
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

  // ── AI mode ───────────────────────────────────────────────────────────────
  getAiMode: () => ipcRenderer.invoke('get-ai-mode') as Promise<'cloud' | 'ollama'>,
  setAiMode: (mode: 'cloud' | 'ollama') => ipcRenderer.send('set-ai-mode', mode),
})
