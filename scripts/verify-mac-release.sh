#!/bin/bash

set -euo pipefail

expected_arch="${1:?usage: verify-mac-release.sh <arm64|x86_64|universal>}"
case "${expected_arch}" in
  arm64) app_path="dist/mac-arm64/Nerion.app" ;;
  x86_64) app_path="dist/mac/Nerion.app" ;;
  universal) app_path="dist/mac-universal/Nerion.app" ;;
  *) echo "Unknown expected architecture: ${expected_arch}" >&2; exit 1 ;;
esac

if [[ ! -d "${app_path}" ]]; then
  echo "Packaged Nerion.app was not found under dist/." >&2
  exit 1
fi

scanner_path="${app_path}/Contents/Resources/scanner-bin"
if [[ ! -x "${scanner_path}" ]]; then
  echo "The packaged native scanner is missing or not executable." >&2
  exit 1
fi

plist_path="${app_path}/Contents/Info.plist"
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSAllowsArbitraryLoads' "${plist_path}")" != "false" ]]; then
  echo "The packaged app allows arbitrary insecure network traffic." >&2
  exit 1
fi
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSAllowsLocalNetworking' "${plist_path}")" != "true" ]]; then
  echo "The packaged app is missing the local-network exception required for Ollama." >&2
  exit 1
fi

architectures="$(lipo -archs "${scanner_path}")"
case "${expected_arch}" in
  arm64) [[ " ${architectures} " == *" arm64 "* ]] ;;
  x86_64) [[ " ${architectures} " == *" x86_64 "* ]] ;;
  universal) [[ " ${architectures} " == *" arm64 "* && " ${architectures} " == *" x86_64 "* ]] ;;
esac

codesign --verify --deep --strict --verbose=2 "${app_path}"
spctl --assess --type execute --verbose=2 "${app_path}"
xcrun stapler validate "${app_path}"

echo "Verified signed, notarized, stapled ${expected_arch} app: ${app_path}"
