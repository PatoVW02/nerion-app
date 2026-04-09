import { DiskEntry } from '../types'
import { FileRow } from './FileRow'
import { EmptyState } from './EmptyState'
import { ScanningLoader } from './ScanningLoader'

interface FileListProps {
  entries: DiskEntry[]
  scanning: boolean      // global scan still in progress
  scannedCount: number
  error: string | null
  onNavigate: (entry: DiskEntry) => void
}

function ScanningBadge({ count }: { count: number }) {
  return (
    <div className="flex items-center justify-center gap-2 py-2 text-xs text-zinc-500">
      <div className="w-3 h-3 rounded-full border border-transparent border-t-blue-500 animate-spin" />
      Scanning… {count.toLocaleString()} items found
    </div>
  )
}

export function FileList({ entries, scanning, scannedCount, error, onNavigate }: FileListProps) {
  // No entries yet for this path
  if (entries.length === 0) {
    if (scanning) return <ScanningLoader scannedCount={scannedCount} />
    if (error) return <EmptyState type="error" error={error} />
    return <EmptyState type="empty" />
  }

  const maxSizeKB = entries[0]?.sizeKB ?? 1

  return (
    <div className="overflow-y-auto h-full px-2 py-2 flex flex-col">
      <div className="flex-1">
        {entries.map((entry) => (
          <FileRow
            key={entry.path}
            entry={entry}
            maxSizeKB={maxSizeKB}
            onClick={() => onNavigate(entry)}
          />
        ))}
      </div>

      {scanning && <ScanningBadge count={scannedCount} />}
    </div>
  )
}
