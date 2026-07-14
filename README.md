# Nerion

Nerion is a cross-platform disk space analyzer built with Electron, React, TypeScript, and a native Rust scanner.

It helps users:

- visualize storage with an interactive treemap
- find large files and folders quickly
- review cleanup suggestions with Smart Clean
- get AI-powered file analysis
- receive background scan updates and in-app release notes

## Stack

- Electron + `electron-vite`
- React + TypeScript
- Tailwind CSS
- `electron-builder` for packaging and GitHub Releases
- Rust for the native scanner binary in `resources/`

## Repo Layout

- `src/main`: Electron main-process code, IPC, updater, licensing, background behavior
- `src/renderer`: React UI
- `native/scanner-rs`: Rust source for the native scanner
- `scripts/release-mac.sh`: local macOS release script that triggers the Windows CI release
- `scripts/release-all.sh`: multi-architecture macOS release script
- `dist`: packaged app output

## Requirements

- Node.js and npm
- Rust toolchain with `cargo` and `rustc`
- macOS
- GitHub CLI (`gh`) for `npm run release:all`

Install the GitHub CLI if needed:

```bash
brew install gh
gh auth login
```

## Environment Variables

Create `.env.local` in the `App/` directory with the values you use locally.

Current variables referenced by the app:

- `VITE_MONTHLY_CHECKOUT_URL`
- `VITE_LIFETIME_CHECKOUT_URL`
- `VITE_MONTHLY_VARIANT_ID`
- `VITE_LIFETIME_VARIANT_ID`
- `GH_TOKEN`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `CSC_NAME`
- `NERION_OPENAI_API_KEY` (optional, runtime-only internal builds)
- `NERION_OPENAI_PROMPT_ID` (optional, runtime-only internal builds)
- `NERION_OPENAI_PROMPT_VERSION` (optional, runtime-only internal builds)

Notes:

- `GH_TOKEN` is used by the GitHub publishing flow. Apple credentials and
  `CSC_NAME` are required only for a signed, notarized public release.
- Windows Authenticode signing is optional. When GitHub Actions has both
  `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`, CI verifies signatures on
  the installer, app executable, and native scanner before upload. With neither
  secret configured, CI publishes an unsigned installer and skips signature
  verification. A partial one-secret configuration fails closed.
- Public builds offer local Ollama and an optional bring-your-own-key OpenAI
  mode. User keys are verified before replacement, encrypted with Electron's
  OS-backed `safeStorage`, and never returned to the renderer. `NERION_OPENAI_*`
  remains available for managed/internal deployments. Never use `VITE_OPENAI_*`
  for credentials because Vite embeds those values in the packaged app.
- Checkout and variant values are used for paid plans and license flows.

## Development

Install dependencies:

```bash
npm install
```

Start the app in development:

```bash
npm run dev
```

Useful commands:

```bash
npm run build
npm run typecheck
npm run dist:arm64
npm run dist:x64
npm run dist:universal
```

## How Building Works

The app has two build layers:

1. `npm run build` compiles the Electron main process and renderer.
2. `npm run build:scanner*` compiles the native Rust scanner binary used by the app.

Architecture-specific scanner commands:

- `npm run build:scanner`
- `npm run build:scanner:x64`
- `npm run build:scanner:universal`

## Publish a New Version

### Quick release

For the fully gated macOS release plus a Windows CI release:

```bash
npm run release
```

This runs the same complete release pipeline as `release:all`.

### Full release

For arm64, x64, and universal artifacts with architecture-specific updater files:

```bash
npm run release:all
```

This script refuses to release a dirty or version-mismatched checkout. It:

1. validates the package, lockfile, What's New entry, billing checkout URLs,
   pushed default-branch commit, GitHub Actions billing configuration,
   Developer ID identity, and Apple notarization credentials
2. runs typecheck, unit/integration tests, and native scanner tests
3. builds, notarizes, staples, and verifies arm64, x64, and universal apps
4. creates and pushes the source tag only after every local artifact passes
5. uploads the verified macOS assets to an explicit draft, then publishes it
6. lets Windows CI build from that exact tag and attach its NSIS installer
7. keeps `latest-mac.yml` as universal for backward compatibility

Generated release assets should include:

- `latest-mac.yml`
- `universal-mac.yml`
- `arm64-mac.yml`
- `x64-mac.yml`

### Release checklist

1. Update `version` in `package.json`.
2. Update `src/renderer/whats-new.json`.
3. Export the release variables listed above (a gitignored `.env.local` is
   supported for local use) and confirm the Lemon Squeezy Share URLs are live.
4. Make sure `gh` is installed and authenticated.
5. Run `npm run typecheck`.
6. Run `npm run release` or `npm run release:all`; both execute the same gated multi-architecture flow.
7. Verify the GitHub Release includes the DMG/ZIP files, the Windows NSIS installer, and the three architecture-specific `*-mac.yml` assets when using `release:all`.
8. Install or update from the published builds and verify auto-update behavior.

## Troubleshooting

### `gh: command not found`

`npm run release:all` uses the GitHub CLI inside `scripts/release-all.sh` to download and re-upload updater metadata files.

Fix:

```bash
brew install gh
gh auth login
```

### Release publishes but updater files are missing

Check that:

- `gh` is installed
- `GH_TOKEN` is present
- the GitHub release tag matches the version in `package.json`
- the release was created successfully by `electron-builder`

## Product Notes

The public site and marketing assets live outside this app repo folder structure:

- sibling `Landing/` folder: marketing website
- sibling `Logos/` folder: brand assets

If you change the product positioning, pricing, or release messaging, it is worth updating both the app and landing site together.
