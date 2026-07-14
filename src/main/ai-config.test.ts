import { describe, expect, it } from 'vitest'
import { getAiCapabilities, getCloudAiConfig, normalizeAiMode } from './ai-config'

describe('AI runtime configuration', () => {
  it('keeps cloud AI disabled when credentials are missing or incomplete', () => {
    expect(getAiCapabilities({})).toEqual({ cloudAvailable: false, cloudSource: null, cloudConfigurable: false })
    expect(getCloudAiConfig({ NERION_OPENAI_API_KEY: 'key-only' })).toBeNull()
    expect(getCloudAiConfig({ NERION_OPENAI_PROMPT_ID: 'prompt-only' })).toBeNull()
    expect(normalizeAiMode('cloud', {})).toBe('ollama')
  })

  it('accepts runtime-only credentials without requiring a bundled Vite value', () => {
    const env = {
      NERION_OPENAI_API_KEY: 'runtime-key',
      NERION_OPENAI_PROMPT_ID: 'pmpt_runtime',
      NERION_OPENAI_PROMPT_VERSION: '7',
    }

    expect(getCloudAiConfig(env)).toEqual({
      apiKey: 'runtime-key',
      promptId: 'pmpt_runtime',
      promptVersion: '7',
    })
    expect(getAiCapabilities(env)).toEqual({ cloudAvailable: true, cloudSource: 'runtime', cloudConfigurable: false })
    expect(normalizeAiMode('cloud', env)).toBe('cloud')
  })

  it('accepts a user-managed credential without a runtime secret', () => {
    expect(getAiCapabilities({}, true, true)).toEqual({
      cloudAvailable: true,
      cloudSource: 'user',
      cloudConfigurable: true,
    })
    expect(normalizeAiMode('cloud', {}, true)).toBe('cloud')
  })

  it('normalizes unknown modes to local AI', () => {
    expect(normalizeAiMode('something-else', {})).toBe('ollama')
    expect(normalizeAiMode(undefined, {})).toBe('ollama')
  })
})
