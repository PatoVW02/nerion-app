import { execFileSync } from 'child_process'
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { loadSettings } from './settings'
import { setQuitting } from './background'

/**
 * Returns 'universal', 'arm64', or 'x64' by inspecting the running binary
 * with `lipo`. This is the only reliable way to distinguish a universal build
 * from an arm64-only build at runtime (both report process.arch === 'arm64'
 * on Apple Silicon).
 */
function detectBuildArch(): 'universal' | 'arm64' | 'x64' {
  if (process.platform === 'darwin') {
    try {
      const archs = execFileSync('lipo', ['-archs', process.execPath], { timeout: 3000 })
        .toString()
        .trim()
      if (archs.includes('arm64') && archs.includes('x86_64')) return 'universal'
    } catch {
      // lipo unavailable or failed — fall through to process.arch
    }
  }
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

let listenersRegistered = false
let checkInFlight = false
let downloadedUpdateReady = false

export type UpdaterStatusEvent =
  | { type: 'checking' }
  | { type: 'update-available'; version: string }
  | { type: 'update-not-available'; version: string }
  | { type: 'download-progress'; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { type: 'update-downloaded'; version: string }
  | { type: 'error'; message: string }

function broadcastUpdaterStatus(event: UpdaterStatusEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('updater-status', event)
    }
  }
}

function compareSemver(a: string, b: string): number {
  const aParts = a.replace(/^v/i, '').split('.').map(n => parseInt(n, 10))
  const bParts = b.replace(/^v/i, '').split('.').map(n => parseInt(n, 10))
  const len = Math.max(aParts.length, bParts.length)

  for (let i = 0; i < len; i += 1) {
    const av = Number.isFinite(aParts[i]) ? aParts[i] : 0
    const bv = Number.isFinite(bParts[i]) ? bParts[i] : 0
    if (av > bv) return 1
    if (av < bv) return -1
  }

  return 0
}
function ensureUpdaterListeners(): void {
  if (listenersRegistered) return

  autoUpdater.on('error', (err) => {
    downloadedUpdateReady = false
    const message = err instanceof Error ? err.message : String(err)
    broadcastUpdaterStatus({ type: 'error', message })
    console.error('[Vectra] Auto-updater error:', err)
  })

  autoUpdater.on('update-available', (info) => {
    broadcastUpdaterStatus({ type: 'update-available', version: info.version })
    console.log(`[Vectra] Update available: ${info.version}`)
  })

  autoUpdater.on('update-not-available', (info) => {
    downloadedUpdateReady = false
    broadcastUpdaterStatus({ type: 'update-not-available', version: info.version })
    console.log(`[Vectra] No update available (provider): ${info.version}`)
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcastUpdaterStatus({
      type: 'download-progress',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateReady = true
    broadcastUpdaterStatus({ type: 'update-downloaded', version: info.version })
    console.log(`[Vectra] Update downloaded: ${info.version}. Will install on app quit.`)
  })

  listenersRegistered = true
}

export async function runAutoUpdateCheck(reason: 'startup' | 'settings-enabled' | 'scheduled' | 'manual' = 'startup'): Promise<boolean> {
  if (!app.isPackaged) return false
  if (process.platform !== 'darwin') return false

  const settings = loadSettings()
  if (reason !== 'manual' && !settings.autoUpdateEnabled) return false
  if (checkInFlight) return false

  checkInFlight = true
  try {
    broadcastUpdaterStatus({ type: 'checking' })
    const currentVersion = app.getVersion()

    ensureUpdaterListeners()

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.channel = detectBuildArch()
    downloadedUpdateReady = false

    console.log(`[Vectra] Auto-update check (${reason}): channel=${autoUpdater.channel}, checking from ${currentVersion}.`)
    const result = await autoUpdater.checkForUpdates()
    const nextVersion = result?.updateInfo?.version
    if (!nextVersion || compareSemver(nextVersion, currentVersion) <= 0) {
      console.log(`[Vectra] Auto-update check (${reason}): already up to date (${currentVersion}).`)
      return false
    }

    console.log(`[Vectra] Auto-update check (${reason}): ${currentVersion} -> ${nextVersion}.`)
    return true
  } catch (err) {
    downloadedUpdateReady = false
    const message = err instanceof Error ? err.message : String(err)
    broadcastUpdaterStatus({ type: 'error', message })
    console.error('[Vectra] Auto-update check failed:', err)
    return false
  } finally {
    checkInFlight = false
  }
}

export function installDownloadedUpdateNow(): boolean {
  if (!downloadedUpdateReady) return false
  setQuitting()
  autoUpdater.quitAndInstall(false, true)
  return true
}

export function scheduleAutoUpdateChecks(): void {
  // Lightweight periodic check to keep long-running sessions up to date.
  setInterval(() => {
    runAutoUpdateCheck('scheduled').catch(() => {})
  }, 6 * 60 * 60 * 1000)
}
