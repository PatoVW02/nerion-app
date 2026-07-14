import { describe, expect, it } from 'vitest'
import { scannerBinaryBufferIsCompatible } from './binary-compat'

function thinMach(cpuType: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeUInt32LE(0xfeedfacf, 0)
  buffer.writeUInt32LE(cpuType, 4)
  return buffer
}

function universalMach(...cpuTypes: number[]): Buffer {
  const buffer = Buffer.alloc(8 + cpuTypes.length * 20)
  buffer.writeUInt32BE(0xcafebabe, 0)
  buffer.writeUInt32BE(cpuTypes.length, 4)
  cpuTypes.forEach((cpuType, index) => buffer.writeUInt32BE(cpuType, 8 + index * 20))
  return buffer
}

function pe(machine: number): Buffer {
  const buffer = Buffer.alloc(256)
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(128, 0x3c)
  buffer.write('PE\0\0', 128, 'ascii')
  buffer.writeUInt16LE(machine, 132)
  return buffer
}

describe('native scanner architecture compatibility', () => {
  it('rejects an Intel-only scanner on Apple Silicon', () => {
    expect(scannerBinaryBufferIsCompatible(thinMach(0x01000007), 'darwin', 'arm64')).toBe(false)
    expect(scannerBinaryBufferIsCompatible(thinMach(0x01000007), 'darwin', 'x64')).toBe(true)
  })

  it('accepts either architecture in a universal Mach-O scanner', () => {
    const buffer = universalMach(0x01000007, 0x0100000c)
    expect(scannerBinaryBufferIsCompatible(buffer, 'darwin', 'arm64')).toBe(true)
    expect(scannerBinaryBufferIsCompatible(buffer, 'darwin', 'x64')).toBe(true)
  })

  it('validates Windows PE machine types', () => {
    expect(scannerBinaryBufferIsCompatible(pe(0x8664), 'win32', 'x64')).toBe(true)
    expect(scannerBinaryBufferIsCompatible(pe(0x8664), 'win32', 'arm64')).toBe(false)
  })
})
