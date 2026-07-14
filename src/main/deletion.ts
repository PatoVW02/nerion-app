import { shell } from 'electron'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DeleteBatchResult, DeleteChildOperation, DeleteItemResult, DeleteItemStatus } from '../shared/contracts'
import { isContentOnlyProtectedRoot, isCriticalPath } from '../shared/policy'
import { isSameOrDescendantPath, pathComparisonKey } from '../shared/path-utils'
import type { AppPlatform } from '../shared/platform'

export interface DeleteProgress {
  requestedPath: string
  path: string
  status: DeleteItemStatus
  error?: string
}

export interface DeleteOptions {
  deleteImmediately: boolean
  premium: boolean
  remainingQuota: number
  onProgress?: (progress: DeleteProgress) => void
  /** Test/embedding overrides; production defaults to the running OS and user home. */
  platform?: AppPlatform
  homeDir?: string
}

function platform(): AppPlatform {
  return process.platform === 'win32' ? 'windows' : 'macos'
}

export function isAlreadyInTrash(itemPath: string, currentPlatform: AppPlatform): boolean {
  const key = pathComparisonKey(itemPath, currentPlatform)
  // Only the real drive-root Recycle Bin has permanent-delete semantics. An
  // ordinary folder named "$Recycle.Bin" must still go through shell trash.
  if (currentPlatform === 'windows') return /^[a-z]:\\\$recycle\.bin(?:\\|$)/i.test(key)
  const trash = pathComparisonKey(path.join(os.homedir(), '.Trash'), currentPlatform)
  return isSameOrDescendantPath(key, trash, currentPlatform)
}

