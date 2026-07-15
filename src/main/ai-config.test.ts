import { describe, expect, it } from 'vitest'
import { DEFAULT_CLOUD_AI_ENDPOINT, getAiCapabilities, getCloudAiConfig, normalizeAiMode } from './ai-config'

describe('Nerion Cloud AI configuration', () => {
  it('uses the first-party service without requiring a desktop API key', () => {
    expect(getCloudAiConfig({})).toEqual({ endpoint: DEFAULT_CLOUD_AI_ENDPOINT })
    expect(getAiCapabilities()).toEqual({
      cloudAvailable: true,
      cloudSource: 'service',
      cloudConfigurable: false,
    })
    expect(normalizeAiMode('cloud')).toBe('cloud')
  })

  it('accepts a secure runtime endpoint override for staging', () => {
    expect(getCloudAiConfig({ NERION_CLOUD_AI_ENDPOINT: 'https://preview.nerionapp.com/api/ai/analyze' })).toEqual({
      endpoint: 'https://preview.nerionapp.com/api/ai/analyze',
    })
    expect(getCloudAiConfig({ NERION_CLOUD_AI_ENDPOINT: 'http://localhost:3000/api/ai/analyze' })).toEqual({
      endpoint: 'http://localhost:3000/api/ai/analyze',
    })
  })

  it('falls back to production for insecure or credential-bearing overrides', () => {
    expect(getCloudAiConfig({ NERION_CLOUD_AI_ENDPOINT: 'http://example.com/analyze' })).toEqual({ endpoint: DEFAULT_CLOUD_AI_ENDPOINT })
    expect(getCloudAiConfig({ NERION_CLOUD_AI_ENDPOINT: 'https://user:pass@example.com/analyze' })).toEqual({ endpoint: DEFAULT_CLOUD_AI_ENDPOINT })
  })

  it('normalizes unknown modes to local AI', () => {
    expect(normalizeAiMode('something-else')).toBe('ollama')
    expect(normalizeAiMode(undefined)).toBe('ollama')
  })
})
