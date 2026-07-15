import { app, BrowserWindow, net, safeStorage } from 'electron'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import type { LicenseKind, LicenseSnapshot } from '../shared/contracts'

const LS_API = 'https://api.lemonsqueezy.com/v1/licenses'
const VALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000
const MONTHLY_OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000
const env = (import.meta as unknown as { env: Record<string, string> }).env
const MONTHLY_VARIANT_ID = env.VITE_MONTHLY_VARIANT_ID ? Number(env.VITE_MONTHLY_VARIANT_ID) : null
const LIFETIME_VARIANT_ID = env.VITE_LIFETIME_VARIANT_ID ? Number(env.VITE_LIFETIME_VARIANT_ID) : null

interface LicenseFile {
  schemaVersion: 3
  key: string
  instanceId: string
  kind: Exclude<LicenseKind, null>
  status: 'active' | 'inactive' | 'expired' | 'disabled'
  customerEmail: string | null
  expiresAt: string | null
  lastValidated: string
  lastValidationAttempt: string
  validationError: string | null
  needsMonthlyCancellation: boolean
  requiresOnlineValidation: boolean
}

interface SecureLicenseEnvelope {
  schemaVersion: 3
  encrypted: string
}

interface LicenseMeta {
  variant_id?: number | null
  variant_name?: string | null
  subscription_id?: number | null
  customer_email?: string | null
}

interface LicenseKeyPayload {
  status?: string
  expires_at?: string | null
}

interface ActivateResponse {
  activated?: boolean
  error?: string
  license_key?: LicenseKeyPayload
  instance?: { id?: string }
  meta?: LicenseMeta
}

interface ValidateResponse {
  valid?: boolean
  error?: string
  license_key?: LicenseKeyPayload
  meta?: LicenseMeta
}

let revalidationInFlight: Promise<LicenseSnapshot> | null = null
let validationPollTimer: NodeJS.Timeout | null = null

function getLicensePath(): string {
  return path.join(app.getPath('userData'), 'license.json')
}

/**
 * Recognizes schema-v2 files created by Nerion 1.4.x. This application-name
 * HMAC is not proof of entitlement, so migration always disables access until
 * Lemon Squeezy validates the preserved key and instance online. New files use
 * the OS-backed Electron safeStorage service instead.
 */
function computeV2Sig(data: Record<string, unknown>): string {
  return createHmac('sha256', app.name).update(JSON.stringify({
    schemaVersion: data.schemaVersion,
    key: data.key,
    instanceId: data.instanceId,
    kind: data.kind,
    status: data.status,
    customerEmail: data.customerEmail,
    expiresAt: data.expiresAt,
    lastValidated: data.lastValidated,
    lastValidationAttempt: data.lastValidationAttempt,
    validationError: data.validationError,
    needsMonthlyCancellation: data.needsMonthlyCancellation,
  })).digest('hex')
}

function computeLegacySig(data: Record<string, unknown>): string {
  return createHmac('sha256', app.name).update(JSON.stringify({
    key: data.key,
    instanceId: data.instanceId,
    licenseType: data.licenseType,
    status: data.status,
    customerEmail: data.customerEmail,
    expiresAt: data.expiresAt,
    lastValidated: data.lastValidated,
  })).digest('hex')
}

function parseLicensePayload(value: unknown): LicenseFile | null {
  if (!value || typeof value !== 'object') return null
  const parsed = value as Record<string, unknown>
  if (parsed.schemaVersion !== 3) return null
  if (typeof parsed.key !== 'string' || !parsed.key) return null
  if (typeof parsed.instanceId !== 'string' || !parsed.instanceId) return null
  if (parsed.kind !== 'monthly' && parsed.kind !== 'lifetime') return null
  if (!['active', 'inactive', 'expired', 'disabled'].includes(String(parsed.status))) return null
  if (parsed.customerEmail !== null && typeof parsed.customerEmail !== 'string') return null
  if (parsed.expiresAt !== null && typeof parsed.expiresAt !== 'string') return null
  if (typeof parsed.lastValidated !== 'string' || typeof parsed.lastValidationAttempt !== 'string') return null
  if (parsed.validationError !== null && typeof parsed.validationError !== 'string') return null
  if (typeof parsed.needsMonthlyCancellation !== 'boolean') return null
  if (typeof parsed.requiresOnlineValidation !== 'boolean') return null

  return parsed as unknown as LicenseFile
}

function protectLicense(data: LicenseFile): SecureLicenseEnvelope {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure license storage is unavailable on this device.')
  }
  return {
    schemaVersion: 3,
    encrypted: safeStorage.encryptString(JSON.stringify(data)).toString('base64'),
  }
}

