import { useEffect, useState } from 'react'

type Step = 'notifications' | 'full-disk-access' | 'ai-choice' | 'ai-provider-choice' | 'ollama-install' | 'login'

interface Props {
  onComplete: () => void
}

export function OnboardingFlow({ onComplete }: Props) {
  const [history, setHistory] = useState<Step[]>(['notifications'])
  const step = history[history.length - 1]
  const [notifDone, setNotifDone] = useState(false)
  const [notifGranted, setNotifGranted] = useState<boolean | null>(null)
  const [notifChecking, setNotifChecking] = useState(false)
  const [fdaSettingsOpened, setFdaSettingsOpened] = useState(false)
  const [fdaContinueReady, setFdaContinueReady] = useState(false)
  const [fdaActuallyGranted, setFdaActuallyGranted] = useState(false)
  const [checkingOllama, setCheckingOllama] = useState(false)
  const [loginEnabled, setLoginEnabled] = useState(true)
  const [deleteImmediately, setDeleteImmediately] = useState(false)

  function navigate(next: Step) {
    setHistory(h => [...h, next])
  }

  function goBack() {
    setHistory(h => h.length > 1 ? h.slice(0, -1) : h)
  }

  useEffect(() => {
    if (step === 'login') {
      window.electronAPI.setLoginItem(true)
    }
  }, [step])

  useEffect(() => {
    window.electronAPI.checkNotificationPermission().then((granted) => {
      setNotifGranted(granted)
      setNotifDone(granted === true)
    }).catch(() => {})
    window.electronAPI.getSettings().then((settings) => {
      setDeleteImmediately(settings.deleteImmediately ?? false)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!fdaSettingsOpened) return
    // 3-second hard fallback
    const fallback = setTimeout(() => setFdaContinueReady(true), 3000)
    // Poll every 1.5 s for actual FDA grant
    const poll = setInterval(async () => {
      const granted = await window.electronAPI.checkFullDiskAccess()
      if (granted) { clearInterval(poll); clearTimeout(fallback); setFdaActuallyGranted(true); setFdaContinueReady(true) }
    }, 1500)
    return () => { clearInterval(poll); clearTimeout(fallback) }
  }, [fdaSettingsOpened])

  function handleOpenFdaSettings() {
    window.electronAPI.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
    setFdaSettingsOpened(true)
  }

  async function handleRevealElectronApp() {
    const exePath = await window.electronAPI.getElectronExePath()
    // exePath is the Electron binary inside the .app bundle; we want the bundle itself
    const appPath = exePath.includes('.app/Contents/')
      ? exePath.split('.app/Contents/')[0] + '.app'
      : exePath
    window.electronAPI.revealInFinder(appPath)
  }

  function finish() {
    window.electronAPI.markOnboardingComplete()
    if (fdaSettingsOpened && !fdaActuallyGranted) {
      // FDA was opened but the running process never confirmed it — relaunch so
      // the TCC grant takes effect (required for scanning/cleaning ~/Library/Logs).
      window.electronAPI.relaunchApp()
    } else {
      onComplete()
    }
  }

  async function handleAllowNotifications() {
    setNotifChecking(true)
    await window.electronAPI.requestNotificationPermission()
    const granted = await window.electronAPI.checkNotificationPermission().catch(() => null)
    setNotifGranted(granted)
    setNotifDone(true)
    setNotifChecking(false)
  }

  function handleEnableAI() {
    navigate('ai-provider-choice')
  }

  function handleSkipAI() {
    localStorage.setItem('nerion:aiHidden', 'true')
    navigate('login')
  }

  function handleCloudModel() {
    localStorage.removeItem('nerion:aiHidden')
    navigate('login')
  }

  async function handleOllamaChoice() {
    setCheckingOllama(true)
    const status = await window.electronAPI.checkOllama()
    setCheckingOllama(false)
    localStorage.removeItem('nerion:aiHidden')
    if (status.installed) {
      navigate('login')
    } else {
      navigate('ollama-install')
    }
  }

  function handleInstallOllama() {
    window.electronAPI.openExternal('https://ollama.com/download')
    navigate('login')
  }

  async function toggleLogin() {
    const next = !loginEnabled
    setLoginEnabled(next)
    await window.electronAPI.setLoginItem(next)
  }

  async function toggleDeleteImmediately() {
    const next = !deleteImmediately
    setDeleteImmediately(next)
    const settings = await window.electronAPI.getSettings()
    await window.electronAPI.saveSettings({ ...settings, deleteImmediately: next })
  }

  const stepIndex = step === 'notifications' ? 0 : step === 'full-disk-access' ? 1 : step === 'login' ? 3 : 2

  return (
    <div
      className="flex flex-col h-screen bg-zinc-950 text-zinc-100 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div style={{ height: '52px' }} />

      <div
        className="flex-1 flex flex-col items-center justify-center px-8"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div className="w-full max-w-sm flex flex-col gap-8">
          {/* Wordmark */}
          <div className="flex flex-col items-center gap-1.5">
            <p className="text-2xl font-semibold tracking-tight text-zinc-100">Nerion</p>
            <p className="text-sm text-zinc-500">Let's get you set up in four quick steps.</p>
          </div>

          {/* ── Step 1: Notifications ── */}
          {step === 'notifications' && (
            <StepCard
              icon={
                <svg className="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
              }
              title="Notifications"
              description="Nerion can alert you when a background scan finds space you can reclaim. Clicking the notification takes you straight to the review screen."
            >
              {notifDone ? (
                <div className="flex flex-col gap-3">
                  {notifGranted !== true && (
                    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.07]">
                      <svg className="w-3.5 h-3.5 text-zinc-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <p className="text-xs text-zinc-400 leading-relaxed">
                        If you didn't see a prompt, enable it in{' '}
                        <button
                          onClick={() => window.electronAPI.openExternal('x-apple.systempreferences:com.apple.preference.notifications')}
                          className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
                        >
                          System Settings → Notifications
                        </button>
                        .
                      </p>
                    </div>
                  )}
                  <button
                    onClick={() => navigate('full-disk-access')}
                    className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
                  >
                    Continue
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <button
                    onClick={handleAllowNotifications}
                    disabled={notifChecking}
                    className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium text-white transition-colors"
                  >
                    {notifChecking ? 'Checking…' : 'Allow Notifications'}
                  </button>
                  <button
                    onClick={() => navigate('full-disk-access')}
                    className="w-full py-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    Skip
                  </button>
                </div>
              )}
            </StepCard>
          )}

          {/* ── Step 2: Full Disk Access ── */}
          {step === 'full-disk-access' && (
            <StepCard
              onBack={goBack}
              icon={
                <svg className="w-6 h-6 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              }
              title="Full Disk Access"
              description="Nerion needs Full Disk Access to scan all folders and move files to the trash. Without it, some items like system logs, can't be cleaned and certain features won't work at full capacity."
            >
              <div className="flex flex-col gap-2">
                {window.electronAPI.isDev && (
                  <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <p className="text-xs text-amber-300 font-medium">Development build</p>
                    <p className="text-xs text-amber-300/80 leading-relaxed">
                      macOS identifies this process as <span className="font-mono bg-amber-500/10 px-1 rounded">Electron</span>, not "Nerion Dev". In System Settings, click <strong>+</strong> and add the Electron app from your node_modules.
                    </p>
                    <button
                      onClick={handleRevealElectronApp}
                      className="self-start text-xs text-amber-400 hover:text-amber-300 underline underline-offset-2 transition-colors"
                    >
                      Reveal Electron.app in Finder →
                    </button>
                  </div>
                )}
                {fdaContinueReady ? (
                  <button
                    onClick={() => navigate('ai-choice')}
                    className="w-full py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-sm font-medium text-white transition-colors"
                  >
                    Continue
                  </button>
                ) : fdaSettingsOpened ? (
                  <button
                    disabled
                    className="w-full py-2 rounded-lg bg-orange-600 opacity-70 cursor-not-allowed text-sm font-medium text-white flex items-center justify-center gap-2"
                  >
                    <div className="w-3.5 h-3.5 rounded-full border border-transparent border-t-white animate-spin shrink-0" />
                    Checking permission…
                  </button>
                ) : (
                  <button
                    onClick={handleOpenFdaSettings}
                    className="w-full py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-sm font-medium text-white transition-colors"
                  >
                    Open System Settings
                  </button>
                )}
                {!fdaContinueReady && (
                  <button
                    onClick={() => navigate('ai-choice')}
                    className="w-full py-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    Skip for now
                  </button>
                )}
              </div>
            </StepCard>
          )}

          {/* ── Step 3: AI ── */}
          {step === 'ai-choice' && (
            <StepCard
              onBack={goBack}
              icon={
                <svg className="w-6 h-6 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              }
              title="AI-powered analysis"
              description="Nerion can use a local AI model to explain what files are and whether they're safe to delete. Everything runs on your Mac — nothing leaves your device."
            >
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleEnableAI}
                  className="w-full py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm font-medium text-white transition-colors"
                >
                  Enable AI Analysis
                </button>
                <button
                  onClick={handleSkipAI}
                  className="w-full py-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Skip for now
                </button>
              </div>
            </StepCard>
          )}

          {/* ── Step 2a: AI provider choice ── */}
          {step === 'ai-provider-choice' && (
            <StepCard
              onBack={checkingOllama ? undefined : goBack}
              icon={
                <svg className="w-6 h-6 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              }
              title="Choose AI provider"
              description="Use a cloud model for the best results, or run Ollama locally to keep everything on your Mac."
            >
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleCloudModel}
                  className="w-full py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm font-medium text-white transition-colors"
                >
                  Cloud model
                </button>
                <button
                  onClick={handleOllamaChoice}
                  disabled={checkingOllama}
                  className="w-full py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 text-sm font-medium text-zinc-200 transition-colors flex items-center justify-center gap-2"
                >
                  {checkingOllama && (
                    <div className="w-3.5 h-3.5 rounded-full border border-transparent border-t-white animate-spin shrink-0" />
                  )}
                  {checkingOllama ? 'Checking…' : 'Ollama (local)'}
                </button>
              </div>
            </StepCard>
          )}

          {/* ── Step 2b: Ollama install ── */}
          {step === 'ollama-install' && (
            <StepCard
              onBack={goBack}
              icon={
                <svg className="w-6 h-6 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              }
              title="Install Ollama"
              description="AI analysis requires Ollama, a free tool that runs language models locally on your Mac. All processing stays on your device."
            >
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleInstallOllama}
                  className="w-full py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-sm font-medium text-white transition-colors"
                >
                  Download Ollama
                </button>
                <button
                  onClick={() => navigate('login')}
                  className="w-full py-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Skip for now
                </button>
              </div>
            </StepCard>
          )}

          {/* ── Step 3: Open at login ── */}
          {step === 'login' && (
            <StepCard
              onBack={goBack}
              icon={
                <svg className="w-6 h-6 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" />
                </svg>
              }
              title="Startup and deletion"
              description="Choose whether Nerion launches in the background at startup, and whether cleanups go to the Trash or are deleted immediately."
            >
              <div className="flex flex-col gap-3">
                {/* Toggle row */}
                <button
                  onClick={toggleLogin}
                  className={[
                    'flex items-center justify-between gap-4 w-full px-4 py-3 rounded-xl border transition-colors',
                    loginEnabled
                      ? 'bg-emerald-600/10 border-emerald-500/25'
                      : 'bg-white/[0.03] border-white/[0.07] hover:bg-white/[0.06]'
                  ].join(' ')}
                >
                  <span className={['text-sm font-medium', loginEnabled ? 'text-emerald-300' : 'text-zinc-300'].join(' ')}>
                    Launch at startup
                  </span>
                  <div className={['relative w-10 h-5 rounded-full transition-colors duration-200 shrink-0', loginEnabled ? 'bg-emerald-500' : 'bg-zinc-700'].join(' ')}>
                    <span className={['absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200', loginEnabled ? 'translate-x-5' : 'translate-x-0'].join(' ')} />
                  </div>
                </button>

                <button
                  onClick={toggleDeleteImmediately}
                  className={[
                    'flex items-center justify-between gap-4 w-full px-4 py-3 rounded-xl border transition-colors',
                    deleteImmediately
                      ? 'bg-red-600/10 border-red-500/25'
                      : 'bg-white/[0.03] border-white/[0.07] hover:bg-white/[0.06]'
                  ].join(' ')}
                >
                  <div className="min-w-0 text-left">
                    <span className={['block text-sm font-medium', deleteImmediately ? 'text-red-300' : 'text-zinc-300'].join(' ')}>
                      Delete immediately
                    </span>
                    <span className="block text-xs text-zinc-500 mt-0.5">
                      Skip the Trash and permanently delete cleaned items.
                    </span>
                  </div>
                  <div className={['relative w-10 h-5 rounded-full transition-colors duration-200 shrink-0', deleteImmediately ? 'bg-red-500' : 'bg-zinc-700'].join(' ')}>
                    <span className={['absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200', deleteImmediately ? 'translate-x-5' : 'translate-x-0'].join(' ')} />
                  </div>
                </button>

                <button
                  onClick={finish}
                  className="w-full py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm font-medium text-zinc-200 transition-colors"
                >
                  {loginEnabled ? 'Finish' : 'Skip for now'}
                </button>
              </div>
            </StepCard>
          )}

          {/* Step dots */}
          <div className="flex items-center justify-center gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={[
                  'w-1.5 h-1.5 rounded-full transition-colors',
                  i === stepIndex ? 'bg-zinc-400' : 'bg-zinc-700'
                ].join(' ')}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function StepCard({
  icon,
  title,
  description,
  onBack,
  children
}: {
  icon: React.ReactNode
  title: string
  description: string
  onBack?: () => void
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl bg-white/[0.04] border border-white/[0.07] p-6 flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="w-10 h-10 rounded-xl bg-white/[0.06] flex items-center justify-center">
            {icon}
          </div>
          {onBack && (
            <button
              onClick={onBack}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
          )}
        </div>
        <div>
          <p className="text-sm font-semibold text-zinc-200">{title}</p>
          <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{description}</p>
        </div>
      </div>
      {children}
    </div>
  )
}
