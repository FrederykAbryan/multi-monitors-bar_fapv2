# Multi Monitor Bar for GNOME Shell

Add multiple monitors overview and panel for GNOME Shell. This is an updated fork with GNOME 46 compatibility.

## Features

- Show panel on additional monitors
- Show Activities button on additional monitors
- Show AppMenu on additional monitors
- Show DateTime menu on additional monitors
- Show thumbnails slider on additional monitors
- Transfer indicators from main panel to additional monitors
- Exclude specific indicators from being transferred (e.g., Fildem menu)
- Hot corners on all monitors

## Compatibility

This extension supports GNOME Shell versions:
- 40, 41, 42, 43, 44, 45, 46

Tested on:
- Zorin OS 18 (Ubuntu 24.04 LTS)
- GNOME 46

## Installation

### Method 1: Manual Installation

1. **Copy the extension to the GNOME extensions directory:**
   ```bash
   cp -r multi-monitors-bar@frederykabryan ~/.local/share/gnome-shell/extensions/
   ```

2. **Compile the GSettings schema:**
   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/multi-monitors-bar@frederykabryan/schemas/
   ```

3. **Restart GNOME Shell:**
   - On **X11**: Press `Alt+F2`, type `r`, and press Enter
   - On **Wayland**: Log out and log back in (or reboot)

4. **Enable the extension:**
   ```bash
   gnome-extensions enable multi-monitors-bar@frederykabryan
   ```

### Method 2: Using the Install Script (Recommended)

The extension includes an install script that handles everything automatically:

```bash
chmod +x install.sh
./install.sh
```

The script will:
- Check your GNOME Shell version for compatibility
- Create the necessary directories
- Copy all extension files
- Compile the GSettings schemas
- Provide instructions for enabling the extension

## Configuration

### Access Extension Preferences

Open the extension preferences using one of these methods:

1. **GNOME Extensions app:**
   - Open "Extensions" application
   - Find "Multi Monitor Bar"
   - Click the settings icon

2. **Command line:**
   ```bash
   gnome-extensions prefs multi-monitors-bar@frederykabryan
   ```

### Settings

#### Show Panel on Additional Monitors
Enable or disable panels on additional monitors.

#### Show Activities Button
Show/hide the Activities button on additional monitor panels.

#### Show AppMenu Button
Show/hide the application menu on additional monitor panels.

#### Show DateTime Menu
Show/hide the date/time menu on additional monitor panels.

#### Thumbnails Slider Position
Choose where to show workspace thumbnails on additional monitors:
- None (disabled)
- Left
- Right
- Auto (follows main monitor)

#### Transfer Indicators
Select which indicators from the main panel should be transferred to additional monitor panels.

**Note:** Indicators in the exclude list (like Fildem) will not appear in the available indicators list.

### Advanced Configuration (gsettings)

#### Exclude Indicators from Transfer

By default, the `fildem-indicator` is excluded from being transferred to secondary monitors. You can customize this:

```bash
# View currently excluded indicators
gsettings get org.gnome.shell.extensions.multi-monitors-add-on exclude-indicators

# Add more indicators to exclude
gsettings set org.gnome.shell.extensions.multi-monitors-add-on exclude-indicators "['fildem-indicator', 'another-indicator']"

# Remove all exclusions (allow all indicators to be transferred)
gsettings set org.gnome.shell.extensions.multi-monitors-add-on exclude-indicators "[]"
```

#### Find Indicator Names

To find the internal name of an indicator:

```bash
# Run this in Looking Glass (Alt+F2, type 'lg', press Enter)
# Then in the Evaluator tab:
Object.keys(Main.panel.statusArea)
```

#### Other Settings

```bash
# Show/hide the extension indicator in the main panel
gsettings set org.gnome.shell.extensions.multi-monitors-add-on show-indicator true

# Show/hide panels on additional monitors
gsettings set org.gnome.shell.extensions.multi-monitors-add-on show-panel true

# Show/hide Activities button
gsettings set org.gnome.shell.extensions.multi-monitors-add-on show-activities true

