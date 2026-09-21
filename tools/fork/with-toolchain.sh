#!/usr/bin/env bash
set -euo pipefail
FORK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FORK_NODE_ROOT="$FORK_ROOT/.codexhost/toolchains/node-v24.13.1-darwin-$(uname -m)"
if [[ "$(uname -m)" == x86_64 ]]; then
  FORK_NODE_ROOT="$FORK_ROOT/.codexhost/toolchains/node-v24.13.1-darwin-x64"
fi
export CARGO_HOME="$FORK_ROOT/.codexhost/toolchains/cargo"
export RUSTUP_HOME="$FORK_ROOT/.codexhost/toolchains/rustup"
export RUSTUP_DIST_SERVER=https://static-rust-lang-org.s3.amazonaws.com
export RUSTUP_UPDATE_ROOT=https://static-rust-lang-org.s3.amazonaws.com/rustup
export PATH="$FORK_NODE_ROOT/bin:$CARGO_HOME/bin:$PATH"
if [[ ! -x "$FORK_NODE_ROOT/bin/node" || ! -x "$CARGO_HOME/bin/cargo" ]]; then
  echo 'Run npm run fork:bootstrap first.' >&2
  exit 1
fi
cd "$FORK_ROOT"
exec "$@"
