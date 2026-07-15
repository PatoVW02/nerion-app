#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const outputRoot = resolve(process.cwd(), process.argv[2] ?? 'out')
const forbiddenPatterns = [
  { name: 'Vite OpenAI credential reference', pattern: /VITE_OPENAI_(?:API_KEY|PROMPT_ID|PROMPT_VERSION)/ },
  { name: 'runtime OpenAI credential reference', pattern: /NERION_OPENAI_(?:API_KEY|PROMPT_ID|PROMPT_VERSION)/ },
  { name: 'OpenAI saved prompt identifier', pattern: /\bpmpt_[A-Za-z0-9_-]{8,}\b/ },
  { name: 'OpenAI project/service credential', pattern: /\bsk-(?:proj|svcacc|svcacct)-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'legacy OpenAI credential', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'GitHub credential', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
]

async function collectFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(entryPath))
    else if (entry.isFile()) files.push(entryPath)
  }
  return files
}

try {
  if (!(await stat(outputRoot)).isDirectory()) throw new Error(`${outputRoot} is not a directory`)
  const violations = []
  for (const filePath of await collectFiles(outputRoot)) {
    const contents = await readFile(filePath, 'utf8').catch(() => null)
    if (contents === null) continue
    for (const rule of forbiddenPatterns) {
      if (rule.pattern.test(contents)) {
        violations.push(`${relative(process.cwd(), filePath)}: ${rule.name}`)
      }
    }
  }

  if (violations.length > 0) {
    console.error('Bundled secret verification failed:')
    violations.forEach((violation) => console.error(`- ${violation}`))
    process.exit(1)
  }

  console.log(`Bundled secret verification passed (${relative(process.cwd(), outputRoot) || '.'}).`)
} catch (error) {
  console.error(`Bundled secret verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
