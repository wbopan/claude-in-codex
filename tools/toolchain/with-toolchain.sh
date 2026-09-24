#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/.node-version")"
NODE_ARCH=arm64
if [[ "$(uname -m)" == x86_64 ]]; then
  NODE_ARCH=x64
fi
NODE_ROOT="$ROOT/.dev/toolchains/node-v${NODE_VERSION#v}-darwin-$NODE_ARCH"
export CARGO_HOME="$ROOT/.dev/toolchains/cargo"
export RUSTUP_HOME="$ROOT/.dev/toolchains/rustup"
export PATH="$NODE_ROOT/bin:$CARGO_HOME/bin:$PATH"
if [[ ! -x "$NODE_ROOT/bin/node" || ! -x "$CARGO_HOME/bin/cargo" ]]; then
  echo 'Run npm run bootstrap first.' >&2
  exit 1
fi
cd "$ROOT"
exec "$@"
