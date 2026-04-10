import { app, net, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { loadSettings } from './settings'
import { setQuitting } from './background'

const DEFAULT_LANDING_URLS = [
    'https://vectra-mu.vercel.app', 
    // 'https://vectrapp.com', 
    // 'https://vectra-app.com',
    // 'https://vectraapp.com'
]

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

function resolveLandingUrls(): string[] {
  const env = process.env['VECTRA_LANDING_PAGE_URLS'] ?? process.env['VECTRA_LANDING_PAGE_URL']
  if (!env) return DEFAULT_LANDING_URLS

  const parsed = env
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)

  return parsed.length > 0 ? parsed : DEFAULT_LANDING_URLS
}

function parseVersionFromLanding(html: string): string | null {
  const patterns = [
    /releases\/download\/v(\d+\.\d+\.\d+)/i,
    /Vectra-(\d+\.\d+\.\d+)-[a-z0-9]+\.dmg/i,
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return match[1]
  }

  return null
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

async function fetchLatestLandingVersion(): Promise<string | null> {
  for (const url of resolveLandingUrls()) {
    try {
      const res = await net.fetch(url)
      if (!res.ok) continue
      const html = await res.text()
      const version = parseVersionFromLanding(html)
      if (version) return version
    } catch {
      // Try the next landing URL candidate.
    }
  }

  return null
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
    const latestLandingVersion = await fetchLatestLandingVersion()
    if (!latestLandingVersion) {
      console.log('[Vectra] Auto-update check skipped: could not detect latest version from landing page.')
      return false
    }

    const currentVersion = app.getVersion()
    if (compareSemver(latestLandingVersion, currentVersion) <= 0) {
      console.log(`[Vectra] Auto-update check (${reason}): already up to date (${currentVersion}).`)
      return false
    }

    ensureUpdaterListeners()

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    downloadedUpdateReady = false

    console.log(`[Vectra] Auto-update check (${reason}): ${currentVersion} -> ${latestLandingVersion}. Checking provider feed.`)
    await autoUpdater.checkForUpdates()
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
