import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

export interface BackgroundScanSettings {
  enabled: boolean
  intervalHours: number
  scanTimeHour: number   // 0–23, hour of day to run the scan
  lastScanPath: string | null
  lastScanTime: number | null
  lastScanResults: Array<{ path: string; name: string; sizeKB: number; isDir: boolean }>
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

function currentMonthKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${now.getFullYear()}-${month}`
}

const DEFAULTS: VectraSettings = {
  backgroundScan: {
    enabled: false,
    intervalHours: 168,
    scanTimeHour: 2,
    lastScanPath: null,
    lastScanTime: null,
    lastScanResults: []
  },
  showMenuBarIcon: true,
  autoUpdateEnabled: true,
  preferredOllamaModel: null,
  onboardingComplete: false,
  showDevDependencies: false,
  quickScanFolders: ['Caches', 'Logs', 'Developer', 'Containers', 'Downloads', 'Desktop'],
  customQuickScanFolders: [],
  lastManualScanTime: null,
  lastManualScanFoundKB: 0,
  lastCleanedTime: null,
  lastCleanedKB: 0,
  deleteQuota: {
    monthKey: currentMonthKey(),
    used: 0,
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): VectraSettings {
  try {
    const raw = readFileSync(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<VectraSettings>
    const hasValidDeleteQuota =
      !!parsed.deleteQuota &&
      typeof parsed.deleteQuota.monthKey === 'string' &&
      Number.isFinite(parsed.deleteQuota.used)

    const merged: VectraSettings = {
      ...DEFAULTS,
      ...parsed,
      backgroundScan: { ...DEFAULTS.backgroundScan, ...parsed.backgroundScan },
      deleteQuota: { ...DEFAULTS.deleteQuota, ...parsed.deleteQuota },
    }

    // Auto-reset quota when the month changes.
    const monthKey = currentMonthKey()
    const shouldNormalize = !hasValidDeleteQuota
    if (merged.deleteQuota.monthKey !== monthKey) {
      merged.deleteQuota = { monthKey, used: 0 }
      saveSettings(merged)
    } else if (shouldNormalize) {
      // Backfill missing schema keys on disk so subsequent reads/writes are stable.
      saveSettings(merged)
    }

    return merged
  } catch {
    return {
      ...DEFAULTS,
      backgroundScan: { ...DEFAULTS.backgroundScan },
      deleteQuota: { ...DEFAULTS.deleteQuota },
    }
  }
}

export function saveSettings(next: VectraSettings): void {
  const p = settingsPath()
  const dir = join(p, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
}

export function patchSettings(patch: Partial<VectraSettings>): VectraSettings {
  const current = loadSettings()
  const next: VectraSettings = {
    ...current,
    ...patch,
    backgroundScan: { ...current.backgroundScan, ...(patch.backgroundScan ?? {}) },
    deleteQuota: { ...current.deleteQuota, ...(patch.deleteQuota ?? {}) },
  }
  saveSettings(next)
  return next
}
