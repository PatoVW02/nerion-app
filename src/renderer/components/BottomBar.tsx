type ScanMode = 'quick' | 'deep'

interface BottomBarProps {
  selectedPath: string
  scanningPath?: string
  scanning: boolean
  scannedCount: number
  cleanableCount: number
  scanMode: ScanMode
  quickScanFolders?: string[]
  isPremium?: boolean
  onScan: () => void
  onCancelScan: () => void
  onChangeFolder: () => void
  onSmartClean: () => void
  onToggleScanMode: (mode: ScanMode) => void
}

export function BottomBar({
  selectedPath,
  scanningPath,
  scanning,
  scannedCount,
  cleanableCount,
  scanMode,
  quickScanFolders = [],
  isPremium = false,
  onScan,
  onCancelScan,
  onChangeFolder,
  onSmartClean,
  onToggleScanMode,
}: BottomBarProps) {
  const activeScanPath = scanningPath || selectedPath
  const activeScanFolder = activeScanPath === '/'
    ? 'root'
    : (activeScanPath.split('/').filter(Boolean).pop() ?? activeScanPath)

  return (
    <div className="shrink-0 border-t border-white/[0.08] px-4 py-3 flex flex-col items-center gap-1.5 bg-zinc-950/70 backdrop-blur-xl">
      <div className="flex items-center gap-2">
        {cleanableCount > 0 && (
          <button
            onClick={onSmartClean}
            disabled={scanning}
            className="relative px-3 py-1.5 rounded-md bg-violet-600/20 hover:bg-violet-600/35 border border-violet-500/25 text-xs text-violet-300 hover:text-violet-200 transition-colors flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <svg className="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 2a1 1 0 011 1v1h1a1 1 0 010 2H6v1a1 1 0 01-2 0V6H3a1 1 0 010-2h1V3a1 1 0 011-1zm0 10a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1v-1a1 1 0 011-1zM12 2a1 1 0 01.967.744L14.146 7.2 17.5 9.134a1 1 0 010 1.732l-3.354 1.935-1.18 4.455a1 1 0 01-1.933 0L9.854 12.8 6.5 10.866a1 1 0 010-1.732l3.354-1.935 1.18-4.455A1 1 0 0112 2z" clipRule="evenodd" />
            </svg>
            Smart Clean
            <span className="bg-violet-500/30 text-violet-200 text-[10px] font-medium px-1.5 py-0.5 rounded-full leading-none">
              {cleanableCount}
            </span>
            {!isPremium && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-900 border border-white/10 flex items-center justify-center">
                <svg className="w-2.5 h-2.5 text-zinc-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                </svg>
              </span>
            )}
          </button>
        )}

        {/* Scan mode toggle */}
        <div className="flex items-center gap-0.5 bg-white/[0.05] rounded-md p-0.5">
          {(['quick', 'deep'] as ScanMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => onToggleScanMode(mode)}
              disabled={scanning}
              className={[
                'px-2.5 py-1 rounded text-[11px] font-medium transition-colors capitalize disabled:cursor-not-allowed',
                scanMode === mode ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300 disabled:opacity-40',
              ].join(' ')}
            >
              {mode}
            </button>
          ))}
        </div>

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

        {scanMode === 'deep' && (
          <button
            onClick={onChangeFolder}
            disabled={scanning}
            className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Change Folder
          </button>
        )}
      </div>

      <div className="w-full px-2 flex justify-center">
        {scanning ? (
          <span className="text-xs text-zinc-500 flex items-center justify-center gap-1.5 w-full">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            <span className="truncate text-center">
              Scanning "{activeScanFolder}" · {scannedCount.toLocaleString()} items
            </span>
          </span>
        ) : (
          <span className="text-xs text-zinc-600 font-mono truncate block w-full text-center" title={selectedPath}>
            {scanMode === 'quick'
              ? (quickScanFolders.length > 0
                  ? quickScanFolders.map(f => f.startsWith('/') ? f.split('/').pop() : f).join(' · ')
                  : '~/Library')
              : (selectedPath === '/' ? 'root' : selectedPath)}
          </span>
        )}
      </div>
    </div>
  )
}
