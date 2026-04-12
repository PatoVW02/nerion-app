import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LicenseInfo } from '../types'

interface LicenseModalProps {
  license: LicenseInfo | null
  onClose: () => void
  onUpgrade: () => void
  /** Called with the license key string — should be the hook's activate() so state updates immediately. */
  onActivate: (key: string) => Promise<{ ok: true; info: LicenseInfo } | { ok: false; error: string }>
  /** Called when the user deactivates — should be the hook's deactivate() so state clears immediately. */
  onDeactivate: () => Promise<void>
}

export function LicenseModal({ license, onClose, onUpgrade, onActivate, onDeactivate }: LicenseModalProps) {
  const [entered, setEntered] = useState(false)
  const [key, setKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [deactivating, setDeactivating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keyInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    if (license?.active) return
    const id = requestAnimationFrame(() => {
      const input = keyInputRef.current
      if (!input) return
      input.focus()
      input.select()
    })
    return () => cancelAnimationFrame(id)
  }, [license?.active])

  async function handleActivate() {
    const trimmed = key.trim()
    if (!trimmed) { setError('Please enter a license key'); return }
    setLoading(true)
    setError(null)
    const result = await onActivate(trimmed)
    setLoading(false)
    if (result.ok) {
      onClose()
    } else {
      setError(result.error)
    }
  }

  async function handleDeactivate() {
    setDeactivating(true)
    await onDeactivate()
    setDeactivating(false)
    onClose()
  }

  return createPortal(
    <div
      className={[
        'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm',
        'transition-opacity duration-200 ease-out',
        entered ? 'opacity-100' : 'opacity-0'
      ].join(' ')}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={[
        'relative w-full max-w-[400px] mx-4 bg-zinc-900/80 backdrop-blur-2xl border border-white/[0.12] rounded-xl shadow-2xl overflow-hidden',
        'transition-all duration-200 ease-out',
        entered ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-2 scale-[0.98]'
      ].join(' ')}>
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-3.5 right-3.5 w-6 h-6 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-300 hover:bg-white/8 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="px-6 pt-6 pb-5">
          <h2 className="text-sm font-semibold text-zinc-100 mb-1">License</h2>
          <p className="text-xs text-zinc-500">
            {license?.active
              ? `Active ${license.licenseType === 'lifetime' ? 'lifetime' : 'monthly'} license`
              : 'Enter your license key to unlock premium features'}
          </p>
        </div>

        {license?.active ? (
          /* ── Active license view ── */
          <div className="px-6 pb-6 space-y-4">
            <div className="rounded-lg bg-green-950/30 border border-green-700/30 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <p className="text-xs font-medium text-green-400">Active</p>
              </div>
              {license.maskedKey && (
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-zinc-500">Key</span>
                  <span className="text-[11px] font-mono text-zinc-400">{license.maskedKey}</span>
                </div>
              )}
              {license.customerEmail && (
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-zinc-500">Email</span>
                  <span className="text-[11px] text-zinc-400">{license.customerEmail}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-500">Type</span>
                <span className="text-[11px] text-zinc-400 capitalize">{license.licenseType}</span>
              </div>
            </div>
            <button
              onClick={handleDeactivate}
              disabled={deactivating}
              className="w-full py-2 rounded-lg border border-white/10 hover:border-white/20 text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
            >
              {deactivating ? 'Deactivating…' : 'Deactivate on this Mac'}
            </button>
            <p className="text-[11px] text-zinc-700 text-center">
              Deactivating frees up an activation slot so you can use your license on another Mac.
            </p>
          </div>
        ) : (
          /* ── Activation form ── */
          <div className="px-6 pb-6 space-y-3">
            <div>
              <input
                ref={keyInputRef}
                value={key}
                onChange={(e) => { setKey(e.target.value); setError(null) }}
                onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
                placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
                spellCheck={false}
                autoComplete="off"
                className={[
                  'w-full px-3 py-2 rounded-lg bg-white/[0.04] border text-xs font-mono text-zinc-200',
                  'placeholder:text-zinc-700 outline-none transition-colors',
                  error ? 'border-red-500/50 focus:border-red-500/70' : 'border-white/10 focus:border-white/20',
                ].join(' ')}
              />
              {error && (
                <p className="mt-1.5 text-[11px] text-red-400">{error}</p>
              )}
            </div>
            <button
              onClick={handleActivate}
              disabled={loading || !key.trim()}
              className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium text-white transition-colors flex items-center justify-center gap-2"
            >
              {loading && (
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              {loading ? 'Activating…' : 'Activate License'}
            </button>
            <p className="text-center">
              <button onClick={onUpgrade} className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors">
                Don't have a license? Get one →
              </button>
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
