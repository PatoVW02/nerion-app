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

export interface NerionSettings {
  backgroundScan: BackgroundScanSettings
  showMenuBarIcon: boolean
  autoUpdateEnabled: boolean
  deleteImmediately: boolean
  quickScanTrashConfigured: boolean
  preferredOllamaModel: string | null
  onboardingComplete: boolean
  showDevDependencies: boolean
  /** 'cloud' = OpenAI (default); 'ollama' = local Ollama */
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

function currentMonthKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${now.getFullYear()}-${month}`
}

const DEFAULTS: NerionSettings = {
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
  deleteImmediately: false,
  quickScanTrashConfigured: false,
  preferredOllamaModel: null,
  onboardingComplete: false,
  showDevDependencies: false,
  aiMode: 'cloud',
  quickScanFolders: ['Caches', 'Logs', 'Developer', 'Containers', 'Downloads', 'Desktop', 'Trash'],
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

export function loadSettings(): NerionSettings {
  try {
    const raw = readFileSync(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<NerionSettings>
    const hasValidDeleteQuota =
      !!parsed.deleteQuota &&
      typeof parsed.deleteQuota.monthKey === 'string' &&
      Number.isFinite(parsed.deleteQuota.used)

    const merged: NerionSettings = {
      ...DEFAULTS,
      ...parsed,
      backgroundScan: { ...DEFAULTS.backgroundScan, ...parsed.backgroundScan },
      deleteQuota: { ...DEFAULTS.deleteQuota, ...parsed.deleteQuota },
    }

    let mutated = false
    if (!merged.quickScanTrashConfigured) {
      if (!merged.quickScanFolders.includes('Trash')) {
        merged.quickScanFolders = [...merged.quickScanFolders, 'Trash']
      }
      merged.quickScanTrashConfigured = true
      mutated = true
    }

    // Auto-reset quota when the month changes.
    const monthKey = currentMonthKey()
    const shouldNormalize = !hasValidDeleteQuota
    if (merged.deleteQuota.monthKey !== monthKey) {
      merged.deleteQuota = { monthKey, used: 0 }
      saveSettings(merged)
    } else if (shouldNormalize || mutated) {
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

export function saveSettings(next: NerionSettings): void {
  const p = settingsPath()
  const dir = join(p, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
}

export function patchSettings(patch: Partial<Omit<NerionSettings, 'backgroundScan'>> & { backgroundScan?: Partial<BackgroundScanSettings> }): NerionSettings {
  const current = loadSettings()
  const next: NerionSettings = {
    ...current,
    ...patch,
    backgroundScan: { ...current.backgroundScan, ...(patch.backgroundScan ?? {}) } as BackgroundScanSettings,
    deleteQuota: { ...current.deleteQuota, ...(patch.deleteQuota ?? {}) },
  }
  saveSettings(next)
  return next
}
