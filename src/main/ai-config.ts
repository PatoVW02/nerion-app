export type AiMode = 'cloud' | 'ollama'

import type { AiCapabilities } from '../shared/contracts'

export interface CloudAiConfig {
  apiKey: string
  promptId: string
  promptVersion: string
}

/**
 * Cloud credentials are intentionally read only at runtime. Never use VITE_*
 * variables here: Vite replaces those values in the packaged JavaScript.
 */
export function getCloudAiConfig(env: NodeJS.ProcessEnv = process.env): CloudAiConfig | null {
  const apiKey = env.NERION_OPENAI_API_KEY?.trim() ?? ''
  const promptId = env.NERION_OPENAI_PROMPT_ID?.trim() ?? ''
  if (!apiKey || !promptId) return null

  return {
    apiKey,
    promptId,
    promptVersion: env.NERION_OPENAI_PROMPT_VERSION?.trim() || '1',
  }
}

export function getAiCapabilities(env: NodeJS.ProcessEnv = process.env): AiCapabilities {
  return { cloudAvailable: getCloudAiConfig(env) !== null }
}

export function normalizeAiMode(mode: unknown, env: NodeJS.ProcessEnv = process.env): AiMode {
  return mode === 'cloud' && getAiCapabilities(env).cloudAvailable ? 'cloud' : 'ollama'
}
