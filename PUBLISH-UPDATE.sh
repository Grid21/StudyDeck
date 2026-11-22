#!/usr/bin/env bash
# StudyDeck - build the update file and send it (with the source) to GitHub, into the "Updates" folder.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
echo "============================================================="
echo "  StudyDeck - publish an update to GitHub"
echo "============================================================="
echo
DIR="$(pwd)"
ENSURE="$DIR/ENSURE-NODE.sh"
if [ -f "$ENSURE" ]; then source "$ENSURE"; ensure_node || exit 1
elif ! command -v node >/dev/null 2>&1; then echo "Node.js was not found. Install it from https://nodejs.org"; exit 1; fi
if ! command -v git >/dev/null 2>&1; then echo "Git was not found. Install it from https://git-scm.com"; exit 1; fi
if [ ! -d .git ]; then
  echo "This folder is not connected to GitHub yet. Do this once:"
  echo "  1. git clone https://github.com/Grid21/StudyDeck.git"
  echo "  2. copy the StudyDeck program files into that new folder (replace when asked)"
  echo "  3. run PUBLISH-UPDATE.sh from inside it"
  exit 1
fi
NOTES="${1:-$(node -e "const t=require('fs').readFileSync('CHANGELOG.md','utf8').split(/\n## /)[1]||'';console.log(t.split('\n').slice(1).join(' ').trim().slice(0,400))")}"
VERSION="$(node -p "require('./package.json').version")"
mkdir -p Updates
echo "Building update $VERSION ..."
node tools/make-update.js --notes "$NOTES" --out Updates || { echo "Building the update failed."; exit 1; }
git add -A
if git diff --cached --quiet; then echo "Nothing new to send. (Is the version number in package.json new?)"; exit 0; fi
git commit -q -m "StudyDeck $VERSION" || exit 1
echo "Sending to GitHub (it may ask you to sign in) ..."
if git push; then echo; echo "Done. Version $VERSION is on GitHub. Running copies of StudyDeck will offer it."
else echo; echo "Sending failed. Check that you are signed in to GitHub and have permission, then run this again."; exit 1; fi
