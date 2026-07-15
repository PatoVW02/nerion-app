import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { getDefaultQuickScanFolders } from '../shared/policy'
import { getAppPlatform, getPlatformMeta } from './platform'
import { normalizeAiMode } from './ai-config'
import { normalizeSettingsFolderList, normalizeStoredBackgroundResults } from './runtime-policy'

export interface BackgroundScanSettings {
  enabled: boolean
  intervalHours: number
  scanTimeHour: number   // 0–23, hour of day to run the scan
  lastScanPath: string | null
  lastScanTime: number | null
  lastScanResults: Array<{ path: string; name: string; sizeKB: number; isDir: boolean }>
  /** Whether every selected root completed without scanner or permission errors. */
  lastScanComplete: boolean | null
  lastScanIssueCount: number
  lastScanError: string | null
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
  /** Store anonymous scan timing counters locally. Never transmitted. */
  localPerformanceDiagnostics: boolean
  /** 'cloud' = Nerion-managed cloud service; 'ollama' = local Ollama */
  aiMode: 'cloud' | 'ollama'
  /** Platform-specific quick scan folder identifiers or absolute paths. */
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

function isAbsoluteSettingsPath(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\]+\\[^\\]+/.test(value)
    || /^\/\/[^/]+\/[^/]+/.test(value)
}

