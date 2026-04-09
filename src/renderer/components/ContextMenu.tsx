import { useEffect, useRef } from 'react'

interface ContextMenuProps {
  x: number
  y: number
  isDir: boolean
  isSelected: boolean
  onRevealInFinder: () => void
  onToggleSelect: () => void
  onInfo: () => void
  onClose: () => void
}

export function ContextMenu({
  x,
  y,
  isSelected,
  onRevealInFinder,
  onToggleSelect,
  onInfo,
  onClose
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleMouseDown() { onClose() }
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const adjustedX = Math.min(x, window.innerWidth - 192)
  const adjustedY = Math.min(y, window.innerHeight - 140)

  return (
    <div
      ref={menuRef}
      style={{ position: 'fixed', left: adjustedX, top: adjustedY, zIndex: 1000 }}
      className="w-48 bg-zinc-800/95 backdrop-blur border border-white/10 rounded-lg shadow-2xl py-1 overflow-hidden"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        className="w-full px-3 py-2 text-left text-sm text-zinc-200 hover:bg-white/10 transition-colors"
        onClick={() => { onRevealInFinder(); onClose() }}
      >
        Reveal in Finder
      </button>
      <button
        className={`w-full px-3 py-2 text-left text-sm hover:bg-white/10 transition-colors ${
          isSelected ? 'text-blue-400' : 'text-zinc-200'
        }`}
        onClick={() => { onToggleSelect(); onClose() }}
      >
        {isSelected ? 'Remove from Selection' : 'Add to Selection'}
      </button>
      <div className="my-1 border-t border-white/5" />
      <button
        className="w-full px-3 py-2 text-left text-sm text-zinc-200 hover:bg-white/10 transition-colors flex items-center gap-2"
        onClick={() => { onInfo(); onClose() }}
      >
        <svg className="w-3.5 h-3.5 text-violet-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M5 2a1 1 0 011 1v1h1a1 1 0 010 2H6v1a1 1 0 01-2 0V6H3a1 1 0 010-2h1V3a1 1 0 011-1zm0 10a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1v-1a1 1 0 011-1zM12 2a1 1 0 01.967.744L14.146 7.2 17.5 9.134a1 1 0 010 1.732l-3.354 1.935-1.18 4.455a1 1 0 01-1.933 0L9.854 12.8 6.5 10.866a1 1 0 010-1.732l3.354-1.935 1.18-4.455A1 1 0 0112 2z"
            clipRule="evenodd"
          />
        </svg>
        Info
      </button>
    </div>
  )
}
