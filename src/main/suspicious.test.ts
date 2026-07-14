import { describe, expect, it, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ScanEntryV1 } from '../shared/contracts'
import {
  classifyLaunchConfiguration,
  classifyMasqueradingName,
  extractLaunchTarget,
  getSuspiciousPersistenceRoots,
  inspectMasqueradingEntry,
  isRiskyPersistenceTarget,
  suspiciousTesting,
} from './suspicious'

function entry(name: string, itemPath = `/Users/test/Downloads/${name}`): ScanEntryV1 {
  return {
    protocolVersion: 1,
    event: 'entry',
    scanId: 'scan-test',
    rootId: 'root-test',
    name,
    path: itemPath,
    allocatedBytes: 4096,
    sizeKB: 4,
    isDir: false,
    device: '1',
    inode: '2',
    hardlinkDuplicate: false,
  }
}

describe('local suspicious file evidence', () => {
  it('flags document-like double extensions but suppresses ordinary executables and documents', () => {
    expect(classifyMasqueradingName('invoice.pdf.exe').map((item) => item.code)).toContain('double-extension')
    expect(classifyMasqueradingName('setup.exe')).toEqual([])
    expect(classifyMasqueradingName('invoice.pdf')).toEqual([])
  })

  it('flags an executable name containing a bidirectional text control', () => {
    const evidence = classifyMasqueradingName('photo\u202egnp.exe')
    expect(evidence.map((item) => item.code)).toContain('bidi-control')
  })

  it('creates an elevated finding without classifying it as malware', () => {
    const finding = inspectMasqueradingEntry(entry('invoice.pdf.exe'), 'macos')
    expect(finding).toMatchObject({
      category: 'masquerading-file',
      risk: 'elevated',
      path: '/Users/test/Downloads/invoice.pdf.exe',
    })
    expect(finding?.summary.toLocaleLowerCase('en-US')).not.toContain('malware')
  })
})

describe('background persistence review', () => {
  it('uses only known startup locations for each supported platform', () => {
    expect(getSuspiciousPersistenceRoots('macos', '/Users/test')).toEqual([
      '/Users/test/Library/LaunchAgents',
      '/Library/LaunchAgents',
      '/Library/LaunchDaemons',
    ])
    expect(getSuspiciousPersistenceRoots('windows', 'C:\\Users\\Test', {
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      ProgramData: 'C:\\ProgramData',
    })).toEqual([
      'C:\\Users\\Test\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
    ])
  })

  it('extracts the payload behind a trusted interpreter', () => {
    expect(extractLaunchTarget({
      Program: '/bin/zsh',
      ProgramArguments: ['/bin/zsh', '-c', '/Users/test/Downloads/run.sh'],
    }, '/Users/test')).toBe('/Users/test/Downloads/run.sh')
  })

  it('recognizes user-writable temporary persistence targets', () => {
    expect(isRiskyPersistenceTarget('/Users/test/Downloads/run.sh', '/Users/test', 'macos')).toBe(true)
    expect(isRiskyPersistenceTarget('/Applications/Acme.app/Contents/MacOS/Acme', '/Users/test', 'macos')).toBe(false)
  })

  it('suppresses Apple launch items', async () => {
    const probe = vi.fn(async () => ({ exists: true, unsignedExecutable: false }))
    const finding = await classifyLaunchConfiguration(
      { path: '/Library/LaunchAgents/com.apple.test.plist', name: 'com.apple.test.plist', allocatedBytes: 4096, sizeKB: 4 },
      { Label: 'com.apple.test', Program: '/usr/bin/true' },
      '/Users/test',
      probe,
    )
    expect(finding).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('elevates an autorun item targeting Downloads and explains the evidence', async () => {
    const finding = await classifyLaunchConfiguration(
      { path: '/Users/test/Library/LaunchAgents/com.acme.update.plist', name: 'com.acme.update.plist', allocatedBytes: 4096, sizeKB: 4 },
      {
        Label: 'com.acme.update',
        Program: '/bin/zsh',
        ProgramArguments: ['/bin/zsh', '/Users/test/Downloads/update.sh'],
        RunAtLoad: true,
      },
      '/Users/test',
      async () => ({ exists: true, unsignedExecutable: false }),
    )
    expect(finding?.risk).toBe('elevated')
    expect(finding?.targetPath).toBe('/Users/test/Downloads/update.sh')
    expect(finding?.evidence.map((item) => item.code)).toEqual(expect.arrayContaining([
      'startup-location',
      'autorun',
      'risky-target',
    ]))
  })

  it('elevates a stale launch item whose target no longer exists', async () => {
    const finding = await classifyLaunchConfiguration(
      { path: '/Library/LaunchDaemons/com.acme.stale.plist', name: 'com.acme.stale.plist', allocatedBytes: 4096, sizeKB: 4 },
      { Label: 'com.acme.stale', Program: '/Applications/Missing.app/Contents/MacOS/Missing' },
      '/Users/test',
      async () => ({ exists: false, unsignedExecutable: false }),
    )
    expect(finding?.risk).toBe('elevated')
    expect(finding?.evidence.map((item) => item.code)).toContain('missing-target')
  })

  it('reports a symbolic launch registration without following it', async () => {
    if (process.platform === 'win32') return
    const temporaryHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'nerion-security-'))
    const launchRoot = path.join(temporaryHome, 'Library', 'LaunchAgents')
    const target = path.join(temporaryHome, 'outside.plist')
    const link = path.join(launchRoot, 'com.example.link.plist')
    try {
      await fsp.mkdir(launchRoot, { recursive: true })
      await fsp.writeFile(target, 'This target must not be parsed')
      await fsp.symlink(target, link)
      const result = await suspiciousTesting.inspectMacPersistenceRoot(launchRoot, temporaryHome)
      expect(result.complete).toBe(true)
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0]).toMatchObject({
        path: link,
        category: 'background-item',
        risk: 'review',
        targetPath: null,
      })
      expect(result.findings[0].evidence.map((item) => item.code)).toContain('invalid-config')
    } finally {
      await fsp.rm(temporaryHome, { recursive: true, force: true })
    }
  })
})
