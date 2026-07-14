import { useEffect, useState } from 'react'
import type { PlatformAppearance } from '../types'

const fallback: PlatformAppearance = {
  platform: 'macos',
  material: 'solid',
  reducedTransparency: false,
  highContrast: false,
  reducedMotion: false,
  windowActive: true,
}

function applyToDocument(appearance: PlatformAppearance): void {
  const root = document.documentElement
  root.dataset.material = appearance.material
  root.dataset.windowActive = appearance.windowActive ? 'true' : 'false'
  root.dataset.reducedTransparency = appearance.reducedTransparency ? 'true' : 'false'
  root.dataset.highContrast = appearance.highContrast ? 'true' : 'false'
  root.dataset.reducedMotion = appearance.reducedMotion ? 'true' : 'false'
}

export function usePlatformAppearance(): PlatformAppearance {
  const [appearance, setAppearance] = useState(fallback)

  useEffect(() => {
    const update = (next: PlatformAppearance) => {
      setAppearance(next)
      applyToDocument(next)
    }
    window.electronAPI.getPlatformAppearance().then(update).catch(() => applyToDocument(fallback))
    return window.electronAPI.onPlatformAppearanceChanged(update)
  }, [])

  return appearance
}
