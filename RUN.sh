#!/usr/bin/env bash
# StudyDeck - start the program straight from this folder (no building needed).
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
DIR="$(pwd)"
# shellcheck disable=SC1091
source "$DIR/ENSURE-NODE.sh"
ensure_node || exit 1

if [ ! -d node_modules/electron ]; then
  echo "First run: downloading the libraries (a few minutes, internet needed)."
  npm install --no-audit --no-fund || { echo "The download did not finish. Check your internet connection and run ./RUN.sh again."; exit 1; }
fi
npm start
