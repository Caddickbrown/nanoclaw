#!/bin/bash
# Start claude CLI to trigger OAuth token refresh, then exit cleanly after ~10s.
# Running claude re-authenticates and updates ~/.claude/.credentials.json.

LOG="/tmp/claude-oauth-refresh.log"
echo "[$(date)] Starting claude OAuth refresh..." >> "$LOG"

# Feed claude a 10-second delayed /exit so it has time to initialise and refresh tokens.
# timeout 30 sends SIGTERM (graceful) if it hasn't exited by then.
(sleep 10; printf '/exit\n') | timeout 30 claude 2>>"$LOG"
STATUS=$?

if [ $STATUS -eq 0 ] || [ $STATUS -eq 143 ]; then
  echo "[$(date)] Done (exit $STATUS)" >> "$LOG"
else
  echo "[$(date)] Unexpected exit $STATUS" >> "$LOG"
fi
