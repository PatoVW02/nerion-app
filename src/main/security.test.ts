import { describe, expect, it } from 'vitest'
import { isAllowedExternalUrl, isTrustedRendererNavigation } from './security'

describe('external URL policy', () => {
  it.each([
    'https://nerion.app/billing',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    'ms-settings:privacy-notifications',
  ])('allows supported external destinations: %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true)
  })

  it.each([
    'http://example.com',
    'file:///tmp/untrusted.html',
    'javascript:alert(1)',
    'data:text/html,hello',
    'mailto:someone@example.com',
    'not a url',
    '',
  ])('rejects unsupported or unsafe destinations: %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false)
  })
})

describe('renderer navigation policy', () => {
  it('allows same-origin development navigation', () => {
    expect(isTrustedRendererNavigation(
      'http://localhost:5173/settings?tab=ai',
      'http://localhost:5173/',
    )).toBe(true)
  })

  it('rejects a different origin or protocol', () => {
    expect(isTrustedRendererNavigation('https://example.com/', 'http://localhost:5173/')).toBe(false)
    expect(isTrustedRendererNavigation('http://127.0.0.1:5173/', 'http://localhost:5173/')).toBe(false)
  })

  it('only allows the packaged renderer document for file navigation', () => {
    const expected = 'file:///Applications/Nerion.app/Contents/Resources/app.asar/out/renderer/index.html'
    expect(isTrustedRendererNavigation(`${expected}#settings`, expected)).toBe(true)
    expect(isTrustedRendererNavigation('file:///tmp/untrusted.html', expected)).toBe(false)
  })
})
