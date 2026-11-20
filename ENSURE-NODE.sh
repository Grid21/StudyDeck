#!/usr/bin/env bash
# StudyDeck - makes sure Node.js 24 or newer is available (Linux / macOS).
# Use it like this:   source ENSURE-NODE.sh; ensure_node || exit 1
# If a good Node.js is already installed it is used and nothing is downloaded.
# Otherwise a private copy is downloaded from nodejs.org into
#   ~/.local/share/studydeck-node
# (it never touches or replaces a Node.js you installed yourself; UNINSTALL.sh can remove it).

STUDYDECK_NODE_MIN=24

_sd_node_major() { "$1" -p "process.versions.node.split('.')[0]" 2>/dev/null; }

ensure_node() {
  local dir="${STUDYDECK_NODE_DIR:-${HOME}/.local/share/studydeck-node}"
  local major

  if command -v node >/dev/null 2>&1; then
    major="$(_sd_node_major node)"
    if [ -n "$major" ] && [ "$major" -ge "$STUDYDECK_NODE_MIN" ] 2>/dev/null; then return 0; fi
  fi

  if [ -x "$dir/bin/node" ]; then
    major="$(_sd_node_major "$dir/bin/node")"
    if [ -n "$major" ] && [ "$major" -ge "$STUDYDECK_NODE_MIN" ] 2>/dev/null; then
      export PATH="$dir/bin:$PATH"; return 0
    fi
  fi

  echo "Node.js $STUDYDECK_NODE_MIN or newer was not found. Downloading it now (about 30 MB)..."

  local os arch
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "This system is not supported."; return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "This processor type ($(uname -m)) is not supported."; return 1 ;; esac

  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    echo "Neither curl nor wget was found. Install curl (sudo apt install curl) or install Node.js from https://nodejs.org"
    return 1
  fi
  if ! command -v tar >/dev/null 2>&1; then echo "tar was not found, so Node.js cannot be unpacked."; return 1; fi

  _sd_get() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -q "$1" -O "$2"; fi; }

  local tmp; tmp="$(mktemp -d)" || return 1
  if ! _sd_get "https://nodejs.org/dist/index.json" "$tmp/index.json"; then
    echo "Could not reach nodejs.org. Check your internet connection, or install Node.js from https://nodejs.org"
    rm -rf "$tmp"; return 1
  fi
  # the list is newest first, so the first v24.x entry is the newest 24.x
  local ver; ver="$(grep -o "\"version\":\"v${STUDYDECK_NODE_MIN}\.[0-9]*\.[0-9]*\"" "$tmp/index.json" | head -n1 | sed 's/.*"\(v[0-9.]*\)"/\1/')"
  if [ -z "$ver" ]; then echo "Could not find a Node.js $STUDYDECK_NODE_MIN version on nodejs.org."; rm -rf "$tmp"; return 1; fi

  local name="node-$ver-$os-$arch"
  echo "Downloading Node.js $ver ..."
  if ! _sd_get "https://nodejs.org/dist/$ver/$name.tar.gz" "$tmp/node.tar.gz"; then
    echo "The Node.js download did not finish. Check your internet connection and try again."
    rm -rf "$tmp"; return 1
  fi
  # verify the download against nodejs.org's published checksum when possible
  if _sd_get "https://nodejs.org/dist/$ver/SHASUMS256.txt" "$tmp/SHASUMS256.txt"; then
    local want got
    want="$(grep " $name.tar.gz\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
    if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/node.tar.gz" | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then got="$(shasum -a 256 "$tmp/node.tar.gz" | cut -d' ' -f1)"; fi
    if [ -n "$want" ] && [ -n "$got" ] && [ "$want" != "$got" ]; then
      echo "The downloaded file is damaged (checksum mismatch). Nothing was installed. Please try again."
      rm -rf "$tmp"; return 1
    fi
  fi

  mkdir -p "$dir" || { rm -rf "$tmp"; return 1; }
  if ! tar -xzf "$tmp/node.tar.gz" -C "$dir" --strip-components=1; then
    echo "Could not unpack Node.js."; rm -rf "$tmp"; return 1
  fi
  rm -rf "$tmp"
  export PATH="$dir/bin:$PATH"
  echo "Node.js $ver is ready."
  return 0
}
