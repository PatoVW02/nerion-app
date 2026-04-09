import { useState, useEffect } from 'react'

const MESSAGES = [
  'Reading directories…',
  'Calculating sizes…',
  'Scanning files…',
  'Counting bytes…',
  'Tallying disk usage…',
  'Measuring folders…',
  'Almost there…',
]

interface ScanningLoaderProps {
  scannedCount?: number
  folderName?: string
}

export function ScanningLoader({ scannedCount, folderName }: ScanningLoaderProps) {
  const [index, setIndex] = useState(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const cycle = setInterval(() => {
      setVisible(false)
      setTimeout(() => {
        setIndex((i) => (i + 1) % MESSAGES.length)
        setVisible(true)
      }, 300)
    }, 2200)
    return () => clearInterval(cycle)
  }, [])

  return (
    <div className="flex flex-col items-center justify-center h-full gap-5">
      {/* Spinner */}
      <div className="relative w-10 h-10">
        <div className="absolute inset-0 rounded-full border-2 border-white/10" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-blue-500 animate-spin" />
      </div>

      <div className="flex flex-col items-center gap-1.5">
        {folderName && (
          <p className="text-sm font-medium text-zinc-300">
            Scanning{' '}
            <span className="text-blue-400 font-semibold">{folderName}</span>
          </p>
        )}
        <p
          className="text-xs text-zinc-500 transition-opacity duration-300"
          style={{ opacity: visible ? 1 : 0 }}
        >
          {MESSAGES[index]}
        </p>
      </div>

      {scannedCount !== undefined && scannedCount > 0 && (
        <p className="text-xs text-zinc-700 tabular-nums">
          {scannedCount.toLocaleString()} items found so far
        </p>
      )}
    </div>
  )
}
