#!/bin/bash

set -euo pipefail

EXPECTED_CSC_NAME="Patricio Villarreal (9QNARUMXB4)"
EXPECTED_IDENTITY="Developer ID Application: ${EXPECTED_CSC_NAME}"

required=(
  APPLE_ID
  APPLE_APP_SPECIFIC_PASSWORD
  APPLE_TEAM_ID
  CSC_NAME
  GH_TOKEN
  VITE_MONTHLY_CHECKOUT_URL
  VITE_LIFETIME_CHECKOUT_URL
  VITE_MONTHLY_VARIANT_ID
  VITE_LIFETIME_VARIANT_ID
)
missing=()
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then missing+=("${name}"); fi
done

if (( ${#missing[@]} > 0 )); then
  echo "Missing required release environment variables: ${missing[*]}" >&2
  exit 1
fi

if [[ "${NERION_SKIP_NOTARIZE:-0}" == "1" ]]; then
  echo "NERION_SKIP_NOTARIZE cannot be enabled for a public release." >&2
  exit 1
fi

for command in node npm cargo rustc git gh security codesign spctl xcrun lipo; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required release tool is unavailable: ${command}" >&2
    exit 1
  fi
done

if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree must be clean before a release. Commit or remove every pending change first." >&2
  exit 1
fi

repo_info="$(gh repo view --json nameWithOwner,defaultBranchRef --jq '[.nameWithOwner, .defaultBranchRef.name] | @tsv')" || {
  echo "Could not resolve the GitHub repository and its default branch." >&2
  exit 1
}
IFS=$'\t' read -r repo_name default_branch <<< "${repo_info}"
current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"

if [[ -z "${default_branch}" || "${current_branch}" != "${default_branch}" ]]; then
  echo "Public releases must run from the GitHub default branch '${default_branch:-unknown}', not '${current_branch:-detached HEAD}'." >&2
  exit 1
fi

remote_default_sha="$(git ls-remote origin "refs/heads/${default_branch}" | awk 'NR == 1 { print $1 }')"
if [[ -z "${remote_default_sha}" ]]; then
  echo "Could not resolve origin/${default_branch}; push the default branch before releasing." >&2
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "${remote_default_sha}" ]]; then
  echo "HEAD does not match origin/${default_branch}. Push the release commit before releasing." >&2
  exit 1
fi

if ! action_variables="$(gh variable list --repo "${repo_name}" --json name --jq '.[].name' 2>&1)"; then
  token_error="${action_variables}"
  if [[ -n "${GH_TOKEN:-}" ]] && action_variables="$(env -u GH_TOKEN gh variable list --repo "${repo_name}" --json name --jq '.[].name' 2>&1)"; then
    echo "GH_TOKEN cannot inspect Actions variables; using the authenticated GitHub CLI keyring for preflight checks."
  else
    echo "Could not inspect GitHub Actions variables for ${repo_name}. Ensure GitHub CLI can read repository Actions settings, or configure them in GitHub before releasing." >&2
    echo "${token_error}" >&2
    echo "${action_variables}" >&2
    exit 1
  fi
fi

required_action_variables=(
  VITE_MONTHLY_CHECKOUT_URL
  VITE_LIFETIME_CHECKOUT_URL
  VITE_MONTHLY_VARIANT_ID
  VITE_LIFETIME_VARIANT_ID
)
missing_action_variables=()

for name in "${required_action_variables[@]}"; do
  if ! grep -Fxq "${name}" <<< "${action_variables}"; then
    missing_action_variables+=("${name}")
  fi
done
if (( ${#missing_action_variables[@]} > 0 )); then
  echo "Missing required GitHub Actions variables: ${missing_action_variables[*]}" >&2
  exit 1
fi

node <<'NODE'
const pkg = require('./package.json')
const lock = require('./package-lock.json')
const whatsNew = require('./src/renderer/whats-new.json')

if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error(`Release version is not stable semver: ${pkg.version}`)
if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
  throw new Error('package.json and package-lock.json versions do not match.')
}
if (whatsNew.releases?.[0]?.version !== pkg.version) {
  throw new Error("The newest What's New entry does not match package.json.")
}

const headPackage = JSON.parse(require('node:child_process').execFileSync(
  'git', ['show', 'HEAD:package.json'], { encoding: 'utf8' },
))
if (headPackage.version !== pkg.version) {
  throw new Error(`HEAD contains version ${headPackage.version}, but the working tree contains ${pkg.version}.`)
}

NODE

node scripts/validate-checkout-urls.mjs

if [[ "${CSC_NAME}" != "${EXPECTED_CSC_NAME}" ]]; then
  echo "CSC_NAME must be '${EXPECTED_CSC_NAME}' for public Nerion releases." >&2
  exit 1
fi

if [[ "${APPLE_TEAM_ID}" != "9QNARUMXB4" ]]; then
  echo "APPLE_TEAM_ID does not match the Developer ID signing identity." >&2
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -Fq "${EXPECTED_IDENTITY}"; then
  echo "Developer ID Application identity is not available in the login keychain." >&2
  exit 1
fi

if ! xcrun notarytool history \
  --apple-id "${APPLE_ID}" \
  --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
  --team-id "${APPLE_TEAM_ID}" >/dev/null; then
  echo "Apple notarization credentials could not be validated." >&2
  exit 1
fi

echo "Default branch, billing configuration, macOS signing identity, and notarization credentials are ready."
