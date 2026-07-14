import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const binary = process.env.NERION_SCANNER_BINARY
  ?? join(projectRoot, 'native', 'scanner-rs', 'target', 'debug', process.platform === 'win32' ? 'scanner-bin.exe' : 'scanner-bin')
const fixture = mkdtempSync(join(tmpdir(), 'nerion-scanner-'))

try {
  const nested = join(fixture, 'unicode-ñ')
  mkdirSync(nested)
  // NTFS rejects control characters in file names. Unix integration still
  // verifies tab/newline round-tripping, while Windows exercises Unicode,
  // hard-link identity, and the same JSONL protocol with a legal native name.
  const unusualName = process.platform === 'win32' ? 'unusual-ñame.txt' : 'tab\tline\nname.txt'
  const unusual = join(nested, unusualName)
  const hardlink = join(nested, 'hardlink.txt')
  writeFileSync(unusual, 'scanner protocol fixture')
  linkSync(unusual, hardlink)
  if (process.platform !== 'win32') symlinkSync(unusual, join(nested, 'ignored-symlink'))

  const output = execFileSync(binary, [fixture, 'integration-scan', 'root-fixture'], { encoding: 'utf8' })
  const events = output.trim().split('\n').map((line) => JSON.parse(line))
  const entries = events.filter((event) => event.event === 'entry')
  const summary = events.at(-1)

  assert.equal(summary.event, 'summary')
  assert.equal(summary.scanId, 'integration-scan')
  assert.equal(summary.rootId, 'root-fixture')
  assert.equal(summary.complete, true)
  assert.ok(entries.some((entry) => entry.path === unusual), 'native Unicode path must round-trip through JSON')
  const linkedEntries = entries.filter((entry) => entry.path === unusual || entry.path === hardlink)
  assert.equal(linkedEntries.length, 2, 'both hard-link names must be reported')
  assert.equal(linkedEntries.filter((entry) => entry.hardlinkDuplicate === true).length, 1, 'exactly one hard-link name must be deduplicated')
  assert.equal(linkedEntries.find((entry) => entry.hardlinkDuplicate === true)?.allocatedBytes, 0, 'the duplicate must not be double-counted')
  assert.equal(new Set(linkedEntries.map((entry) => `${entry.device}:${entry.inode}`)).size, 1, 'hard-link names must share one native identity')
  assert.ok(!entries.some((entry) => entry.path.endsWith('ignored-symlink')), 'symlinks must not be followed or emitted')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
