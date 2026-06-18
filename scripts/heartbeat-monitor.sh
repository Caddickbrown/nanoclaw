#!/bin/bash
HEARTBEAT="$HOME/nanoclaw/.token-sync-heartbeat"
ALERT_DIR="$HOME/nanoclaw/alerts"
ALERT_FILE="$ALERT_DIR/token-sync-down.alert"
LOG="$HOME/nanoclaw/logs/heartbeat-monitor.log"

mkdir -p "$ALERT_DIR"

# Skip during boot grace period (first 10 min) — Linux reads uptime from /proc/uptime
UPTIME_SEC=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 99999)
if [ "$UPTIME_SEC" -lt 600 ]; then
  echo "$(date -Iseconds) boot grace period (${UPTIME_SEC}s uptime) — skipping" >> "$LOG"
  exit 0
fi

NOW=$(date +%s)

# Check NanoClaw service is running
if ! systemctl --user is-active --quiet nanoclaw 2>/dev/null; then
  echo "{\"alert\":\"nanoclaw-down\",\"since\":\"$(date -Iseconds)\",\"reason\":\"systemd service not active\"}" > "$ALERT_DIR/nanoclaw-down.alert"
  echo "$(date -Iseconds) ALERT: nanoclaw service is not active" >> "$LOG"
else
  rm -f "$ALERT_DIR/nanoclaw-down.alert"
fi

# Check token-sync heartbeat
if [ ! -f "$HEARTBEAT" ]; then
  echo "{\"alert\":\"token-sync-down\",\"since\":\"$(date -Iseconds)\",\"reason\":\"no heartbeat file\"}" > "$ALERT_FILE"
  echo "$(date -Iseconds) ALERT: no heartbeat file" >> "$LOG"
  exit 0
fi

# Linux stat uses -c%Y for modification time
AGE=$(( NOW - $(stat -c%Y "$HEARTBEAT") ))
if [ "$AGE" -gt 300 ]; then
  echo "{\"alert\":\"token-sync-down\",\"since\":\"$(date -Iseconds)\",\"age\":$AGE,\"reason\":\"heartbeat stale\"}" > "$ALERT_FILE"
  echo "$(date -Iseconds) ALERT: heartbeat is ${AGE}s old" >> "$LOG"
else
  [ -f "$ALERT_FILE" ] && rm "$ALERT_FILE"
  echo "$(date -Iseconds) OK: heartbeat is ${AGE}s old" >> "$LOG"
fi
