import { describe, expect, it } from 'vitest'
import type { NerionSettings } from './settings'
import {
  MAX_BACKGROUND_TIMER_DELAY_MS,
  isValidIpcPath,
  normalizeNonNegativeKilobytes,
  normalizeRendererSettings,
  normalizeSettingsFolderList,
  normalizeStoredBackgroundResults,
  parseOllamaPullRecord,
  planBackgroundTimer,
  summarizeBackgroundScan,
} from './runtime-policy'

function settings(): NerionSettings {
  return {
    backgroundScan: {
      enabled: true,
      intervalHours: 168,
      scanTimeHour: 2,
      lastScanPath: '/Users/test/Library/Caches',
      lastScanTime: 123,
      lastScanResults: [{ path: '/cache', name: 'cache', sizeKB: 10, isDir: true }],
      lastScanComplete: true,
      lastScanIssueCount: 0,
      lastScanError: null,
    },
    showMenuBarIcon: true,
    autoUpdateEnabled: true,
    lastAutoUpdateCheckTime: 456,
    deleteImmediately: false,
    quickScanTrashConfigured: true,
    preferredOllamaModel: null,
    onboardingComplete: true,
    showDevDependencies: false,
    localPerformanceDiagnostics: false,
    aiMode: 'ollama',
    quickScanFolders: ['Caches', '/Users/test/Existing'],
    customQuickScanFolders: ['/Users/test/Existing'],
    lastManualScanTime: 789,
    lastManualScanFoundKB: 20,
    lastCleanedTime: 999,
    lastCleanedKB: 4,
    deleteQuota: { monthKey: '2026-07', used: 3 },
  }
}

describe('renderer settings validation', () => {
  it('preserves main-owned counters and rejects malformed values', () => {
    const previous = settings()
    const normalized = normalizeRendererSettings({
      backgroundScan: { enabled: 'yes', intervalHours: 1, scanTimeHour: 99, lastScanTime: 0 },
      lastManualScanFoundKB: -100,
      deleteQuota: { monthKey: 'x', used: 0 },
      showMenuBarIcon: 'yes',
      preferredOllamaModel: 'x'.repeat(200),
    }, previous, { premium: true, allowedQuickFolderPresets: new Set(['Caches']) })

    expect(normalized.backgroundScan).toEqual(previous.backgroundScan)
    expect(normalized.lastManualScanFoundKB).toBe(20)
    expect(normalized.deleteQuota).toEqual({ monthKey: '2026-07', used: 3 })
    expect(normalized.showMenuBarIcon).toBe(true)
    expect(normalized.preferredOllamaModel).toBeNull()
  })

  it('prevents free renderers from adding custom roots while retaining existing ones', () => {
    const normalized = normalizeRendererSettings({
      backgroundScan: { enabled: true },
      quickScanFolders: ['Caches', '/tmp/new-root', '../escape'],
      customQuickScanFolders: ['/tmp/new-root'],
    }, settings(), { premium: false, allowedQuickFolderPresets: new Set(['Caches']) })

    expect(normalized.backgroundScan.enabled).toBe(false)
    expect(normalized.quickScanFolders).toEqual(['Caches', '/Users/test/Existing'])
    expect(normalized.customQuickScanFolders).toEqual(['/Users/test/Existing'])
  })

  it('accepts a deliberate empty folder selection', () => {
    const normalized = normalizeRendererSettings({ quickScanFolders: [] }, settings(), {
      premium: true,
      allowedQuickFolderPresets: new Set(['Caches']),
    })
    expect(normalized.quickScanFolders).toEqual([])
  })

  it('only enables local performance diagnostics from an explicit boolean', () => {
    expect(normalizeRendererSettings({ localPerformanceDiagnostics: true }, settings(), {
      premium: true,
      allowedQuickFolderPresets: new Set(['Caches']),
    }).localPerformanceDiagnostics).toBe(true)
    expect(normalizeRendererSettings({ localPerformanceDiagnostics: 'yes' }, settings(), {
      premium: true,
      allowedQuickFolderPresets: new Set(['Caches']),
    }).localPerformanceDiagnostics).toBe(false)
  })

  it('keeps the tray accessible whenever background scanning is enabled', () => {
    const previous = { ...settings(), showMenuBarIcon: false }
    const normalized = normalizeRendererSettings({
      backgroundScan: { enabled: true },
      showMenuBarIcon: false,
    }, previous, { premium: true, allowedQuickFolderPresets: new Set(['Caches']) })
    expect(normalized.backgroundScan.enabled).toBe(true)
    expect(normalized.showMenuBarIcon).toBe(true)
  })
})

