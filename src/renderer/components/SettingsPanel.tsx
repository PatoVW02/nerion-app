import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { VectraSettings, OllamaModel, LicenseInfo, UpdaterStatusEvent } from '../types'
import { formatSize } from '../utils/format'
import { HeaderFrame } from './HeaderFrame'

interface SettingsPanelProps {
  onClose: () => void
  onDevDepsChange: (value: boolean) => void
  quickScanFolders: string[]
  onQuickScanFoldersChange: (folders: string[]) => void
  isPremium: boolean
  license: LicenseInfo | null
  onUpgrade: () => void
  onLicense: () => void
}

function PremiumLock({ onUpgrade }: { onUpgrade: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg bg-zinc-950/80 backdrop-blur-[1px] z-10">
      <svg className="w-4 h-4 text-zinc-500" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
      </svg>
      <p className="text-[11px] text-zinc-500">Premium feature</p>
      <button
        onClick={onUpgrade}
        className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
      >
        Upgrade to unlock →
      </button>
    </div>
  )
}

function PaddedPremiumLock({ onUpgrade }: { onUpgrade: () => void }) {
  return (
    <div className="absolute -inset-1.5 flex flex-col items-center justify-center gap-2 rounded-xl bg-zinc-950/80 backdrop-blur-[1px] z-10">
      <svg className="w-4 h-4 text-zinc-500" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
      </svg>
      <p className="text-[11px] text-zinc-500">Premium feature</p>
      <button
        onClick={onUpgrade}
        className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
      >
        Upgrade to unlock →
      </button>
    </div>
  )
}

const INTERVALS = [
  { label: 'Daily', hours: 24 },
  { label: 'Weekly', hours: 168 },
  { label: 'Monthly', hours: 720 }
]

const RECOMMENDED_MODELS = [
  { name: 'llama3.2', display: 'Llama 3.2', size: '2.0 GB' },
  { name: 'llama3.1', display: 'Llama 3.1', size: '4.7 GB' },
  { name: 'mistral',  display: 'Mistral',   size: '4.1 GB' },
  { name: 'phi3',     display: 'Phi-3 Mini', size: '2.2 GB' },
  { name: 'gemma2',   display: 'Gemma 2',   size: '5.5 GB' },
]

// Folders available in Quick Scan mode.
// Names starting with '~/' are home-relative; others are relative to ~/Library.
const QUICK_FOLDER_OPTIONS = [
  { name: 'Caches',                 desc: 'App cache files' },
  { name: 'Logs',                   desc: 'App log files' },
  { name: 'Developer',              desc: 'Xcode DerivedData & dev tool caches' },
  { name: 'Containers',             desc: 'App sandbox containers' },
  { name: 'Downloads',              desc: '~/Downloads folder' },
  { name: 'Desktop',                desc: '~/Desktop folder' },
  { name: 'Application Support',    desc: 'Persistent app data' },
  { name: 'Saved Application State', desc: 'Saved window & app states' },
  { name: 'Group Containers',       desc: 'Shared app group containers' },
]

type OllamaStatus = 'idle' | 'checking' | 'not-installed' | 'installed'
type SettingsTab = 'general' | 'background' | 'ai' | 'scanning'

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; premium?: boolean }> = [
  { id: 'general', label: 'General' },
  { id: 'scanning', label: 'Scanning' },
  { id: 'background', label: 'Background', premium: true },
  { id: 'ai', label: 'AI', premium: true },
]

function fmtHour(h: number): string {
  if (h === 0) return '12:00 AM'
  if (h < 12) return `${h}:00 AM`
  if (h === 12) return '12:00 PM'
  return `${h - 12}:00 PM`
}

function timeAgo(ts: number): string {
  const d = Date.now() - ts
  const days = Math.floor(d / 86400000)
  const hrs = Math.floor(d / 3600000)
  const mins = Math.floor(d / 60000)
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`
  if (hrs > 0) return `${hrs} hour${hrs > 1 ? 's' : ''} ago`
  if (mins > 0) return `${mins} minute${mins > 1 ? 's' : ''} ago`
  return 'just now'
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${Math.round(bytes / 1e3)} KB`
}

function modelShortName(name: string): string {
  return name.replace(/:latest$/, '')
}

function fmtSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 KB/s'
  return `${fmtBytes(bytesPerSecond)}/s`
}

