import { isContentOnlyProtectedRoot as sharedIsContentOnlyProtectedRoot, isCriticalPath as sharedIsCriticalPath } from '../../shared/policy'

export function isCriticalPath(itemPath: string, homeDir?: string | null): boolean {
  return sharedIsCriticalPath(itemPath, undefined, homeDir)
}

export function isContentOnlyProtectedRoot(itemPath: string, homeDir?: string | null): boolean {
  return sharedIsContentOnlyProtectedRoot(itemPath, undefined, homeDir)
}
