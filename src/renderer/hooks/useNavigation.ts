import { useState, useCallback } from 'react'

export interface NavigationState {
  stack: string[]
  currentPath: string | null
  navigate: (path: string) => void
  goBack: () => void
  goTo: (index: number) => void
  reset: () => void
}

export function useNavigation(): NavigationState {
  const [stack, setStack] = useState<string[]>([])

  const currentPath = stack.length > 0 ? stack[stack.length - 1] : null

  const navigate = useCallback((path: string) => {
    setStack((prev) => [...prev, path])
  }, [])

  const goBack = useCallback(() => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
  }, [])

  const goTo = useCallback((index: number) => {
    setStack((prev) => prev.slice(0, index + 1))
  }, [])

  const reset = useCallback(() => {
    setStack([])
  }, [])

  return { stack, currentPath, navigate, goBack, goTo, reset }
}
