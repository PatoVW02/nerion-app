import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync, statSync } from 'node:fs'

vi.mock('electron', () => ({
  app: { name: 'Nerion', getPath: () => '/tmp/nerion-license-tests' },
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`nerion-test-vault:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('nerion-test-vault:')) throw new Error('invalid protected value')
      return text.slice('nerion-test-vault:'.length)
    },
  },
}))

import { activateLicense, getCloudLicenseAuthorization, licenseTesting, revalidateLicense } from './license'
import { net } from 'electron'

const baseLicense = {
  schemaVersion: 3 as const,
  key: 'TEST-KEY',
  instanceId: 'instance',
  status: 'active' as const,
  customerEmail: null,
  expiresAt: null,
  lastValidated: '2026-01-01T00:00:00.000Z',
  lastValidationAttempt: '2026-01-01T00:00:00.000Z',
  validationError: null,
  needsMonthlyCancellation: false,
  requiresOnlineValidation: false,
}

describe('license lifecycle policy', () => {
  beforeEach(() => {
    rmSync('/tmp/nerion-license-tests', { recursive: true, force: true })
    vi.mocked(net.fetch).mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync('/tmp/nerion-license-tests', { recursive: true, force: true })
  })

  it('does not silently classify an unknown plan as Lifetime', () => {
    expect(licenseTesting.detectLicenseKind({}, {})).toBeNull()
    expect(licenseTesting.detectLicenseKind({ variant_name: 'Monthly' }, {})).toBe('monthly')
    expect(licenseTesting.detectLicenseKind({ variant_name: 'Lifetime' }, {})).toBe('lifetime')
  })

  it('uses a non-identifying activation label instead of a username or hostname', () => {
    expect(licenseTesting.activationInstanceName()).toMatch(/^Nerion on (macOS|Windows|desktop)$/)
  })

  it('keeps a validated Lifetime license active indefinitely during network failures', () => {
    const snapshot = licenseTesting.snapshot({
      ...baseLicense,
      kind: 'lifetime',
      validationError: 'offline',
    })
    expect(snapshot.active).toBe(true)
    expect(snapshot.state).toBe('lifetime-active')
  })

  it('allows 72 hours of monthly offline grace and then expires access', () => {
    const expiresAt = '2026-07-12T12:00:00.000Z'
    const inGrace = licenseTesting.snapshot({ ...baseLicense, kind: 'monthly', expiresAt, validationError: 'offline' })
    expect(inGrace.active).toBe(true)
    expect(inGrace.state).toBe('monthly-offline-grace')

    vi.setSystemTime(new Date('2026-07-16T12:00:01.000Z'))
    const expired = licenseTesting.snapshot({ ...baseLicense, kind: 'monthly', expiresAt, validationError: 'offline' })
    expect(expired.active).toBe(false)
    expect(expired.state).toBe('monthly-expired')
  })

  it('honors an explicit inactive server status immediately', () => {
    const snapshot = licenseTesting.snapshot({ ...baseLicense, kind: 'monthly', status: 'inactive' })
    expect(snapshot.active).toBe(false)
    expect(snapshot.state).toBe('monthly-expired')
  })

  it('protects the complete cached entitlement with OS-backed storage', () => {
    const license = { ...baseLicense, kind: 'lifetime' as const }
    const envelope = licenseTesting.protectLicense(license)

    expect(envelope).toEqual({
      schemaVersion: 3,
      encrypted: expect.any(String),
    })
    expect(JSON.stringify(envelope)).not.toContain(license.key)
    expect(licenseTesting.unprotectLicense(envelope)).toEqual(license)
  })

  it('keeps the relay credential in the main process and returns it only for active paid access', async () => {
    vi.mocked(net.fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        activated: true,
        license_key: { status: 'active', expires_at: null },
        instance: { id: 'cloud-instance' },
        meta: { variant_name: 'Lifetime' },
      }),
    } as Response)

    expect(getCloudLicenseAuthorization()).toBeNull()
    await expect(activateLicense('cloud-license-key')).resolves.toMatchObject({ ok: true })
    expect(getCloudLicenseAuthorization()).toEqual({
      licenseKey: 'cloud-license-key',
      instanceId: 'cloud-instance',
    })
  })

  it('rejects a forged or malformed secure entitlement envelope', () => {
    const forged = Buffer.from(JSON.stringify({
      ...baseLicense,
      kind: 'lifetime',
      status: 'active',
    }), 'utf8').toString('base64')

    expect(licenseTesting.unprotectLicense({ schemaVersion: 3, encrypted: forged })).toBeNull()
    expect(licenseTesting.unprotectLicense({ schemaVersion: 3, encrypted: 'not-base64!' })).toBeNull()
    expect(licenseTesting.parseLicensePayload({ ...baseLicense, key: '', kind: 'lifetime' })).toBeNull()
  })

  it('does not grant access from a forgeable legacy Lifetime cache before online validation', () => {
    const legacy = {
      ...baseLicense,
      schemaVersion: 2 as const,
      kind: 'lifetime' as const,
    }
    const migrated = licenseTesting.migrateLegacyFile({
      ...legacy,
      sig: licenseTesting.computeV2Sig(legacy),
    })

    expect(migrated).toMatchObject({
      schemaVersion: 3,
      key: legacy.key,
      instanceId: legacy.instanceId,
      kind: 'lifetime',
      status: 'inactive',
      requiresOnlineValidation: true,
    })
    expect(licenseTesting.snapshot(migrated!)).toMatchObject({ active: false, state: 'free' })
    expect(net.fetch).not.toHaveBeenCalled()
    const persisted = JSON.parse(readFileSync('/tmp/nerion-license-tests/license.json', 'utf8'))
    expect(persisted.schemaVersion).toBe(3)
    expect(persisted.encrypted).toEqual(expect.any(String))
    expect(JSON.stringify(persisted)).not.toContain(legacy.key)
    expect(licenseTesting.unprotectLicense(persisted)).toEqual(migrated)
    if (process.platform !== 'win32') {
      expect(statSync('/tmp/nerion-license-tests/license.json').mode & 0o777).toBe(0o600)
    }
  })

  it('restores migrated Lifetime access only after validation, then keeps it during outages', async () => {
    const legacy = {
      ...baseLicense,
      schemaVersion: 2 as const,
      kind: 'lifetime' as const,
    }
    licenseTesting.migrateLegacyFile({ ...legacy, sig: licenseTesting.computeV2Sig(legacy) })

    const fetchMock = vi.mocked(net.fetch)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        valid: true,
        license_key: { status: 'active', expires_at: null },
        meta: { variant_name: 'Lifetime' },
      }),
    } as Response)

    await expect(revalidateLicense()).resolves.toMatchObject({ active: true, state: 'lifetime-active' })
    let persisted = JSON.parse(readFileSync('/tmp/nerion-license-tests/license.json', 'utf8'))
    expect(licenseTesting.unprotectLicense(persisted)).toMatchObject({
      status: 'active',
      kind: 'lifetime',
      requiresOnlineValidation: false,
    })

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(revalidateLicense(true)).resolves.toMatchObject({ active: true, state: 'lifetime-active' })
    persisted = JSON.parse(readFileSync('/tmp/nerion-license-tests/license.json', 'utf8'))
    expect(licenseTesting.unprotectLicense(persisted)?.validationError).toBe('offline')
  })

  it('keeps the current monthly entitlement when a non-Lifetime replacement is entered', async () => {
    const fetchMock = vi.mocked(net.fetch)
    const response = (body: unknown) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    } as Response)

    fetchMock.mockResolvedValueOnce(response({
      activated: true,
      license_key: { status: 'active', expires_at: '2026-08-13T12:00:00.000Z' },
      instance: { id: 'monthly-instance-one' },
      meta: { variant_name: 'Monthly' },
    }))
    await expect(activateLicense('monthly-key-one')).resolves.toMatchObject({ ok: true })

    fetchMock
      .mockResolvedValueOnce(response({
        activated: true,
        license_key: { status: 'active', expires_at: '2026-08-13T12:00:00.000Z' },
        instance: { id: 'monthly-instance-two' },
        meta: { variant_name: 'Monthly' },
      }))
      .mockResolvedValueOnce(response({ deactivated: true }))

    await expect(activateLicense('monthly-key-two')).resolves.toEqual({
      ok: false,
      error: 'Only an active Lifetime license can replace the current monthly license.',
    })

    const persisted = JSON.parse(readFileSync('/tmp/nerion-license-tests/license.json', 'utf8'))
    expect(licenseTesting.unprotectLicense(persisted)?.key).toBe('monthly-key-one')
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/deactivate'), expect.objectContaining({
      body: expect.stringContaining('instance_id=monthly-instance-two'),
    }))
  })

  it('treats valid false as inactive even if the nested key status is stale', () => {
    expect(licenseTesting.resolvedServerStatus(false, 'active')).toBe('inactive')
    expect(licenseTesting.resolvedServerStatus(true, 'active')).toBe('active')
  })

  it('uses form encoding and rejects malformed successful responses', async () => {
    const fetchMock = vi.mocked(net.fetch)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ valid: true }),
    } as Response)
    await licenseTesting.postForm('validate', { license_key: 'A B', instance_id: 'one' })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/validate'), expect.objectContaining({
      body: 'license_key=A+B&instance_id=one',
      headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    }))

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '<html>bad</html>' } as Response)
    await expect(licenseTesting.postForm('validate', { license_key: 'test' })).rejects.toThrow('invalid response')
  })
})
