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
rsync -a --exclude='.git' --exclude='.gitignore' --exclude='*.zip' --exclude='mmworkspaceindicator.js' --exclude='.claude' "$SOURCE_DIR/" "$EXT_DIR/"

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