function unprotectLicense(value: unknown): LicenseFile | null {
  if (!value || typeof value !== 'object') return null
  const envelope = value as Partial<SecureLicenseEnvelope>
  if (envelope.schemaVersion !== 3 || typeof envelope.encrypted !== 'string' || !envelope.encrypted) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const plaintext = safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64'))
    return parseLicensePayload(JSON.parse(plaintext))
  } catch {
    return null
  }
}

function migrateLegacyFile(parsed: Record<string, unknown>): LicenseFile | null {
  const migrationAttempt = new Date(0).toISOString()
  const migrationError = 'This upgraded license must be verified online before paid features can be used.'

  if (parsed.schemaVersion === 2) {
    const { sig, ...rest } = parsed
    if (typeof sig !== 'string' || sig !== computeV2Sig(rest)) return null
    const migrated = parseLicensePayload({
      ...rest,
      schemaVersion: 3,
      status: 'inactive',
      lastValidationAttempt: migrationAttempt,
      validationError: migrationError,
      needsMonthlyCancellation: false,
      requiresOnlineValidation: true,
    })
    if (!migrated) return null
    saveFile(migrated)
    return migrated
  }

  if (typeof parsed.sig !== 'string' || parsed.sig !== computeLegacySig(parsed)) return null
  if (parsed.licenseType !== 'subscription' && parsed.licenseType !== 'lifetime') return null
  const lastValidated = typeof parsed.lastValidated === 'string' ? parsed.lastValidated : new Date(0).toISOString()
  const migrated = parseLicensePayload({
    schemaVersion: 3,
    key: String(parsed.key ?? ''),
    instanceId: String(parsed.instanceId ?? ''),
    kind: parsed.licenseType === 'subscription' ? 'monthly' : 'lifetime',
    status: ['active', 'inactive', 'expired', 'disabled'].includes(String(parsed.status))
      ? parsed.status as LicenseFile['status']
      : 'inactive',
    customerEmail: typeof parsed.customerEmail === 'string' ? parsed.customerEmail : null,
    expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null,
    lastValidated,
    lastValidationAttempt: migrationAttempt,
    validationError: migrationError,
    needsMonthlyCancellation: false,
    requiresOnlineValidation: true,
  })
  if (!migrated) return null
  saveFile(migrated)
  return migrated
}

function loadFile(): LicenseFile | null {
  try {
    const parsed = JSON.parse(readFileSync(getLicensePath(), 'utf8')) as Record<string, unknown>
    if (parsed.schemaVersion === 3) return unprotectLicense(parsed)
    return migrateLegacyFile(parsed)
  } catch {
    return null
  }
}

function saveFile(data: LicenseFile): void {
  const filePath = getLicensePath()
  const tempPath = `${filePath}.tmp`
  mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    writeFileSync(tempPath, JSON.stringify(protectLicense(data), null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tempPath, filePath)
  } finally {
    try { unlinkSync(tempPath) } catch { /* renamed or never written */ }
  }
}

function maskKey(key: string): string {
  const parts = key.split('-')
  if (parts.length >= 4) return `${parts[0]}-****-****-${parts.at(-1)}`
  return `${key.slice(0, 4)}-****-${key.slice(-4)}`
}

function activationInstanceName(): string {
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'desktop'
  return `Nerion on ${platform}`
}

function detectLicenseKind(meta: LicenseMeta | undefined, licenseKey: LicenseKeyPayload | undefined): Exclude<LicenseKind, null> | null {
  const variantId = meta?.variant_id ?? null
  if (variantId !== null && MONTHLY_VARIANT_ID !== null && variantId === MONTHLY_VARIANT_ID) return 'monthly'
  if (variantId !== null && LIFETIME_VARIANT_ID !== null && variantId === LIFETIME_VARIANT_ID) return 'lifetime'
  if (meta?.subscription_id != null) return 'monthly'

  const variantName = (meta?.variant_name ?? '').toLocaleLowerCase('en-US')
  if (/month|annual|year|week|subscription/.test(variantName)) return 'monthly'
  if (/lifetime|one[ -]?time|forever/.test(variantName)) return 'lifetime'
  if (licenseKey?.expires_at) return 'monthly'
  return null
}

function resolvedServerStatus(valid: boolean, status: string): LicenseFile['status'] {
  if (valid && status === 'active') return 'active'
  if (status === 'expired' || status === 'disabled' || status === 'inactive') return status
  // A confirmed `valid: false` response is authoritative even when the nested
  // license-key record still carries its previous active status.
  return 'inactive'
}

function graceEndsAt(file: LicenseFile): string | null {
  if (file.kind !== 'monthly') return null
  const base = file.expiresAt ? new Date(file.expiresAt).getTime() : new Date(file.lastValidated).getTime()
  if (!Number.isFinite(base)) return null
  return new Date(base + MONTHLY_OFFLINE_GRACE_MS).toISOString()
}

