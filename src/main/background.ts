import { Tray, Menu, Notification, nativeImage, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { scanDirectoryStreaming, DiskEntry } from './scanner'
import { loadSettings, patchSettings } from './settings'
import * as os from 'os'
import {
  getDefaultQuickScanFolders,
  isAppleMetadata,
  isAutomaticCleanupRoot,
  isCleanable as sharedIsCleanable,
  isDevDependency as sharedIsDevDependency,
  resolveQuickFolderPath,
} from '../shared/policy'
import { getAppPlatform } from './platform'
import { collapseOverlappingPaths, isSameOrDescendantPath, pathComparisonKey } from '../shared/path-utils'
import { getLicenseInfo } from './license'
import type { BackgroundScanRunOutcome, ScanSummaryV1 } from '../shared/contracts'
import { planBackgroundTimer, summarizeBackgroundScan } from './runtime-policy'
import {
  attachBackgroundCancel,
  cancelBackgroundScan,
  detachBackgroundCancel,
  endBackgroundScan,
  isBackgroundScanActive,
  tryBeginBackgroundScan,
  type BackgroundScanLease,
} from './scan-coordination'

function isCleanableEntry(e: DiskEntry): boolean {
  return sharedIsCleanable(e, getAppPlatform())
}

function isDevDependencyEntry(e: DiskEntry): boolean {
  return sharedIsDevDependency(e, getAppPlatform())
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
let trayLabelInterval: ReturnType<typeof setInterval> | null = null
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

export function initTray(mainWindowGetter: () => BrowserWindow | null): boolean {
  getMainWin = mainWindowGetter
  if (!loadSettings().showMenuBarIcon) return false
  return createTray()
}

function createTray(): boolean {
  if (tray) return true
  try {
    const icon = nativeImage.createFromPath(trayIconPath()).resize({ width: 16, height: 16 })
    if (icon.isEmpty()) throw new Error('Tray icon could not be loaded.')
    if (getAppPlatform() === 'macos') icon.setTemplateImage(true)
    tray = new Tray(icon)
    tray.setToolTip('Nerion')
    rebuildTrayMenu()

    if (getAppPlatform() === 'windows') {
      tray.on('click', () => {
        const win = getMainWin()
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      })
    }

    // Rebuild every minute so "X ago" labels stay accurate.
    // The menu is cached by macOS after setContextMenu(), so without this the
    // timestamp would be frozen at whatever it was when the scan finished.
    if (trayLabelInterval) clearInterval(trayLabelInterval)
    trayLabelInterval = setInterval(() => {
      if (tray) rebuildTrayMenu()
    }, 60_000)
    return true
  } catch {
    // icon missing in dev — skip tray
    tray = null
    return false
  }
}

export function setTrayVisibility(show: boolean): void {
  if (show && !tray) {
    createTray()
  } else if (!show && tray) {
    tray.destroy()
    tray = null
    if (trayLabelInterval) { clearInterval(trayLabelInterval); trayLabelInterval = null }
  }
}

export function isTrayAvailable(): boolean {
  return tray !== null && !tray.isDestroyed()
}

export function testNotification(): void {
  if (!Notification.isSupported()) {
    console.error('[Nerion] Notifications not supported on this system')
    return
  }
  const n = new Notification({
    title: 'Nerion — Test Notification',
    body: 'Notifications are working correctly.'
  })
  n.on('show', () => console.log('[Nerion] Notification shown'))
  n.on('failed', (_e, err) => console.error('[Nerion] Notification failed:', err))
  n.show()
  console.log('[Nerion] testNotification called, isSupported=true')
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
  const backgroundScanIncomplete = bg.lastScanComplete === false && !manualScanIsNewer

  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'Nerion', enabled: false },
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
      label: backgroundScanIncomplete
        ? `Last scan ${timeAgo(bg.lastScanTime)} · Incomplete${bg.lastScanIssueCount > 0 ? ` (${bg.lastScanIssueCount} issues)` : ''}`
        : hasResults
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
    click: () => { void runBackgroundScanNow() }
  })

  items.push({ type: 'separator' })
  items.push({
    label: 'Open Nerion',
    click: () => { const w = getMainWin(); if (w) { w.show(); w.focus() } }
  })
  items.push({ type: 'separator' })
  items.push({
    label: 'Quit',
    click: () => {
      setQuitting()
      if (trayLabelInterval) { clearInterval(trayLabelInterval); trayLabelInterval = null }
      tray?.destroy()
      tray = null
      app.quit()
    }
  })

  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function scanFolder(
  dirPath: string,
  seenHardlinks: Set<string>,
  lease: BackgroundScanLease,
  onEntry: (entry: DiskEntry) => void,
): Promise<ScanSummaryV1> {
  return new Promise((resolve) => {
    const duplicateBytes: Array<{ path: string; bytes: number }> = []
    const currentPlatform = getAppPlatform()
    const scanId = `background-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let cancelScan = (): void => {}
    cancelScan = scanDirectoryStreaming(
      dirPath,
      { scanId, rootId: 'root-0', profile: 'background' },
      (event) => {
        if (event.event !== 'entry') return
        if (!event.isDir && event.device && event.inode) {
          const identity = `${event.device}:${event.inode}`
          if (seenHardlinks.has(identity) && !event.hardlinkDuplicate) {
            duplicateBytes.push({ path: event.path, bytes: event.allocatedBytes })
            onEntry({ ...event, allocatedBytes: 0, sizeKB: 0, hardlinkDuplicate: true })
            return
          }
          seenHardlinks.add(identity)
        }
        if (event.isDir) {
          const adjustment = duplicateBytes
            .filter((duplicate) => isSameOrDescendantPath(duplicate.path, event.path, currentPlatform))
            .reduce((total, duplicate) => total + duplicate.bytes, 0)
          if (adjustment > 0) {
            const allocatedBytes = Math.max(0, event.allocatedBytes - adjustment)
            onEntry({ ...event, allocatedBytes, sizeKB: Math.ceil(allocatedBytes / 1024) })
            return
          }
        }
        onEntry(event)
      },
      ({ summary }) => {
        detachBackgroundCancel(lease, cancelScan)
        resolve(summary)
      },
    )
    attachBackgroundCancel(lease, cancelScan)
  })
}

export async function runBackgroundScan(): Promise<BackgroundScanRunOutcome> {
  if (scanning || quitting) return 'deferred'
  const settings = loadSettings()
  if (!getLicenseInfo().active) {
    if (settings.backgroundScan.enabled) {
      patchSettings({ backgroundScan: { enabled: false } })
      rebuildTrayMenu()
    }
    return 'disabled'
  }
  const lease = tryBeginBackgroundScan()
  if (!lease) return 'deferred'
  const home = os.homedir()
  const platform = getAppPlatform()

  const folders = Array.isArray(settings.quickScanFolders)
    ? settings.quickScanFolders
    : getDefaultQuickScanFolders(platform)
  const allowedPaths = new Set(
    folders
      .map((folder) => resolveQuickFolderPath(folder, home, platform))
      .filter((value): value is string => value !== null)
  )

  const scanPaths = [...allowedPaths]

  const dedupedScanPaths = collapseOverlappingPaths(scanPaths, platform)

  if (dedupedScanPaths.length === 0) {
    patchSettings({
      backgroundScan: {
        lastScanTime: Date.now(),
        lastScanResults: [],
        lastScanComplete: false,
        lastScanIssueCount: 0,
        lastScanError: 'No scan locations are selected.',
      },
    })
    rebuildTrayMenu()
    endBackgroundScan(lease)
    return 'no-targets'
  }

  const allowedPrefixes = [...allowedPaths]
  const downloadsParentKeys = new Set<string>()
  const trashParentKeys = new Set<string>()
  const automaticCleanupParentKeys = new Set<string>()
  for (const p of allowedPaths) {
    const leaf = p.split(/[\\/]/).pop()?.toLowerCase()
    const key = pathComparisonKey(p, platform)
    if (leaf === 'downloads') downloadsParentKeys.add(key)
    if (leaf === '.trash' || leaf === '$recycle.bin') trashParentKeys.add(key)
    if (isAutomaticCleanupRoot(p, platform, home)) automaticCleanupParentKeys.add(key)
  }

  scanning = true
  rebuildTrayMenu()

  try {
    const allCleanable: DiskEntry[] = []
    const seenHardlinks = new Set<string>()
    const rootSummaries: ScanSummaryV1[] = []

    const considerEntry = (entry: DiskEntry) => {
      if (isAppleMetadata(entry, platform)) return
      const isDev = isDevDependencyEntry(entry)
      const lastSeparator = Math.max(entry.path.lastIndexOf('/'), entry.path.lastIndexOf('\\'))
      const parentDir = lastSeparator === -1 ? '' : entry.path.slice(0, lastSeparator)
      const parentKey = pathComparisonKey(parentDir, platform)
      const isDownloadsItem = downloadsParentKeys.has(parentKey) && entry.sizeKB > 0
      const isTrashItem = trashParentKeys.has(parentKey) && entry.sizeKB > 0
      const isAutomaticCleanupItem = automaticCleanupParentKeys.has(parentKey) && entry.sizeKB > 0

      if (!isDev && !isDownloadsItem && !isTrashItem && !isAutomaticCleanupItem) {
        const inAllowedPath = allowedPrefixes.some((p) => isSameOrDescendantPath(entry.path, p, platform))
        if (!inAllowedPath) return
      }

      if (isCleanableEntry(entry) || isDev || isDownloadsItem || isTrashItem || isAutomaticCleanupItem) {
        allCleanable.push(entry)
      }
    }

    for (const scanPath of dedupedScanPaths) {
      const summary = await scanFolder(scanPath, seenHardlinks, lease, considerEntry)
      if (quitting || !isBackgroundScanActive(lease)) return 'cancelled'
      rootSummaries.push(summary)
    }

    const totalKB = allCleanable.reduce((s, e) => s + e.sizeKB, 0)
    const outcome = summarizeBackgroundScan(rootSummaries, dedupedScanPaths.length)

    patchSettings({
      backgroundScan: {
        lastScanTime: Date.now(),
        lastScanResults: allCleanable.map(e => ({ path: e.path, name: e.name, sizeKB: e.sizeKB, isDir: e.isDir })),
        lastScanComplete: outcome.complete,
        lastScanIssueCount: outcome.issueCount,
        lastScanError: outcome.error,
      }
    })

    if (!outcome.complete) {
      if (Notification.isSupported()) {
        const note = new Notification({
          title: 'Nerion — Scan Incomplete',
          body: outcome.issueCount > 0
            ? `${outcome.issueCount} scan ${outcome.issueCount === 1 ? 'issue was' : 'issues were'} reported. Open Nerion to review partial results.`
            : (outcome.error ?? 'Some locations could not be scanned.'),
        })
        note.on('click', () => {
          const win = getMainWin()
          if (!win || win.isDestroyed()) return
          win.show(); win.focus()
          if (allCleanable.length > 0) {
            win.webContents.send('bg-clean-requested', allCleanable.map(e => ({
              path: e.path, name: e.name, sizeKB: e.sizeKB, isDir: e.isDir
            })))
          }
        })
        note.show()
      }
    } else if (allCleanable.length > 0 && Notification.isSupported()) {
      const note = new Notification({
        title: 'Nerion — Scan Complete',
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
    return 'completed'
  } catch (err) {
    console.error('[Nerion] Background scan error:', err)
    patchSettings({
      backgroundScan: {
        lastScanTime: Date.now(),
        lastScanResults: [],
        lastScanComplete: false,
        lastScanIssueCount: 0,
        lastScanError: err instanceof Error ? err.message : 'The background scan failed unexpectedly.',
      },
    })
    return 'failed'
  } finally {
    scanning = false
    endBackgroundScan(lease)
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
  if (!bg.enabled || !getLicenseInfo().active) return
  const timerPlan = planBackgroundTimer(nextScanDelay(bg))
  bgTimeout = setTimeout(async () => {
    bgTimeout = null
    if (!timerPlan.scanWhenFired) {
      scheduleNext()
      return
    }
    const outcome = await runBackgroundScan()
    if (outcome === 'deferred' || outcome === 'cancelled') scheduleRetry()
    else scheduleNext()
  }, timerPlan.delayMs)
}

function scheduleRetry(): void {
  clearSchedule()
  const { backgroundScan: bg } = loadSettings()
  if (!bg.enabled || !getLicenseInfo().active || quitting) return
  bgTimeout = setTimeout(async () => {
    bgTimeout = null
    const outcome = await runBackgroundScan()
    if (outcome === 'deferred' || outcome === 'cancelled') scheduleRetry()
    else scheduleNext()
  }, 15 * 60 * 1000)
}

export function scheduleBackgroundScan(): void {
  clearSchedule()
  scheduleNext()
}

/** A user-triggered run resets the recurring schedule after it finishes. */
export async function runBackgroundScanNow(): Promise<BackgroundScanRunOutcome> {
  const outcome = await runBackgroundScan()
  if (outcome === 'completed' || outcome === 'disabled' || outcome === 'failed' || outcome === 'no-targets') {
    scheduleBackgroundScan()
  }
  return outcome
}

export function stopBackgroundScan(): void {
  clearSchedule()
  cancelBackgroundScan()
}

function clearSchedule(): void {
  if (bgTimeout) { clearTimeout(bgTimeout); bgTimeout = null }
}

export function disposeBackgroundServices(): void {
  clearSchedule()
  cancelBackgroundScan()
  if (trayLabelInterval) {
    clearInterval(trayLabelInterval)
    trayLabelInterval = null
  }
  tray?.destroy()
  tray = null
}

export function updateLastScanPath(p: string): void {
  patchSettings({ backgroundScan: { lastScanPath: p } })
}
