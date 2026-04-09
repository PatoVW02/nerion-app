interface EmptyStateProps {
  type: 'no-root' | 'empty' | 'error'
  error?: string
}

export function EmptyState({ type, error }: EmptyStateProps) {
  if (type === 'no-root') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
        <div className="text-5xl mb-2">🗂️</div>
        <p className="text-zinc-300 text-lg font-medium">No folder selected</p>
        <p className="text-zinc-500 text-sm">Choose a folder to analyze its disk usage</p>
      </div>
    )
  }

  if (type === 'empty') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-8">
        <div className="text-4xl mb-2">📭</div>
        <p className="text-zinc-400 text-sm">This folder is empty</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-8">
      <div className="text-4xl mb-2">⚠️</div>
      <p className="text-zinc-300 text-sm font-medium">Could not read this folder</p>
      {error && (
        <p className="text-zinc-500 text-xs max-w-sm font-mono break-all">{error}</p>
      )}
    </div>
  )
}
