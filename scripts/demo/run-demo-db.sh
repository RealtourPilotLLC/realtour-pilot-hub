#!/bin/bash
# ---------------------------------------------------------------------------
# Start the isolated demo DATABASE (scripts/demo/isolated-demo.ts): a private
# Postgres on 127.0.0.1:5599 that lives in this process, seeded once with the
# three TEST clients, plus the demo clip on 127.0.0.1:5598. Ctrl-C stops it.
#
#   scripts/demo/run-demo-db.sh            reuse the demo database if it exists
#   scripts/demo/run-demo-db.sh --reset    delete it and seed a fresh month
#
# You normally don't run this yourself: scripts/demo/run-demo-dev.sh starts it
# in the background when nothing is on 5599. Run it here when you want the
# "signin" command (fresh one-time client sign-in links) in a terminal.
#
# The environment is emptied (env -i) and rebuilt from nothing but PATH/HOME,
# so no variable exported by a shell profile — a provider key, a production
# DATABASE_URL — can reach the process. The TypeScript then pins its own
# database URL to loopback and blanks every .env key before Prisma loads.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin"
if [ ! -x "$NODE_BIN/node" ]; then NODE_BIN="$(dirname "$(command -v node)")"; fi
if [ "$("$NODE_BIN/node" -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "The demo needs Node 20 (found $("$NODE_BIN/node" -v) at $NODE_BIN). Run: nvm use" >&2
  exit 1
fi

cd "$REPO"
# --conditions=react-server: app modules marked "server-only" load outside Next
# (the drills run the same way). The preload stubs next/navigation.
exec env -i \
  HOME="$HOME" \
  PATH="$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  TMPDIR="${TMPDIR:-/tmp}" \
  LANG="${LANG:-en_US.UTF-8}" \
  TERM="${TERM:-xterm-256color}" \
  DEMO_DATA_DIR="${DEMO_DATA_DIR:-}" \
  NODE_OPTIONS="--conditions=react-server" \
  "$REPO/node_modules/.bin/tsx" --require ./scripts/_drill/_drill-preload.cjs scripts/demo/isolated-demo.ts "$@"
