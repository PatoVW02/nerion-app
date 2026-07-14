import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const updater = {
    channel: null as string | null,
    allowDowngrade: true,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  }
  return {
    updater,
    loadSettings: vi.fn(() => ({ autoUpdateEnabled: true, lastAutoUpdateCheckTime: null })),
    patchSettings: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.5.0' },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported(): boolean { return false }
  },
}))

vi.mock('electron-updater', () => ({ autoUpdater: mocks.updater }))
vi.mock('./settings', () => ({
  loadSettings: mocks.loadSettings,
  patchSettings: mocks.patchSettings,
}))
vi.mock('./background', () => ({ setQuitting: vi.fn() }))

import { runAutoUpdateCheck } from './updater'

describe('auto updater runtime behavior', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.updater.channel = null
    mocks.updater.allowDowngrade = true
    mocks.updater.checkForUpdates.mockReset()
    mocks.patchSettings.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never enables downgrade behavior for architecture metadata channels', async () => {
    mocks.updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.4.7' } })

    await expect(runAutoUpdateCheck('manual')).resolves.toBe(false)
    if (process.platform === 'darwin') {
      expect(mocks.updater.channel).toMatch(/^(arm64|x64|universal)$/)
    } else {
      expect(mocks.updater.channel).toBeNull()
    }
    expect(mocks.updater.allowDowngrade).toBe(false)
  })

  it('rejects a manual provider failure so the UI cannot call it up to date', async () => {
    mocks.updater.checkForUpdates.mockRejectedValue(new Error('network unavailable'))

    await expect(runAutoUpdateCheck('manual')).rejects.toThrow('network unavailable')
  })
})
