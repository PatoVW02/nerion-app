import type { AppPlatform } from './platform'

export const SCAN_PROTOCOL_VERSION = 1 as const

export interface ScanIssue {
  path: string
  code: 'permission-denied' | 'not-found' | 'io-error' | 'invalid-event' | 'scanner-error' | 'non_utf8_path'
  message: string
}

export interface ScanEntryV1 {
  protocolVersion: typeof SCAN_PROTOCOL_VERSION
  event: 'entry'
  scanId: string
  rootId: string
  name: string
  path: string
  allocatedBytes: number
  sizeKB: number
  isDir: boolean
  device: string | null
  inode: string | null
  hardlinkDuplicate: boolean
}

export interface ScanIssueV1 {
  protocolVersion: typeof SCAN_PROTOCOL_VERSION
  event: 'issue'
  scanId: string
  rootId: string
  issue: ScanIssue
}

export type SuspiciousCategory = 'background-item' | 'masquerading-file'
export type SuspiciousRisk = 'review' | 'elevated'

export interface SuspiciousEvidence {
  code: 'startup-location' | 'autorun' | 'risky-target' | 'missing-target' | 'unsigned-target' | 'double-extension' | 'bidi-control' | 'invalid-config'
  label: string
  detail: string | null
}

export interface SuspiciousFinding {
  id: string
  path: string
  name: string
  isDir: boolean
  allocatedBytes: number
  sizeKB: number
  category: SuspiciousCategory
  risk: SuspiciousRisk
  summary: string
  evidence: SuspiciousEvidence[]
  targetPath: string | null
  recommendedAction: string
}

export interface ScanSuspiciousV1 {
  protocolVersion: typeof SCAN_PROTOCOL_VERSION
  event: 'suspicious'
  scanId: string
  rootId: string
  finding: SuspiciousFinding
}

export interface ScanSummaryV1 {
  protocolVersion: typeof SCAN_PROTOCOL_VERSION
  event: 'summary'
  scanId: string
  rootId: string | null
  complete: boolean
  cancelled: boolean
  entryCount: number
  issueCount: number
  rootsCompleted: number
  rootsRequested: number
  fatalError: string | null
  securityAnalysis: 'disabled' | 'complete' | 'partial'
  suspiciousCount: number
  /** Whether this result required filesystem traversal or reused a journal-validated index. */
  source?: 'filesystem' | 'index'
  /** Wall-clock work for this root or aggregate scan. Used for local diagnostics only. */
  durationMs?: number
  /** Native change-journal cursor used internally to validate a persisted index. */
  journalId?: string | null
}

export type ScanEventV1 = ScanEntryV1 | ScanIssueV1 | ScanSuspiciousV1 | ScanSummaryV1

export type BackgroundScanRunOutcome =
  | 'completed'
  | 'deferred'
  | 'cancelled'
  | 'disabled'
  | 'failed'
  | 'no-targets'

export type DeleteItemStatus =
  | 'moved-to-trash'
  | 'permanently-removed'
  | 'already-missing'
  | 'skipped'
  | 'protected'
  | 'failed'

export interface DeleteChildOperation {
  path: string
  status: DeleteItemStatus
  error: string | null
}

export interface DeleteItemResult {
  requestedPath: string
  status: DeleteItemStatus
  movedToTrash: boolean
  reclaimedBytes: number
  movedToTrashBytes: number
  operations: DeleteChildOperation[]
  error: string | null
}

export interface DeleteBatchResult {
  items: DeleteItemResult[]
  requestedCount: number
  successfulCount: number
  failedCount: number
  quotaUsed: number
  reclaimedBytes: number
  movedToTrashBytes: number
  error: string | null
}

export type LeftoverConfidence = 'recommended' | 'review'

export interface LeftoverArtifact {
  path: string
  name: string
  location: string
  isDir: boolean
  allocatedBytes: number
  sizeKB: number
  sizeComplete: boolean
}

export interface LeftoverGroup {
  id: string
  appName: string
  bundleId: string | null
  confidence: LeftoverConfidence
  evidence: string[]
  installedConflicts: string[]
  allocatedBytes: number
  sizeKB: number
  complete: boolean
  artifacts: LeftoverArtifact[]
  // Compatibility fields used by the current review UI. The path represents
  // the primary artifact; grouped artifacts are expanded before deletion.
  path: string
  name: string
  location: string
}

export interface LeftoverScanResult {
  groups: LeftoverGroup[]
  complete: boolean
  inaccessiblePaths: string[]
}

export type LicenseKind = 'monthly' | 'lifetime' | null
export type LicenseLifecycleState =
  | 'free'
  | 'monthly-active'
  | 'monthly-offline-grace'
  | 'monthly-expired'
  | 'lifetime-active'
  | 'validation-unavailable'

export interface LicenseSnapshot {
  active: boolean
  kind: LicenseKind
  state: LicenseLifecycleState
  maskedKey: string | null
  customerEmail: string | null
  expiresAt: string | null
  graceEndsAt: string | null
  lastValidated: string | null
  validationError: string | null
  canManageBilling: boolean
  needsMonthlyCancellation: boolean
  message: string | null
  // Compatibility alias for existing UI code.
  licenseType: 'subscription' | 'lifetime' | null
}

export interface PlatformAppearance {
  platform: AppPlatform
  material: 'vibrancy' | 'mica' | 'solid'
  reducedTransparency: boolean
  highContrast: boolean
  reducedMotion: boolean
  windowActive: boolean
}

export interface AiCapabilities {
  cloudAvailable: boolean
  cloudSource: 'runtime' | 'user' | null
  cloudConfigurable: boolean
}
