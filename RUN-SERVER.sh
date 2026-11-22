#!/usr/bin/env bash
# StudyDeck - start the friends server on this computer (see server/README.md).
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
# shellcheck disable=SC1091
source ./ENSURE-NODE.sh
ensure_node || exit 1
node server/server.js
