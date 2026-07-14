import { describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { leftoverTesting } from './leftovers'

describe('leftover identity matching', () => {
  it('normalizes app-group and team-prefixed bundle identifiers', () => {
    expect(leftoverTesting.normalizeBundleId('group.com.example.Widget')).toBe('com.example.widget')
    expect(leftoverTesting.normalizeBundleId('AB12CD34EF.com.example.Widget')).toBe('com.example.widget')
    expect(leftoverTesting.normalizeBundleId('AB12CD34EF.Office')).toBeNull()
    expect(leftoverTesting.artifactIdentity('AB12CD34EF.Office').bundleId).toBeNull()
  })

  it('suppresses Apple and generic system artifacts', () => {
    expect(leftoverTesting.isSystemOwned(leftoverTesting.artifactIdentity('com.apple.Safari.plist'))).toBe(true)
    expect(leftoverTesting.artifactIdentity('Caches').strong).toBe(false)
    expect(leftoverTesting.isSystemOwned(
      leftoverTesting.artifactIdentity('Photoshop'),
      new Set(['photos']),
    )).toBe(false)
    expect(leftoverTesting.isSystemOwned(leftoverTesting.artifactIdentity('CallHistoryDB'))).toBe(true)
    expect(leftoverTesting.isSystemOwned(leftoverTesting.artifactIdentity('org.swift.swiftpm'))).toBe(true)
  })

  it('suppresses developer-tool caches that are not application identities', () => {
    expect(leftoverTesting.isNonApplicationArtifact(
      'claude-cli-nodejs',
      leftoverTesting.artifactIdentity('claude-cli-nodejs'),
    )).toBe(true)
    expect(leftoverTesting.isNonApplicationArtifact(
      'com.github.Electron.plist',
      leftoverTesting.artifactIdentity('com.github.Electron.plist'),
    )).toBe(true)
  })

  it('treats exact bundle IDs and structured helper IDs as installed conflicts', () => {
    const installed = [{
      sourcePath: '/Applications/Widget.app',
      bundleIds: new Set(['com.example.widget']),
      names: new Set(['widget']),
      tokens: new Set(['example', 'widget']),
    }]
    expect(leftoverTesting.installedConflicts(leftoverTesting.artifactIdentity('com.example.widget.plist'), installed)).toHaveLength(1)
    expect(leftoverTesting.installedConflicts(leftoverTesting.artifactIdentity('com.example.widget.helper'), installed)).toHaveLength(1)
    expect(leftoverTesting.installedConflicts(leftoverTesting.artifactIdentity('com.other.widgetizer'), installed)).toHaveLength(0)
  })

  it('suppresses an exact shared vendor folder when one of that vendor’s apps is installed', () => {
    const installed = [{
      sourcePath: '/Applications/Adobe Photoshop.app',
      bundleIds: new Set(['com.adobe.photoshop']),
      names: new Set(['adobephotoshop']),
      tokens: new Set(['adobe', 'photoshop']),
    }]
    expect(leftoverTesting.installedConflicts(leftoverTesting.artifactIdentity('Adobe'), installed)).toHaveLength(1)
  })

  it('suppresses camel-cased vendor folders and exact installed app-group entitlements', () => {
    const installed = [{
      sourcePath: '/Applications/Portal.app',
      bundleIds: new Set(['app.portal.ios.v1', 'app.portal.prod']),
      names: new Set(['portal']),
      tokens: new Set(['portal']),
    }, {
      sourcePath: '/Applications/Brave Browser.app',
      bundleIds: new Set(['com.brave.browser']),
      names: new Set(['bravebrowser']),
      tokens: new Set(['brave', 'browser']),
    }]
    expect(leftoverTesting.installedConflicts(
      leftoverTesting.artifactIdentity('U355UULQVV.app.portal.prod'),
      installed,
    )).toHaveLength(1)
    expect(leftoverTesting.installedConflicts(
      leftoverTesting.artifactIdentity('BraveSoftware'),
      installed,
    )).toHaveLength(1)

    const logiInstalled = [{
      sourcePath: '/Applications/logioptionsplus.app',
      bundleIds: new Set(['com.logi.optionsplus']),
      names: new Set(['logioptionsplus']),
      tokens: new Set(['logi', 'optionsplus']),
    }]
    expect(leftoverTesting.installedConflicts(
      leftoverTesting.artifactIdentity('com.logi.cp-dev-mgr.plist'),
      logiInstalled,
    )).toHaveLength(1)
    expect(leftoverTesting.installedConflicts(
      leftoverTesting.artifactIdentity('Logitech.localized'),
      logiInstalled,
    )).toHaveLength(1)
  })

  it('groups independent artifacts only through exact names or multiple strong tokens', () => {
    const bundleArtifact = leftoverTesting.artifactIdentity('com.google.Chrome.plist')
    const namedArtifact = leftoverTesting.artifactIdentity('Google Chrome')
    const ambiguousArtifact = leftoverTesting.artifactIdentity('Chrome Cache')
    expect(leftoverTesting.identitiesBelongTogether(bundleArtifact, namedArtifact)).toBe(true)
    expect(leftoverTesting.identitiesBelongTogether(bundleArtifact, ambiguousArtifact)).toBe(false)
  })

  it('does not merge unrelated structured identities through generic leaves or vendor namespaces', () => {
    expect(leftoverTesting.identitiesBelongTogether(
      leftoverTesting.artifactIdentity('homebrew.mxcl.mongodb-community.plist'),
      leftoverTesting.artifactIdentity('homebrew.mxcl.postgresql.plist'),
    )).toBe(false)
    expect(leftoverTesting.identitiesBelongTogether(
      leftoverTesting.artifactIdentity('com.google.Keystone.Agent.plist'),
      leftoverTesting.artifactIdentity('com.logitech.LogiRightSight.Agent.plist'),
    )).toBe(false)
  })

  it('does not treat ordinary two-part database filenames as authoritative bundle IDs', () => {
    expect(leftoverTesting.artifactIdentity('default.store').bundleId).toBeNull()
    expect(leftoverTesting.artifactIdentity('default.store-wal').bundleId).toBeNull()
  })

  it('suppresses a weak name-only cache but keeps structured or multi-location evidence', () => {
    const identity = leftoverTesting.artifactIdentity('PossibleApp')
    const cacheArtifact = {
      path: '/tmp/PossibleApp',
      name: 'PossibleApp',
      location: 'Caches',
      isDir: true,
      allocatedBytes: 1024,
      sizeKB: 1,
      sizeComplete: true,
    }
    expect(leftoverTesting.shouldEmitGroup(identity, [cacheArtifact])).toBe(false)
    expect(leftoverTesting.shouldEmitGroup(identity, [
      cacheArtifact,
      { ...cacheArtifact, path: '/tmp/support/PossibleApp', location: 'Application Support' },
    ])).toBe(true)
    expect(leftoverTesting.shouldEmitGroup(
      leftoverTesting.artifactIdentity('com.example.PossibleApp'),
      [cacheArtifact],
    )).toBe(true)
  })

  it('downgrades findings when the installed inventory is incomplete and records permission failures', () => {
    const identity = leftoverTesting.artifactIdentity('com.example.Uninstalled')
    expect(leftoverTesting.leftoverConfidence(identity, 2, true)).toBe('recommended')
    expect(leftoverTesting.leftoverConfidence(identity, 2, false)).toBe('review')

    const audit = { inaccessiblePaths: new Set<string>(), timedOut: false }
    leftoverTesting.recordInventoryReadFailure('/Applications/Restricted', { code: 'EACCES' }, audit)
    leftoverTesting.recordInventoryReadFailure('/Applications/Missing', { code: 'ENOENT' }, audit)
    expect([...audit.inaccessiblePaths]).toEqual(['/Applications/Restricted'])
  })

  it('stops installed-app identity work when the scan deadline has elapsed', async () => {
    let calls = 0
    const result = await leftoverTesting.mapWithConcurrencyUntil(
      ['one', 'two', 'three'],
      2,
      Date.now() - 1,
      async (value) => {
        calls += 1
        return value
      },
    )

    expect(result).toEqual({ results: [], timedOut: true })
    expect(calls).toBe(0)
  })

  it('preserves the actual filesystem kind for artifact review and deletion', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nerion-leftover-kind-'))
    const directory = path.join(root, 'com.example.folder')
    const file = path.join(root, 'com.example.data.db')
    try {
      await fsp.mkdir(directory)
      await fsp.writeFile(file, 'fixture')
      const inaccessible = new Set<string>()
      const [directoryArtifact, fileArtifact] = await Promise.all([
        leftoverTesting.measureArtifact(directory, 'Test', inaccessible, Date.now() + 5000),
        leftoverTesting.measureArtifact(file, 'Test', inaccessible, Date.now() + 5000),
      ])
      expect(directoryArtifact.isDir).toBe(true)
      expect(fileArtifact.isDir).toBe(false)
      expect(inaccessible).toEqual(new Set())

      await fsp.writeFile(path.join(directory, 'nested-data'), 'nested fixture')
      const containerArtifact = await leftoverTesting.measureArtifact(
        directory,
        'Containers',
        inaccessible,
        Date.now() + 5000,
      )
      expect(containerArtifact.isDir).toBe(true)
      expect(containerArtifact.sizeComplete).toBe(false)
      expect(containerArtifact.allocatedBytes).toBeLessThan(directoryArtifact.allocatedBytes + 4096)
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
})
