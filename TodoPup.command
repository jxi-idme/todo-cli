#!/bin/bash
# Double-click this file to launch the To-Do app.
# A Terminal window will open and stay open while the app runs.
# To stop the app: press Ctrl+C in that window, or just close it.

# Always run from the folder this script lives in (so it works wherever you move it).
cd "$(dirname "$0")" || exit 1

PORT=5001
URL="http://127.0.0.1:${PORT}"

# Create the virtualenv + install deps on first run if it's missing.
# Works whether or not `uv` is installed (falls back to standard venv + pip).
if [ ! -d ".venv" ]; then
  echo "First run: setting up the environment (one time only)..."
  if command -v uv >/dev/null 2>&1; then
    uv venv && uv pip install -r requirements.txt
  else
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
  fi
fi

# Stop any server already listening on this port, so re-launching never hits
# "Address already in use" -- we just take over the port.
EXISTING=$(lsof -ti "tcp:${PORT}" 2>/dev/null)
if [ -n "$EXISTING" ]; then
  echo "Stopping the server already running on port ${PORT} (PID: ${EXISTING})..."
  kill $EXISTING 2>/dev/null
  # Give it a moment to release the port; force-kill anything still holding on.
  sleep 1
  STILL=$(lsof -ti "tcp:${PORT}" 2>/dev/null)
  [ -n "$STILL" ] && kill -9 $STILL 2>/dev/null
fi

# Open the browser a couple seconds after the server starts.
( sleep 2 && open "$URL" ) &

echo "Starting To-Do app at ${URL}"
echo "Leave this window open while you use the app. Close it (or press Ctrl+C) to stop."
echo ""

# Run the server in the foreground — this window IS the running app.
exec .venv/bin/python -m flask --app app run --port "$PORT"