function snapshot(file = loadFile()): LicenseSnapshot {
  if (!file) {
    return {
      active: false,
      kind: null,
      state: 'free',
      maskedKey: null,
      customerEmail: null,
      expiresAt: null,
      graceEndsAt: null,
      lastValidated: null,
      validationError: null,
      canManageBilling: false,
      needsMonthlyCancellation: false,
      message: null,
      licenseType: null,
    }
  }

  const explicitInactive = file.status !== 'active' || file.requiresOnlineValidation
  const graceEnd = graceEndsAt(file)
  const graceEndMs = graceEnd ? new Date(graceEnd).getTime() : 0
  const expiresMs = file.expiresAt ? new Date(file.expiresAt).getTime() : 0
  let active = false
  let state: LicenseSnapshot['state']
  let message: string | null = null

  if (file.kind === 'lifetime') {
    active = !explicitInactive
    state = active ? 'lifetime-active' : 'free'
    if (file.validationError && active) message = 'Could not refresh the license status; lifetime access remains available.'
    if (file.requiresOnlineValidation) message = 'Connect to the internet to verify this license before paid features can be used.'
  } else if (explicitInactive || (graceEndMs > 0 && Date.now() > graceEndMs)) {
    state = 'monthly-expired'
    message = file.requiresOnlineValidation
      ? 'Connect to the internet to verify this license before paid features can be used.'
      : 'The monthly license is expired or inactive.'
  } else if (expiresMs > 0 && Date.now() > expiresMs) {
    active = true
    state = 'monthly-offline-grace'
    message = `Offline grace ends ${graceEnd}. Connect to the internet to refresh the subscription.`
  } else if (file.validationError) {
    active = true
    state = 'validation-unavailable'
    message = 'The license server could not be reached. Cached monthly access is still active.'
  } else {
    active = true
    state = 'monthly-active'
  }

  return {
    active,
    kind: file.kind,
    state,
    maskedKey: maskKey(file.key),
    customerEmail: file.customerEmail,
    expiresAt: file.expiresAt,
    graceEndsAt: graceEnd,
    lastValidated: file.lastValidated,
    validationError: file.validationError,
    canManageBilling: file.kind === 'monthly' || file.needsMonthlyCancellation,
    needsMonthlyCancellation: file.needsMonthlyCancellation,
    message,
    licenseType: file.kind === 'monthly' ? 'subscription' : 'lifetime',
  }
}

export const licenseTesting = {
  activationInstanceName,
  computeV2Sig,
  detectLicenseKind,
  migrateLegacyFile,
  parseLicensePayload,
  postForm,
  protectLicense,
  resolvedServerStatus,
  snapshot,
  unprotectLicense,
}

function publish(current = snapshot()): LicenseSnapshot {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send('license:changed', current)
  }
  return current
}

