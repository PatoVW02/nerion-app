import { useEffect, useState, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  Clock,
  Cloud,
  Download,
  Folder,
  ListChecks,
  Monitor,
  PackageSearch,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash,
  Zap,
  type LucideProps,
} from 'lucide-react'
import changelog from '../whats-new.json'

interface ReleaseItem {
  icon: string
  title: string
  description: string
}

interface Release {
  version: string
  date: string
  description?: string
  items: ReleaseItem[]
}

interface WhatsNewModalProps {
  version?: string
  onClose: () => void
}

/** Returns the release matching the given version, or the latest if not found. */
export function getRelease(version?: string): Release | null {
  const releases = changelog.releases as Release[]
  if (version) {
    const match = releases.find((r) => r.version === version)
    if (match) return match
  }
  return releases[0] ?? null
}

// Keep this list explicit. Importing the Lucide namespace pulls every icon into
// the renderer bundle just to resolve a handful of changelog names at runtime.
const RELEASE_ICONS: Record<string, ComponentType<LucideProps>> = {
  AlertTriangle,
  Clock,
  Cloud,
  Download,
  Folder,
  ListChecks,
  Monitor,
  PackageSearch,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash,
  Zap,
}

/** Resolve a supported icon name, falling back to a dot for malformed data. */
function ReleaseIcon({ name, className }: { name: string; className?: string }) {
  const Icon = RELEASE_ICONS[name]
  if (!Icon) return <span className={className}>·</span>
  return <Icon size={16} className={className} strokeWidth={1.75} />
}

export function WhatsNewModal({ version, onClose }: WhatsNewModalProps) {
  const [entered, setEntered] = useState(false)
  const release = getRelease(version)

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!release) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="whats-new-title"
      className={[
        'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6',
        'transition-opacity duration-200 ease-out',
        entered ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Wrapper — relative so the close button positions off the card corner, outside overflow-hidden */}
      <div
        className="relative w-full max-w-[580px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={[
            'glass-popover w-full border rounded-2xl',
            'flex flex-col max-h-[min(620px,calc(100vh-3rem))]',
            'transition-all duration-200 ease-out',
            entered ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-2 scale-[0.98]',
          ].join(' ')}
        >
          {/* Header — always visible, never scrolls */}
          <div className="shrink-0 px-8 pt-8 pb-6 border-b border-white/5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-blue-600/15 border border-blue-500/20 flex items-center justify-center shrink-0">
                <Sparkles className="text-blue-400" width={16} height={16} />
              </div>
              <div>
                <h2 id="whats-new-title" className="text-base font-semibold text-zinc-100 leading-tight">
                  What's New in Nerion {release.version}
                </h2>
                <p className="text-xs text-zinc-500 mt-0.5">{release.date}</p>
              </div>
            </div>
          </div>

          {/* Scrollable body */}
          <div className="overflow-y-auto min-h-0 scrollbar-dark">
            {/* General description */}
            {release.description && (
              <div className="px-8 py-4 border-b border-white/5">
                <p className="text-sm text-zinc-400 leading-relaxed">{release.description}</p>
              </div>
            )}

            {/* Feature grid — 2 columns */}
            <div className="px-8 py-6 grid grid-cols-2 gap-4">
              {release.items.map((item) => (
                <div key={item.title} className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-white/[0.04] border border-white/[0.07] flex items-center justify-center shrink-0">
                    <ReleaseIcon name={item.icon} className="text-zinc-400" />
                  </div>
                  <div className="min-w-0 pt-0.5">
                    <p className="text-sm font-medium text-zinc-200 leading-tight">{item.title}</p>
                    <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">{item.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Footer — always visible, never scrolls */}
          <div className="shrink-0 px-8 pb-7 pt-3 border-t border-white/5">
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-all"
            >
              Got it
            </button>
          </div>
        </div>

        {/* Close — outside overflow-hidden so it's never clipped */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-300 hover:bg-white/10 transition-colors"
          aria-label="Close"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>,
    document.body,
  )
}