describe('persisted settings collections', () => {
  it('filters malformed roots while preserving native path spelling exactly', () => {
    expect(normalizeSettingsFolderList([
      '/Users/test/ Folder ',
      12,
      '',
      '/tmp/a\0b',
      '/Users/test/ Folder ',
    ])).toEqual(['/Users/test/ Folder '])
  })

  it('filters malformed tray results before they reach reduce/map calls', () => {
    expect(normalizeStoredBackgroundResults([
      { path: '/cache', name: 'cache', sizeKB: 12.5, isDir: true },
      { path: 1, name: 'bad', sizeKB: 1, isDir: false },
      { path: '/negative', name: 'negative', sizeKB: -1, isDir: false },
      null,
    ])).toEqual([{ path: '/cache', name: 'cache', sizeKB: 12.5, isDir: true }])
  })
})

describe('background runtime policy', () => {
  it('persists incomplete scanner outcomes instead of presenting them as clean', () => {
    expect(summarizeBackgroundScan([
      { complete: true, cancelled: false, issueCount: 0, fatalError: null },
      { complete: false, cancelled: false, issueCount: 2, fatalError: null },
    ], 2)).toEqual({
      complete: false,
      issueCount: 2,
      error: 'Some scan locations could not be read completely.',
    })
  })

  it('reports an empty target selection as incomplete', () => {
    expect(summarizeBackgroundScan([], 0)).toEqual({
      complete: false,
      issueCount: 0,
      error: 'No scan locations are selected.',
    })
  })

  it('does not call a scan complete when a scanner reports issues', () => {
    expect(summarizeBackgroundScan([
      { complete: true, cancelled: false, issueCount: 1, fatalError: null },
    ], 1)).toMatchObject({ complete: false, issueCount: 1 })
  })

  it('uses a safe wake-up timer for monthly schedules', () => {
    expect(planBackgroundTimer(30 * 24 * 60 * 60 * 1000)).toEqual({
      delayMs: MAX_BACKGROUND_TIMER_DELAY_MS,
      scanWhenFired: false,
    })
    expect(planBackgroundTimer(60_000)).toEqual({ delayMs: 60_000, scanWhenFired: true })
  })
})

describe('IPC scalar validation', () => {
  it('rejects empty, null-containing, and oversized paths', () => {
    expect(isValidIpcPath('/Users/test/file')).toBe(true)
    expect(isValidIpcPath('')).toBe(false)
    expect(isValidIpcPath('/tmp/a\0b')).toBe(false)
    expect(isValidIpcPath('x'.repeat(32_769))).toBe(false)
  })

  it('only accepts finite non-negative usage values', () => {
    expect(normalizeNonNegativeKilobytes(12.5)).toBe(12.5)
    expect(normalizeNonNegativeKilobytes(-1)).toBeNull()
    expect(normalizeNonNegativeKilobytes(Number.NaN)).toBeNull()
    expect(normalizeNonNegativeKilobytes('12')).toBeNull()
  })
})

describe('Ollama pull records', () => {
  it('recognizes an explicit final success record without requiring a newline', () => {
    expect(parseOllamaPullRecord('{"status":"success"}')).toEqual({
      status: 'success',
      digest: null,
      total: null,
      completed: 0,
      error: null,
    })
  })

  it('surfaces server errors and rejects malformed records', () => {
    expect(parseOllamaPullRecord('{"error":"model not found"}')?.error).toBe('model not found')
    expect(parseOllamaPullRecord('{bad json')).toBeNull()
  })
})
