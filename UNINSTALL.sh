#!/usr/bin/env bash
# StudyDeck - uninstall (Linux / macOS)
#
# Asks before removing each part, and shows exactly what it found. It only touches StudyDeck's own files:
#   - the "StudyDeck" folder the build scripts made (next to this file)
#   - the libraries downloaded on first run (the node_modules folder next to this file)
#   - the copy of Node.js that StudyDeck's scripts downloaded for themselves (never a Node.js you installed yourself)
#   - menu / launcher entries made for the AppImage
#   - YOUR DATA (decks, notes, friends, plugins, settings). This one is always asked separately and the
#     answer is "no" unless you type y, so a reinstall keeps everything.
# It never deletes this source folder itself. When it is finished it tells you where it is so you can delete it by hand.
#
# For scripts and tests only:  STUDYDECK_UNINSTALL_YES=1 answers "yes" to the program parts (never to your data);
#                              STUDYDECK_UNINSTALL_DATA=1 also answers "yes" to your data.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
HOME_DIR="${HOME:-}"
case "$(uname -s)" in
  Darwin) DATA_DIR="$HOME_DIR/Library/Application Support/studydeck" ;;
  *)      DATA_DIR="${XDG_CONFIG_HOME:-$HOME_DIR/.config}/studydeck" ;;
esac
NODE_DIR="${STUDYDECK_NODE_DIR:-$HOME_DIR/.local/share/studydeck-node}"
APPS_DIR="${XDG_DATA_HOME:-$HOME_DIR/.local/share}"

echo "============================================================="
echo "  StudyDeck - uninstall"
echo "============================================================="
echo

if [ -z "$HOME_DIR" ] || [ ! -d "$HOME_DIR" ]; then
  echo "Your home folder could not be found, so nothing was changed."
  exit 1
fi

# refuses anything that is empty, the top of the disk, or the home folder itself
safe_rm() {
  local p="$1"
  case "$p" in ""|"/"|"$HOME_DIR"|"$HOME_DIR/") echo "  (refused to remove \"$p\")"; return 1 ;; esac
  rm -rf -- "$p"
}

ask() {   # ask "question" default(y/n) -> 0 for yes
  local q="$1" def="$2" ans
  if [ "${STUDYDECK_UNINSTALL_YES:-}" = "1" ] && [ "$def" = "y" ]; then return 0; fi
  if [ "${STUDYDECK_UNINSTALL_DATA:-}" = "1" ] && [ "$def" = "n" ]; then return 0; fi
  if [ ! -t 0 ] && [ -z "${STUDYDECK_UNINSTALL_ANSWERS:-}" ]; then return 1; fi
  if [ "$def" = "y" ]; then read -r -p "$q [Y/n] " ans; case "$ans" in n|N|no|NO) return 1 ;; *) return 0 ;; esac
  else read -r -p "$q [y/N] " ans; case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac; fi
}

size_of() { du -sh "$1" 2>/dev/null | cut -f1; }

# 1. a running StudyDeck would keep files in use
if pgrep -x studydeck >/dev/null 2>&1 || pgrep -f "StudyDeck\.AppImage" >/dev/null 2>&1; then
  echo "StudyDeck is running. Please close it first (then run this again)."
  echo "If it is not visible, look for it in the system tray."
  if ! ask "Close it for you now?" n; then exit 1; fi
  pkill -f "StudyDeck.AppImage" 2>/dev/null; pkill -x studydeck 2>/dev/null; sleep 2
fi

removed=0; kept=0
item() {   # item "what it is" "path" "default"
  local what="$1" p="$2" def="${3:-y}"
  [ -e "$p" ] || return 0
  echo "$what"
  echo "    $p  ($(size_of "$p"))"
  if ask "    Remove it?" "$def"; then safe_rm "$p" && { echo "    removed."; removed=$((removed + 1)); }; else echo "    kept."; kept=$((kept + 1)); fi
  echo
}

item "The finished program (made by BUILD-APP):" "$DIR/StudyDeck" y
item "The libraries StudyDeck downloaded on its first run:" "$DIR/node_modules" y
item "The copy of Node.js that StudyDeck's scripts downloaded for themselves (a Node.js you installed yourself is never touched):" "$NODE_DIR" y

# a Mac copy that was dragged into Applications
[ "$(uname -s)" = "Darwin" ] && item "The StudyDeck app in your Applications folder:" "/Applications/StudyDeck.app" y

shopt -s nullglob
launchers=("$APPS_DIR"/applications/studydeck*.desktop "$APPS_DIR"/applications/appimagekit-studydeck*.desktop "$APPS_DIR"/icons/hicolor/*/apps/studydeck* "$APPS_DIR"/icons/hicolor/*/apps/appimagekit-studydeck*)
if [ ${#launchers[@]} -gt 0 ]; then
  echo "Menu / launcher entries for StudyDeck:"
  for f in "${launchers[@]}"; do echo "    $f"; done
  if ask "    Remove them?" y; then for f in "${launchers[@]}"; do safe_rm "$f"; done; echo "    removed."; removed=$((removed + 1)); else echo "    kept."; kept=$((kept + 1)); fi
  echo
fi

if [ -e "$DATA_DIR" ]; then
  echo "YOUR DATA: decks, notes, friends, plugins and settings."
  echo "    $DATA_DIR  ($(size_of "$DATA_DIR"))"
  echo "    Keep this if you might install StudyDeck again. Removing it cannot be undone."
  if ask "    Delete your data too?" n; then safe_rm "$DATA_DIR" && { echo "    removed."; removed=$((removed + 1)); }; else echo "    kept."; kept=$((kept + 1)); fi
  echo
fi

echo "============================================================="
echo "  Finished: $removed removed, $kept kept."
echo "============================================================="
echo
echo "This source folder was not deleted. If you no longer want it, delete this folder yourself:"
echo "    $DIR"
exit 0
