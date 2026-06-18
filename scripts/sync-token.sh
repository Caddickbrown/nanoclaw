#!/bin/bash
set -euo pipefail

LOG="$HOME/nanoclaw/logs/token-sync.log"
HEARTBEAT="$HOME/nanoclaw/.token-sync-heartbeat"
CREDENTIALS="$HOME/.claude/.credentials.json"
LAST_HASH="$HOME/nanoclaw/.last-synced-token-hash"
EXPIRY_STATE="$HOME/nanoclaw/.token-expiry-state"

# Log rotation (5MB) — Linux stat uses -c%s
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  mv "$LOG" "${LOG}.old"
fi

log() { echo "$(date -Iseconds) $*" >> "$LOG"; }

# Heartbeat
touch "$HEARTBEAT"

# Read credentials
if [ ! -f "$CREDENTIALS" ]; then
  log "ERROR: credentials file not found at $CREDENTIALS"
  exit 1
fi

KC_ACCESS=$(python3 -c "import json; d=json.load(open('$CREDENTIALS')); print(d.get('claudeAiOauth',{}).get('accessToken',''))" 2>/dev/null) || { log "ERROR: credentials parse failed"; exit 1; }
KC_EXPIRES=$(python3 -c "import json; d=json.load(open('$CREDENTIALS')); print(d.get('claudeAiOauth',{}).get('expiresAt',0))" 2>/dev/null)
KC_SUFFIX="${KC_ACCESS: -8}"
KC_EXP_HUMAN=$(python3 -c "from datetime import datetime; print(datetime.fromtimestamp($KC_EXPIRES/1000).strftime('%H:%M'))" 2>/dev/null)

log "credentials token: ...$KC_SUFFIX expires=$KC_EXP_HUMAN"

# Check if token hash changed (log changes but no restart needed — NanoClaw reads directly)
NEW_HASH=$(echo -n "$KC_ACCESS" | sha256sum | cut -c1-16)
OLD_HASH=""
[ -f "$LAST_HASH" ] && OLD_HASH=$(cat "$LAST_HASH")

if [ "$NEW_HASH" != "$OLD_HASH" ]; then
  log "Token changed (new hash=$NEW_HASH) — NanoClaw will pick it up on next request"
  echo -n "$NEW_HASH" > "$LAST_HASH"
fi

# Expiry awareness
EXPIRY_CHECK=$(python3 -c "
import time
expires_ms = $KC_EXPIRES
now_ms = int(time.time() * 1000)
remaining = (expires_ms - now_ms) // 1000
if remaining <= 0:
    print(f'EXPIRED:{remaining}')
elif remaining <= 300:
    print(f'EXPIRING_SOON:{remaining}')
else:
    print(f'OK:{remaining}')
" 2>/dev/null)

case "$EXPIRY_CHECK" in
  EXPIRED:*)
    SECS="${EXPIRY_CHECK#EXPIRED:}"
    log "WARNING: token is EXPIRED (${SECS}s ago). Refresh daemon should handle this."
    log "If this persists for >10 min, the refresh daemon may be dead."
    echo "{\"state\":\"expired\",\"since\":\"$(date -Iseconds)\",\"expired_sec_ago\":${SECS#-}}" > "$EXPIRY_STATE"
    ;;
  EXPIRING_SOON:*)
    SECS="${EXPIRY_CHECK#EXPIRING_SOON:}"
    log "NOTICE: token expiring in ${SECS}s. Refresh daemon should fire soon."
    ;;
  OK:*)
    rm -f "$EXPIRY_STATE"
    ;;
esac
