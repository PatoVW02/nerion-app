import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

const MONTHLY_CHECKOUT_URL = import.meta.env.VITE_MONTHLY_CHECKOUT_URL as string
const LIFETIME_CHECKOUT_URL = import.meta.env.VITE_LIFETIME_CHECKOUT_URL as string

const FEATURES = [
  { icon: '✦', label: 'Smart Clean', desc: 'AI-curated list of safe-to-delete caches, logs & leftovers' },
  { icon: '🗑', label: 'Unlimited deletes from app', desc: 'No monthly cap when cleaning directly inside Vectra' },
  { icon: '⚡', label: 'Background scans', desc: 'Scheduled recurring scans with tray notifications' },
  { icon: '🤖', label: 'AI analysis', desc: 'Per-item explanations and delete recommendations via Ollama' },
  { icon: '⚙', label: 'Custom Quick Scan folders', desc: 'Add any folder to your Quick Scan preset' },
]

interface UpgradeModalProps {
  onClose: () => void
  onActivate: () => void   // open the license activation modal
}

export function UpgradeModal({ onClose, onActivate }: UpgradeModalProps) {
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  function openCheckout(url: string) {
    window.electronAPI.openExternal(url)
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
        'relative w-full max-w-[560px] mx-4 bg-zinc-900/80 backdrop-blur-2xl border border-white/[0.12] rounded-2xl shadow-2xl overflow-hidden',
        'transition-all duration-200 ease-out',
        entered ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-2 scale-[0.98]'
      ].join(' ')}>
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-300 hover:bg-white/8 transition-colors z-10"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Header */}
        <div className="px-8 pt-8 pb-6 text-center border-b border-white/5">
          <div className="w-10 h-10 rounded-xl bg-violet-600/20 border border-violet-500/20 flex items-center justify-center mx-auto mb-3">
            <svg className="w-5 h-5 text-violet-400" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 2a1 1 0 011 1v1h1a1 1 0 010 2H6v1a1 1 0 01-2 0V6H3a1 1 0 010-2h1V3a1 1 0 011-1zm0 10a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1v-1a1 1 0 011-1zM12 2a1 1 0 01.967.744L14.146 7.2 17.5 9.134a1 1 0 010 1.732l-3.354 1.935-1.18 4.455a1 1 0 01-1.933 0L9.854 12.8 6.5 10.866a1 1 0 010-1.732l3.354-1.935 1.18-4.455A1 1 0 0112 2z" clipRule="evenodd" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-zinc-100">Upgrade to Vectra Premium</h2>
          <p className="text-sm text-zinc-500 mt-1">Unlock smart cleaning and automation features</p>
        </div>

        {/* Feature list */}
        <div className="px-8 py-5 border-b border-white/5">
          <div className="grid grid-cols-2 gap-2.5">
            {FEATURES.map(f => (
              <div key={f.label} className="flex items-start gap-2.5">
                <div className="w-6 h-6 rounded-md bg-white/5 flex items-center justify-center shrink-0 mt-0.5">
                  <svg className="w-3 h-3 text-violet-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-medium text-zinc-200">{f.label}</p>
                  <p className="text-[11px] text-zinc-500 mt-0.5 leading-snug">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Plans */}
        <div className="px-8 py-6 flex gap-3">
          {/* Monthly */}
          <button
            onClick={() => openCheckout(MONTHLY_CHECKOUT_URL)}
            className="flex-1 flex flex-col items-center gap-1.5 py-5 rounded-xl border border-white/10 hover:border-white/20 bg-white/[0.03] hover:bg-white/[0.06] transition-all group"
          >
            <p className="text-xs text-zinc-500 group-hover:text-zinc-400 transition-colors">Monthly</p>
            <p className="text-2xl font-bold text-zinc-100">$5</p>
            <p className="text-[11px] text-zinc-600">per month · cancel anytime</p>
            <span className="mt-2 px-3 py-1 rounded-full bg-white/5 text-[11px] text-zinc-400 group-hover:bg-white/10 transition-colors">
              Get started →
            </span>
          </button>

          {/* Lifetime */}
          <button
            onClick={() => openCheckout(LIFETIME_CHECKOUT_URL)}
            className="flex-1 flex flex-col items-center gap-1.5 py-5 rounded-xl border border-violet-500/40 hover:border-violet-500/70 bg-violet-600/10 hover:bg-violet-600/15 transition-all group relative overflow-hidden"
          >
            <div className="absolute top-2.5 right-2.5 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-violet-500/30 text-violet-300 uppercase tracking-wide">
              Best Value
            </div>
            <p className="text-xs text-violet-400/80 group-hover:text-violet-300 transition-colors">Lifetime</p>
            <p className="text-2xl font-bold text-zinc-100">$25</p>
            <p className="text-[11px] text-zinc-600">one-time payment</p>
            <span className="mt-2 px-3 py-1 rounded-full bg-violet-500/20 text-[11px] text-violet-300 group-hover:bg-violet-500/30 transition-colors">
              Buy now →
            </span>
          </button>
        </div>

        {/* Footer */}
        <div className="px-8 pb-6 text-center">
          <button
            onClick={onActivate}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            Already have a license key? Activate it →
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
