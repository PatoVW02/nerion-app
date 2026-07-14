import * as path from 'node:path'
import type { AppPlatform } from './platform'

function stripTrailingSeparators(value: string, platform: AppPlatform): string {
  if (platform === 'windows') {
    const normalized = value.replace(/\//g, '\\')
    if (/^[a-z]:\\?$/i.test(normalized)) return `${normalized.slice(0, 2)}\\`
    return normalized.replace(/\\+$/, '')
  }
  return value === '/' ? '/' : value.replace(/\/+$/, '')
}

/** Preserve the native path for I/O; use this key only for comparisons. */
export function pathComparisonKey(value: string, platform: AppPlatform): string {
  // Do not let the host OS decide how a path from another platform is parsed.
  const normalized = stripTrailingSeparators(
    platform === 'windows' ? path.win32.normalize(value) : path.posix.normalize(value),
    platform,
  )
  return platform === 'windows' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function isSameOrDescendantPath(candidate: string, ancestor: string, platform: AppPlatform): boolean {
  const candidateKey = pathComparisonKey(candidate, platform)
  const ancestorKey = pathComparisonKey(ancestor, platform)
  if (candidateKey === ancestorKey) return true
  const separator = platform === 'windows' ? '\\' : '/'
  return candidateKey.startsWith(ancestorKey.endsWith(separator) ? ancestorKey : `${ancestorKey}${separator}`)
}

export function collapseOverlappingPaths(values: string[], platform: AppPlatform): string[] {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const key = pathComparisonKey(value, platform)
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(value)
    }
  }
  return unique.filter((candidate) => !unique.some(
    (other) => other !== candidate && isSameOrDescendantPath(candidate, other, platform),
  ))
}
