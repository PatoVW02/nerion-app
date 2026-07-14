import { app, net, safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

interface CloudCredentialEnvelope {
  schemaVersion: 1
  encrypted: string
}

const OPENAI_MODEL = 'gpt-5-mini'
const OPENAI_MODEL_URL = `https://api.openai.com/v1/models/${OPENAI_MODEL}`

function credentialPath(): string {
  return path.join(app.getPath('userData'), 'cloud-ai.json')
}

function parseEnvelope(value: unknown): CloudCredentialEnvelope | null {
  if (!value || typeof value !== 'object') return null
  const envelope = value as Partial<CloudCredentialEnvelope>
  return envelope.schemaVersion === 1 && typeof envelope.encrypted === 'string' && envelope.encrypted.length > 0
    ? { schemaVersion: 1, encrypted: envelope.encrypted }
    : null
}

function normalizeApiKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim()
  if (key.length < 20 || key.length > 512 || /\s|\0/.test(key)) return null
  return key
}

export function canConfigureCloudAi(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function loadCloudAiKey(): string | null {
  if (!canConfigureCloudAi()) return null
  try {
    const envelope = parseEnvelope(JSON.parse(readFileSync(credentialPath(), 'utf8')))
    if (!envelope) return null
    return normalizeApiKey(safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64')))
  } catch {
    return null
  }
}

function saveCloudAiKey(apiKey: string): void {
  if (!canConfigureCloudAi()) throw new Error('Secure credential storage is unavailable on this device.')
  const destination = credentialPath()
  const temporary = `${destination}.tmp`
  mkdirSync(path.dirname(destination), { recursive: true })
  try {
    const envelope: CloudCredentialEnvelope = {
      schemaVersion: 1,
      encrypted: safeStorage.encryptString(apiKey).toString('base64'),
    }
    writeFileSync(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, destination)
  } finally {
    try { unlinkSync(temporary) } catch { /* already moved or never created */ }
  }
}

export function removeCloudAiKey(): void {
  try { unlinkSync(credentialPath()) } catch { /* absent is already removed */ }
}

export async function validateAndSaveCloudAiKey(value: unknown): Promise<void> {
  const apiKey = normalizeApiKey(value)
  if (!apiKey) throw new Error('Enter a valid OpenAI API key.')
  if (!canConfigureCloudAi()) throw new Error('Secure credential storage is unavailable on this device.')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  let response: Response
  try {
    response = await net.fetch(OPENAI_MODEL_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) throw new Error('OpenAI validation timed out. Try again.')
    throw new Error('OpenAI could not be reached. Check your connection and try again.')
  } finally {
    clearTimeout(timeout)
  }

  if (response.status === 401) throw new Error('OpenAI rejected this API key.')
  if (response.status === 403 || response.status === 404) {
    throw new Error(`This OpenAI project cannot use ${OPENAI_MODEL}.`)
  }
  if (!response.ok) throw new Error(`OpenAI validation failed (${response.status}).`)

  // Replacement is atomic and only happens after the new key is validated.
  saveCloudAiKey(apiKey)
}

export const cloudAiTesting = {
  normalizeApiKey,
  saveCloudAiKey,
}

export { OPENAI_MODEL }
