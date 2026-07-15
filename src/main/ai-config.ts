export type AiMode = 'cloud' | 'ollama'

import type { AiCapabilities } from '../shared/contracts'

export interface CloudAiConfig {
  endpoint: string
}

export const DEFAULT_CLOUD_AI_ENDPOINT = 'https://nerionapp.com/api/ai/analyze'

/**
 * The endpoint is public configuration; the OpenAI key and saved-prompt ID
 * live only on Nerion's server. A runtime override exists for local testing.
 */
export function getCloudAiConfig(env: NodeJS.ProcessEnv = process.env): CloudAiConfig {
  const candidate = env.NERION_CLOUD_AI_ENDPOINT?.trim() || DEFAULT_CLOUD_AI_ENDPOINT
  try {
    const url = new URL(candidate)
    const localDevelopment = (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.protocol === 'http:'
    if (url.protocol !== 'https:' && !localDevelopment) throw new Error('insecure endpoint')
    if (url.username || url.password || url.search || url.hash) throw new Error('invalid endpoint')
    return { endpoint: url.toString() }
  } catch {
    return { endpoint: DEFAULT_CLOUD_AI_ENDPOINT }
  }
}

export function getAiCapabilities(): AiCapabilities {
  return {
    cloudAvailable: true,
    cloudSource: 'service',
    cloudConfigurable: false,
  }
}

export function normalizeAiMode(mode: unknown): AiMode {
  return mode === 'cloud' ? 'cloud' : 'ollama'
}
