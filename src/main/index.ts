import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { initTray, scheduleBackgroundScan, isQuitting, setQuitting } from './background'
import { loadSettings } from './settings'
import { runAutoUpdateCheck, scheduleAutoUpdateChecks } from './updater'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 700,
    minHeight: 500,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow!.show())

  // Hide to tray instead of closing when background scan is enabled,
  // but let the close through when the user explicitly chose Quit.
  mainWindow.on('close', (e) => {
    if (!isQuitting() && loadSettings().backgroundScan.enabled) {
      e.preventDefault()
      mainWindow?.hide()
      app.dock?.hide()
    }
  })

  mainWindow.on('show', () => app.dock?.show())

  // On macOS, Cmd+Q should behave like "close app window" (keep tray/background
  // process alive) when the menu bar icon is enabled.
  // True quits (tray Quit, updater install/restart, OS/app menu quit) still pass
  // through because those paths set the quitting flag.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (process.platform !== 'darwin') return
    const isCmdQ = input.type === 'keyDown' && input.meta && !input.control && !input.alt && !input.shift && input.key.toLowerCase() === 'q'
    if (!isCmdQ) return
    if (isQuitting()) return
    if (!loadSettings().showMenuBarIcon) return

    event.preventDefault()
    mainWindow?.hide()
    app.dock?.hide()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.patricio.vectra')

  // Mark all real app quits so close handlers don't hide to tray.
  app.on('before-quit', () => setQuitting())

  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))

  registerIpcHandlers()
  createWindow()
  initTray(() => mainWindow)

  if (loadSettings().backgroundScan.enabled) {
    scheduleBackgroundScan()
  }

  runAutoUpdateCheck('startup').catch(() => {})
  scheduleAutoUpdateChecks()

  app.on('activate', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus() }
    else createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})


