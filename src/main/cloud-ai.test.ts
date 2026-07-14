import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'

const TEST_DIRECTORY = '/tmp/nerion-cloud-ai-tests'

vi.mock('electron', () => ({
  app: { getPath: () => TEST_DIRECTORY },
  net: { fetch: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('protected:')) throw new Error('invalid protected value')
      return text.slice('protected:'.length)
    },
  },
}))

import { net } from 'electron'
import { loadCloudAiKey, removeCloudAiKey, validateAndSaveCloudAiKey } from './cloud-ai'

describe('OpenAI credential storage', () => {
  beforeEach(() => {
    rmSync(TEST_DIRECTORY, { recursive: true, force: true })
    vi.mocked(net.fetch).mockReset()
  })

  afterEach(() => rmSync(TEST_DIRECTORY, { recursive: true, force: true }))

  it('validates before saving and never writes the plaintext key', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    const key = 'sk-proj-valid-test-key-1234567890'
    await validateAndSaveCloudAiKey(key)

    expect(loadCloudAiKey()).toBe(key)
    expect(readFileSync(`${TEST_DIRECTORY}/cloud-ai.json`, 'utf8')).not.toContain(key)
  })

  it('keeps the last valid credential when a replacement is rejected', async () => {
    const original = 'sk-proj-original-test-key-123456'
    vi.mocked(net.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await validateAndSaveCloudAiKey(original)
    vi.mocked(net.fetch).mockResolvedValueOnce(new Response('{}', { status: 401 }))

    await expect(validateAndSaveCloudAiKey('sk-proj-rejected-test-key-123456')).rejects.toThrow('rejected')
    expect(loadCloudAiKey()).toBe(original)
  })

  it('removes the stored credential without exposing it', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    await validateAndSaveCloudAiKey('sk-proj-removable-test-key-123456')
    removeCloudAiKey()
    expect(loadCloudAiKey()).toBeNull()
  })
})
