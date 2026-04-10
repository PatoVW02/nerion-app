import { Tray, Menu, Notification, nativeImage, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { scanDirectoryStreaming, DiskEntry } from './scanner'
import { loadSettings, patchSettings } from './settings'
import * as os from 'os'

const CLEANABLE_NAMES = new Set(['.cache', '.tmp', 'tmp', 'temp', '.temp', 'logs', 'deriveddata'])
const DEV_DEPENDENCY_NAMES = new Set([
  'node_modules',
  'venv', '.venv', 'env', '__pycache__', '.tox',
  '.m2',
  '.gradle',
  'vendor',
  'target',
  '.build',
  'pods',
  '.stack-work',
  'bower_components',
])
const SYSTEM_PATH_PREFIXES = ['/opt/', '/usr/', '/System/', '/Library/', '/Applications/', '/Developer/', '/private/', '/bin/', '/sbin/']
const MANAGED_PATH_SUBSTRINGS = [
  '/.nvm/',
  '/.vscode/',
  '/.rbenv/',
  '/.pyenv/',
  '/.asdf/',
  '/homebrew/',
  '.app/Contents/',
  '/ShipIt/',
  '/.npm/',
  '/.copilot/',
  '/go/pkg/',
  '/Application Support/',
  '/Library/Python/',
  '/Library/Containers/',
]
function isCleanableEntry(e: DiskEntry): boolean {
  if (!e.isDir || !CLEANABLE_NAMES.has(e.name.toLowerCase())) return false
  for (const prefix of SYSTEM_PATH_PREFIXES) {
    if (e.path.startsWith(prefix)) return false
  }
  return !e.path.includes('/Library/Containers/')
}

function isDevDependencyEntry(e: DiskEntry): boolean {
  if (!DEV_DEPENDENCY_NAMES.has(e.name.toLowerCase())) return false
  for (const prefix of SYSTEM_PATH_PREFIXES) {
    if (e.path.startsWith(prefix)) return false
  }
  for (const sub of MANAGED_PATH_SUBSTRINGS) {
    if (e.path.includes(sub)) return false
  }
  return true
}

function fmtKB(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${kb} KB`
}

function timeAgo(ts: number): string {
  const d = Date.now() - ts
  const days = Math.floor(d / 86400000)
  const hrs = Math.floor(d / 3600000)
  const mins = Math.floor(d / 60000)
  if (days > 0) return `${days}d ago`
  if (hrs > 0) return `${hrs}h ago`
  if (mins > 0) return `${mins}m ago`
  return 'just now'
}

function intervalLabel(hours: number): string {
  if (hours <= 24) return 'day'
  if (hours <= 168) return 'week'
  return 'month'
}

let tray: Tray | null = null
let bgTimeout: ReturnType<typeof setTimeout> | null = null
let scanning = false
let getMainWin: () => BrowserWindow | null = () => null
let quitting = false

export function setQuitting(): void { quitting = true }
export function isQuitting(): boolean { return quitting }

function trayIconPath(): string {
  return is.dev
    ? join(process.cwd(), 'build', 'icon.png')
    : join(process.resourcesPath, 'icon.png')
}

export function initTray(mainWindowGetter: () => BrowserWindow | null): void {
  getMainWin = mainWindowGetter
  if (!loadSettings().showMenuBarIcon) return
  createTray()
}

function createTray(): void {
  try {
    const icon = nativeImage.createFromPath(trayIconPath()).resize({ width: 16, height: 16 })
    tray = new Tray(icon)
    tray.setToolTip('Vectra')
    rebuildTrayMenu()
  } catch {
    // icon missing in dev — skip tray
  }
}

export function setTrayVisibility(show: boolean): void {
  if (show && !tray) {
    createTray()
  } else if (!show && tray) {
    tray.destroy()
    tray = null
  }
}

export function testNotification(): void {
  if (!Notification.isSupported()) {
    console.error('[Vectra] Notifications not supported on this system')
    return
  }
  const n = new Notification({
    title: 'Vectra — Test Notification',
    body: 'Notifications are working correctly.'
  })
  n.on('show', () => console.log('[Vectra] Notification shown'))
  n.on('failed', (_e, err) => console.error('[Vectra] Notification failed:', err))
  n.show()
  console.log('[Vectra] testNotification called, isSupported=true')
}

export function rebuildTrayMenu(): void {
  if (!tray) return
  const s = loadSettings()
  const { backgroundScan: bg } = s
  const bgTotalKB = bg.lastScanResults.reduce((s, r) => s + r.sizeKB, 0)
  const manualTs = s.lastManualScanTime ?? 0
  const bgTs = bg.lastScanTime ?? 0
  const cleanedTs = s.lastCleanedTime ?? 0
  // Hide background scan results when a manual scan has happened more recently —
  // those results are stale relative to what the user just scanned.
  const manualScanIsNewer = manualTs > bgTs
  const hasResults = bg.lastScanResults.length > 0 && !manualScanIsNewer

  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'Vectra', enabled: false },
    { type: 'separator' },
    {
      label: bg.enabled
        ? `● Background scan on · every ${intervalLabel(bg.intervalHours)}`
        : '○ Background scan off',
      enabled: false
    }
  ]

  // Manual scan / clean status takes priority over background scan status
  if (s.lastCleanedTime && cleanedTs >= Math.max(manualTs, bgTs)) {
    items.push({
      label: `Last scan ${timeAgo(s.lastCleanedTime)} · Cleaned ${fmtKB(s.lastCleanedKB)}`,
      enabled: false
    })
  } else if (s.lastManualScanTime && manualTs >= bgTs) {
    items.push({
      label: s.lastManualScanFoundKB > 0
        ? `Last scan ${timeAgo(s.lastManualScanTime)} · Found ${fmtKB(s.lastManualScanFoundKB)}`
        : `Last scan ${timeAgo(s.lastManualScanTime)} · Nothing found`,
      enabled: false
    })
  } else if (bg.lastScanTime) {
    items.push({
      label: hasResults
        ? `Last scan ${timeAgo(bg.lastScanTime)} · Found ${fmtKB(bgTotalKB)}`
        : `Last scan ${timeAgo(bg.lastScanTime)} · Nothing found`,
      enabled: false
    })
  }

  items.push({ type: 'separator' })

  if (manualScanIsNewer && s.lastManualScanFoundKB > 0) {
    // Manual scan is the freshest — show its found amount; clicking just opens the app
    // (which already has the scan results loaded in the UI)
    items.push({
      label: `Review Items (${fmtKB(s.lastManualScanFoundKB)})`,
      click: () => {
        const win = getMainWin()
        if (!win) return
        win.show(); win.focus()
      }
    })
  } else if (hasResults) {
    // Background scan results are the freshest
    items.push({
      label: `Review Items (${fmtKB(bgTotalKB)})`,
      click: () => {
        const win = getMainWin()
        if (!win) return
        win.show(); win.focus()
        win.webContents.send('bg-clean-requested', bg.lastScanResults)
      }
    })
  }

  items.push({
    label: scanning ? 'Scanning…' : 'Scan Now',
    enabled: !scanning,
    click: () => runBackgroundScan()
  })

  items.push({ type: 'separator' })
  items.push({
    label: 'Open Vectra',
    click: () => { const w = getMainWin(); if (w) { w.show(); w.focus() } }
  })
  items.push({ type: 'separator' })
  items.push({
    label: 'Quit',
    click: () => {
      setQuitting()
      tray?.destroy()
      tray = null
      app.quit()
    }
  })

  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function scanFolder(dirPath: string): Promise<DiskEntry[]> {
  return new Promise((resolve) => {
    const entries: DiskEntry[] = []
    scanDirectoryStreaming(
      dirPath,
      (e) => entries.push(e),
      () => resolve(entries),
      { lowPriority: true }
    )
  })
}

export async function runBackgroundScan(): Promise<void> {
  if (scanning) return
  const settings = loadSettings()
  const home = os.homedir()
  const libraryRoot = join(home, 'Library')

  // Always scan the configured quick scan folders for speed and lower I/O impact.
  // Fall back to the default set if the setting is missing or empty.
  const folders = settings.quickScanFolders?.length
    ? settings.quickScanFolders
    : ['Caches', 'Logs', 'Developer', 'Containers', 'Downloads', 'Desktop']
  // Folders starting with '/' are absolute custom paths.
  // Well-known home folder names (e.g. 'Downloads', 'Desktop') resolve to ~/name.
  // Everything else resolves to ~/Library/name.
  const HOME_FOLDER_NAMES = new Set(['Downloads', 'Desktop'])
  const allowedPaths = new Set(folders.map(f =>
    f.startsWith('/') ? f : HOME_FOLDER_NAMES.has(f) ? join(home, f) : join(libraryRoot, f)
  ))

  // Mirror renderer quick-scan path strategy:
  // 1) scan ~/Library once if any Library-relative folder is enabled,
  // 2) scan home-relative folders (Downloads/Desktop) directly,
  // 3) scan absolute custom paths outside ~/Library directly.
  const scanPaths: string[] = []
  if (folders.some(f => !f.startsWith('/') && !HOME_FOLDER_NAMES.has(f))) {
    scanPaths.push(libraryRoot)
  }
  for (const f of folders) {
    if (!f.startsWith('/') && HOME_FOLDER_NAMES.has(f)) scanPaths.push(join(home, f))
  }
  for (const f of folders) {
    if (f.startsWith('/') && !f.startsWith(`${libraryRoot}/`)) scanPaths.push(f)
  }

  const dedupedScanPaths: string[] = []
  const seen = new Set<string>()
  for (const p of scanPaths) {
    if (seen.has(p)) continue
    seen.add(p)
    dedupedScanPaths.push(p)
  }

  const allowedPrefixes = [...allowedPaths]
  const downloadsParents = new Set<string>()
  for (const p of allowedPaths) {
    if (p.split('/').pop()?.toLowerCase() === 'downloads') downloadsParents.add(p)
  }

  scanning = true
  rebuildTrayMenu()

  try {
    const allCleanable: DiskEntry[] = []

    for (const scanPath of dedupedScanPaths) {
      const entries = await scanFolder(scanPath)
      for (const entry of entries) {
        const isDev = isDevDependencyEntry(entry)
        const parentDir = entry.path.slice(0, entry.path.lastIndexOf('/'))
        const isDownloadsItem = downloadsParents.has(parentDir) && entry.sizeKB > 0

        if (!isDev && !isDownloadsItem) {
          const inAllowedPath = allowedPrefixes.some(p => entry.path === p || entry.path.startsWith(`${p}/`))
          if (!inAllowedPath) continue
        }

        if (isCleanableEntry(entry) || isDev || isDownloadsItem) {
          allCleanable.push(entry)
        }
      }
    }

    const totalKB = allCleanable.reduce((s, e) => s + e.sizeKB, 0)

    patchSettings({
      backgroundScan: {
        lastScanTime: Date.now(),
        lastScanResults: allCleanable.map(e => ({ path: e.path, name: e.name, sizeKB: e.sizeKB, isDir: e.isDir }))
      }
    })

    if (allCleanable.length > 0) {
      const note = new Notification({
        title: 'Vectra — Scan Complete',
        body: `Found ${fmtKB(totalKB)} you can clean up. Click to review.`
      })
      note.on('click', () => {
        const win = getMainWin()
        if (!win) return
        win.show(); win.focus()
        win.webContents.send('bg-clean-requested', allCleanable.map(e => ({
          path: e.path, name: e.name, sizeKB: e.sizeKB, isDir: e.isDir
        })))
      })
      note.show()
    }
  } catch (err) {
    console.error('[Vectra] Background scan error:', err)
  } finally {
    scanning = false
    rebuildTrayMenu()
  }
}

/** Returns ms until the next scan should fire, respecting both the interval and the preferred hour. */
function nextScanDelay(bg: ReturnType<typeof loadSettings>['backgroundScan']): number {
  const now = Date.now()
  const intervalMs = bg.intervalHours * 60 * 60 * 1000
  // Earliest we are allowed to run again
  const earliest = bg.lastScanTime ? bg.lastScanTime + intervalMs : now

  // Find the next wall-clock occurrence of scanTimeHour that is >= max(now+30s, earliest)
  const targetHour = bg.scanTimeHour ?? 2
  const notBefore = Math.max(now + 30_000, earliest)

  const d = new Date(notBefore)
  d.setMinutes(0, 0, 0)
  d.setHours(targetHour)
  // If that moment has already passed relative to notBefore, advance by one day
  if (d.getTime() < notBefore) d.setDate(d.getDate() + 1)

  return d.getTime() - now
}

function scheduleNext(): void {
  const { backgroundScan: bg } = loadSettings()
  if (!bg.enabled) return
  const delay = nextScanDelay(bg)
  bgTimeout = setTimeout(async () => {
    await runBackgroundScan()
    scheduleNext()
  }, delay)
}

export function scheduleBackgroundScan(): void {
  clearSchedule()
  scheduleNext()
}

export function stopBackgroundScan(): void {
  clearSchedule()
}

function clearSchedule(): void {
  if (bgTimeout) { clearTimeout(bgTimeout); bgTimeout = null }
}

export function updateLastScanPath(p: string): void {
  patchSettings({ backgroundScan: { lastScanPath: p } })
}
