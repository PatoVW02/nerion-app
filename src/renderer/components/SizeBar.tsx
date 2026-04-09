interface SizeBarProps {
  ratio: number
  isDir: boolean
}

export function SizeBar({ ratio, isDir }: SizeBarProps) {
  return (
    <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-300 ${
          isDir ? 'bg-blue-500' : 'bg-zinc-500'
        }`}
        style={{ width: `${Math.max(ratio * 100, 0.5)}%` }}
      />
    </div>
  )
}
