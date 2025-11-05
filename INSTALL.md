# Installation Guide

## Quick Installation

### Using the Install Script (Recommended)

1. Open a terminal in the extension directory:
   ```bash
   cd /home/frederyk/Documents/Extension/multi-monitors-add-on-master/multi-monitors-bar@frederykabryan
   ```

2. Run the install script:
   ```bash
   ./install.sh
   ```

3. Follow the on-screen instructions

### Manual Installation

If you prefer to install manually:

```bash
# 1. Copy extension to GNOME extensions directory
cp -r multi-monitors-bar@frederykabryan ~/.local/share/gnome-shell/extensions/

# 2. Compile the GSettings schema
glib-compile-schemas ~/.local/share/gnome-shell/extensions/multi-monitors-bar@frederykabryan/schemas/

# 3. Restart GNOME Shell
#    X11: Press Alt+F2, type 'r', press Enter
#    Wayland: Log out and log back in

# 4. Enable the extension
gnome-extensions enable multi-monitors-bar@frederykabryan
```

## Verification

After installation, verify the extension is installed:

```bash
gnome-extensions list | grep multi-monitors
```

You should see: `multi-monitors-bar@frederykabryan`

Check extension status:

```bash
gnome-extensions info multi-monitors-bar@frederykabryan
```

## First-Time Setup

1. **Open Extension Preferences:**
   ```bash
   gnome-extensions prefs multi-monitors-bar@frederykabryan
   ```
   Or use the GNOME Extensions application

2. **Configure Basic Settings:**
   - Enable "Show Panel on additional monitors" (usually enabled by default)
   - Choose which elements to show on secondary monitors:
     - Activities button
     - Application menu
     - Date/Time menu
   - Set thumbnails slider position (auto, left, right, or none)

3. **Transfer Indicators (Optional):**
   - In the preferences, you'll see a list of available indicators
   - Select which indicators you want on your secondary monitors
   - Note: Fildem is excluded by default and won't appear in the list

## Post-Installation

### Verify Multi-Monitor Setup

Connect your secondary monitor(s) and verify:

1. Panels appear on all monitors
2. Activities button works on secondary monitors
3. Workspace thumbnails appear (if enabled)
4. Indicators are transferred as configured

### Common First-Time Issues

**Extension enabled but no panels on secondary monitors:**
- Check Settings > Displays to ensure monitors are detected
- Verify "Show Panel" is enabled in extension preferences
- Try disabling and re-enabling the extension

**Workspace thumbnails not showing:**
- Check that "Thumbnails slider position" is not set to "none"
- Verify that "Workspaces only on primary display" is disabled in GNOME Settings

**Indicators not transferring:**
- Make sure to select them in the extension preferences
- Some indicators may be in the exclude list
- Try refreshing by disabling/enabling the extension

## Updating

To update the extension:

1. Disable the current version:
   ```bash
   gnome-extensions disable multi-monitors-bar@frederykabryan
   ```

2. Run the install script again:
   ```bash
   ./install.sh
   ```

3. When prompted to overwrite, select 'y'

4. Restart GNOME Shell and re-enable the extension

## Uninstallation

To completely remove the extension:

```bash
# 1. Disable the extension
gnome-extensions disable multi-monitors-bar@frederykabryan

# 2. Remove extension files
rm -rf ~/.local/share/gnome-shell/extensions/multi-monitors-bar@frederykabryan

# 3. Restart GNOME Shell
#    X11: Alt+F2, type 'r', press Enter
#    Wayland: Log out and log back in
```

## Getting Help

If you encounter issues:

1. Check the logs for errors:
   ```bash
   journalctl -f -o cat /usr/bin/gnome-shell
   ```

2. Get extension information:
   ```bash
   gnome-extensions info multi-monitors-bar@frederykabryan
   ```

3. See README.md for detailed troubleshooting

4. Visit the project repository:
   https://github.com/spin83/multi-monitors-add-on
