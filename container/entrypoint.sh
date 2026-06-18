#!/bin/bash
set -e
ulimit -c 0

DIST=/app/dist
BUILD_TS=/app/dist/.build-timestamp

# Use pre-compiled dist if src hasn't changed since image build
if [ -f "$BUILD_TS" ] && ! find /app/src -newer "$BUILD_TS" -name "*.ts" | grep -q .; then
  echo "[entrypoint] Using pre-compiled dist" >&2
else
  echo "[entrypoint] Recompiling (source modified)..." >&2
  cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
  ln -s /app/node_modules /tmp/dist/node_modules
  chmod -R a-w /tmp/dist
  DIST=/tmp/dist
fi

cat > /tmp/input.json
node "$DIST/index.js" < /tmp/input.json