async function allocatedBytes(itemPath: string, seen = new Set<string>()): Promise<number> {
  const hardLinks = new Map<string, { bytes: number; linkCount: number; occurrences: number }>()

  const walk = async (currentPath: string): Promise<number> => {
    const stats = await fsp.lstat(currentPath)
    if (stats.isSymbolicLink()) return 0
    // A valid zero block count represents a sparse/unallocated file. Falling
    // back to logical size in that case would overstate reclaimed disk space.
    const ownBytes = typeof stats.blocks === 'number' ? stats.blocks * 512 : Number(stats.size)
    if (stats.isFile()) {
      const identity = `${stats.dev}:${stats.ino}`
      if (seen.has(identity)) return 0
      if (stats.nlink <= 1) {
        seen.add(identity)
        return ownBytes
      }
      const observation = hardLinks.get(identity)
      if (observation) observation.occurrences += 1
      else hardLinks.set(identity, { bytes: ownBytes, linkCount: stats.nlink, occurrences: 1 })
      return 0
    }
    if (!stats.isDirectory()) return ownBytes

    let total = ownBytes
    const children = await fsp.readdir(currentPath)
    for (const child of children) {
      try {
        total += await walk(path.join(currentPath, child))
      } catch {
        // Deletion will report the inaccessible child separately when applicable.
      }
    }
    return total
  }

  let total = await walk(itemPath)
  for (const [identity, observation] of hardLinks) {
    // A folder can contain every name for one inode. Removing that folder frees
    // the allocation even though each pre-delete lstat reports nlink > 1.
    if (observation.occurrences >= observation.linkCount && !seen.has(identity)) {
      seen.add(identity)
      total += observation.bytes
    }
  }
  return total
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  const message = errorMessage(error)
  return code === 'ENOENT' || /does(?:n't| not) exist|no such file/i.test(message)
}

function expectedResolvedPath(itemPath: string, currentPlatform: AppPlatform): string {
  // macOS exposes /tmp as the stable public alias for /private/tmp. Treat that
  // operating-system alias as canonical while rejecting other ancestor links.
  if (currentPlatform === 'macos' && (itemPath === '/tmp' || itemPath.startsWith('/tmp/'))) {
    return `/private${itemPath}`
  }
  return itemPath
}

async function removeOne(itemPath: string, immediate: boolean, seenHardLinks: Set<string>): Promise<{ operation: DeleteChildOperation; bytes: number }> {
  let bytes = 0
  try {
    bytes = await allocatedBytes(itemPath, seenHardLinks)
  } catch (error) {
    if (isMissing(error)) {
      return { operation: { path: itemPath, status: 'already-missing', error: null }, bytes: 0 }
    }
  }

  try {
    if (immediate) await fsp.rm(itemPath, { recursive: true, force: false })
    else await shell.trashItem(itemPath)
    return {
      operation: {
        path: itemPath,
        status: immediate ? 'permanently-removed' : 'moved-to-trash',
        error: null,
      },
      bytes,
    }
  } catch (error) {
    if (isMissing(error)) {
      return { operation: { path: itemPath, status: 'already-missing', error: null }, bytes: 0 }
    }
    return {
      operation: { path: itemPath, status: 'failed', error: errorMessage(error) },
      bytes: 0,
    }
  }
}

function skippedResult(requestedPath: string, status: 'skipped' | 'protected' | 'failed', message: string): DeleteItemResult {
  return {
    requestedPath,
    status,
    movedToTrash: false,
    reclaimedBytes: 0,
    movedToTrashBytes: 0,
    operations: [],
    error: message,
  }
}

export async function deleteRequestedPaths(requestedPaths: string[], options: DeleteOptions): Promise<DeleteBatchResult> {
  const currentPlatform = options.platform ?? platform()
  const home = options.homeDir ?? os.homedir()
  const seenPaths = new Set<string>()
  const seenHardLinks = new Set<string>()
  const uniqueRequests: string[] = []

  for (const requestedPath of requestedPaths) {
    const key = pathComparisonKey(requestedPath, currentPlatform)
    if (!seenPaths.has(key)) {
      seenPaths.add(key)
      uniqueRequests.push(requestedPath)
    }
  }

  const results: DeleteItemResult[] = []
  const effectiveRequests: string[] = []
  for (const requestedPath of uniqueRequests) {
    const ancestor = uniqueRequests.find((other) => other !== requestedPath && isSameOrDescendantPath(requestedPath, other, currentPlatform))
    if (ancestor) {
      results.push(skippedResult(requestedPath, 'skipped', `Covered by selected parent: ${ancestor}`))
    } else {
      effectiveRequests.push(requestedPath)
    }
  }

  let quotaUsed = 0
  let quotaError: string | null = null
  for (const requestedPath of effectiveRequests) {
    if (!options.premium && quotaUsed >= options.remainingQuota) {
      quotaError = 'The free monthly delete limit has been reached.'
      const result = skippedResult(requestedPath, 'skipped', quotaError)
      results.push(result)
      options.onProgress?.({ requestedPath, path: requestedPath, status: 'skipped', error: quotaError })
      continue
    }

    const contentOnly = isContentOnlyProtectedRoot(requestedPath, currentPlatform, home)
    if (isCriticalPath(requestedPath, currentPlatform, home) && !contentOnly) {
      const result = skippedResult(requestedPath, 'protected', 'Protected paths cannot be deleted.')
      results.push(result)
      options.onProgress?.({ requestedPath, path: requestedPath, status: result.status, error: result.error ?? undefined })
      continue
    }

    try {
      const requestStats = await fsp.lstat(requestedPath)
      if (contentOnly && requestStats.isSymbolicLink()) {
        const result = skippedResult(requestedPath, 'protected', 'Protected content roots cannot cross a symlink boundary.')
        results.push(result)
        options.onProgress?.({ requestedPath, path: requestedPath, status: 'protected', error: result.error ?? undefined })
        continue
      }
      if (!requestStats.isSymbolicLink()) {
        const resolvedPath = await fsp.realpath(requestedPath)
        const expectedPath = expectedResolvedPath(requestedPath, currentPlatform)
        const isExpectedSystemAlias = currentPlatform === 'macos'
          && (requestedPath === '/tmp' || requestedPath.startsWith('/tmp/'))
          && pathComparisonKey(resolvedPath, currentPlatform) === pathComparisonKey(expectedPath, currentPlatform)
        if (
          isCriticalPath(resolvedPath, currentPlatform, home)
          && !isContentOnlyProtectedRoot(resolvedPath, currentPlatform, home)
          && !isExpectedSystemAlias
        ) {
          const result = skippedResult(requestedPath, 'protected', `Resolved path is protected: ${resolvedPath}`)
          results.push(result)
          options.onProgress?.({ requestedPath, path: resolvedPath, status: 'protected', error: result.error ?? undefined })
          continue
        }
        if (pathComparisonKey(resolvedPath, currentPlatform) !== pathComparisonKey(expectedPath, currentPlatform)) {
          const result = skippedResult(requestedPath, 'protected', `Path crosses a symlink or junction boundary: ${resolvedPath}`)
          results.push(result)
          options.onProgress?.({ requestedPath, path: resolvedPath, status: 'protected', error: result.error ?? undefined })
          continue
        }
      }
    } catch (error) {
      if (!isMissing(error)) {
        const result = skippedResult(requestedPath, 'failed', errorMessage(error))
        results.push(result)
        options.onProgress?.({ requestedPath, path: requestedPath, status: 'failed', error: result.error ?? undefined })
        continue
      }
    }

    let targets = [requestedPath]
    if (contentOnly) {
      try {
        targets = (await fsp.readdir(requestedPath)).map((child) => path.join(requestedPath, child))
      } catch (error) {
        const result = skippedResult(requestedPath, 'failed', errorMessage(error)) as DeleteItemResult
        results.push(result)
        options.onProgress?.({ requestedPath, path: requestedPath, status: 'failed', error: result.error ?? undefined })
        continue
      }
    }

    if (contentOnly && targets.length === 0) {
      const result = skippedResult(requestedPath, 'skipped', 'The protected folder is already empty.')
      results.push(result)
      options.onProgress?.({ requestedPath, path: requestedPath, status: 'skipped' })
      continue
    }

    const operations: DeleteChildOperation[] = []
    let reclaimedBytes = 0
    let movedToTrashBytes = 0
    for (const target of targets) {
      const immediate = options.deleteImmediately || isAlreadyInTrash(target, currentPlatform)
      const { operation, bytes } = await removeOne(target, immediate, seenHardLinks)
      operations.push(operation)
      if (operation.status === 'permanently-removed') reclaimedBytes += bytes
      if (operation.status === 'moved-to-trash') movedToTrashBytes += bytes
      options.onProgress?.({
        requestedPath,
        path: target,
        status: operation.status,
        error: operation.error ?? undefined,
      })
    }

    const failures = operations.filter((operation) => operation.status === 'failed')
    const successful = operations.filter((operation) => ['moved-to-trash', 'permanently-removed', 'already-missing'].includes(operation.status))
    let primaryStatus: DeleteItemStatus = failures.length > 0
      ? 'failed'
      : operations.some((operation) => operation.status === 'permanently-removed')
        ? 'permanently-removed'
        : operations.some((operation) => operation.status === 'moved-to-trash')
          ? 'moved-to-trash'
          : 'already-missing'
    if (contentOnly && primaryStatus === 'already-missing') primaryStatus = 'skipped'
    const error = failures.length > 0
      ? failures.map((operation) => `${operation.path}: ${operation.error}`).join('\n')
      : null

    const itemResult: DeleteItemResult = {
      requestedPath,
      status: primaryStatus,
      movedToTrash: movedToTrashBytes > 0,
      reclaimedBytes,
      movedToTrashBytes,
      operations,
      error: successful.length === 0 && !error ? 'No items were removed.' : error,
    }
    results.push(itemResult)
    if (!options.premium && ['moved-to-trash', 'permanently-removed'].includes(itemResult.status)) quotaUsed++
  }

  const successfulResults = results.filter((item) => ['moved-to-trash', 'permanently-removed'].includes(item.status))
  const failedResults = results.filter((item) => item.status === 'failed' || item.status === 'protected')
  const reclaimedBytes = results.reduce((total, item) => total + item.reclaimedBytes, 0)
  const movedToTrashBytes = results.reduce((total, item) => total + item.movedToTrashBytes, 0)
  const errors = failedResults.map((item) => `${item.requestedPath}: ${item.error ?? item.status}`)

  return {
    items: results,
    requestedCount: uniqueRequests.length,
    successfulCount: successfulResults.length,
    failedCount: failedResults.length,
    quotaUsed,
    reclaimedBytes,
    // The UI receives accurate reclaimed bytes. Trash bytes are informational and
    // intentionally zero until the item leaves Trash; it must never be presented as freed.
    movedToTrashBytes,
    error: [...errors, ...(quotaError ? [quotaError] : [])].join('\n') || null,
  }
}
