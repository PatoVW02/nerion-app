import { ipcMain, dialog, shell, net, Notification, app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, readdir } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { scanDirectoryStreaming } from './scanner'
import { loadSettings, saveSettings, patchSettings, VectraSettings } from './settings'
import { rebuildTrayMenu, scheduleBackgroundScan, stopBackgroundScan, runBackgroundScan, updateLastScanPath, setTrayVisibility, testNotification } from './background'
import { getLicenseInfo, activateLicense, revalidateLicense, deactivateLicense } from './license'
import { runAutoUpdateCheck } from './updater'

const execFileAsync = promisify(execFile)

let cancelCurrentScan: (() => void) | null = null

// Ollama state — tracked per active request
let ollamaAbort: AbortController | null = null
let ollamaUserCancelled = false
const FREE_DELETE_LIMIT_PER_MONTH = 15

function currentMonthKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${now.getFullYear()}-${month}`
}

function formatSizeForPrompt(sizeKB: number): string {
  if (sizeKB > 1024 * 1024) return `${(sizeKB / 1024 / 1024).toFixed(1)} GB`
  if (sizeKB > 1024) return `${(sizeKB / 1024).toFixed(1)} MB`
  return `${sizeKB} KB`
}

// Known macOS path descriptions — gives the AI accurate context so it reasons
// correctly about what a path is and whether it is safe to delete.
function getMacOSPathContext(itemPath: string): string {
  const home = os.homedir()
  const normalized = itemPath.replace(/\/+$/, '')

  // Build a lookup of path → human description of what it is and its sensitivity.
  // Ordered from most-specific to least-specific so first match wins.
  const knownPaths: Array<{ match: string | RegExp; description: string }> = [
    // ── root / top-level ──────────────────────────────────────────────────────
    { match: '/', description: 'The root of the macOS file system. Every file on the computer lives inside this directory. Deleting it would make the system completely non-functional.' },

    // ── Core system trees ─────────────────────────────────────────────────────
    { match: '/System', description: 'Contains the core macOS operating system files managed exclusively by Apple. Nothing in here should ever be deleted; doing so would make the Mac unbootable.' },
    { match: '/System/Library', description: 'Houses frameworks, kernel extensions, and system-level resources required by macOS. Deleting anything here will break the operating system.' },
    { match: '/Library', description: 'System-wide support files, fonts, preferences, and extensions installed for all users. Many items here are required for apps and system features to work.' },
    { match: '/Applications', description: 'The standard install location for all macOS applications. Deleting this folder removes every app on the machine.' },
    { match: '/usr', description: 'UNIX system resources including compilers, libraries, and command-line tools used by macOS and developer tools. Removing it breaks the system and all developer toolchains.' },
    { match: '/usr/bin', description: 'Essential UNIX command-line binaries (e.g. python3, ruby, git wrappers) used by macOS internals and developer tools. Deleting this breaks the system shell environment.' },
    { match: '/usr/lib', description: 'Shared system libraries that macOS and applications link against at runtime. Removing them causes apps and system services to crash.' },
    { match: '/usr/local', description: 'User-installed UNIX tools (e.g. Homebrew packages, manual installs). Safer than /usr/bin but still contains tools that scripts and apps may depend on.' },
    { match: '/bin', description: 'Fundamental UNIX shell commands (ls, cp, mv, bash, etc.) required for the system to boot and operate. Deleting this makes the Mac unbootable.' },
    { match: '/sbin', description: 'System administration binaries used during boot and by macOS daemons. Deleting this prevents the system from starting correctly.' },
    { match: '/etc', description: 'Symbolic link to /private/etc. Contains system-wide configuration files for networking, user accounts, and services. Removing it breaks system configuration.' },
    { match: '/private/etc', description: 'System-wide configuration files: /etc/hosts, /etc/passwd, network settings, and more. These files are required for macOS to configure itself on every boot.' },
    { match: '/var', description: 'Symbolic link to /private/var. Contains dynamic system data: logs, caches, databases, and temporary files that macOS writes to constantly while running.' },
    { match: '/private/var', description: 'Holds variable system data including log files, system caches, the user database, and runtime state. Many system services write here continuously.' },
    { match: '/private/tmp', description: 'Temporary files created by the operating system and apps. macOS clears this automatically; individual temp files are safe to delete but the folder itself must remain.' },
    { match: '/private', description: 'Contains the real /etc, /var, and /tmp directories that their root-level symlinks point to. This entire tree is managed by macOS.' },
    { match: '/Volumes', description: 'Mount point for all connected drives and disk images. This folder itself must not be deleted; the drives mounted inside it are independent.' },
    { match: '/Network', description: 'Legacy mount point for network resources on macOS. Managed by the system.' },
    { match: '/cores', description: 'Stores crash core dump files generated when processes crash. Individual dump files are safe to delete to recover space, but the folder is managed by macOS.' },

    // ── User home directory ───────────────────────────────────────────────────
    { match: /^\/Users\/[^/]+$/, description: 'A user home directory — contains every file, setting, and document belonging to that macOS user account. Deleting it permanently destroys all of that user\'s personal data.' },
    { match: '/Users', description: 'The parent folder for every user account on this Mac. Deleting it would wipe all user data for every account on the system.' },
    { match: home, description: 'Your personal home directory. It contains all your documents, settings, application data, and personal files. Deleting it would permanently destroy all your personal data.' },
    { match: `${home}/Library`, description: 'Stores all per-user application support data, preferences, caches, and saved states. Deleting it would reset or break every app installed for this user.' },
    { match: `${home}/Library/Preferences`, description: 'Contains .plist preference files for every app installed for this user. Deleting individual plists resets that app\'s settings; deleting the folder resets all apps.' },
    { match: `${home}/Library/Application Support`, description: 'Stores persistent app data such as databases, saved states, and user content created by applications. Deleting items here may cause permanent data loss for those apps.' },
    { match: `${home}/Library/Keychains`, description: 'Holds the user\'s keychain files which store saved passwords, certificates, and secure credentials. Deleting this causes loss of all saved passwords.' },
    { match: `${home}/Library/Mail`, description: 'Contains the local database and downloaded messages for the Mail app. Deleting it removes all locally stored emails.' },
    { match: `${home}/Library/Messages`, description: 'Stores the local history for iMessage and SMS conversations synced from iPhone. Deleting it erases your local message history.' },
    { match: `${home}/Library/Caches`, description: 'Application cache files for the current user. These are regenerated automatically and are generally safe to delete to recover disk space.' },
    { match: `${home}/Library/Logs`, description: 'Log files written by user-level apps and processes. Generally safe to delete; apps will recreate them as needed.' },
    { match: `${home}/Documents`, description: 'The standard folder for user documents and files. Contains personal data created by the user — deleting it causes irreversible data loss.' },
    { match: `${home}/Desktop`, description: 'Files and folders the user has placed on the desktop. Contains personal data — deleting it causes data loss.' },
    { match: `${home}/Downloads`, description: 'Files downloaded from the internet and other sources. Contents are generally user-managed but may include important files the user has not yet organized.' },
    { match: `${home}/Movies`, description: 'The standard location for video projects and movie files, including Final Cut Pro and iMovie libraries. Contains personal media — deleting causes data loss.' },
    { match: `${home}/Music`, description: 'Stores the Music app library and iTunes data including purchased music and playlists. Deleting it removes your music library.' },
    { match: `${home}/Pictures`, description: 'Contains the Photos app library and other image files. The Photos library holds your entire photo collection — deleting it causes permanent data loss.' },
    { match: `${home}/Applications`, description: 'User-specific application installs (installed only for this user rather than system-wide). Removing it uninstalls those apps for this user.' },
  ]

  for (const entry of knownPaths) {
    const hit = typeof entry.match === 'string'
      ? normalized === entry.match || normalized.startsWith(entry.match + '/')
      : entry.match.test(normalized)
    if (hit) return entry.description
  }

  // Generic context based on well-known path segments
  if (normalized.startsWith(`${home}/Library/Caches`)) {
    return 'An application cache directory inside the user Library. Cache files are temporary and regenerated automatically — safe to delete to recover space.'
  }
  if (normalized.startsWith(`${home}/Library/`)) {
    return 'A subdirectory inside the user Library folder, which stores per-user application data, preferences, and support files.'
  }
  if (normalized.startsWith('/Library/Caches')) {
    return 'System-wide application cache files. Generally safe to delete; apps and the OS will recreate them as needed.'
  }
  if (normalized.startsWith('/Library/')) {
    return 'A subdirectory inside the system Library, which stores system-wide application support files, fonts, and configuration data.'
  }

  return ''
}

async function pickOllamaModel(): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await net.fetch('http://localhost:11434/api/tags', { signal: controller.signal })
    if (!res.ok) throw new Error(`Ollama responded with ${res.status}`)
    const data = (await res.json()) as { models?: { name: string }[] }
    const models = data.models ?? []
    if (models.length === 0) {
      throw new Error('No models installed in Ollama. Run: ollama pull llama3.2')
    }
    // Honour user's preferred model if it's installed
    const { preferredOllamaModel } = loadSettings()
    if (preferredOllamaModel) {
      const found = models.find(
        (m) => m.name === preferredOllamaModel || m.name.startsWith(preferredOllamaModel + ':')
      )
      if (found) return found.name
    }
    const preferred = ['llama3.2', 'llama3.1', 'llama3', 'mistral', 'gemma2', 'gemma']
    for (const pref of preferred) {
      const found = models.find((m) => m.name.startsWith(pref))
      if (found) return found.name
    }
    return models[0].name
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch') || msg.includes('Failed')) {
      throw new Error('Ollama is not running. Start it with: ollama serve')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

let pullAbort: AbortController | null = null

// ── App leftover detection ────────────────────────────────────────────────────

// Locations under ~/Library that commonly hold per-app data
const LEFTOVER_LOCATIONS = [
  path.join('Library', 'Application Support'),
  path.join('Library', 'Caches'),
  path.join('Library', 'Containers'),
  path.join('Library', 'Group Containers'),
  path.join('Library', 'Logs'),
  path.join('Library', 'Preferences'),  // .plist files
]

// Items starting with these are always system/Apple-owned — never flag them
const SYSTEM_PREFIXES = [
  'com.apple.', 'com.apple', 'apple',
  'systempreferences', 'loginitems', 'screensavers', 'savedapplicationstate',
  // Python runtimes (covers python2.x, python3.x, pythonXY, etc.)
  'python',
  // Symbol caches used by Xcode / developer tools
  'symbolsource',
]

// Apple-branded apps and services whose Library data should never be flagged,
// even if the .app is not present in the standard scan directories.
const APPLE_APP_NAMES = new Set([
  // Developer tools
  'xcode', 'instruments', 'simulator', 'iphonesimulator', 'realitycomposer', 'createml',
  'swift', 'swiftpm',
  // Pro media apps
  'garageband', 'logic', 'logicpro', 'finalcut', 'imovie', 'motion', 'compressor',
  'mainstage', 'soundtrack',
  // iWork
  'pages', 'numbers', 'keynote',
  // System apps
  'itunes', 'music', 'podcasts', 'books', 'ibooks', 'news', 'stocks',
  'photos', 'facetime', 'messages', 'mail', 'notes', 'reminders',
  'calendar', 'contacts', 'maps', 'shortcuts', 'automator',
  // iCloud / system services
  'icloud', 'mobiledocuments', 'clouddocs', 'cloudkit',
  // System UI / OS features
  'animoji', 'networkserviceproxy',
  // Developer / symbol caching
  'symbolsourcesymbols',
  // Python runtimes and virtual environments (installed by python.org or brew)
  'python', 'python3', 'python3.9', 'python3.10', 'python3.11', 'python3.12', 'python3.13',
  'virtualenv', 'virtualenvs', 'venv',
  // This app — never recommend deleting Vectra's own data
  'vectra',
  // Firebase / Google services
  'firestore',
  // Developer tools and version managers — never flagged even when not a .app
  'copilot', 'github', 'github-copilot', 'githubcopilot',
  'nvm', 'rbenv', 'pyenv', 'asdf', 'mise',
  'homebrew', 'linuxbrew',
  'npm', 'yarn', 'pnpm',
  'rustup', 'cargo',
  // VS Code and extensions — data is valid as long as VS Code itself is installed
  'code', 'vscode', 'visual', 'cursor', 'windsurf',
])

function addWords(ids: Set<string>, text: string) {
  // Add the full string plus every meaningful word (split on spaces and dots, min 4 chars)
  ids.add(text)
  for (const word of text.split(/[\s.]+/)) {
    if (word.length >= 4) ids.add(word)
  }
}

async function getInstalledAppIdentifiers(): Promise<Set<string>> {
  const ids = new Set<string>()
  const home = os.homedir()
  const appDirs = ['/Applications', path.join(home, 'Applications'), '/System/Applications']

  await Promise.allSettled(
    appDirs.map(async (dir) => {
      try {
        const entries = await readdir(dir)
        const apps = entries.filter((n) => n.endsWith('.app'))
        await Promise.allSettled(
          apps.map(async (app) => {
            // Add display name and each meaningful word in it
            const displayName = app.replace(/\.app$/, '').toLowerCase()
            addWords(ids, displayName)

            // Try to extract bundle identifier via plutil
            const plistPath = path.join(dir, app, 'Contents', 'Info.plist')
            try {
              const { stdout } = await execFileAsync(
                'plutil',
                ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plistPath],
                { timeout: 1500 }
              )
              const bundleId = stdout.trim().toLowerCase()
              if (bundleId) {
                // Add full bundle ID and every segment
                addWords(ids, bundleId)
              }
            } catch {
              // plutil not available or plist malformed — display name words are enough
            }
          })
        )
      } catch {
        // directory does not exist
      }
    })
  )

  // Also scan VS Code extensions so their Application Support data is never flagged.
  // Extension folders are named: {publisher}.{name}-{version}  e.g. github.copilot-1.181.0
  const vscodeExtDirs = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.windsurf', 'extensions'),
  ]
  await Promise.allSettled(
    vscodeExtDirs.map(async (extDir) => {
      try {
        const entries = await readdir(extDir)
        for (const name of entries) {
          // Strip the trailing version segment (last -semver) to get publisher.extname
          const withoutVersion = name.replace(/-\d+\.\d+.*$/, '').toLowerCase()
          addWords(ids, withoutVersion)
        }
      } catch {
        // directory does not exist or not readable
      }
    })
  )

  return ids
}

function isKnownApp(itemName: string, installedIds: Set<string>): boolean {
  // Strip .plist extension and lowercase for uniform comparison
  const name = itemName.toLowerCase().replace(/\.plist$/, '')
  if (!name) return true

  // Always skip system/Apple-owned items by prefix
  for (const prefix of SYSTEM_PREFIXES) {
    if (name.startsWith(prefix)) return true
  }

  // Always skip known Apple app names and their words
  if (APPLE_APP_NAMES.has(name)) return true
  // Also check if any word in a bundle-ID-style name matches an Apple app
  // e.g. "com.apple.garageband10" → already caught by com.apple prefix
  // e.g. "GarageBand" → caught above
  for (const word of name.split(/[\s.]+/)) {
    if (word.length >= 4 && APPLE_APP_NAMES.has(word)) return true
  }

  // Exact match against installed app identifiers (display names, bundle IDs, words)
  if (installedIds.has(name)) return true

  // For bundle-ID style names: check every dot-segment individually
  if (name.includes('.')) {
    for (const segment of name.split('.')) {
      if (segment.length >= 4 && installedIds.has(segment)) return true
    }
    // Prefix match: "com.google.chrome.helper" → matches "com.google.chrome"
    for (const id of installedIds) {
      if (name.startsWith(id + '.') || id.startsWith(name + '.')) return true
    }
  }

  return false
}

export interface AppLeftover {
  path: string
  name: string
  sizeKB: number
  location: string  // e.g. "Application Support"
}

async function findLeftoversInDir(
  dirPath: string,
  locationLabel: string,
  installedIds: Set<string>,
  minSizeKB: number
): Promise<AppLeftover[]> {
  const results: AppLeftover[] = []
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    await Promise.allSettled(
      entries.map(async (entry) => {
        const name = entry.name
        if (isKnownApp(name, installedIds)) return

        const fullPath = path.join(dirPath, name)
        try {
          const { stdout } = await execFileAsync('du', ['-sk', fullPath], { timeout: 8000 })
          const sizeKB = parseInt(stdout.split('\t')[0], 10)
          if (!isNaN(sizeKB) && sizeKB >= minSizeKB) {
            results.push({ path: fullPath, name, sizeKB, location: locationLabel })
          }
        } catch {
          // couldn't stat — skip
        }
      })
    )
  } catch {
    // location doesn't exist or permission denied
  }
  return results
}

// ─────────────────────────────────────────────────────────────────────────────

export function registerIpcHandlers(): void {
  // ── Scanner ──────────────────────────────────────────────────────────────

  ipcMain.on('scan-start', (event, pathOrPaths: string | string[]) => {
    if (cancelCurrentScan) {
      cancelCurrentScan()
      cancelCurrentScan = null
    }
    const paths = Array.isArray(pathOrPaths) ? [...pathOrPaths] : [pathOrPaths]

    const send = (channel: string, data: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, data)
    }

    if (paths.length === 1) {
      // Single path — simple case, no coordination needed
      cancelCurrentScan = scanDirectoryStreaming(
        paths[0],
        (entry) => send('scan-entry', entry),
        (error) => { cancelCurrentScan = null; send('scan-done', error ?? null) }
      )
    } else {
      // Multiple paths — scan all in parallel so every root populates concurrently
      // (e.g. ~/Library and ~/Downloads appear in the treemap at the same time).
      const cancellers: Array<() => void> = []
      let completed = 0
      let doneSent = false

      const onDone = (error?: string) => {
        completed++
        if (!doneSent && (error || completed === paths.length)) {
          doneSent = true
          send('scan-done', error ?? null)
        }
      }

      for (const dirPath of paths) {
        cancellers.push(
          scanDirectoryStreaming(dirPath, (entry) => send('scan-entry', entry), onDone)
        )
      }

      cancelCurrentScan = () => { cancellers.forEach((c) => c()); cancelCurrentScan = null }
    }
  })

  ipcMain.on('scan-cancel', () => {
    if (cancelCurrentScan) { cancelCurrentScan(); cancelCurrentScan = null }
  })

  // ── File operations ───────────────────────────────────────────────────────

  ipcMain.handle('open-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose a folder to analyze'
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('open-external', (_event, url: string) => {
    shell.openExternal(url)
  })

  ipcMain.handle('reveal-in-finder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('trash-entries', async (_event, paths: string[]) => {
    const requested = Math.max(0, paths.length)
    const premium = getLicenseInfo().active

    if (!premium) {
      const settingsAtStart = loadSettings()
      const monthKey = currentMonthKey()
      const usedAtStart = settingsAtStart.deleteQuota.monthKey === monthKey ? settingsAtStart.deleteQuota.used : 0
      const remaining = Math.max(0, FREE_DELETE_LIMIT_PER_MONTH - usedAtStart)

      if (remaining <= 0) {
        return `You've reached your free delete limit (${FREE_DELETE_LIMIT_PER_MONTH} per month). Upgrade to Premium for unlimited in-app deletes.`
      }
      if (requested > remaining) {
        return `You can delete ${remaining} more ${remaining === 1 ? 'item' : 'items'} this month on Free. Remove fewer items or upgrade to Premium for unlimited deletes.`
      }
    }

    const errors: string[] = []
    let deletedCount = 0
    for (const p of paths) {
      try {
        await shell.trashItem(p)
        deletedCount += 1
      } catch (err) {
        errors.push(String(err))
      }
    }

    if (!premium && deletedCount > 0) {
      const settings = loadSettings()
      const monthKey = currentMonthKey()
      const used = settings.deleteQuota.monthKey === monthKey ? settings.deleteQuota.used : 0
      patchSettings({
        deleteQuota: {
          monthKey,
          used: Math.min(FREE_DELETE_LIMIT_PER_MONTH, used + deletedCount),
        }
      })
    }

    return errors.length === 0 ? null : errors.join('\n')
  })

  ipcMain.handle('get-item-stats', async (_event, filePath: string) => {
    try {
      const s = await stat(filePath)
      return {
        modified: s.mtime.toISOString(),
        created: s.birthtime.toISOString(),
        sizeBytes: s.size
      }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── App leftover detection ────────────────────────────────────────────────

  ipcMain.handle('find-app-leftovers', async () => {
    const home = os.homedir()

    // Minimum size to report (1 MB = 1024 KB)
    const MIN_SIZE_KB = 1024

    const installedIds = await getInstalledAppIdentifiers()

    const allResults = await Promise.all(
      LEFTOVER_LOCATIONS.map((rel) => {
        const fullPath = path.join(home, rel)
        const label = rel.split(path.sep).pop() ?? rel
        return findLeftoversInDir(fullPath, label, installedIds, MIN_SIZE_KB)
      })
    )

    const flat = allResults.flat()
    // Deduplicate by path and sort largest first
    const seen = new Set<string>()
    const unique: AppLeftover[] = []
    for (const item of flat.sort((a, b) => b.sizeKB - a.sizeKB)) {
      if (!seen.has(item.path)) {
        seen.add(item.path)
        unique.push(item)
      }
    }
    return unique
  })

  // ── Ollama AI ─────────────────────────────────────────────────────────────

  ipcMain.on(
    'ollama-start',
    async (event, payload: { path: string; name: string; isDir: boolean; sizeKB: number }) => {
      // Cancel any in-progress request
      if (ollamaAbort) {
        ollamaUserCancelled = true
        ollamaAbort.abort()
        ollamaAbort = null
      }
      ollamaUserCancelled = false
      ollamaAbort = new AbortController()

      const send = (channel: string, data: unknown) => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, data)
      }

      try {
        const model = await pickOllamaModel()
        if (ollamaUserCancelled) return

        send('ollama-model', model)

        const pathContext = getMacOSPathContext(payload.path)

        const prompt = `Do not use markdown, just plain sentences and text. You are a macOS storage expert helping a user understand items on their disk.

Item details:
Name: ${payload.name}
Path: ${payload.path}
Type: ${payload.isDir ? 'Folder' : 'File'}
Size: ${formatSizeForPrompt(payload.sizeKB)}
${pathContext ? `\nContext about this path: ${pathContext}\n` : ''}
macOS directory reference (use this to reason about safety):
- /System, /usr, /bin, /sbin, /private/etc, /private/var — core OS files, never safe to delete
- /Library — system-wide app support, fonts, extensions; most items required by apps
- /Users — parent of all user home folders; deleting destroys all user accounts
- ~/Library/Application Support, ~/Library/Preferences, ~/Library/Keychains — important per-user app data; individual files may be resettable but whole folders should not be deleted
- ~/Documents, ~/Desktop, ~/Downloads, ~/Movies, ~/Music, ~/Pictures — personal user data, never safe to bulk-delete
- ~/Library/Caches, /Library/Caches, tmp, temp, Logs, DerivedData — regenerable; generally safe to delete

In 2 brief sentences explain what this item is and whether deleting it is safe, using the context above to reason accurately.

Then end with exactly one recommendation that matches your explanation:
- If deleting is safe or the item can be regenerated: RECOMMENDATION: DELETE
- If deleting could break something, cause data loss, or cause instability: RECOMMENDATION: KEEP

Your recommendation MUST be consistent with your explanation. Do not say deleting is risky and then recommend DELETE. Do not say it is safe and then recommend KEEP.`

        const res = await net.fetch('http://localhost:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt, stream: true }),
          signal: ollamaAbort.signal
        })

        if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}`)

        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            const obj = JSON.parse(line) as { response?: string; done?: boolean }
            if (obj.response) send('ollama-token', obj.response)
            if (obj.done) { send('ollama-done', null); return }
          }
        }
        send('ollama-done', null)
      } catch (err: unknown) {
        if (ollamaUserCancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        send('ollama-done', msg)
      } finally {
        ollamaAbort = null
      }
    }
  )

  ipcMain.on('ollama-cancel', () => {
    if (ollamaAbort) {
      ollamaUserCancelled = true
      ollamaAbort.abort()
      ollamaAbort = null
    }
  })

  // ── Settings ───────────────────────────────────────────────────────────────
  ipcMain.handle('get-settings', () => loadSettings())
  ipcMain.handle('get-home-dir', () => os.homedir())
  ipcMain.handle('get-app-version', () => app.getVersion())

  ipcMain.handle('save-settings', (_event, settings: VectraSettings) => {
    const prev = loadSettings()
    // Keep runtime-managed counters from the source of truth in main process,
    // so stale renderer state can't overwrite delete quota or scan history.
    const mergedSettings: VectraSettings = {
      ...settings,
      lastManualScanTime: prev.lastManualScanTime,
      lastManualScanFoundKB: prev.lastManualScanFoundKB,
      lastCleanedTime: prev.lastCleanedTime,
      lastCleanedKB: prev.lastCleanedKB,
      deleteQuota: prev.deleteQuota,
    }
    saveSettings(mergedSettings)
    if (settings.backgroundScan.enabled !== prev.backgroundScan.enabled ||
        settings.backgroundScan.intervalHours !== prev.backgroundScan.intervalHours) {
      if (settings.backgroundScan.enabled) scheduleBackgroundScan()
      else stopBackgroundScan()
    }
    if (settings.showMenuBarIcon !== prev.showMenuBarIcon) {
      setTrayVisibility(settings.showMenuBarIcon)
    }
    if (settings.autoUpdateEnabled && !prev.autoUpdateEnabled) {
      runAutoUpdateCheck('settings-enabled').catch(() => {})
    }
    rebuildTrayMenu()
  })

  ipcMain.handle('test-notification', () => testNotification())

  ipcMain.handle('check-for-updates', () => {
    return runAutoUpdateCheck('settings-enabled')
  })

  ipcMain.handle('request-notification-permission', () => {
    // Showing a notification triggers the native macOS permission dialog on production builds.
    // If already authorized the notification simply appears; if denied the user sees nothing
    // and can fall back to opening System Settings manually.
    if (Notification.isSupported()) {
      new Notification({
        title: 'Vectra',
        body: "You'll be notified when background scans find space to reclaim."
      }).show()
    }
  })

  ipcMain.handle('mark-onboarding-complete', () => {
    patchSettings({ onboardingComplete: true })
  })

  ipcMain.handle('get-login-item', () => {
    return app.getLoginItemSettings().openAtLogin
  })

  ipcMain.handle('set-login-item', (_event, enable: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enable, openAsHidden: enable })
  })

  ipcMain.handle('check-ollama', async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const res = await net.fetch('http://localhost:11434/api/tags', { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) return { installed: false }
      const data = await res.json() as { models?: { name: string }[] }
      return { installed: true, hasModels: (data.models?.length ?? 0) > 0 }
    } catch {
      return { installed: false }
    }
  })

  ipcMain.handle('get-ollama-models', async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      const res = await net.fetch('http://localhost:11434/api/tags', { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) return { ok: false, models: [] }
      const data = await res.json() as {
        models?: Array<{ name: string; size: number; modified_at: string }>
      }
      return { ok: true, models: data.models ?? [] }
    } catch {
      return { ok: false, models: [] }
    }
  })

  ipcMain.on('pull-model', async (event, modelName: string) => {
    if (pullAbort) { pullAbort.abort(); pullAbort = null }
    pullAbort = new AbortController()

    const send = (channel: string, data: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, data)
    }

    const layerProgress = new Map<string, { total: number; completed: number }>()

    try {
      const res = await net.fetch('http://localhost:11434/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: true }),
        signal: pullAbort.signal
      })

      if (!res.ok || !res.body) {
        send('pull-done', { model: modelName, error: `Ollama returned ${res.status}` })
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line) as {
              status?: string; digest?: string; total?: number; completed?: number
            }
            if (obj.digest && obj.total) {
              layerProgress.set(obj.digest, { total: obj.total, completed: obj.completed ?? 0 })
            }
            const totalBytes = [...layerProgress.values()].reduce((s, v) => s + v.total, 0)
            const completedBytes = [...layerProgress.values()].reduce((s, v) => s + v.completed, 0)
            const progress = totalBytes > 0 ? Math.round((completedBytes / totalBytes) * 100) : null
            send('pull-progress', { model: modelName, progress, status: obj.status ?? '' })
            if (obj.status === 'success') {
              send('pull-done', { model: modelName, error: null })
              return
            }
          } catch { /* malformed line */ }
        }
      }
      send('pull-done', { model: modelName, error: null })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('abort') && !msg.includes('AbortError')) {
        send('pull-done', { model: modelName, error: msg })
      }
    } finally {
      pullAbort = null
    }
  })

  ipcMain.on('cancel-pull', () => {
    if (pullAbort) { pullAbort.abort(); pullAbort = null }
  })

  // ── License ────────────────────────────────────────────────────────────────
  ipcMain.handle('license:get', () => getLicenseInfo())
  ipcMain.handle('license:activate', (_event, key: string) => activateLicense(key))
  ipcMain.handle('license:deactivate', () => deactivateLicense())

  // Silently re-validate on startup — updates cached status without blocking
  revalidateLicense().catch(() => {})

  ipcMain.handle('run-bg-scan', () => runBackgroundScan())

  ipcMain.on('update-last-scan-path', (_event, scanPath: string) => {
    updateLastScanPath(scanPath)
  })

  ipcMain.on('notify-manual-scan-done', (_event, foundKB: number) => {
    patchSettings({
      lastManualScanTime: Date.now(),
      lastManualScanFoundKB: foundKB,
      // Reset cleaned state so tray shows "Found" for the new scan
      lastCleanedTime: null,
      lastCleanedKB: 0
    })
    rebuildTrayMenu()
  })

  ipcMain.on('notify-cleaned', (_event, cleanedKB: number) => {
    patchSettings({ lastCleanedTime: Date.now(), lastCleanedKB: cleanedKB })
    rebuildTrayMenu()
  })
}
