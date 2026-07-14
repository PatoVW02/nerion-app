export type MacBuildArch = 'universal' | 'arm64' | 'x64'

/** Determine the actual packaged Mach-O architecture from its first 8 bytes. */
export function detectMachOArch(header: Buffer, fallback: 'arm64' | 'x64'): MacBuildArch {
  if (header.length < 8) return fallback

  const magicBe = header.readUInt32BE(0)
  const magicLe = header.readUInt32LE(0)
  // FAT_MAGIC and FAT_MAGIC_64. Electron universal executables can use either.
  if (magicBe === 0xcafebabe || magicBe === 0xcafebabf) return 'universal'

  const isLittleEndian64 = magicLe === 0xfeedfacf
  const isBigEndian64 = magicBe === 0xfeedfacf
  if (isLittleEndian64 || isBigEndian64) {
    const cpuType = isLittleEndian64 ? header.readUInt32LE(4) : header.readUInt32BE(4)
    if (cpuType === 0x0100000c) return 'arm64'
    if (cpuType === 0x01000007) return 'x64'
  }

  return fallback
}

interface ParsedVersion {
  core: number[]
  prerelease: Array<number | string>
}

function parseVersion(value: string): ParsedVersion {
  const normalized = value.trim().replace(/^v/i, '').split('+', 1)[0]
  const [coreValue, prereleaseValue = ''] = normalized.split('-', 2)
  const core = coreValue.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  })
  const prerelease = prereleaseValue
    ? prereleaseValue.split('.').map((part) => /^\d+$/.test(part) ? Number.parseInt(part, 10) : part)
    : []
  return { core, prerelease }
}

/** Small SemVer comparator sufficient for updater metadata, including prereleases. */
export function compareUpdaterVersions(a: string, b: string): number {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)
  const coreLength = Math.max(parsedA.core.length, parsedB.core.length)
  for (let index = 0; index < coreLength; index += 1) {
    const aPart = parsedA.core[index] ?? 0
    const bPart = parsedB.core[index] ?? 0
    if (aPart !== bPart) return aPart > bPart ? 1 : -1
  }

  if (parsedA.prerelease.length === 0 && parsedB.prerelease.length === 0) return 0
  if (parsedA.prerelease.length === 0) return 1
  if (parsedB.prerelease.length === 0) return -1

  const prereleaseLength = Math.max(parsedA.prerelease.length, parsedB.prerelease.length)
  for (let index = 0; index < prereleaseLength; index += 1) {
    const aPart = parsedA.prerelease[index]
    const bPart = parsedB.prerelease[index]
    if (aPart === undefined) return -1
    if (bPart === undefined) return 1
    if (aPart === bPart) continue
    if (typeof aPart === 'number' && typeof bPart === 'string') return -1
    if (typeof aPart === 'string' && typeof bPart === 'number') return 1
    return aPart > bPart ? 1 : -1
  }
  return 0
}
