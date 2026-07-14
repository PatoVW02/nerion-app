export interface VirtualWindow {
  start: number
  end: number
  offsetTop: number
  totalHeight: number
}

export function getVirtualWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
): VirtualWindow {
  const count = Math.max(0, Math.floor(itemCount))
  const height = Math.max(1, rowHeight)
  const safeTop = Math.max(0, scrollTop)
  const safeViewport = Math.max(0, viewportHeight)
  const safeOverscan = Math.max(0, Math.floor(overscan))
  const visibleStart = Math.floor(safeTop / height)
  const visibleCount = Math.ceil(safeViewport / height)
  const start = Math.max(0, Math.min(count, visibleStart - safeOverscan))
  const end = Math.max(start, Math.min(count, visibleStart + visibleCount + safeOverscan))
  return { start, end, offsetTop: start * height, totalHeight: count * height }
}
