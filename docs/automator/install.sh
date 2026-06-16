#!/bin/bash
# Creates or updates the TodoPup Automator app at /Applications/TodoPup.app.
# Run once on a new machine after cloning the repo.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/TodoPup.app"
STUB="/System/Library/Automator/Run Shell Script.action/Contents/MacOS/Run Shell Script"

if [ ! -d "$APP" ]; then
  echo "Creating $APP ..."
  mkdir -p "$APP/Contents/MacOS"
  mkdir -p "$APP/Contents/Resources"

  # The app bundle needs the Automator Application Stub binary.
  STUB_SRC="/System/Library/CoreServices/Automator Application Stub.app/Contents/MacOS/Automator Application Stub"
  if [ ! -f "$STUB_SRC" ]; then
    echo "Error: Automator Application Stub not found. Is Automator installed?"
    exit 1
  fi
  cp "$STUB_SRC" "$APP/Contents/MacOS/Automator Application Stub"
  cp "$SCRIPT_DIR/Info.plist" "$APP/Contents/Info.plist"
fi

echo "Installing workflow ..."
cp "$SCRIPT_DIR/document.wflow" "$APP/Contents/document.wflow"

# Touch the bundle so macOS re-registers it.
touch "$APP"

echo "Done. TodoPup is at $APP — drag it to your dock if needed."