function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'less than a second'
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.ceil(seconds % 60)
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        'relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 mt-0.5 disabled:opacity-50',
        on ? 'bg-blue-600' : 'bg-zinc-700'
      ].join(' ')}
    >
      <span className={[
        'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200',
        on ? 'translate-x-5' : 'translate-x-0'
      ].join(' ')} />
    </button>
  )
}

export function SettingsPanel({ onClose, onDevDepsChange, quickScanFolders, onQuickScanFoldersChange, isPremium, license, onUpgrade, onLicense }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [settings, setSettings] = useState<VectraSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [scanningNow, setScanningNow] = useState(false)
  const [checkingForUpdates, setCheckingForUpdates] = useState(false)
  const [updateMessage, setUpdateMessage] = useState<string | null>(null)
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState<number | null>(null)
  const [updateDownloadTransferred, setUpdateDownloadTransferred] = useState<number | null>(null)
  const [updateDownloadTotal, setUpdateDownloadTotal] = useState<number | null>(null)
  const [updateDownloadBps, setUpdateDownloadBps] = useState<number | null>(null)
  const [updateReadyToInstall, setUpdateReadyToInstall] = useState(false)
  const [restartingToInstall, setRestartingToInstall] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [loginItem, setLoginItem] = useState<boolean | null>(null)

  // AI state
  const [aiEnabled, setAiEnabled] = useState(() => localStorage.getItem('vectra:aiHidden') !== 'true')
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>('idle')
  const [installedModels, setInstalledModels] = useState<OllamaModel[]>([])
  const [pullingModel, setPullingModel] = useState<string | null>(null)
  const [pullProgress, setPullProgress] = useState<number | null>(null)
  const [pullStatus, setPullStatus] = useState('')
  const [pullError, setPullError] = useState<string | null>(null)

  // Keep a ref so pull-done callback can access latest settings without stale closure
  const settingsRef = useRef<VectraSettings | null>(null)
  settingsRef.current = settings

  useEffect(() => {
    window.electronAPI.getSettings().then(setSettings).catch(() => {})
    window.electronAPI.getLoginItem().then(setLoginItem).catch(() => {})
    if (window.electronAPI.getAppVersion) {
      window.electronAPI.getAppVersion().then(setAppVersion).catch(() => {})
    }
  }, [])

  // Register pull listeners once
  useEffect(() => {
    window.electronAPI.onPullProgress((data) => {
      setPullProgress(data.progress)
      setPullStatus(data.status)
    })
    window.electronAPI.onPullDone(async (data) => {
      setPullingModel(null)
      setPullProgress(null)
      setPullStatus('')
      if (data.error) {
        setPullError(data.error)
      } else {
        setPullError(null)
        // Refresh model list and auto-select newly downloaded model
        const result = await window.electronAPI.getOllamaModels()
        if (result.ok) setInstalledModels(result.models)
        const current = settingsRef.current
        if (current) {
          const next = { ...current, preferredOllamaModel: data.model }
          setSettings(next)
          await window.electronAPI.saveSettings(next)
        }
      }
    })
    return () => window.electronAPI.removePullListeners()
  }, [])

  useEffect(() => {
    const handleUpdaterStatus = (event: UpdaterStatusEvent) => {
      if (event.type === 'checking') {
        setUpdateReadyToInstall(false)
        setUpdateDownloadProgress(null)
        setUpdateDownloadTransferred(null)
        setUpdateDownloadTotal(null)
        setUpdateDownloadBps(null)
        return
      }

      if (event.type === 'update-available') {
        setUpdateMessage(`Update ${event.version} found. Downloading...`)
        setUpdateDownloadProgress(0)
        setUpdateDownloadTransferred(0)
        setUpdateDownloadTotal(null)
        setUpdateDownloadBps(null)
        return
      }

      if (event.type === 'download-progress') {
        const pct = Number.isFinite(event.percent)
          ? Math.max(0, Math.min(100, event.percent))
          : 0
        setUpdateDownloadProgress(pct)
        setUpdateDownloadTransferred(event.transferred)
        setUpdateDownloadTotal(event.total)
        setUpdateDownloadBps(event.bytesPerSecond)
        return
      }

      if (event.type === 'update-downloaded') {
        setCheckingForUpdates(false)
        setUpdateDownloadProgress(100)
        setUpdateDownloadBps(null)
        setUpdateReadyToInstall(true)
        setUpdateMessage(`Update ${event.version} downloaded. Restart to install.`)
        return
      }

      if (event.type === 'update-not-available') {
        setCheckingForUpdates(false)
        setUpdateReadyToInstall(false)
        setUpdateDownloadProgress(null)
        setUpdateDownloadTransferred(null)
        setUpdateDownloadTotal(null)
        setUpdateDownloadBps(null)
        setUpdateMessage('No update available')
        setTimeout(() => setUpdateMessage(null), 3000)
        return
      }

      if (event.type === 'error') {
        setCheckingForUpdates(false)
        setUpdateReadyToInstall(false)
        setUpdateDownloadProgress(null)
        setUpdateDownloadTransferred(null)
        setUpdateDownloadTotal(null)
        setUpdateDownloadBps(null)
        setUpdateMessage(`Update failed: ${event.message}`)
      }
    }

    window.electronAPI.onUpdaterStatus(handleUpdaterStatus)
    return () => window.electronAPI.removeUpdaterListeners()
  }, [])

  // Check Ollama whenever AI is toggled on
  useEffect(() => {
    if (aiEnabled) checkOllama()
  }, [aiEnabled])

  async function checkOllama() {
    setOllamaStatus('checking')
    const result = await window.electronAPI.getOllamaModels()
    if (result.ok) {
      setInstalledModels(result.models)
      setOllamaStatus('installed')
    } else {
      setInstalledModels([])
      setOllamaStatus('not-installed')
    }
  }

  const bg = settings?.backgroundScan
  const totalKB = bg?.lastScanResults.reduce((s, r) => s + r.sizeKB, 0) ?? 0

  async function toggleBgEnabled() {
    if (!settings) return
    const next = { ...settings, backgroundScan: { ...settings.backgroundScan, enabled: !settings.backgroundScan.enabled } }
    setSettings(next); setSaving(true)
    await window.electronAPI.saveSettings(next)
    setSaving(false)
  }

  async function toggleMenuBarIcon() {
    if (!settings) return
    const next = { ...settings, showMenuBarIcon: !settings.showMenuBarIcon }
    setSettings(next)
    await window.electronAPI.saveSettings(next)
  }

  async function toggleAutoUpdate() {
    if (!settings) return
    const next = { ...settings, autoUpdateEnabled: !settings.autoUpdateEnabled }
    setSettings(next)
    await window.electronAPI.saveSettings(next)
  }

  async function handleCheckForUpdates() {
    setCheckingForUpdates(true)
    setUpdateReadyToInstall(false)
    setUpdateDownloadProgress(null)
    setUpdateDownloadTransferred(null)
    setUpdateDownloadTotal(null)
    setUpdateDownloadBps(null)
    setUpdateMessage(null)
    try {
      const updateFound = await window.electronAPI.checkForUpdates()
      if (!updateFound) {
        setUpdateMessage('No update available')
        setTimeout(() => setUpdateMessage(null), 3000)
      }
    } catch (err) {
      console.error('Failed to check for updates:', err)
      setUpdateReadyToInstall(false)
      setUpdateDownloadProgress(null)
      setUpdateDownloadTransferred(null)
      setUpdateDownloadTotal(null)
      setUpdateDownloadBps(null)
      setUpdateMessage('Failed to check for updates')
      setTimeout(() => setUpdateMessage(null), 3000)
    } finally {
      setCheckingForUpdates(false)
    }
  }

  async function handleRestartToInstall() {
    setRestartingToInstall(true)
    const started = await window.electronAPI.installUpdateNow()
    if (!started) {
      setRestartingToInstall(false)
      setUpdateMessage('Update is not ready to install yet')
      setTimeout(() => setUpdateMessage(null), 3000)
    }
  }

  async function setBgInterval(hours: number) {
    if (!settings) return
    const next = { ...settings, backgroundScan: { ...settings.backgroundScan, intervalHours: hours } }
    setSettings(next)
    await window.electronAPI.saveSettings(next)
  }

  async function setScanTimeHour(hour: number) {
    if (!settings) return
    const next = { ...settings, backgroundScan: { ...settings.backgroundScan, scanTimeHour: hour } }
    setSettings(next)
    await window.electronAPI.saveSettings(next)
  }

  async function scanNow() {
    setScanningNow(true)
    await window.electronAPI.runBgScanNow()
    const updated = await window.electronAPI.getSettings()
    setSettings(updated)
    setScanningNow(false)
  }

  async function toggleDevDeps() {
    if (!settings) return
    const next = { ...settings, showDevDependencies: !settings.showDevDependencies }
    setSettings(next)
    onDevDepsChange(next.showDevDependencies)
    await window.electronAPI.saveSettings(next)
  }

  async function toggleQuickFolder(name: string) {
    if (!settings) return
    const next = quickScanFolders.includes(name)
      ? quickScanFolders.filter(f => f !== name)
      : [...quickScanFolders, name]
    onQuickScanFoldersChange(next)
    await window.electronAPI.saveSettings({ ...settings, quickScanFolders: next })
  }

  async function addCustomFolder() {
    if (!settings) return
    const result = await window.electronAPI.openDirectory()
    if (!result) return
    const alreadyKnown = (settings.customQuickScanFolders ?? []).includes(result)
    const alreadyEnabled = quickScanFolders.includes(result)
    const nextCustom = alreadyKnown ? (settings.customQuickScanFolders ?? []) : [...(settings.customQuickScanFolders ?? []), result]
    const nextEnabled = alreadyEnabled ? quickScanFolders : [...quickScanFolders, result]
    onQuickScanFoldersChange(nextEnabled)
    await window.electronAPI.saveSettings({ ...settings, quickScanFolders: nextEnabled, customQuickScanFolders: nextCustom })
    setSettings(s => s ? { ...s, customQuickScanFolders: nextCustom } : s)
  }

  async function removeCustomFolder(path: string) {
    if (!settings) return
    const nextCustom = (settings.customQuickScanFolders ?? []).filter(f => f !== path)
    const nextEnabled = quickScanFolders.filter(f => f !== path)
    onQuickScanFoldersChange(nextEnabled)
    await window.electronAPI.saveSettings({ ...settings, quickScanFolders: nextEnabled, customQuickScanFolders: nextCustom })
    setSettings(s => s ? { ...s, customQuickScanFolders: nextCustom } : s)
  }

  async function toggleCustomFolder(path: string) {
    if (!settings) return
    const next = quickScanFolders.includes(path)
      ? quickScanFolders.filter(f => f !== path)
      : [...quickScanFolders, path]
    onQuickScanFoldersChange(next)
    await window.electronAPI.saveSettings({ ...settings, quickScanFolders: next })
  }

  async function toggleLoginItem() {
    const next = !loginItem
    setLoginItem(next)
    await window.electronAPI.setLoginItem(next)
  }

  function toggleAI() {
    const next = !aiEnabled
    setAiEnabled(next)
    if (next) {
      localStorage.removeItem('vectra:aiHidden')
    } else {
      localStorage.setItem('vectra:aiHidden', 'true')
      setOllamaStatus('idle')
    }
  }

  async function setActiveModel(modelName: string) {
    if (!settings) return
    const next = { ...settings, preferredOllamaModel: modelName }
    setSettings(next)
    await window.electronAPI.saveSettings(next)
  }

  function startPull(modelName: string) {
    setPullingModel(modelName)
    setPullProgress(null)
    setPullStatus('Connecting…')
    setPullError(null)
    window.electronAPI.pullModel(modelName)
  }

  function cancelPull() {
    window.electronAPI.cancelPull()
    setPullingModel(null)
    setPullProgress(null)
    setPullStatus('')
  }

  // Models not yet installed
  const notInstalled = RECOMMENDED_MODELS.filter(
    (r) => !installedModels.some((m) => m.name === r.name || m.name.startsWith(r.name + ':'))
  )

  const activeModel = settings?.preferredOllamaModel ?? installedModels[0]?.name ?? null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-zinc-950"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Header */}
      <HeaderFrame>
        <button
          onClick={onClose}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-500 hover:text-zinc-200 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-zinc-500 text-xs font-medium tracking-widest uppercase select-none">Settings</h1>
      </HeaderFrame>

      {/* Tabs */}
      <div className="shrink-0 px-5 pt-4 pb-2.5">
        <div className="w-full overflow-x-auto scrollbar-dark">
          <div className="flex items-center justify-center gap-1.5 min-w-max mx-auto">
            {SETTINGS_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={[
                  'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors inline-flex items-center gap-1.5',
                  activeTab === tab.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-white/[0.04] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.08]'
                ].join(' ')}
              >
                {tab.label}
                {tab.premium && (
                  <span className={[
                    'px-1.5 py-0.5 rounded-full text-[9px] leading-none font-semibold tracking-wide',
                    activeTab === tab.id
                      ? 'bg-white/20 text-white/90'
                      : 'bg-violet-500/20 text-violet-300'
                  ].join(' ')}>
                    PRO
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
  <div className="scrollbar-dark flex-1 overflow-y-auto px-5 pt-2 pb-6 flex flex-col gap-6 max-w-lg mx-auto w-full">

        {/* ── License ── */}
        {activeTab === 'general' && (
        <section>
          <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">
            License
          </h2>
        <div className="px-4 py-4 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-zinc-300">Vectra Premium</p>
              <p className="text-[11px] text-zinc-600 mt-0.5">
                {isPremium
                  ? `Active · ${license?.licenseType === 'lifetime' ? 'Lifetime' : 'Monthly'}`
                  : 'Unlock Smart Clean, AI analysis & more'}
              </p>
            </div>
            {isPremium ? (
              <button
                onClick={onLicense}
                className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors border border-white/10 hover:border-white/20 rounded-md px-2.5 py-1"
              >
                Manage
              </button>
            ) : (
              <button
                onClick={onUpgrade}
                className="text-[11px] font-medium text-violet-300 hover:text-violet-200 bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/25 hover:border-violet-500/40 rounded-md px-2.5 py-1 transition-colors"
              >
                Upgrade →
              </button>
            )}
          </div>
        </div>
        </section>
        )}

        {/* ── Background Scanning ── */}
        {activeTab === 'background' && (
        <section>
          <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">
            Background Scanning
          </h2>
          <div className="relative">
            {!isPremium && <PremiumLock onUpgrade={onUpgrade} />}
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] divide-y divide-white/[0.04]">
            <div className="flex items-start justify-between gap-4 px-4 py-4">
              <div className="min-w-0">
                <p className="text-sm text-zinc-200 font-medium">Auto-scan &amp; notify</p>
                <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                  Scan your Mac periodically and send a notification when there's space to reclaim.
                </p>
              </div>
              <Toggle on={!!bg?.enabled} onClick={toggleBgEnabled} disabled={saving} />
            </div>

            <div className={['flex items-center justify-between gap-4 px-4 py-3.5 transition-opacity', !bg?.enabled ? 'opacity-40 pointer-events-none' : ''].join(' ')}>
              <p className="text-sm text-zinc-300">Scan every</p>
              <div className="flex items-center gap-0.5 bg-white/[0.05] rounded-lg p-0.5">
                {INTERVALS.map(({ label, hours }) => (
                  <button
                    key={hours}
                    onClick={() => setBgInterval(hours)}
                    className={['px-3 py-1 rounded-md text-xs font-medium transition-colors', bg?.intervalHours === hours ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300'].join(' ')}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className={['flex items-center justify-between gap-4 px-4 py-3.5 transition-opacity', !bg?.enabled ? 'opacity-40 pointer-events-none' : ''].join(' ')}>
              <p className="text-sm text-zinc-300">Scan at</p>
              <select
                value={bg?.scanTimeHour ?? 2}
                onChange={(e) => setScanTimeHour(Number(e.target.value))}
                className="bg-white/[0.05] border border-white/[0.08] text-zinc-300 text-xs rounded-lg px-2.5 py-1.5 appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500/50"
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i} className="bg-zinc-900">{fmtHour(i)}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0">
                <p className="text-xs text-zinc-400">
                  {bg?.lastScanTime ? `Last scan: ${timeAgo(bg.lastScanTime)}` : 'No scan run yet'}
                </p>
                {bg?.lastScanTime && (
                  <p className="text-xs text-zinc-600 mt-0.5">
                    {totalKB > 0 ? `Found ${formatSize(totalKB)} cleanable` : 'Nothing found'}
                  </p>
                )}
              </div>
              <button
                onClick={scanNow}
                disabled={scanningNow}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed text-xs text-zinc-300 transition-colors shrink-0"
              >
                {scanningNow
                  ? <><div className="w-3 h-3 rounded-full border border-transparent border-t-zinc-400 animate-spin shrink-0" />Scanning…</>
                  : 'Scan Now'}
              </button>
            </div>
          </div>
          </div>
        </section>
        )}

        {/* ── AI Analysis ── */}
        {activeTab === 'ai' && (
        <section>
          <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">
            AI Analysis
          </h2>
          <div className="relative">
            {!isPremium && <PremiumLock onUpgrade={onUpgrade} />}
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] divide-y divide-white/[0.04]">

            {/* Toggle row */}
            <div className="flex items-start justify-between gap-4 px-4 py-4">
              <div className="min-w-0">
                <p className="text-sm text-zinc-200 font-medium">Enable AI analysis</p>
                <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                  Uses a local model via Ollama to explain files and recommend what's safe to delete. Everything stays on your Mac.
                </p>
              </div>
              <Toggle on={aiEnabled} onClick={toggleAI} />
            </div>

            {/* Content when enabled */}
            {aiEnabled && (
              <>
                {/* Checking */}
                {ollamaStatus === 'checking' && (
                  <div className="flex items-center gap-2.5 px-4 py-3.5">
                    <div className="w-3.5 h-3.5 rounded-full border border-transparent border-t-zinc-500 animate-spin shrink-0" />
                    <p className="text-xs text-zinc-500">Checking for Ollama…</p>
                  </div>
                )}

                {/* Not installed */}
                {ollamaStatus === 'not-installed' && (
                  <div className="flex items-center justify-between gap-4 px-4 py-4">
                    <div className="min-w-0">
                      <p className="text-sm text-zinc-300 font-medium">Ollama required</p>
                      <p className="text-xs text-zinc-500 mt-0.5">
                        Free tool that runs AI models locally on your Mac.
                      </p>
                    </div>
                    <button
                      onClick={() => window.electronAPI.openExternal('https://ollama.com/download')}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white transition-colors shrink-0"
                    >
                      Install Ollama
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </button>
                  </div>
                )}

                {/* Installed — model list */}
                {ollamaStatus === 'installed' && (
                  <>
                    {/* Installed models */}
                    {installedModels.length > 0 && (
                      <div className="px-4 py-3 flex flex-col gap-1">
                        <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-2">Installed</p>
                        {installedModels.map((model) => {
                          const isActive = activeModel === model.name ||
                            (activeModel && model.name.startsWith(activeModel + ':')) ||
                            (activeModel && activeModel.startsWith(modelShortName(model.name)))
                          return (
                            <button
                              key={model.name}
                              onClick={() => setActiveModel(model.name)}
                              className={[
                                'flex items-center justify-between gap-3 w-full px-3 py-2 rounded-lg transition-colors text-left',
                                isActive ? 'bg-blue-600/15 border border-blue-500/20' : 'hover:bg-white/[0.04]'
                              ].join(' ')}
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className={['w-1.5 h-1.5 rounded-full shrink-0', isActive ? 'bg-blue-400' : 'bg-zinc-600'].join(' ')} />
                                <span className={['text-xs font-medium truncate', isActive ? 'text-zinc-200' : 'text-zinc-400'].join(' ')}>
                                  {modelShortName(model.name)}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="text-[10px] text-zinc-600">{fmtBytes(model.size)}</span>
                                {isActive && (
                                  <span className="text-[10px] text-blue-400 font-medium">active</span>
                                )}
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {/* More models to download */}
                    {notInstalled.length > 0 && (
                      <div className="px-4 py-3 flex flex-col gap-1">
                        <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-2">More Models</p>
                        {pullError && (
                          <p className="text-xs text-red-400 mb-2">{pullError}</p>
                        )}
                        {notInstalled.map((model) => {
                          const isDownloading = pullingModel === model.name
                          return (
                            <div
                              key={model.name}
                              className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs text-zinc-400 font-medium">{model.display}</span>
                                  {!isDownloading && (
                                    <span className="text-[10px] text-zinc-600 shrink-0">{model.size}</span>
                                  )}
                                </div>
                                {isDownloading && (
                                  <div className="mt-1.5 flex items-center gap-2">
                                    <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                                      <div
                                        className="h-full bg-blue-500 rounded-full transition-all duration-300"
                                        style={{ width: pullProgress !== null ? `${pullProgress}%` : '0%' }}
                                      />
                                    </div>
                                    <span className="text-[10px] text-zinc-500 w-8 text-right shrink-0">
                                      {pullProgress !== null ? `${pullProgress}%` : '…'}
                                    </span>
                                  </div>
                                )}
                                {isDownloading && pullStatus && pullProgress === null && (
                                  <p className="text-[10px] text-zinc-600 mt-1">{pullStatus}</p>
                                )}
                              </div>
                              {isDownloading ? (
                                <button
                                  onClick={cancelPull}
                                  className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors shrink-0 ml-2"
                                >
                                  Cancel
                                </button>
                              ) : (
                                <button
                                  onClick={() => startPull(model.name)}
                                  disabled={pullingModel !== null}
                                  className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/[0.05] hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-[10px] text-zinc-400 transition-colors shrink-0 ml-2"
                                >
                                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                  </svg>
                                  Download
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
          </div>
        </section>
        )}

        {/* ── Scanning Behaviour ── */}
        {activeTab === 'scanning' && (
          <section>
            <div className="flex flex-col gap-6">
              <div>
                <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">Development Dependencies</p>
                <div className="rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  <div className="flex items-start justify-between gap-4 px-4 py-4">
                    <div className="min-w-0">
                      <p className="text-sm text-zinc-200 font-medium">Auto-select development dependencies</p>
                      <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                        Development dependencies are always shown in Smart Clean. Enable this to pre-select <span className="font-mono text-zinc-400">node_modules</span>, virtual environments, and other dev artifacts automatically.
                      </p>
                    </div>
                    <Toggle on={!!settings?.showDevDependencies} onClick={toggleDevDeps} />
                  </div>
                </div>
              </div>

              <div>
                <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">Quick Scan Folders</p>
                <div className="rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  <div className="px-4 py-4">
                    <div className="mb-3">
                      <p className="text-sm text-zinc-200 font-medium">Quick Scan folders</p>
                      <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                        Choose which folders are scanned and shown in Quick Scan mode.
                      </p>
                    </div>

                    <div className="flex flex-col gap-0.5">
                      <div className="px-2 pt-1 pb-1">
                        <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest">Predefined folders</p>
                      </div>

                      {QUICK_FOLDER_OPTIONS.map(({ name, desc }) => {
                        const checked = quickScanFolders.includes(name)
                        return (
                          <button
                            key={name}
                            onClick={() => toggleQuickFolder(name)}
                            className="flex items-center gap-3 w-full px-2 py-2 rounded-lg hover:bg-white/[0.04] transition-colors text-left"
                          >
                            <div className={[
                              'w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors',
                              checked ? 'bg-blue-600 border-blue-600' : 'border-zinc-600 bg-transparent'
                            ].join(' ')}>
                              {checked && (
                                <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                            <div className="min-w-0">
                              <span className="text-xs font-medium text-zinc-300">{name}</span>
                              <span className="text-xs text-zinc-600 ml-2">{desc}</span>
                            </div>
                          </button>
                        )
                      })}

                      <div className="flex items-center justify-between px-2 pt-3 pb-1 mt-1 border-t border-white/[0.06]">
                        <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest">Custom folders</p>
                        <span className="px-1.5 py-0.5 rounded-full text-[9px] leading-none font-semibold tracking-wide bg-violet-500/20 text-violet-300">
                          PRO
                        </span>
                      </div>

                      {/* Custom (absolute path) folders — premium only */}
                      <div className={['relative', isPremium ? 'mt-0.5' : 'mt-2'].join(' ')}>
                        {!isPremium && <PaddedPremiumLock onUpgrade={onUpgrade} />}
                        {(settings?.customQuickScanFolders ?? []).map((folderPath) => {
                          const enabled = quickScanFolders.includes(folderPath)
                          return (
                            <div key={folderPath} className="flex items-center gap-3 w-full px-2 py-2 rounded-lg hover:bg-white/[0.04] transition-colors">
                              <button
                                onClick={() => toggleCustomFolder(folderPath)}
                                className="shrink-0"
                              >
                                <div className={[
                                  'w-4 h-4 rounded border flex items-center justify-center transition-colors',
                                  enabled ? 'bg-blue-600 border-blue-600' : 'border-zinc-600 bg-transparent'
                                ].join(' ')}>
                                  {enabled && (
                                    <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                    </svg>
                                  )}
                                </div>
                              </button>
                              <button
                                onClick={() => toggleCustomFolder(folderPath)}
                                className="text-xs font-mono text-zinc-400 truncate flex-1 min-w-0 text-left"
                                title={folderPath}
                              >
                                {folderPath}
                              </button>
                              <button
                                onClick={() => removeCustomFolder(folderPath)}
                                className="text-zinc-600 hover:text-red-400 transition-colors shrink-0 ml-1"
                                title="Remove"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          )
                        })}

                        {/* Add custom folder button */}
                        <button
                          onClick={addCustomFolder}
                          className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/[0.04] transition-colors text-left mt-0.5"
                        >
                          <div className="w-4 h-4 rounded border border-dashed border-zinc-600 shrink-0 flex items-center justify-center">
                            <svg className="w-2.5 h-2.5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                            </svg>
                          </div>
                          <span className="text-xs text-zinc-500">Add folder…</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ── Startup ── */}
        {activeTab === 'general' && (
        <section>
          <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">
            Startup
          </h2>
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <div className="flex items-start justify-between gap-4 px-4 py-4">
              <div className="min-w-0">
                <p className="text-sm text-zinc-200 font-medium">Open at startup</p>
                <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                  Launch Vectra silently in the background when your Mac starts so background scans can run without opening the app.
                </p>
              </div>
              <Toggle on={!!loginItem} onClick={toggleLoginItem} disabled={loginItem === null} />
            </div>
          </div>
        </section>
        )}

        {/* ── Updates ── */}
        {activeTab === 'general' && (
        <section>
          <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">
            Updates
          </h2>
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] divide-y divide-white/[0.04]">
            <div className="flex items-start justify-between gap-4 px-4 py-4">
              <div className="min-w-0">
                <p className="text-sm text-zinc-200 font-medium">Auto update</p>
                <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                  Automatically updates when a newer version is available.
                </p>
              </div>
              <Toggle on={!!settings?.autoUpdateEnabled} onClick={toggleAutoUpdate} disabled={!settings} />
            </div>
            <div className="px-4 py-4">
              <button
                onClick={handleCheckForUpdates}
                disabled={checkingForUpdates || !settings}
                className="text-xs text-blue-400 hover:text-blue-300 disabled:text-zinc-600 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                {checkingForUpdates ? (
                  <>
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Checking...
                  </>
                ) : (
                  <>Check for updates →</>
                )}
              </button>
              {updateMessage && (
                <p className="text-xs text-zinc-500 mt-2">
                  {updateMessage}
                </p>
              )}
              {updateDownloadProgress !== null && !updateReadyToInstall && (
                <div className="mt-3">
                  <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-[width] duration-200"
                      style={{ width: `${Math.round(updateDownloadProgress)}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1">
                    Downloading update... {Math.round(updateDownloadProgress)}%
                  </p>
                  {(updateDownloadTransferred !== null || updateDownloadTotal !== null || updateDownloadBps !== null) && (
                    <p className="text-[11px] text-zinc-600 mt-1">
                      {updateDownloadTransferred !== null && updateDownloadTotal !== null
                        ? `${fmtBytes(updateDownloadTransferred)} / ${fmtBytes(updateDownloadTotal)}`
                        : 'Preparing download...'}
                      {updateDownloadBps !== null && updateDownloadBps > 0
                        ? ` • ${fmtSpeed(updateDownloadBps)}`
                        : ''}
                      {updateDownloadTransferred !== null &&
                        updateDownloadTotal !== null &&
                        updateDownloadBps !== null &&
                        updateDownloadBps > 0 &&
                        updateDownloadTotal > updateDownloadTransferred
                        ? ` • ${fmtEta((updateDownloadTotal - updateDownloadTransferred) / updateDownloadBps)} left`
                        : ''}
                    </p>
                  )}
                </div>
              )}
              {updateReadyToInstall && (
                <button
                  onClick={handleRestartToInstall}
                  disabled={restartingToInstall}
                  className="mt-3 text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {restartingToInstall ? 'Restarting...' : 'Restart to install update'}
                </button>
              )}
              {appVersion && (
                <p className="text-xs text-zinc-600 mt-2">
                  Current version: {appVersion}
                </p>
              )}
            </div>
          </div>
        </section>
        )}

        {/* ── Menu Bar ── */}
        {activeTab === 'general' && (
        <section>
          <h2 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest mb-3">
            Menu Bar
          </h2>
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <div className="flex items-start justify-between gap-4 px-4 py-4">
              <div className="min-w-0">
                <p className="text-sm text-zinc-200 font-medium">Show in menu bar</p>
                <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                  Display the Vectra icon in the macOS menu bar for quick access and scan status.
                </p>
              </div>
              <Toggle on={!!settings?.showMenuBarIcon} onClick={toggleMenuBarIcon} />
            </div>
          </div>
        </section>
        )}

      </div>
    </div>,
    document.body
  )
}
