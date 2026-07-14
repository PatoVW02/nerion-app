import { useState, useEffect, useCallback } from 'react'
import { LicenseInfo } from '../types'

export interface LicenseState {
  license: LicenseInfo | null   // null = still loading
  isPremium: boolean
  activate: (key: string) => Promise<{ ok: true; info: LicenseInfo } | { ok: false; error: string }>
  deactivate: () => Promise<void>
}

export function useLicense(): LicenseState {
  const [license, setLicense] = useState<LicenseInfo | null>(null)

  useEffect(() => {
    window.electronAPI.getLicense().then(setLicense)
    const unsubscribe = window.electronAPI.onLicenseChanged(setLicense)
    return unsubscribe
  }, [])

  const activate = useCallback(async (key: string) => {
    const result = await window.electronAPI.activateLicense(key)
    if (result.ok) setLicense(result.info)
    return result
  }, [])

  const deactivate = useCallback(async () => {
    const snapshot = await window.electronAPI.deactivateLicense()
    setLicense(snapshot)
  }, [])

  return {
    license,
    isPremium: license?.active === true,
    activate,
    deactivate,
  }
}