async function postForm<T>(endpoint: string, fields: Record<string, string>): Promise<T> {
  const response = await net.fetch(`${LS_API}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  })
  const text = await response.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`License server returned an invalid response (HTTP ${response.status}).`)
  }
  if (!response.ok) {
    const error = (data as { error?: unknown })?.error
    throw new Error(typeof error === 'string' ? error : `License request failed (HTTP ${response.status}).`)
  }
  if (!data || typeof data !== 'object') throw new Error('License server returned an invalid response.')
  return data as T
}

export type LicenseInfo = LicenseSnapshot

export function getLicenseInfo(): LicenseSnapshot {
  return snapshot()
}

/** Main-process-only credential used to authorize the Nerion Cloud AI relay. */
export function getCloudLicenseAuthorization(): { licenseKey: string; instanceId: string } | null {
  const file = loadFile()
  if (!file || !snapshot(file).active) return null
  return { licenseKey: file.key, instanceId: file.instanceId }
}

async function releaseActivationSlot(key: string, instanceId: string): Promise<void> {
  try {
    await postForm('deactivate', { license_key: key, instance_id: instanceId })
  } catch {
    // This is compensation for an activation that cannot be committed locally.
    // The original, still-valid entitlement remains untouched either way.
  }
}

export async function activateLicense(rawKey: string): Promise<{ ok: true; info: LicenseSnapshot } | { ok: false; error: string }> {
  const key = rawKey.trim()
  if (!key) return { ok: false, error: 'Enter a license key.' }
  const existing = loadFile()
  const existingActive = existing ? snapshot(existing).active : false

  try {
    const data = await postForm<ActivateResponse>('activate', {
      license_key: key,
      instance_name: activationInstanceName(),
    })
    if (data.activated !== true || typeof data.instance?.id !== 'string' || !data.instance.id) {
      return { ok: false, error: data.error ?? 'The license could not be activated.' }
    }
    const status = data.license_key?.status
    if (!status || !['active', 'inactive', 'expired', 'disabled'].includes(status)) {
      return { ok: false, error: 'The license server omitted the license status.' }
    }
    const kind = detectLicenseKind(data.meta, data.license_key)
    if (!kind) {
      await releaseActivationSlot(key, data.instance.id)
      return { ok: false, error: 'The license plan could not be identified. Check the configured Lemon Squeezy variant IDs.' }
    }
    if (status !== 'active') {
      await releaseActivationSlot(key, data.instance.id)
      return { ok: false, error: `This license is ${status} and cannot be activated.` }
    }
    if (existingActive && existing?.kind === 'lifetime') {
      await releaseActivationSlot(key, data.instance.id)
      return { ok: false, error: 'Deactivate the current Lifetime license before activating a different key.' }
    }
    if (existingActive && existing?.kind === 'monthly' && kind !== 'lifetime') {
      await releaseActivationSlot(key, data.instance.id)
      return { ok: false, error: 'Only an active Lifetime license can replace the current monthly license.' }
    }

    const now = new Date().toISOString()
    try {
      saveFile({
        schemaVersion: 3,
        key,
        instanceId: data.instance.id,
        kind,
        status,
        customerEmail: data.meta?.customer_email ?? null,
        expiresAt: data.license_key?.expires_at ?? null,
        lastValidated: now,
        lastValidationAttempt: now,
        validationError: null,
        needsMonthlyCancellation: kind === 'lifetime' && existing?.kind === 'monthly' && existingActive,
        requiresOnlineValidation: false,
      })
    } catch (error) {
      await releaseActivationSlot(key, data.instance.id)
      throw error
    }
    return { ok: true, info: publish() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the license server.' }
  }
}

async function performRevalidation(force: boolean): Promise<LicenseSnapshot> {
  const file = loadFile()
  if (!file) return snapshot(null)
  const lastAttemptMs = new Date(file.lastValidationAttempt).getTime()
  if (!force && !file.requiresOnlineValidation && Number.isFinite(lastAttemptMs) && Date.now() - lastAttemptMs < VALIDATION_INTERVAL_MS) return snapshot(file)

  const attemptTime = new Date().toISOString()
  try {
    const data = await postForm<ValidateResponse>('validate', {
      license_key: file.key,
      instance_id: file.instanceId,
    })
    if (typeof data.valid !== 'boolean' || !data.license_key || typeof data.license_key.status !== 'string') {
      throw new Error('License server returned an incomplete validation response.')
    }
    const status = data.license_key.status
    if (!['active', 'inactive', 'expired', 'disabled'].includes(status)) throw new Error('License server returned an unknown license status.')
    const detectedKind = detectLicenseKind(data.meta, data.license_key)
    const resolvedStatus = resolvedServerStatus(data.valid, status)
    if (file.requiresOnlineValidation && resolvedStatus === 'active' && !detectedKind) {
      throw new Error('The license server did not identify the migrated license plan.')
    }
    const updated: LicenseFile = {
      ...file,
      kind: detectedKind ?? file.kind,
      status: resolvedStatus,
      customerEmail: data.meta?.customer_email ?? file.customerEmail,
      expiresAt: data.license_key.expires_at ?? file.expiresAt,
      lastValidated: attemptTime,
      lastValidationAttempt: attemptTime,
      validationError: null,
      requiresOnlineValidation: false,
    }
    saveFile(updated)
  } catch (error) {
    saveFile({
      ...file,
      lastValidationAttempt: attemptTime,
      validationError: error instanceof Error ? error.message : 'License validation is unavailable.',
    })
  }
  return publish()
}

export function revalidateLicense(force = false): Promise<LicenseSnapshot> {
  if (revalidationInFlight) return revalidationInFlight
  revalidationInFlight = performRevalidation(force).finally(() => { revalidationInFlight = null })
  return revalidationInFlight
}

export function startLicenseValidationService(): void {
  revalidateLicense().catch(() => {})
  if (validationPollTimer) return
  // Poll cheaply so a cached validation that was already 23 hours old at
  // startup is refreshed near its true 24-hour boundary, not a day later.
  validationPollTimer = setInterval(() => {
    revalidateLicense().catch(() => {})
  }, 60 * 60 * 1000)
  validationPollTimer.unref()
}

export async function deactivateLicense(): Promise<LicenseSnapshot> {
  const file = loadFile()
  if (file) {
    try {
      await postForm('deactivate', { license_key: file.key, instance_id: file.instanceId })
    } catch {
      // Local deactivation is explicit; remote slot cleanup remains best effort.
    }
  }
  try { unlinkSync(getLicensePath()) } catch { /* already removed */ }
  return publish(snapshot(null))
}
