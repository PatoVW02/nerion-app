import React, { type ReactNode } from 'react'

interface HeaderFrameProps {
  children: ReactNode
  className?: string
}

export function HeaderFrame({ children, className = '' }: HeaderFrameProps) {
  return (
    <div className="shrink-0 border-b border-white/5">
      <div
        className={[
          'flex items-center gap-3 px-5 pb-4',
          className,
        ].join(' ')}
        style={{ paddingTop: '52px', WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {children}
      </div>
    </div>
  )
}
