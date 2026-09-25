#!/bin/bash
# ---------------------------------------------------------------------------
# THE ISOLATED DEMO HUB: `next dev` on http://localhost:3100 against the demo
# database on 127.0.0.1:5599, with every provider disconnected.
#
#   scripts/demo/run-demo-dev.sh              start (and the demo database, if it isn't running)
#   scripts/demo/run-demo-dev.sh --reset      same, with a freshly seeded database
#   scripts/demo/run-demo-dev.sh --stop       stop a demo left running in the background
#   scripts/demo/run-demo-dev.sh --print-env  show the environment next dev would get, and exit
#
# WHAT KEEPS PRODUCTION OUT, in the order it is checked:
#   1. DATABASE_URL/DIRECT_URL are BUILT here, never inherited, and refused
#      unless they are exactly postgresql://…@127.0.0.1:5599 — a hard-coded
#      pattern, not the config value, so editing the config cannot move it.
#   2. `env -i`: next dev starts from an EMPTY environment. Nothing a shell
#      profile exports (a production DATABASE_URL, a provider key) reaches it.
#   3. Every key any .env* file defines, and every process.env name the app
#      reads, is passed in as an empty string. Next and Prisma both load .env
#      but never override a key that is already set, so the file's production
#      values cannot fill them back in.
#   4. The demo database holds no provider connections (Aryeo, Stripe, Slack,
#      Gmail, OpenPhone, Dropbox…) — only a dummy "ai" one for the stub model.
#   5. scripts/demo/demo-preload.cjs, loaded into every Node process of the
#      server, refuses to load on any other DATABASE_URL and fences every
#      outbound connection (fetch and raw sockets): the model and the demo clip
#      are answered locally, Google Fonts pass, everything else is blocked.
#      This script checks the process SERVING the port carries that fence and
#      stops the server if it does not.
#   6. AUTH_ENFORCE is unset, so the hub's sign-in gate is off (local dev
#      mode): staff pages open without Google, which is not connected anyway.
#
# ONE `next dev` PER PROJECT FOLDER. Next 16 writes dev output to .next/dev and
# holds .next/dev/lock while it runs; there is no environment variable for a
# second output folder (distDir is next.config only, and next.config is shared
# with production builds). So the normal dev server must be stopped while the
# demo runs, and vice versa — this script refuses to start next to it. If the
# normal dev server misbehaves after a demo session ("React Client Manifest"
# 500s), `rm -rf .next/dev` and start it again.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin"
if [ ! -x "$NODE_BIN/node" ]; then NODE_BIN="$(dirname "$(command -v node)")"; fi
NODE="$NODE_BIN/node"
if [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "The demo needs Node 20 (found $("$NODE" -v) at $NODE_BIN). Run: nvm use" >&2
  exit 1
fi

CFG="$REPO/scripts/demo/demo-config.json"
cfg() { "$NODE" -e 'process.stdout.write(String(require(process.argv[1])[process.argv[2]]))' "$CFG" "$1"; }
DB_PORT="$(cfg dbPort)"
DEV_PORT="$(cfg devPort)"
DATA_NAME="$(cfg dataDirName)"
DATA_DIR="${DEMO_DATA_DIR:-$("$NODE" -p 'require("os").tmpdir()')/$DATA_NAME}"
DB_LOG="${DATA_DIR}.db.log"
BASE="http://localhost:${DEV_PORT}"
DB_URL="postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable"

refuse() { echo "run-demo-dev: refusing — $*" >&2; exit 1; }

# ---- 1. the database URL: the demo's loopback database or nothing ----------
case "$DB_URL" in
  "postgresql://postgres:postgres@127.0.0.1:5599/postgres?sslmode=disable") ;;
  *) refuse "DATABASE_URL would be $DB_URL; the demo only ever runs against 127.0.0.1:5599." ;;
esac
[ "$(basename "$DATA_DIR")" = "$DATA_NAME" ] || refuse "DEMO_DATA_DIR must end in /$DATA_NAME (got $DATA_DIR)."
case "$DATA_DIR" in *" "*) refuse "DEMO_DATA_DIR may not contain spaces (it goes into NODE_OPTIONS): $DATA_DIR" ;; esac

