#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
source scripts/env.sh
source scripts/node.sh
./gradlew exportDebugApk --console=plain
exec "$PICKSPOT_NODE" scripts/run-competition-demo.mjs
