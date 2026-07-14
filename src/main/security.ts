export function isAllowedExternalUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 4096) return false

  try {
    const protocol = new URL(rawUrl).protocol.toLowerCase()
    return protocol === 'https:' || protocol === 'x-apple.systempreferences:' || protocol === 'ms-settings:'
  } catch {
    return false
  }
}

export function isTrustedRendererNavigation(candidateUrl: string, rendererUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl)
    const expected = new URL(rendererUrl)
    if (candidate.protocol !== expected.protocol) return false

    if (expected.protocol === 'file:') {
      return candidate.host === expected.host && candidate.pathname === expected.pathname
    }

    return candidate.origin === expected.origin
  } catch {
    return false
  }
}
