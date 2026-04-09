interface BreadcrumbProps {
  stack: string[]
  onNavigate: (index: number) => void
}

function displayName(path: string, isRoot: boolean): string {
  if (path === '/') return 'Root'
  const base = path.split('/').filter(Boolean).pop() ?? path
  // The very first stack entry (scan root) shows just its folder name, not the full path
  return isRoot ? base : base
}

export function Breadcrumb({ stack, onNavigate }: BreadcrumbProps) {
  if (stack.length === 0) return null

  const segments = stack.map((p, i) => ({
    label: displayName(p, i === 0),
    index: i
  }))

  return (
    <div className="flex items-center gap-0.5 px-4 py-2 text-sm overflow-x-auto whitespace-nowrap scrollbar-none">
      {segments.map((seg, i) => (
        <span key={seg.index} className="flex items-center gap-0.5">
          {i > 0 && (
            <svg className="w-3 h-3 text-zinc-700 shrink-0 mx-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          )}
          <button
            onClick={() => onNavigate(seg.index)}
            disabled={i === segments.length - 1}
            className={`px-1.5 py-0.5 rounded transition-colors text-sm ${
              i === segments.length - 1
                ? 'text-zinc-200 cursor-default font-medium'
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
            }`}
          >
            {seg.label}
          </button>
        </span>
      ))}
    </div>
  )
}
