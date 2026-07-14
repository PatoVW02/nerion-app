import { closeSync, openSync, readSync } from 'node:fs'

const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c
const PE_MACHINE_X64 = 0x8664
const PE_MACHINE_ARM64 = 0xaa64

function expectedMachCpu(architecture: string): number | null {
  if (architecture === 'x64') return CPU_TYPE_X86_64
  if (architecture === 'arm64') return CPU_TYPE_ARM64
  return null
}

function machArchitectures(buffer: Buffer): Set<number> {
  const result = new Set<number>()
  if (buffer.length < 8) return result

  // Thin Mach-O files use host-endian headers. Reading the common little-
  // endian magic as LE produces MH_MAGIC_64 (0xfeedfacf).
  const magicLe = buffer.readUInt32LE(0)
  if (magicLe === 0xfeedfacf) {
    result.add(buffer.readUInt32LE(4))
    return result
  }
  if (magicLe === 0xcffaedfe) {
    result.add(buffer.readUInt32BE(4))
    return result
  }

  const magicBe = buffer.readUInt32BE(0)
  const fat64 = magicBe === 0xcafebabf || magicBe === 0xbfbafeca
  const fat32 = magicBe === 0xcafebabe || magicBe === 0xbebafeca
  if (!fat32 && !fat64) return result
  const swapped = magicBe === 0xbebafeca || magicBe === 0xbfbafeca
  const read32 = (offset: number) => swapped ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
  const count = read32(4)
  const entrySize = fat64 ? 32 : 20
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * entrySize
    if (offset + 4 > buffer.length) break
    result.add(read32(offset))
  }
  return result
}

function peArchitecture(buffer: Buffer): number | null {
  if (buffer.length < 64 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return null
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset + 6 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null
  return buffer.readUInt16LE(peOffset + 4)
}

export function scannerBinaryBufferIsCompatible(
  buffer: Buffer,
  nodePlatform: NodeJS.Platform,
  architecture: string,
): boolean {
  if (nodePlatform === 'darwin') {
    const expected = expectedMachCpu(architecture)
    return expected !== null && machArchitectures(buffer).has(expected)
  }
  if (nodePlatform === 'win32') {
    const expected = architecture === 'x64' ? PE_MACHINE_X64 : architecture === 'arm64' ? PE_MACHINE_ARM64 : null
    return expected !== null && peArchitecture(buffer) === expected
  }
  return true
}

export function scannerBinaryIsCompatible(
  filePath: string,
  nodePlatform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): boolean {
  let descriptor: number | null = null
  try {
    descriptor = openSync(filePath, 'r')
    const header = Buffer.alloc(4096)
    const bytesRead = readSync(descriptor, header, 0, header.length, 0)
    return scannerBinaryBufferIsCompatible(header.subarray(0, bytesRead), nodePlatform, architecture)
  } catch {
    return false
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch { /* descriptor already closed */ }
    }
  }
}
