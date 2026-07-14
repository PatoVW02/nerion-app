import { describe, expect, it } from 'vitest'
import { compareUpdaterVersions, detectMachOArch } from './updater-policy'

describe('updater architecture detection', () => {
  it('recognizes both 32-bit and 64-bit fat Mach-O headers as universal', () => {
    expect(detectMachOArch(Buffer.from('cafebabe00000002', 'hex'), 'arm64')).toBe('universal')
    expect(detectMachOArch(Buffer.from('cafebabf00000002', 'hex'), 'x64')).toBe('universal')
  })

  it('recognizes little-endian thin arm64 and x64 executables', () => {
    expect(detectMachOArch(Buffer.from('cffaedfe0c000001', 'hex'), 'x64')).toBe('arm64')
    expect(detectMachOArch(Buffer.from('cffaedfe07000001', 'hex'), 'arm64')).toBe('x64')
  })

  it('uses the process fallback for unknown or truncated headers', () => {
    expect(detectMachOArch(Buffer.from('00', 'hex'), 'arm64')).toBe('arm64')
    expect(detectMachOArch(Buffer.alloc(8), 'x64')).toBe('x64')
  })
})

describe('updater version comparison', () => {
  it('orders normal versions without treating 1.10 as 1.1', () => {
    expect(compareUpdaterVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareUpdaterVersions('v1.5', '1.5.0')).toBe(0)
  })

  it('orders prereleases below their stable release', () => {
    expect(compareUpdaterVersions('1.5.0-beta.2', '1.5.0-beta.1')).toBe(1)
    expect(compareUpdaterVersions('1.5.0-beta.2', '1.5.0')).toBe(-1)
    expect(compareUpdaterVersions('1.5.0', '1.5.0-rc.1')).toBe(1)
  })
})
