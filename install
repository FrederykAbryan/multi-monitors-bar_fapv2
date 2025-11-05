#!/bin/bash

# Multi Monitors Add-On Installation Script
# For GNOME Shell 40-46

set -e

EXTENSION_UUID="multi-monitors-bar@frederykabryan"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "=========================================="
echo "Multi Monitors Add-On Installation"
echo "=========================================="
echo ""

# Check if GNOME Shell is installed
if ! command -v gnome-shell &> /dev/null; then
    echo "Error: GNOME Shell is not installed."
    exit 1
fi

# Get GNOME Shell version
GNOME_VERSION=$(gnome-shell --version | cut -d' ' -f3 | cut -d'.' -f1)
echo "Detected GNOME Shell version: $GNOME_VERSION"

if [ "$GNOME_VERSION" -lt 40 ] || [ "$GNOME_VERSION" -gt 46 ]; then
    echo "Warning: This extension is designed for GNOME Shell 40-46."
    echo "Your version ($GNOME_VERSION) may not be fully supported."
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Create extensions directory if it doesn't exist
echo "Creating extensions directory..."
mkdir -p "$HOME/.local/share/gnome-shell/extensions"

# Check if extension is already installed
if [ -d "$EXTENSION_DIR" ]; then
    echo ""
    echo "Extension is already installed at: $EXTENSION_DIR"
    read -p "Overwrite existing installation? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Removing old installation..."
        rm -rf "$EXTENSION_DIR"
    else
        echo "Installation cancelled."
        exit 0
    fi
fi

# Copy extension files
echo "Installing extension files..."
cp -r "$SCRIPT_DIR" "$EXTENSION_DIR"

# Remove unnecessary files from installation
echo "Cleaning up installation..."
rm -f "$EXTENSION_DIR/install.sh"
rm -f "$EXTENSION_DIR/README.md.backup" 2>/dev/null || true
rm -rf "$EXTENSION_DIR/.claude" 2>/dev/null || true

# Compile schemas
echo "Compiling GSettings schemas..."
if command -v glib-compile-schemas &> /dev/null; then
    glib-compile-schemas "$EXTENSION_DIR/schemas/"
    echo "Schemas compiled successfully."
else
    echo "Warning: glib-compile-schemas not found. Schemas not compiled."
    echo "You may need to install glib-2.0 development tools."
fi

echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""
echo "Extension installed to: $EXTENSION_DIR"
echo ""
echo "Next steps:"
echo ""
echo "1. Restart GNOME Shell:"
if [ "$XDG_SESSION_TYPE" = "wayland" ]; then
    echo "   Log out and log back in (Wayland session)"
else
    echo "   Press Alt+F2, type 'r', and press Enter (X11 session)"
fi
echo ""
echo "2. Enable the extension:"
echo "   gnome-extensions enable $EXTENSION_UUID"
echo ""
echo "   Or use the Extensions application (GNOME Extensions app)"
echo ""
echo "3. Configure the extension (optional):"
echo "   gnome-extensions prefs $EXTENSION_UUID"
echo ""
echo "For more information, see the README.md file or visit:"
echo "https://github.com/spin83/multi-monitors-add-on"
echo ""
echo "Note: Fildem indicator is excluded by default and will"
echo "      stay on your main monitor. Other indicators can be"
echo "      transferred to secondary monitors via preferences."
echo ""
