import { app, shell, BrowserWindow, dialog, nativeTheme, session } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { disposeIpcRuntime, registerIpcHandlers } from './ipc'
import { disposeBackgroundServices, initTray, isQuitting, isTrayAvailable, scheduleBackgroundScan, setQuitting } from './background'
import { loadSettings } from './settings'
import { runAutoUpdateCheck, scheduleAutoUpdateChecks, stopAutoUpdateChecks } from './updater'
import { applyWindowMaterial, getAppPlatform, getWindowOptions, hideDock, shouldKeepAppAliveOnWindowClose, showDock } from './platform'
import { isAllowedExternalUrl, isTrustedRendererNavigation } from './security'

let mainWindow: BrowserWindow | null = null
let lastRendererRecoveryAt = 0
const RENDERER_RECOVERY_WINDOW_MS = 60_000

function publishAppearance(): void {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) return
  const appearance = applyWindowMaterial(mainWindow)
  mainWindow.webContents.send('appearance:changed', appearance)
}

function createWindow(showOnReady = true): void {
  const packagedRendererPath = join(__dirname, '../renderer/index.html')
  const rendererUrl = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(packagedRendererPath).toString()

  const window = new BrowserWindow({
    ...getWindowOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    }
  })
  mainWindow = window

  window.on('ready-to-show', () => {
    if (showOnReady && !window.isDestroyed()) window.show()
  })
  window.on('focus', publishAppearance)
  window.on('blur', publishAppearance)

  // Hide only when there is a working tray/menu-bar icon that can reopen the
  // window. Otherwise closing must never strand an inaccessible process.
  window.on('close', (e) => {
    const settings = loadSettings()
    if (!isQuitting() && settings.showMenuBarIcon && isTrayAvailable()) {
      e.preventDefault()
      window.hide()
      hideDock()
    }
  })

  window.on('show', () => showDock())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })

  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (isTrustedRendererNavigation(url, rendererUrl)) return
    event.preventDefault()
    if (isAllowedExternalUrl(url)) shell.openExternal(url).catch(() => {})
  }
  window.webContents.on('will-navigate', guardNavigation)
  window.webContents.on('will-redirect', guardNavigation)
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || isQuitting()) return

    const crashedWindow = window
    const now = Date.now()
    if (now - lastRendererRecoveryAt > RENDERER_RECOVERY_WINDOW_MS) {
      lastRendererRecoveryAt = now
      setTimeout(() => {
        if (mainWindow !== crashedWindow || !crashedWindow || crashedWindow.isDestroyed()) return
        crashedWindow.reload()
      }, 250)
      return
    }

    dialog.showMessageBox({
      type: 'error',
      title: 'Nerion needs to restart',
      message: 'The Nerion window stopped unexpectedly more than once.',
      detail: 'Restart Nerion to continue. If a cleanup was already running, review the selected locations before retrying it.',
      buttons: ['Restart Nerion', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      setQuitting()
      if (response === 0) app.relaunch()
      app.quit()
    }).catch(() => {
      setQuitting()
      app.quit()
    })
  })

  window.loadURL(rendererUrl).catch((error) => {
    if (isQuitting() || window.isDestroyed()) return
    console.error('[Nerion] Failed to load the application window:', error)
    dialog.showErrorBox(
      'Nerion could not open',
      'The application interface could not be loaded. Quit Nerion and try opening it again.',
    )
  })
}

if (is.dev) {
  app.setName('Nerion Dev')
  app.setPath('userData', join(app.getPath('appData'), 'Nerion-Dev'))
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  setQuitting()
  app.quit()
} else {
app.on('second-instance', () => {
  if (!app.isReady()) return
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

app.on('before-quit', () => {
  setQuitting()
  stopAutoUpdateChecks()
  disposeIpcRuntime()
  disposeBackgroundServices()
})

void app.whenReady().then(() => {
  // Keep native window chrome, vibrancy/Mica, menus, and Chromium controls in
  // Nerion's dark appearance regardless of the operating-system theme.
  nativeTheme.themeSource = 'dark'
  electronApp.setAppUserModelId('com.patricio.nerion')

  // Nerion does not render remote content or need web camera/location/etc.
  // Native notifications and filesystem access use Electron APIs instead.
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))

  registerIpcHandlers()
  const trayReady = initTray(() => mainWindow)
  const loginItemSettings = app.getLoginItemSettings()
  const launchedHidden = app.isPackaged
    && trayReady
    && loadSettings().showMenuBarIcon
    && (
      process.argv.includes('--hidden')
      || loginItemSettings.wasOpenedAsHidden === true
      || (getAppPlatform() === 'macos' && loginItemSettings.wasOpenedAtLogin === true)
    )
  createWindow(!launchedHidden)
  if (launchedHidden) hideDock()
  nativeTheme.on('updated', publishAppearance)
  publishAppearance()

  if (loadSettings().backgroundScan.enabled) {
    scheduleBackgroundScan()
  }

  runAutoUpdateCheck('startup').catch(() => {})
  scheduleAutoUpdateChecks()

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus() }
    else createWindow()
  })
}).catch((error) => {
  console.error('[Nerion] Application startup failed:', error)
  setQuitting()
  dialog.showErrorBox('Nerion could not start', 'An unexpected startup error occurred. Please restart Nerion.')
  app.quit()
})
}

app.on('window-all-closed', () => {
  if (!shouldKeepAppAliveOnWindowClose()) app.quit()
})