# Show/hide AppMenu button
gsettings set org.gnome.shell.extensions.multi-monitors-add-on show-app-menu true

# Show/hide DateTime menu
gsettings set org.gnome.shell.extensions.multi-monitors-add-on show-date-time true

# Set thumbnails slider position (none, left, right, auto)
gsettings set org.gnome.shell.extensions.multi-monitors-add-on thumbnails-slider-position 'auto'
```

## Troubleshooting

### Extension doesn't appear in the list

1. Make sure the extension is installed in the correct directory:
   ```bash
   ls ~/.local/share/gnome-shell/extensions/multi-monitors-bar@frederykabryan/
   ```

2. Check that the schema is compiled:
   ```bash
   ls ~/.local/share/gnome-shell/extensions/multi-monitors-bar@frederykabryan/schemas/gschemas.compiled
   ```

3. Restart GNOME Shell

### Extension fails to enable

1. Check for errors in the logs:
   ```bash
   journalctl -f -o cat /usr/bin/gnome-shell
   ```

2. Try enabling with verbose output:
   ```bash
   gnome-extensions enable multi-monitors-bar@frederykabryan --verbose
   ```

3. Check extension info for errors:
   ```bash
   gnome-extensions info multi-monitors-bar@frederykabryan
   ```

### Panels not showing on additional monitors

1. Make sure "Show Panel" is enabled in preferences
2. Check that you have multiple monitors connected
3. Try disabling and re-enabling the extension:
   ```bash
   gnome-extensions disable multi-monitors-bar@frederykabryan
   gnome-extensions enable multi-monitors-bar@frederykabryan
   ```

### Indicators not transferring

1. Make sure the indicator is not in the exclude list:
   ```bash
   gsettings get org.gnome.shell.extensions.multi-monitors-add-on exclude-indicators
   ```

2. Check available indicators:
   ```bash
   gsettings get org.gnome.shell.extensions.multi-monitors-add-on available-indicators
   ```

3. Refresh the available indicators by disabling/enabling the extension

## Uninstallation

To remove the extension:

```bash
# Disable the extension
gnome-extensions disable multi-monitors-bar@frederykabryan

# Remove extension files
rm -rf ~/.local/share/gnome-shell/extensions/multi-monitors-bar@frederykabryan

# Restart GNOME Shell
# X11: Alt+F2, type 'r', press Enter
# Wayland: Log out and log back in
```

## Development

### File Structure

- `extension.js` - Main extension code
- `mmpanel.js` - Multi-monitor panel implementation
- `mmlayout.js` - Layout manager for multi-monitor setup
- `mmoverview.js` - Overview/workspace thumbnails for additional monitors
- `mmcalendar.js` - Calendar/date-time menu for additional monitors
- `indicator.js` - Extension status indicator
- `prefs.js` - Preferences dialog
- `convenience.js` - Utility functions
- `metadata.json` - Extension metadata
- `schemas/*.gschema.xml` - GSettings schema definitions

### Making Changes

After making changes to the extension code:

1. Recompile schemas if you modified the schema file:
   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/multi-monitors-bar@frederykabryan/schemas/
   ```

2. Restart GNOME Shell to reload the extension

3. Check for errors in the logs:
   ```bash
   journalctl -f -o cat /usr/bin/gnome-shell
   ```

## License

This program is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation; either version 2 of the License, or (at your option) any later version.

## Credits
This repo structure and base is copied from spin83

Original author: spin83

Original repository: https://github.com/spin83/multi-monitors-add-on

Updated by: Frederyk, Claude, Github Copilot. (Mostly done by AI though.I only use 45 hours of my time to debug,prompt,debug,prompt,frustrated and repeat) 

## Changelog

### Version 29 (Current)
- Updated extension UUID to `multi-monitors-bar@frederykabryan`
- Added support for GNOME Shell 45 and 46
- Added `exclude-indicators` setting to prevent specific indicators from being transferred
- Fildem indicator is now excluded by default, keeping it on the main monitor
- Improved indicator filtering logic
- Updated for Zorin OS 18 / Ubuntu 24.04 LTS compatibility
- Improved installation script with version checking and better error handling
