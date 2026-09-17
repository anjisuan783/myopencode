#!/usr/bin/env bash
set -euo pipefail

# install.sh - install the locally-built opencode binary into
# $OPENCODE_INSTALL_DIR (default ~/.opencode/bin), backing up any previous
# version first. --restore rolls back to that backup.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INSTALL_DIR="${OPENCODE_INSTALL_DIR:-$HOME/.opencode/bin}"
BINARY_NAME="opencode"
BASELINE=0
SOURCE=""
RESTORE=0

usage() {
  cat <<EOF
Usage: $0 [options]

Install the locally-built opencode binary into \$OPENCODE_INSTALL_DIR (default
$HOME/.opencode/bin), backing up any previous version first.

Options:
  --source PATH  Path to the built binary (default: auto-detected from dist/)
  --baseline     Use the baseline (non-AVX2) build
  --dir DIR      Install directory (or set \$OPENCODE_INSTALL_DIR)
  --restore      Restore the previous backup instead of installing
  -h, --help     Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE="$2"
      shift 2
      ;;
    --baseline)
      BASELINE=1
      shift
      ;;
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --restore)
      RESTORE=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

install_binary() {
  local src="$1"
  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$src" "$INSTALL_DIR/$BINARY_NAME"
}

backup_path() {
  echo "$INSTALL_DIR/$BINARY_NAME.bak"
}

detect_source() {
  local os arch suffix="" base
  case "$(uname -s)" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    MINGW* | MSYS* | CYGWIN*) os="windows" && suffix=".exe" ;;
    *) echo "unsupported os: $(uname -s)" >&2 && exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) echo "unsupported arch: $(uname -m)" >&2 && exit 1 ;;
  esac
  base="opencode-$os-$arch"
  if [[ "$BASELINE" -eq 1 ]]; then
    base="opencode-$os-$arch-baseline"
  fi
  echo "$ROOT/packages/opencode/dist/$base/bin/$BINARY_NAME$suffix"
}

if [[ "$RESTORE" -eq 1 ]]; then
  local_backup="$(backup_path)"
  if [[ ! -f "$local_backup" ]]; then
    echo "no backup found at $local_backup" >&2
    exit 1
  fi
  install_binary "$local_backup"
  echo "restored previous version from $local_backup"
  "$INSTALL_DIR/$BINARY_NAME" --version
  exit 0
fi

if [[ -n "$SOURCE" ]]; then
  SRC="$SOURCE"
else
  SRC="$(detect_source)"
fi

if [[ ! -f "$SRC" ]]; then
  echo "built binary not found: $SRC" >&2
  echo "build it first: bun run build" >&2
  exit 1
fi

if [[ -f "$INSTALL_DIR/$BINARY_NAME" ]]; then
  mkdir -p "$INSTALL_DIR"
  cp -p "$INSTALL_DIR/$BINARY_NAME" "$(backup_path)"
  echo "backed up previous version to $(backup_path)"
fi

install_binary "$SRC"
echo "installed $SRC -> $INSTALL_DIR/$BINARY_NAME"
"$INSTALL_DIR/$BINARY_NAME" --version
