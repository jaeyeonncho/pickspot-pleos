#!/bin/bash
PICKSPOT_NODE="${PICKSPOT_NODE:-$(command -v node || true)}"
if [ ! -x "$PICKSPOT_NODE" ] || ! "$PICKSPOT_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo 'Install Node.js 22 or newer and add it to PATH.' >&2; exit 1
fi
