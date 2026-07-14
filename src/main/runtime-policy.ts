import type { NerionSettings } from './settings'

export const MAX_BACKGROUND_TIMER_DELAY_MS = 2_147_000_000
const MAX_SETTINGS_PATHS = 64
const MAX_PATH_LENGTH = 32_768
const ALLOWED_BACKGROUND_INTERVALS = new Set([24, 168, 720])

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNullableModel(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : fallback
}

function isAbsoluteNativePath(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\]+\\[^\\]+/.test(value)
    || /^\/\/[^/]+\/[^/]+/.test(value)
}

export function normalizeSettingsFolderList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null

  const unique = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    if (!candidate || candidate.length > MAX_PATH_LENGTH || candidate.includes('\0')) continue
    unique.add(candidate)
    if (unique.size >= MAX_SETTINGS_PATHS) break
  }
  return [...unique]
}

export function normalizeStoredBackgroundResults(value: unknown): NerionSettings['backgroundScan']['lastScanResults'] | null {
  if (!Array.isArray(value)) return null
  const results: NerionSettings['backgroundScan']['lastScanResults'] = []
  for (const candidate of value.slice(0, 10_000)) {
    const item = asRecord(candidate)
    if (typeof item.path !== 'string' || !isValidIpcPath(item.path)) continue
    if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 1024 || item.name.includes('\0')) continue
    if (typeof item.sizeKB !== 'number' || !Number.isFinite(item.sizeKB) || item.sizeKB < 0) continue
    if (typeof item.isDir !== 'boolean') continue
    results.push({
      path: item.path,
      name: item.name,
      sizeKB: Math.min(item.sizeKB, Number.MAX_SAFE_INTEGER),
      isDir: item.isDir,
    })
  }
  return results
}

function isAllowedFolder(value: string, allowedPresets: ReadonlySet<string>): boolean {
  return allowedPresets.has(value) || isAbsoluteNativePath(value)
}

/**
 * Treat settings supplied by the renderer as a patch over main-process state.
 * Runtime counters and scan results never come from the renderer, and free
 * users cannot smuggle new custom scan roots into the paid background feature.
 */
export function normalizeRendererSettings(
  value: unknown,
  previous: NerionSettings,
  options: { premium: boolean; allowedQuickFolderPresets: ReadonlySet<string> },
): NerionSettings {
  const input = asRecord(value)
  const background = asRecord(input.backgroundScan)
  const requestedQuickFolders = normalizeSettingsFolderList(input.quickScanFolders)
  const requestedCustomFolders = normalizeSettingsFolderList(input.customQuickScanFolders)

  const previousCustom = new Set(previous.customQuickScanFolders)
  const preservedCustomSelections = previous.quickScanFolders.filter((folder) => previousCustom.has(folder))
  const requestedAllowedFolders = (requestedQuickFolders ?? previous.quickScanFolders)
    .filter((folder) => isAllowedFolder(folder, options.allowedQuickFolderPresets))

  const quickScanFolders = options.premium
    ? requestedAllowedFolders
    : [...new Set([
        ...requestedAllowedFolders.filter((folder) => options.allowedQuickFolderPresets.has(folder)),
        ...preservedCustomSelections,
      ])]

  const intervalHours = typeof background.intervalHours === 'number'
    && ALLOWED_BACKGROUND_INTERVALS.has(background.intervalHours)
    ? background.intervalHours
    : previous.backgroundScan.intervalHours
  const scanTimeHour = typeof background.scanTimeHour === 'number'
    && Number.isInteger(background.scanTimeHour)
    && background.scanTimeHour >= 0
    && background.scanTimeHour <= 23
    ? background.scanTimeHour
    : previous.backgroundScan.scanTimeHour

  const requestedAiMode = input.aiMode === 'cloud' || input.aiMode === 'ollama'
    ? input.aiMode
    : previous.aiMode
  const backgroundEnabled = options.premium && asBoolean(background.enabled, previous.backgroundScan.enabled)

  return {
    ...previous,
    backgroundScan: {
      ...previous.backgroundScan,
      enabled: backgroundEnabled,
      intervalHours,
      scanTimeHour,
    },
    showMenuBarIcon: backgroundEnabled ? true : asBoolean(input.showMenuBarIcon, previous.showMenuBarIcon),
    autoUpdateEnabled: asBoolean(input.autoUpdateEnabled, previous.autoUpdateEnabled),
    deleteImmediately: asBoolean(input.deleteImmediately, previous.deleteImmediately),
    preferredOllamaModel: asNullableModel(input.preferredOllamaModel, previous.preferredOllamaModel),
    onboardingComplete: asBoolean(input.onboardingComplete, previous.onboardingComplete),
    showDevDependencies: asBoolean(input.showDevDependencies, previous.showDevDependencies),
    localPerformanceDiagnostics: asBoolean(input.localPerformanceDiagnostics, previous.localPerformanceDiagnostics),
    aiMode: requestedAiMode,
    quickScanFolders,
    customQuickScanFolders: options.premium
      ? (requestedCustomFolders ?? previous.customQuickScanFolders).filter(isAbsoluteNativePath)
      : previous.customQuickScanFolders,
  }
}