# ---- 2 + 3. the environment next dev gets: nothing inherited, every secret blank
RUNTIME="$DATA_DIR/runtime"
ENV_VARS=(
  "HOME=$HOME"
  "PATH=$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
  "TMPDIR=${TMPDIR:-/tmp}"
  "LANG=${LANG:-en_US.UTF-8}"
  "TERM=${TERM:-xterm-256color}"
  "NODE_ENV=development"
  "NEXT_TELEMETRY_DISABLED=1"
  "RTP_DEMO=1"
  "DEMO_DATA_DIR=$DATA_DIR"
  "NODE_OPTIONS=--require=$RUNTIME/demo-preload.cjs"
)
PINNED=(
  "DATABASE_URL=$DB_URL"
  "DIRECT_URL=$DB_URL"
  "APP_SECRET=$(cfg appSecret)"
  "NEXT_PUBLIC_APP_URL=$BASE"
)
KEEP=" HOME PATH TMPDIR LANG TERM NODE_ENV NEXT_TELEMETRY_DISABLED RTP_DEMO DEMO_DATA_DIR NODE_OPTIONS DATABASE_URL DIRECT_URL APP_SECRET NEXT_PUBLIC_APP_URL "
BLANK=()
add_blank() { case "$KEEP" in *" $1 "*) ;; *) case " ${BLANK[*]-} " in *" $1 "*) ;; *) BLANK+=("$1") ;; esac ;; esac; }
for f in "$REPO"/.env*; do
  [ -f "$f" ] || continue
  while IFS= read -r key; do add_blank "$key"; done < <(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$f")
done
while IFS= read -r key; do add_blank "$key"; done < <(grep -rhoE 'process\.env\.[A-Z][A-Z0-9_]*' "$REPO/src" | sed 's/process\.env\.//' | sort -u)
for key in ANTHROPIC_API_KEY OPENAI_API_KEY DEEPGRAM_API_KEY STRIPE_SECRET_KEY PLAID_CLIENT_ID PLAID_SECRET OPENPHONE_API_KEY SLACK_BOT_TOKEN ARYEO_API_KEY DROPBOX_ACCESS_TOKEN VERCEL_OIDC_TOKEN; do add_blank "$key"; done
for key in ${BLANK[@]+"${BLANK[@]}"}; do ENV_VARS+=("$key="); done
ENV_VARS+=("${PINNED[@]}")

if [ "${1:-}" = "--print-env" ]; then
  for kv in "${ENV_VARS[@]}"; do
    k="${kv%%=*}"; v="${kv#*=}"
    if [ -z "$v" ]; then echo "$k=(blank)"; else echo "$k=$v"; fi
  done
  exit 0
fi

listener() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true; }
ready_pid() { "$NODE" -e 'try { process.stdout.write(String(require(process.argv[1]).pid)) } catch {}' "$DATA_DIR/ready.json" 2>/dev/null || true; }

if [ "${1:-}" = "--stop" ]; then
  stopped=0
  L="$(listener "$DEV_PORT")"
  if [ -n "$L" ] && [ -f "$DATA_DIR/fence/$L.json" ]; then kill -TERM "$L" 2>/dev/null && echo "stopped the demo hub (pid $L)" && stopped=1; fi
  R="$(ready_pid)"
  if [ -n "$R" ] && [ "$(listener "$DB_PORT")" = "$R" ]; then kill -INT "$R" 2>/dev/null && echo "stopped the demo database (pid $R)" && stopped=1; fi
  [ "$stopped" = 1 ] || echo "no demo was running"
  exit 0
fi

# ---- one next dev per folder -------------------------------------------------
LOCK_HOLDER="$(lsof -t "$REPO/.next/dev/lock" 2>/dev/null | head -1 || true)"
[ -z "$LOCK_HOLDER" ] || refuse "a next dev server is already running in this folder (pid $LOCK_HOLDER). Stop the normal dev server first — Next 16 allows one per project folder."
[ -z "$(listener "$DEV_PORT")" ] || refuse "port $DEV_PORT is in use. If it is an old demo: scripts/demo/run-demo-dev.sh --stop"

