import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIRECTORY = join(tmpdir(), 'nerion-cloud-ai-tests')

vi.mock('electron', () => ({
  app: { getPath: () => TEST_DIRECTORY },
}))

import { buildCloudAiRelayRequest, cloudAiFailureMessage, removeLegacyCloudAiCredential } from './cloud-ai'

describe('managed Cloud AI migration', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIRECTORY, { recursive: true })
  })

  it('removes the obsolete user API-key envelope without needing to decrypt it', () => {
    const credentialPath = join(TEST_DIRECTORY, 'cloud-ai.json')
    writeFileSync(credentialPath, '{"schemaVersion":1,"encrypted":"legacy"}')
    removeLegacyCloudAiCredential()
    expect(existsSync(credentialPath)).toBe(false)
  })

  it('is safe when no legacy credential exists', () => {
    removeLegacyCloudAiCredential()
    expect(existsSync(join(TEST_DIRECTORY, 'cloud-ai.json'))).toBe(false)
  })

  it('authorizes the first-party relay without embedding OpenAI configuration', () => {
    const signal = new AbortController().signal
    const request = buildCloudAiRelayRequest(
      { licenseKey: 'paid-license', instanceId: 'paid-instance' },
      {
        name: 'Cache',
        path: '/Users/test/Library/Caches/example',
        isDirectory: true,
        size: '4 MB',
        sizeKB: 4096,
        pathContext: 'User cache directory',
        platform: 'macos',
      },
      '1.5.3',
      signal,
    )

    expect(request).toMatchObject({ method: 'POST', signal })
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer paid-license',
      'X-Nerion-License-Instance': 'paid-instance',
      'X-Nerion-App-Version': '1.5.3',
    })
    expect(String(request.body)).not.toContain('OPENAI')
    expect(String(request.body)).not.toContain('fileContents')
  })

  it('uses bounded relay errors and hides proxy HTML', async () => {
    await expect(cloudAiFailureMessage(new Response('{"error":"Try later"}', {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }))).resolves.toBe('Try later')
    await expect(cloudAiFailureMessage(new Response('<html>secret proxy page</html>', { status: 502 }))).resolves.toBe('Nerion Cloud AI returned 502.')
  })
})
