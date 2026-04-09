import { DiskEntry } from '../types'
import { SizeBar } from './SizeBar'
import { formatSize } from '../utils/format'

interface FileRowProps {
  entry: DiskEntry
  maxSizeKB: number
  onClick: () => void
}

function FolderIcon() {
  return (
    <svg className="w-4 h-4 text-blue-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg className="w-4 h-4 text-zinc-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
        clipRule="evenodd"
      />
    </svg>
  )
}

export function FileRow({ entry, maxSizeKB, onClick }: FileRowProps) {
  const ratio = maxSizeKB > 0 ? entry.sizeKB / maxSizeKB : 0

  return (
    <div
      onClick={entry.isDir ? onClick : undefined}
      className={`flex items-center gap-3 px-4 py-2.5 rounded-lg transition-colors ${
        entry.isDir
          ? 'cursor-pointer hover:bg-white/5 active:bg-white/10'
          : 'cursor-default'
      }`}
    >
      {entry.isDir ? <FolderIcon /> : <FileIcon />}

      <span className="w-48 shrink-0 text-sm text-zinc-200 truncate" title={entry.name}>
        {entry.name}
      </span>

      <div className="flex-1 min-w-0">
        <SizeBar ratio={ratio} isDir={entry.isDir} />
      </div>

      <span className="w-20 shrink-0 text-right text-sm text-zinc-400 tabular-nums">
        {formatSize(entry.sizeKB)}
      </span>

      {entry.isDir && (
        <svg className="w-3.5 h-3.5 text-zinc-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      )}
    </div>
  )
}
