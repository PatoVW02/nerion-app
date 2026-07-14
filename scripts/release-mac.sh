#!/bin/bash

set -euo pipefail

# Keep the historical command as an alias for the gated all-platform release.
exec bash scripts/release-all.sh
