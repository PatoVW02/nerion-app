import { accessSync, constants } from 'node:fs'
import * as path from 'node:path'
import { is } from '@electron-toolkit/utils'
import { app, nativeTheme, shell, systemPreferences, type BrowserWindow } from 'electron'
import * as os from 'node:os'
import { detectRuntimePlatform, getPlatformInfo, platformFromNode, type AppPlatform, type PlatformInfo } from '../shared/platform'
import type { PlatformAppearance } from '../shared/contracts'
import { scannerBinaryIsCompatible } from './binary-compat'

export function getAppPlatform(): AppPlatform {
  return platformFromNode(process.platform)
}

export function getPlatformMeta(): PlatformInfo {
  return getPlatformInfo(getAppPlatform())
}

export function getScannerBinaryName(platform = getAppPlatform()): string {
  return platform === 'windows' ? 'scanner-bin.exe' : 'scanner-bin'
}

export function resolveScannerBinaryPath(): string | null {
  const binaryName = getScannerBinaryName()
  const candidates = [
    is.dev
      ? path.join(process.cwd(), 'resources', binaryName)
      : path.join(process.resourcesPath, binaryName),
  ]

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      if (!scannerBinaryIsCompatible(candidate)) continue
      return candidate
    } catch {
      // continue
    }
  }

  return null
}

export function revealInFileManager(filePath: string): void {
  shell.showItemInFolder(filePath)
}

export function getWindowOptions(): Electron.BrowserWindowConstructorOptions {
  const appearance = getPlatformAppearance(true)
  return {
    width: 1200,
    height: 820,
    minWidth: 700,
    minHeight: 500,
    show: false,
    titleBarStyle: getAppPlatform() === 'macos' ? 'hiddenInset' : 'default',
    backgroundColor: appearance.material === 'solid' ? '#0f0f0f' : '#00000000',
    vibrancy: appearance.material === 'vibrancy' ? 'under-window' : undefined,
    visualEffectState: appearance.material === 'vibrancy' ? 'followWindow' : undefined,
    backgroundMaterial: appearance.material === 'mica' ? 'mica' : undefined,
  }
}

function windowsSupportsMica(): boolean {
  if (getAppPlatform() !== 'windows') return false
  const build = Number(os.release().split('.').at(-1))
  return Number.isFinite(build) && build >= 22621
}

export function getPlatformAppearance(windowActive: boolean): PlatformAppearance {
  const platform = getAppPlatform()
  const reducedTransparency = nativeTheme.prefersReducedTransparency
  const highContrast = nativeTheme.shouldUseHighContrastColors
  const material: PlatformAppearance['material'] = reducedTransparency || highContrast
    ? 'solid'
    : platform === 'macos'
      ? 'vibrancy'
      : windowsSupportsMica() ? 'mica' : 'solid'
  return {
    platform,
    material,
    reducedTransparency,
    highContrast,
    reducedMotion: systemPreferences.getAnimationSettings().prefersReducedMotion,
    windowActive,
  }
}

export function applyWindowMaterial(window: BrowserWindow): PlatformAppearance {
  const appearance = getPlatformAppearance(window.isFocused())
  if (appearance.platform === 'macos') window.setVibrancy(appearance.material === 'vibrancy' ? 'under-window' : null)
  if (appearance.platform === 'windows') window.setBackgroundMaterial(appearance.material === 'mica' ? 'mica' : 'none')
  window.setBackgroundColor(appearance.material === 'solid' ? '#0f0f0f' : '#00000000')
  return appearance
}

export function supportsDockVisibility(): boolean {
  return getAppPlatform() === 'macos'
}

export function hideDock(): void {
  if (supportsDockVisibility()) app.dock?.hide()
}

export function showDock(): void {
  if (supportsDockVisibility()) app.dock?.show()
}

export function shouldKeepAppAliveOnWindowClose(): boolean {
  return getAppPlatform() === 'macos'
}

export function supportsFullDiskAccess(): boolean {
  return getPlatformMeta().supportsFullDiskAccess
}

export function getRendererPlatformInfo(): PlatformInfo {
  return getPlatformInfo(detectRuntimePlatform())
}
