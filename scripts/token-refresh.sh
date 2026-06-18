#!/bin/bash
# Expiry-aware token refresh for NanoClaw on Linux.
# Runs every 5 minutes but is cheap (file read only) when token is healthy.
# When token is near expiry, invokes the Claude CLI to refresh it.

LOG="$HOME/nanoclaw/logs/token-refresh.log"
CREDENTIALS="$HOME/.claude/.credentials.json"
REFRESH_BUFFER_SEC=600  # Trigger refresh when <10 min remaining
CLAUDE_BIN="$HOME/.local/bin/claude"

# Log rotation (1MB) — Linux stat uses -c%s
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  mv "$LOG" "${LOG}.old"
fi

log() { echo "$(date -Iseconds) [refresh] $*" >> "$LOG"; }

# Read token expiry from credentials file
if [ ! -f "$CREDENTIALS" ]; then
  log "ERROR: credentials file not found at $CREDENTIALS"
  exit 1
fi

EXPIRES_MS=$(python3 -c "import json; d=json.load(open('$CREDENTIALS')); print(d.get('claudeAiOauth',{}).get('expiresAt',0))" 2>/dev/null)

if [ -z "$EXPIRES_MS" ] || [ "$EXPIRES_MS" = "0" ]; then
  log "ERROR: no expiresAt in credentials — forcing refresh (fallback)"
  (sleep 10; printf '/exit\n') | timeout 30 "$CLAUDE_BIN" >> "$LOG" 2>&1
  exit $?
fi

NOW_MS=$(python3 -c "import time; print(int(time.time() * 1000))")
REMAINING_SEC=$(( (EXPIRES_MS - NOW_MS) / 1000 ))
EXPIRES_HUMAN=$(python3 -c "from datetime import datetime; print(datetime.fromtimestamp($EXPIRES_MS/1000).strftime('%H:%M:%S'))")

if [ "$REMAINING_SEC" -le 0 ]; then
  log "TOKEN EXPIRED (expired at $EXPIRES_HUMAN, ${REMAINING_SEC}s ago) — emergency refresh via Claude CLI"
  (sleep 10; printf '/exit\n') | timeout 30 "$CLAUDE_BIN" >> "$LOG" 2>&1
  exit $?
elif [ "$REMAINING_SEC" -le "$REFRESH_BUFFER_SEC" ]; then
  log "TOKEN EXPIRING SOON (expires $EXPIRES_HUMAN, ${REMAINING_SEC}s left) — refreshing via Claude CLI"
  (sleep 10; printf '/exit\n') | timeout 30 "$CLAUDE_BIN" >> "$LOG" 2>&1
  exit $?
else
  log "token healthy (expires $EXPIRES_HUMAN, ${REMAINING_SEC}s left) — skipping"
  exit 0
fi