function buildDefaults(): NerionSettings {
  const quickScanDefaults = getDefaultQuickScanFolders(getAppPlatform())
  return {
  backgroundScan: {
    enabled: false,
    intervalHours: 168,
    scanTimeHour: 2,
    lastScanPath: null,
    lastScanTime: null,
    lastScanResults: [],
    lastScanComplete: null,
    lastScanIssueCount: 0,
    lastScanError: null,
  },
  showMenuBarIcon: true,
  autoUpdateEnabled: true,
  lastAutoUpdateCheckTime: null,
  deleteImmediately: false,
  quickScanTrashConfigured: false,
  preferredOllamaModel: null,
  onboardingComplete: false,
  showDevDependencies: false,
  localPerformanceDiagnostics: false,
  aiMode: 'ollama',
  quickScanFolders: quickScanDefaults,
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
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): NerionSettings {
  try {
    const raw = readFileSync(settingsPath(), 'utf-8')
    const parsedValue = JSON.parse(raw) as unknown
    if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
      throw new Error('Settings file is not an object.')
    }
    const parsed = parsedValue as Partial<NerionSettings>
    const defaults = buildDefaults()
    const hasValidDeleteQuota =
      !!parsed.deleteQuota &&
      typeof parsed.deleteQuota.monthKey === 'string' &&
      Number.isFinite(parsed.deleteQuota.used) &&
      parsed.deleteQuota.used >= 0

    const merged: NerionSettings = {
      ...defaults,
      ...parsed,
      backgroundScan: { ...defaults.backgroundScan, ...parsed.backgroundScan },
      deleteQuota: { ...defaults.deleteQuota, ...parsed.deleteQuota },
    }

    let mutated = false
    const currentDefaults = getDefaultQuickScanFolders(getAppPlatform())
    const allowedQuickFolderPresets = new Set(getPlatformMeta().quickScanOptions.map((option) => option.name))
    const normalizedQuickScanFolders = normalizeSettingsFolderList(merged.quickScanFolders)
    if (normalizedQuickScanFolders === null) {
      merged.quickScanFolders = currentDefaults
      mutated = true
    } else {
      const safeQuickScanFolders = normalizedQuickScanFolders.filter((folder) => (
        allowedQuickFolderPresets.has(folder) || isAbsoluteSettingsPath(folder)
      ))
      if (safeQuickScanFolders.length !== merged.quickScanFolders.length) mutated = true
      merged.quickScanFolders = safeQuickScanFolders
    }
    const normalizedCustomFolders = normalizeSettingsFolderList(merged.customQuickScanFolders)
    if (normalizedCustomFolders === null) {
      merged.customQuickScanFolders = []
      mutated = true
    } else {
      const safeCustomFolders = normalizedCustomFolders.filter(isAbsoluteSettingsPath)
      if (safeCustomFolders.length !== merged.customQuickScanFolders.length) mutated = true
      merged.customQuickScanFolders = safeCustomFolders
    }
    const normalizedScanResults = normalizeStoredBackgroundResults(merged.backgroundScan.lastScanResults)
    if (normalizedScanResults === null) {
      merged.backgroundScan.lastScanResults = []
      mutated = true
    } else {
      if (normalizedScanResults.length !== merged.backgroundScan.lastScanResults.length) mutated = true
      merged.backgroundScan.lastScanResults = normalizedScanResults
    }
    if (typeof merged.backgroundScan.enabled !== 'boolean') {
      merged.backgroundScan.enabled = defaults.backgroundScan.enabled
      mutated = true
    }
    if (![24, 168, 720].includes(merged.backgroundScan.intervalHours)) {
      merged.backgroundScan.intervalHours = defaults.backgroundScan.intervalHours
      mutated = true
    }
    if (!Number.isInteger(merged.backgroundScan.scanTimeHour)
        || merged.backgroundScan.scanTimeHour < 0
        || merged.backgroundScan.scanTimeHour > 23) {
      merged.backgroundScan.scanTimeHour = defaults.backgroundScan.scanTimeHour
      mutated = true
    }
    if (merged.backgroundScan.lastScanComplete !== null
        && typeof merged.backgroundScan.lastScanComplete !== 'boolean') {
      merged.backgroundScan.lastScanComplete = null
      mutated = true
    }
    if (!Number.isFinite(merged.backgroundScan.lastScanIssueCount)
        || merged.backgroundScan.lastScanIssueCount < 0) {
      merged.backgroundScan.lastScanIssueCount = 0
      mutated = true
    }
    if (merged.backgroundScan.lastScanError !== null
        && typeof merged.backgroundScan.lastScanError !== 'string') {
      merged.backgroundScan.lastScanError = null
      mutated = true
    }
    for (const key of ['showMenuBarIcon', 'autoUpdateEnabled', 'deleteImmediately', 'quickScanTrashConfigured', 'onboardingComplete', 'showDevDependencies', 'localPerformanceDiagnostics'] as const) {
      if (typeof merged[key] !== 'boolean') {
        merged[key] = defaults[key]
        mutated = true
      }
    }
    if (merged.backgroundScan.enabled && !merged.showMenuBarIcon) {
      merged.showMenuBarIcon = true
      mutated = true
    }
    if (!hasValidDeleteQuota) {
      merged.deleteQuota = { ...defaults.deleteQuota }
      mutated = true
    }
    if (!merged.quickScanTrashConfigured && getAppPlatform() === 'macos') {
      if (!merged.quickScanFolders.includes('Trash')) {
        merged.quickScanFolders = [...merged.quickScanFolders, 'Trash']
      }
      merged.quickScanTrashConfigured = true
      mutated = true
    } else if (!Array.isArray(parsed.quickScanFolders)) {
      merged.quickScanFolders = currentDefaults
      mutated = true
    }

    const normalizedAiMode = normalizeAiMode(merged.aiMode)
    if (merged.aiMode !== normalizedAiMode) {
      merged.aiMode = normalizedAiMode
      mutated = true
    }

    // Auto-reset quota when the month changes.
    const monthKey = currentMonthKey()
    const shouldNormalize = !hasValidDeleteQuota
    if (merged.deleteQuota.monthKey !== monthKey) {
      merged.deleteQuota = { monthKey, used: 0 }
      mutated = true
    }
    if (shouldNormalize || mutated) {
      // Backfill missing schema keys on disk so subsequent reads/writes are stable.
      saveSettings(merged)
    }

    return merged
  } catch {
    return {
      ...buildDefaults(),
      backgroundScan: { ...buildDefaults().backgroundScan },
      deleteQuota: { ...buildDefaults().deleteQuota },
    }
  }
}

export function saveSettings(next: NerionSettings): void {
  const p = settingsPath()
  const dir = join(p, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tempPath = `${p}.${process.pid}.tmp`
  try {
    writeFileSync(tempPath, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 })
    renameSync(tempPath, p)
  } catch (error) {
    try { unlinkSync(tempPath) } catch { /* best-effort cleanup */ }
    throw error
  }
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
