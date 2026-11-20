#!/usr/bin/env bash
# Runs the window tests: import, study, progress, plugins, settings, installing a .studyupdate, restart, go back.
# Needs a display (on a server: xvfb-run is used automatically). Root users get --no-sandbox.
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
export UI_TEST_DATA="$(mktemp -d)"
EL="node_modules/electron/dist/electron"; [ -x "$EL" ] || EL="node_modules/.bin/electron"
FLAGS=""; [ "$(id -u)" = "0" ] && FLAGS="--no-sandbox"
RUNNER=""; [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null && RUNNER="xvfb-run -a"
for phase in 1 2 3; do
  $RUNNER "$EL" test/ui-main.js $FLAGS --phase=$phase 2>&1 | grep -E "^(ok|FAIL|UI TEST|NEXT)" || exit 1
  pkill -f "dist/electron" 2>/dev/null; sleep 1
done
rm -rf "$UI_TEST_DATA"