export interface BackgroundScanOutcome {
  complete: boolean
  issueCount: number
  error: string | null
}

export function summarizeBackgroundScan(
  summaries: Array<{ complete: boolean; cancelled: boolean; issueCount: number; fatalError: string | null }>,
  expectedRoots: number,
): BackgroundScanOutcome {
  if (expectedRoots === 0) {
    return { complete: false, issueCount: 0, error: 'No scan locations are selected.' }
  }

  const fatalErrors = summaries
    .map((summary) => summary.fatalError)
    .filter((error): error is string => typeof error === 'string' && error.length > 0)
  const issueCount = summaries.reduce((total, summary) => total + Math.max(0, summary.issueCount), 0)
  const complete = summaries.length === expectedRoots
    && summaries.every((summary) => summary.complete && !summary.cancelled && !summary.fatalError && summary.issueCount === 0)

  return {
    complete,
    issueCount,
    error: fatalErrors.length > 0
      ? fatalErrors[0]
      : complete ? null : 'Some scan locations could not be read completely.',
  }
}

/**
 * Node clamps larger timeouts to roughly one millisecond. Long schedules must
 * wake once at the maximum safe delay, recompute, and only scan when due.
 */
export function planBackgroundTimer(delayMs: number): { delayMs: number; scanWhenFired: boolean } {
  const safeDelay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0
  if (safeDelay > MAX_BACKGROUND_TIMER_DELAY_MS) {
    return { delayMs: MAX_BACKGROUND_TIMER_DELAY_MS, scanWhenFired: false }
  }
  return { delayMs: safeDelay, scanWhenFired: true }
}

export function isValidIpcPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PATH_LENGTH
    && !value.includes('\0')
}

export function normalizeNonNegativeKilobytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, Number.MAX_SAFE_INTEGER)
    : null
}

export interface OllamaPullRecord {
  status: string
  digest: string | null
  total: number | null
  completed: number
  error: string | null
}

/** Parse one complete Ollama pull record without assuming a trailing newline. */
export function parseOllamaPullRecord(line: string): OllamaPullRecord | null {
  if (!line.trim()) return null
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return {
      status: typeof value.status === 'string' ? value.status : '',
      digest: typeof value.digest === 'string' && value.digest.length > 0 ? value.digest : null,
      total: typeof value.total === 'number' && Number.isFinite(value.total) && value.total > 0 ? value.total : null,
      completed: typeof value.completed === 'number' && Number.isFinite(value.completed) && value.completed >= 0
        ? value.completed
        : 0,
      error: typeof value.error === 'string' && value.error.length > 0 ? value.error : null,
    }
  } catch {
    return null
  }
}
