#!/bin/bash
# Reinstall script for Multi Monitor Bar extension

EXT_UUID="multi-monitors-bar@frederykabryan"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Disabling extension..."
gnome-extensions disable "$EXT_UUID" 2>/dev/null

echo "Removing old installation..."
rm -rf "$EXT_DIR"

echo "Creating extension directory..."
mkdir -p "$EXT_DIR"

echo "Copying files..."
# Copy everything from the source directory to the extension install dir so newly
# added modules (e.g. mmPanelConstants.js, statusIndicatorsController.js,
# mirroredIndicatorButton.js) are included automatically.
# Exclude VCS metadata, zip files, and problematic workspace indicator file.
rsync -a --exclude='.git' --exclude='.gitignore' --exclude='*.zip' --exclude='schemas/gschemas.compiled' --exclude='mmworkspaceindicator.js' --exclude='.claude' "$SOURCE_DIR/" "$EXT_DIR/"

# GNOME Shell asks extensions.gnome.org about every per-user extension on login.
# When the local version differs from the published one, EGO replies
# "upgrade"/"downgrade" and the shell silently swaps in the EGO build on the
# next restart. Dropping "version" from the *installed* metadata makes EGO
# ignore this dev copy (the repo's metadata.json is left untouched).
echo "Stripping version from installed metadata (prevents EGO auto-downgrade)..."
python3 - "$EXT_DIR/metadata.json" <<'PY'
import json, sys
p = sys.argv[1]
with open(p) as f:
    m = json.load(f)
m.pop("version", None)
with open(p, "w") as f:
    json.dump(m, f, indent=4)
    f.write("\n")
PY
rm -rf "$HOME/.local/share/gnome-shell/extension-updates/$EXT_UUID"

echo "Compiling schemas..."
glib-compile-schemas "$EXT_DIR/schemas/"

echo "Enabling extension..."
gnome-extensions enable "$EXT_UUID"

echo ""
echo "✅ Extension reinstalled successfully!"
echo ""
echo "⚠️  IMPORTANT: On Wayland, you must LOG OUT and LOG BACK IN for changes to take effect."
echo "    On X11, you can restart GNOME Shell by pressing Alt+F2, typing 'r', and pressing Enter."
echo ""
