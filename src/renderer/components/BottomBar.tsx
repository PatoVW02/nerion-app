interface BottomBarProps {
  selectedPath: string
  scanning: boolean
  cleanableCount: number
  onScan: () => void
  onCancelScan: () => void
  onChangeFolder: () => void
  onSmartClean: () => void
}

export function BottomBar({
  selectedPath,
  scanning,
  cleanableCount,
  onScan,
  onCancelScan,
  onChangeFolder,
  onSmartClean
}: BottomBarProps) {
  return (
    <div className="shrink-0 border-t border-white/5 px-4 py-3 flex flex-col items-center gap-1.5">
      <div className="flex items-center gap-2">
        {cleanableCount > 0 && (
          <button
            onClick={onSmartClean}
            disabled={scanning}
            className="px-3 py-1.5 rounded-md bg-violet-600/20 hover:bg-violet-600/35 border border-violet-500/25 text-xs text-violet-300 hover:text-violet-200 transition-colors flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <svg className="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M5 2a1 1 0 011 1v1h1a1 1 0 010 2H6v1a1 1 0 01-2 0V6H3a1 1 0 010-2h1V3a1 1 0 011-1zm0 10a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1v-1a1 1 0 011-1zM12 2a1 1 0 01.967.744L14.146 7.2 17.5 9.134a1 1 0 010 1.732l-3.354 1.935-1.18 4.455a1 1 0 01-1.933 0L9.854 12.8 6.5 10.866a1 1 0 010-1.732l3.354-1.935 1.18-4.455A1 1 0 0112 2z"
                clipRule="evenodd"
              />
            </svg>
            Smart Clean
            <span className="bg-violet-500/30 text-violet-200 text-[10px] font-medium px-1.5 py-0.5 rounded-full leading-none">
              {cleanableCount}
            </span>
          </button>
        )}

        {scanning ? (
          <button
            onClick={onCancelScan}
            className="px-6 py-1.5 rounded-md bg-zinc-700 hover:bg-zinc-600 active:bg-zinc-800 text-sm font-medium text-zinc-200 transition-colors flex items-center gap-2"
          >
            <svg className="w-3 h-3 animate-spin text-zinc-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Cancel
          </button>
        ) : (
          <button
            onClick={onScan}
            className="px-6 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-sm font-medium text-white transition-colors"
          >
            Scan
          </button>
        )}

        <button
          onClick={onChangeFolder}
          disabled={scanning}
          className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Change Folder
        </button>
      </div>

      <span className="text-xs text-zinc-600 font-mono truncate max-w-sm" title={selectedPath}>
        {selectedPath === '/' ? 'Root' : selectedPath}
      </span>
    </div>
  )
}
