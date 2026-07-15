import { app } from 'electron'
import { unlinkSync } from 'node:fs'
import * as path from 'node:path'

export interface CloudAiRelayPayload {
  name: string
  path: string
  isDirectory: boolean
  size: string
  sizeKB: number
  pathContext: string
  platform: 'macos' | 'windows'
}

export function buildCloudAiRelayRequest(
  authorization: { licenseKey: string; instanceId: string },
  payload: CloudAiRelayPayload,
  appVersion: string,
  signal: AbortSignal,
): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authorization.licenseKey}`,
      'X-Nerion-License-Instance': authorization.instanceId,
      'X-Nerion-App-Version': appVersion,
    },
    body: JSON.stringify(payload),
    signal,
  }
}

export async function cloudAiFailureMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string' && body.error.length > 0 && body.error.length <= 300) return body.error
  } catch {
    // The relay intentionally returns generic errors; never surface an HTML proxy response.
  }
  return response.status === 429
    ? 'Cloud AI is busy. Try again shortly.'
    : `Nerion Cloud AI returned ${response.status}.`
}

function credentialPath(): string {
  return path.join(app.getPath('userData'), 'cloud-ai.json')
}

/** Remove credentials stored by 1.5.1 now that Cloud AI is managed by Nerion. */
export function removeLegacyCloudAiCredential(): void {
  try { unlinkSync(credentialPath()) } catch { /* absent is already removed */ }
}