# ---- the database: reuse the running one, or start it --------------------------
DB_PID=""
STARTED_DB=""
cleanup() {
  trap - EXIT INT TERM
  if [ -n "${NEXT_PID:-}" ] && kill -0 "$NEXT_PID" 2>/dev/null; then kill -TERM "$NEXT_PID" 2>/dev/null || true; wait "$NEXT_PID" 2>/dev/null || true; fi
  if [ -n "$STARTED_DB" ] && kill -0 "$DB_PID" 2>/dev/null; then
    echo "stopping the demo database (it keeps its data; --reset starts fresh)…"
    kill -INT "$DB_PID" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$DB_PID" 2>/dev/null || break; sleep 0.5; done
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

L="$(listener "$DB_PORT")"
if [ -z "$L" ]; then
  echo "starting the demo database (the first run seeds it: about a minute; later runs reuse it)…"
  mkdir -p "$(dirname "$DATA_DIR")"
  RESET_ARG=()
  [ "${1:-}" = "--reset" ] && RESET_ARG=(--reset)
  DEMO_DATA_DIR="$DATA_DIR" "$REPO/scripts/demo/run-demo-db.sh" "${RESET_ARG[@]+"${RESET_ARG[@]}"}" > "$DB_LOG" 2>&1 < /dev/null &
  DB_PID=$!
  STARTED_DB=1
  for _ in $(seq 1 600); do
    kill -0 "$DB_PID" 2>/dev/null || { tail -40 "$DB_LOG" >&2; refuse "the demo database did not start (log: $DB_LOG)."; }
    R="$(ready_pid)"
    if [ -n "$R" ] && [ "$(listener "$DB_PORT")" = "$R" ]; then break; fi
    sleep 0.5
  done
  R="$(ready_pid)"
  [ -n "$R" ] || refuse "the demo database did not report ready in 5 minutes (log: $DB_LOG)."
  DB_PID="$R"
else
  [ "${1:-}" != "--reset" ] || refuse "the demo database is already running (pid $L); stop it first to reset: scripts/demo/run-demo-dev.sh --stop"
  R="$(ready_pid)"
  [ "$R" = "$L" ] || refuse "port $DB_PORT is held by pid $L, which is not the isolated demo database (its ready file names ${R:-nobody})."
  DB_PID="$L"
  echo "using the demo database already running (pid $L)"
fi

# ---- 5. the fence, from a path without spaces (it rides in NODE_OPTIONS) -------
mkdir -p "$RUNTIME"
cp "$REPO/scripts/demo/demo-preload.cjs" "$REPO/scripts/demo/demo-config.json" "$RUNTIME/"
rm -rf "$DATA_DIR/fence"

cd "$REPO"
env -i "${ENV_VARS[@]}" "$NODE" "$REPO/node_modules/next/dist/bin/next" dev -p "$DEV_PORT" -H 127.0.0.1 &
NEXT_PID=$!

SERVING=""
for _ in $(seq 1 240); do
  kill -0 "$NEXT_PID" 2>/dev/null || refuse "next dev exited during startup (see above)."
  SERVING="$(listener "$DEV_PORT")"
  [ -n "$SERVING" ] && break
  sleep 0.5
done
[ -n "$SERVING" ] || refuse "next dev did not open port $DEV_PORT in 2 minutes."
if [ ! -f "$DATA_DIR/fence/$SERVING.json" ]; then
  kill -TERM "$NEXT_PID" 2>/dev/null || true
  refuse "the process serving port $DEV_PORT (pid $SERVING) did not load the demo network fence; stopped it before anything could reach a provider."
fi

cat <<EOF

==============================================================================
DEMO HUB READY on $BASE — isolated database 127.0.0.1:$DB_PORT, providers fenced.
The first page compiles for a few seconds. Walkthrough: docs/demo.md
Sign-in links below are single use and expire 15 minutes after the database
started; the client file's "Get sign-in link" button mints fresh ones.
==============================================================================

EOF
cat "$DATA_DIR/links.txt" 2>/dev/null || echo "(links: $DATA_DIR/links.txt)"
echo
echo "Ctrl-C stops the hub${STARTED_DB:+ and the demo database}."
wait "$NEXT_PID"
