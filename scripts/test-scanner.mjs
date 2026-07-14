import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = new URL('..', import.meta.url).pathname
const binary = process.env.NERION_SCANNER_BINARY
  ?? join(projectRoot, 'native', 'scanner-rs', 'target', 'debug', process.platform === 'win32' ? 'scanner-bin.exe' : 'scanner-bin')
const fixture = mkdtempSync(join(tmpdir(), 'nerion-scanner-'))

try {
  const nested = join(fixture, 'unicode-ñ')
  mkdirSync(nested)
  const unusual = join(nested, 'tab\tline\nname.txt')
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
  assert.ok(entries.some((entry) => entry.path === unusual), 'newline/tab path must round-trip through JSON')
  assert.ok(entries.some((entry) => entry.path === hardlink && entry.hardlinkDuplicate === true), 'hard link must be deduplicated')
  assert.ok(!entries.some((entry) => entry.path.endsWith('ignored-symlink')), 'symlinks must not be followed or emitted')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
