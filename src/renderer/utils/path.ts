export function normalizeUiPath(input: string): string {
  if (!input) return input

  const slashified = input.replace(/\\/g, '/')
  const isUnc = /^\/\/[^/]+\/[^/]+/.test(slashified)
  const casefolded = /^[A-Za-z]:/.test(slashified) || isUnc ? slashified.toLowerCase() : slashified

  if (/^[a-z]:\/?$/.test(casefolded)) {
    return casefolded.endsWith('/') ? casefolded : `${casefolded}/`
  }

  const collapsed = isUnc
    ? `//${casefolded.slice(2).replace(/\/{2,}/g, '/')}`
    : casefolded.replace(/\/{2,}/g, '/')
  if (collapsed === '/') return collapsed

  return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed
}

export function isAbsoluteUiPath(input: string): boolean {
  const normalized = normalizeUiPath(input)
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
}

export function pathSegments(input: string): string[] {
  return normalizeUiPath(input).split('/').filter(Boolean)
}

export function pathBasename(input: string): string {
  const normalized = normalizeUiPath(input)
  if (/^[A-Za-z]:\/$/.test(normalized)) return normalized.slice(0, 2)
  const parts = pathSegments(normalized)
  return parts[parts.length - 1] ?? normalized
}

export function pathParent(input: string): string {
  const normalized = normalizeUiPath(input)
  if (normalized === '/') return '/'
  if (/^[A-Za-z]:\/$/.test(normalized)) return normalized
  const uncRoot = normalized.match(/^\/\/[^/]+\/[^/]+/i)?.[0]
  if (uncRoot && normalized === uncRoot) return uncRoot

  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash <= 0) return '/'

  const parent = normalized.slice(0, lastSlash)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}/`
  return parent || '/'
}

export function pathsEqual(left: string, right: string): boolean {
  return normalizeUiPath(left) === normalizeUiPath(right)
}

export function isSameOrDescendantPath(candidate: string, ancestor: string): boolean {
  const candidateKey = normalizeUiPath(candidate)
  const ancestorKey = normalizeUiPath(ancestor)
  if (candidateKey === ancestorKey) return true
  if (ancestorKey === '/') return candidateKey.startsWith('/')
  return candidateKey.startsWith(ancestorKey.endsWith('/') ? ancestorKey : `${ancestorKey}/`)
}
