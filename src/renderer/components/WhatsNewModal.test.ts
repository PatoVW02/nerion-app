import { describe, expect, it } from 'vitest'
import changelog from '../whats-new.json'
import { getRelease } from './WhatsNewModal'

describe("What's New release selection", () => {
  it('contains the user-facing 1.5.0 release', () => {
    const release = getRelease('1.5.0')
    expect(release?.version).toBe('1.5.0')
    expect(release?.items.map((item) => item.title)).toEqual([
      'Local Security Review',
      'Smarter App Leftovers',
      'A New Glass Interface',
      'Clearer Cleanup Review',
    ])
  })

  it('falls back to the latest release when the app version is unavailable or newer', () => {
    const latestVersion = changelog.releases[0].version
    expect(getRelease()?.version).toBe(latestVersion)
    expect(getRelease('99.0.0')?.version).toBe(latestVersion)
  })
})
