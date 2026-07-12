#!/usr/bin/env bash
# Installs the Clipboard Manager GNOME Shell extension for the current user.
set -euo pipefail

UUID="clipboard-manager@bytemastermind"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [[ ! -d "$SRC" ]]; then
    echo "error: $SRC not found" >&2
    exit 1
fi

if ! command -v glib-compile-schemas >/dev/null; then
    echo "error: glib-compile-schemas missing (sudo apt install libglib2.0-bin)" >&2
    exit 1
fi

echo "→ Compiling settings schema"
glib-compile-schemas "$SRC/schemas"

echo "→ Installing to $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"

echo "→ Enabling extension"
if ! gnome-extensions enable "$UUID" 2>/dev/null; then
    # The running shell only scans for new extensions at login; register the
    # UUID directly so it auto-enables on the next session.
    python3 - "$UUID" <<'EOF'
import subprocess, sys, ast
uuid = sys.argv[1]
out = subprocess.check_output(
    ["gsettings", "get", "org.gnome.shell", "enabled-extensions"]).decode()
cur = [] if out.strip() == "@as []" else ast.literal_eval(out)
if uuid not in cur:
    cur.append(uuid)
    subprocess.check_call(
        ["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(cur)])
EOF
fi

echo
echo "Installed."
if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
    echo "Wayland session: log out and back in to load the extension,"
    echo "then it activates automatically. Toggle the popup with Ctrl+Alt+H."
else
    echo "X11 session: press Alt+F2, type 'r', press Enter to reload GNOME Shell."
fi
