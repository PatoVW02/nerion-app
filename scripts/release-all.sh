#!/bin/bash
# Build, notarize, verify, tag, and publish every macOS architecture. Nothing is
# pushed or uploaded until all local release gates and all three packaged apps
# have passed verification.

set -euo pipefail

if [[ -f ./.env.local ]]; then
  set -a
  # shellcheck disable=SC1091 -- local, gitignored developer environment
  . ./.env.local
  set +a
fi

bash scripts/preflight-mac-release.sh

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
HEAD_SHA="$(git rev-parse HEAD)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "Local tag ${TAG} already exists." >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "Remote tag ${TAG} already exists." >&2
  exit 1
fi

echo "▶ Running release gates for Nerion ${TAG}"
npm run typecheck
npm test
cargo clippy --manifest-path native/scanner-rs/Cargo.toml --all-targets -- -D warnings

# Renderer/main JS is architecture independent.
npm run build

echo "▶ Building and verifying arm64"
npm run build:scanner:arm64
npx electron-builder --arm64 --publish never
bash scripts/verify-mac-release.sh arm64
cp dist/latest-mac.yml "${TMP}/arm64-mac.yml"

echo "▶ Building and verifying x64"
npm run build:scanner:x64
npx electron-builder --x64 --publish never
bash scripts/verify-mac-release.sh x86_64
cp dist/latest-mac.yml "${TMP}/x64-mac.yml"

echo "▶ Building and verifying universal"
npm run build:scanner:universal
npx electron-builder --universal --publish never
bash scripts/verify-mac-release.sh universal
cp dist/latest-mac.yml "${TMP}/universal-mac.yml"

required_assets=(
  dist/Nerion-arm64.dmg
  dist/Nerion-arm64.zip
  dist/Nerion-x64.dmg
  dist/Nerion-x64.zip
  dist/Nerion-universal.dmg
  dist/Nerion-universal.zip
  dist/latest-mac.yml
  "${TMP}/arm64-mac.yml"
  "${TMP}/x64-mac.yml"
  "${TMP}/universal-mac.yml"
)
for asset in "${required_assets[@]}"; do
  if [[ ! -f "${asset}" ]]; then
    echo "Required release asset is missing: ${asset}" >&2
    exit 1
  fi
done

# The source tag is created only after all local artifacts are signed,
# notarized, stapled, architecture-checked, and Gatekeeper-approved.
git tag -a "${TAG}" "${HEAD_SHA}" -m "Nerion ${TAG}"
if ! git push origin "refs/tags/${TAG}"; then
  git tag -d "${TAG}" >/dev/null
  echo "Could not push ${TAG}; no release was created." >&2
  exit 1
fi

shopt -s nullglob
blockmaps=(dist/Nerion-{arm64,x64,universal}.{dmg,zip}.blockmap)

# Keep the release explicitly private until every macOS upload succeeds.
# --verify-tag prevents GitHub from silently creating a tag from a different
# commit. If creation fails, remove the new tag so the same version can be
# retried cleanly after the underlying problem is fixed.
if ! gh release create "${TAG}" \
  "${required_assets[@]}" \
  "${blockmaps[@]}" \
  --verify-tag \
  --draft \
  --title "${VERSION}" \
  --generate-notes; then
  gh release delete "${TAG}" --yes >/dev/null 2>&1 || true
  if ! git push origin ":refs/tags/${TAG}"; then
    echo "Warning: failed to remove remote tag ${TAG}; remove it before retrying." >&2
  fi
  git tag -d "${TAG}" >/dev/null 2>&1 || true
  echo "GitHub release creation failed; the local release was not published." >&2
  exit 1
fi

if ! gh release edit "${TAG}" --draft=false; then
  echo "All macOS assets were uploaded, but GitHub could not publish the draft release." >&2
  echo "The verified release remains a draft. Publish ${TAG} manually after resolving GitHub access." >&2
  exit 1
fi

echo ""
echo "✓ Release ${TAG} published from ${HEAD_SHA}"
echo "  latest-mac.yml       → universal (backward compatibility)"
echo "  universal-mac.yml    → universal builds"
echo "  arm64-mac.yml        → Apple Silicon builds"
echo "  x64-mac.yml          → Intel builds"
echo "  Windows CI will attach the verified NSIS installer to this same tag."
