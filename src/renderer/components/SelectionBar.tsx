import { DiskEntry } from '../types'
import { formatSize } from '../utils/format'

interface SelectionBarProps {
  selectedEntries: DiskEntry[]
  onDeselect: () => void
  onContinue: () => void
}

export function SelectionBar({ selectedEntries, onDeselect, onContinue }: SelectionBarProps) {
  const totalKB = selectedEntries.reduce((s, e) => s + e.sizeKB, 0)
  const count = selectedEntries.length
  const folders = selectedEntries.filter(e => e.isDir).length
  const files = count - folders

  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-zinc-900 border-t border-white/[0.07]">

      {/* Icon */}
      <div className="w-7 h-7 rounded-md bg-blue-600/15 border border-blue-500/20 flex items-center justify-center shrink-0">
        <svg className="w-3.5 h-3.5 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
          <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
          <path fillRule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clipRule="evenodd" />
        </svg>
      </div>

      {/* Label */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-zinc-200 leading-snug">
          {count} {count === 1 ? 'item' : 'items'} selected
          <span className="text-blue-400 font-semibold ml-1.5">{formatSize(totalKB)}</span>
        </p>
        {(folders > 0 || files > 0) && (
          <p className="text-[10px] text-zinc-600 mt-0.5">
            {[
              folders > 0 && `${folders} ${folders === 1 ? 'folder' : 'folders'}`,
              files > 0 && `${files} ${files === 1 ? 'file' : 'files'}`
            ].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={onDeselect}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          Clear
        </button>
        <button
          onClick={onContinue}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-xs text-white font-medium transition-colors"
        >
          Review & Delete
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  )
}
