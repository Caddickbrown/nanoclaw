#!/bin/bash
# Switch NanoClaw between OAuth and API key auth modes.
# Usage: ./scripts/auth-mode.sh [oauth|api-key|status]

set -e

ENV_FILE="$(dirname "$0")/../.env"
DATA_ENV="$(dirname "$0")/../data/env/env"

current() {
  grep -m1 '^AUTH_MODE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "unset (auto)"
}

status() {
  mode=$(current)
  echo "Current AUTH_MODE: $mode"
  grep -q '^CLAUDE_CODE_OAUTH_TOKEN=sk-' "$ENV_FILE" 2>/dev/null && echo "OAuth token:  present" || echo "OAuth token:  MISSING"
  grep -q '^ANTHROPIC_API_KEY=sk-' "$ENV_FILE" 2>/dev/null && echo "API key:      present" || echo "API key:      MISSING"
}

switch() {
  target="$1"
  if ! grep -q "^AUTH_MODE=" "$ENV_FILE" 2>/dev/null; then
    echo "AUTH_MODE=$target" >> "$ENV_FILE"
  else
    sed -i "s/^AUTH_MODE=.*/AUTH_MODE=$target/" "$ENV_FILE"
  fi
  cp "$ENV_FILE" "$DATA_ENV"
  systemctl --user restart nanoclaw
  echo "Switched to $target mode and restarted nanoclaw."
}

case "${1:-status}" in
  oauth)    switch oauth ;;
  api-key)  switch api-key ;;
  status)   status ;;
  *)        echo "Usage: $0 [oauth|api-key|status]"; exit 1 ;;
esac
