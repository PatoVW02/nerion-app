# Nerion

Nerion is a macOS disk space analyzer built with Electron, React, TypeScript, and a native Swift scanner.

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
- Swift for the native scanner binary in `resources/scanner`

## Repo Layout

- `src/main`: Electron main-process code, IPC, updater, licensing, background behavior
- `src/renderer`: React UI
- `resources/scanner`: Swift source for the native scanner
- `scripts/release-all.sh`: multi-architecture release script
- `dist`: packaged app output

## Requirements

- Node.js and npm
- Xcode Command Line Tools with `swiftc`
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
- `VITE_OPENAI_API_KEY`
- `VITE_OPENAI_PROMPT_ID`
- `VITE_OPENAI_PROMPT_VERSION`

Notes:

- `GH_TOKEN` is used by the GitHub publishing flow.
- `VITE_OPENAI_*` enables cloud AI mode.
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
2. `npm run build:scanner*` compiles the native Swift scanner binary used by the app.

Architecture-specific scanner commands:

- `npm run build:scanner`
- `npm run build:scanner:x64`
- `npm run build:scanner:universal`

## Publish a New Version

### Quick release

For a single universal release:

```bash
npm run release
```

This builds the universal scanner, packages the app, and publishes the release through `electron-builder`.

### Full release

For arm64, x64, and universal artifacts with architecture-specific updater files:

```bash
npm run release:all
```

This script:

1. reads the version from `package.json`
2. builds the app once
3. builds and publishes `arm64`
4. downloads the generated `latest-mac.yml` and re-uploads it as `arm64-mac.yml`
5. repeats the flow for `x64`
6. publishes the universal build last
7. keeps `latest-mac.yml` as universal for backward compatibility

Generated release assets should include:

- `latest-mac.yml`
- `universal-mac.yml`
- `arm64-mac.yml`
- `x64-mac.yml`

### Release checklist

1. Update `version` in `package.json`.
2. Update `src/renderer/whats-new.json`.
3. Make sure `.env.local` contains a valid `GH_TOKEN`.
4. Make sure `gh` is installed and authenticated.
5. Run `npm run typecheck`.
6. Run `npm run release:all`.
7. Verify the GitHub Release includes the DMG/ZIP files and the three architecture-specific `*-mac.yml` assets.
8. Install or update from the published build and verify auto-update behavior.

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
