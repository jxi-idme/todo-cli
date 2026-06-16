#!/bin/bash
# Double-click this file to launch the To-Do app and open it in the browser.
# The server auto-quits ~30 seconds after you close the last browser tab.
# Re-clicking this icon always starts fresh.

# Always run from the folder this script lives in.
cd "$(dirname "$0")" || exit 1

PORT=5001
URL="http://127.0.0.1:${PORT}"

# Bootstrap the virtualenv on first run.
if [ ! -d ".venv" ]; then
  echo "First run: setting up the environment (one time only)..."
  if command -v uv >/dev/null 2>&1; then
    uv venv && uv pip install -r requirements.txt
  else
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
  fi
fi

# Kill any server already on this port so re-launching never hits "address in use".
EXISTING=$(lsof -ti "tcp:${PORT}" 2>/dev/null)
if [ -n "$EXISTING" ]; then
  kill $EXISTING 2>/dev/null
  sleep 1
  STILL=$(lsof -ti "tcp:${PORT}" 2>/dev/null)
  [ -n "$STILL" ] && kill -9 $STILL 2>/dev/null
fi

# start_server.py uses a double-fork so it returns immediately to this script,
# with Flask running as a completely detached daemon process.
.venv/bin/python start_server.py

# Poll until the server is ready, then open the browser.
# --max-time 1 prevents curl from hanging if Flask didn't start.
for i in $(seq 1 20); do
  sleep 0.5
  curl -s --max-time 1 "$URL" -o /dev/null && break
done
open "$URL"

# Script exits here — the dock icon clears immediately.
