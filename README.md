# Multi Monitor Bar for GNOME Shell

<p align="center">
  <strong>Add full panels, overview, and mirrored indicators to every monitor.</strong>
</p>

<p align="center">
  <a href="https://extensions.gnome.org/extension/XXXX/multi-monitor-bar/">GNOME Extensions</a> ·
  <a href="https://github.com/FrederykAbryan/multi-monitors-bar_fapv2">GitHub</a> ·
  <a href="#donations">Donate</a>
</p>

---

An updated fork of [spin83/multi-monitors-add-on](https://github.com/spin83/multi-monitors-add-on) with modern GNOME Shell support (45 – 49), mirrored indicators, screenshot tool cloning, Blur my Shell integration, and more.

## ✨ Features

| Feature | Description |
|---|---|
| **Panel on every monitor** | Full top bar with left / center / right sections |
| **Activities button** | Open the overview from any monitor |
| **AppMenu** | Per-monitor focused-app menu |
| **DateTime menu** | Mirrored clock & calendar |
| **Workspace thumbnails** | Slider on the left, right, or auto |
| **Mirrored indicators** | Any status-area indicator (Vitals, GSConnect, etc.) can be transferred to secondary panels |
| **Indicator exclusion list** | Prevent specific indicators from being transferred (e.g. Fildem) |
| **Screenshot tools on all monitors** | Clone the screenshot toolbar to every screen, or follow the cursor |
| **Blur my Shell integration** | Blur the secondary panels with Blur my Shell |
| **Overview on extended monitors** | Show App Grid & Search on secondary displays |
| **Force workspaces on all displays** | Override GNOME's *workspaces-only-on-primary* setting |
| **Hot corners** | Enable/disable hot corners on all monitors |
| **Window drag from panel** | Drag maximized windows off the panel on any monitor |

## 📋 Compatibility

**GNOME Shell:** 45, 46, 47, 48, 49

Tested on:
- Fedora 43 — GNOME 49

## 📦 Installation

### Method 1: Reinstall Script (Recommended)

The included script copies everything to the extensions directory, compiles schemas, and enables the extension in one step:

```bash
chmod +x reinstall.sh
./reinstall.sh
```

> [!NOTE]
> On **Wayland** you must log out and log back in for changes to take effect.
> On **X11** press `Alt+F2`, type `r`, and press Enter.

### Method 2: Manual Installation

1. Copy the extension folder:
   ```bash
   cp -r . ~/.local/share/gnome-shell/extensions/multi-monitors-bar@frederykabryan
   ```

2. Compile schemas:
   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/multi-monitors-bar@frederykabryan/schemas/
   ```

3. Restart GNOME Shell (see note above).

4. Enable:
   ```bash
   gnome-extensions enable multi-monitors-bar@frederykabryan
   ```

## ⚙️ Configuration

Open preferences through the **Extensions** app (click the ⚙️ icon next to *Multi Monitor Bar*) or via command line:

```bash
gnome-extensions prefs multi-monitors-bar@frederykabryan
```

### Preference Switches

| Setting | Key | Default |
|---|---|---|
| Show Panel | `show-panel` | `true` |
| Show Activities Button | `show-activities` | `true` |
| Show AppMenu Button | `show-app-menu` | `true` |
| Show DateTime Menu | `show-date-time` | `true` |
| Thumbnails Slider Position | `thumbnails-slider-position` | `auto` |
| Hot Corners | `enable-hot-corners` | (system default) |
| Screenshot on All Monitors | `screenshot-on-all-monitors` | `false` |
| Force Workspaces on All Displays | `force-workspaces-on-all-displays` | `true` |
| Overview on Extended Monitors | `show-overview-on-extended-monitors` | `true` |

### Advanced: gsettings CLI

```bash
# View / set any setting
gsettings get  org.gnome.shell.extensions.multi-monitors-add-on show-panel
gsettings set  org.gnome.shell.extensions.multi-monitors-add-on show-panel true

# Exclude indicators from transfer
gsettings get  org.gnome.shell.extensions.multi-monitors-add-on exclude-indicators
gsettings set  org.gnome.shell.extensions.multi-monitors-add-on exclude-indicators \
  "['fildem-indicator', 'another-indicator']"
```

#### Finding Indicator Names

```bash
# In Looking Glass (Alt+F2 → lg → Evaluator tab):
Object.keys(Main.panel.statusArea)
```

## 🔧 Troubleshooting

<details>
<summary><strong>Extension doesn't appear</strong></summary>

1. Verify installation path:
   ```bash
   ls ~/.local/share/gnome-shell/extensions/multi-monitors-bar@frederykabryan/
   ```
2. Check compiled schema exists:
   ```bash
   ls ~/.local/share/gnome-shell/extensions/multi-monitors-bar@frederykabryan/schemas/gschemas.compiled
   ```
3. Restart GNOME Shell.
</details>

<details>
<summary><strong>Extension fails to enable</strong></summary>

```bash
journalctl -f -o cat /usr/bin/gnome-shell
gnome-extensions info multi-monitors-bar@frederykabryan
```
</details>

<details>
<summary><strong>Panels not showing on secondary monitors</strong></summary>

1. Ensure **Show Panel** is enabled in preferences.
2. Confirm multiple monitors are connected.
3. Toggle the extension:
   ```bash
   gnome-extensions disable multi-monitors-bar@frederykabryan
   gnome-extensions enable  multi-monitors-bar@frederykabryan
   ```
</details>

<details>
<summary><strong>Indicators not transferring</strong></summary>

1. Check the exclude list:
   ```bash
   gsettings get org.gnome.shell.extensions.multi-monitors-add-on exclude-indicators
   ```
2. Refresh by toggling the extension.
</details>

## 🗑️ Uninstallation

```bash
gnome-extensions disable multi-monitors-bar@frederykabryan
rm -rf ~/.local/share/gnome-shell/extensions/multi-monitors-bar@frederykabryan
# Restart GNOME Shell
```

## 🗂️ Project Structure

```
.
├── extension.js                  # Main extension entry point
├── mmpanel.js                    # Multi-monitor panel (layout, drag, indicators)
├── mmlayout.js                   # Layout manager for multi-monitor setup
├── mmoverview.js                 # Overview / workspace views on secondary monitors
├── mmcalendar.js                 # DateTime menu for secondary monitors
├── mirroredIndicatorButton.js    # Generic indicator mirroring via Clutter.Clone
├── statusIndicatorsController.js # Manages indicator transfer lifecycle
├── screenshotPatch.js            # Screenshot UI cloning to all monitors
├── mmPanelConstants.js           # Shared constants and settings keys
├── common.js                     # Shell version detection & utility helpers
├── utils.js                      # Misc utilities
├── prefs.js                      # Preferences dialog (Adw / GTK4)
├── metadata.json                 # Extension metadata & version
├── stylesheet.css                # Panel & indicator CSS
├── schemas/                      # GSettings schema definitions
│   └── org.gnome.shell.extensions.multi-monitors-add-on.gschema.xml
└── reinstall.sh                  # One-step reinstall script
```

## 🛠️ Development

After modifying the source:

1. Run the reinstall script (or copy files manually):
   ```bash
   ./reinstall.sh
   ```
2. On Wayland, log out / log back in. On X11, press `Alt+F2` → `r`.
3. Watch logs for errors:
   ```bash
   journalctl -f -o cat /usr/bin/gnome-shell
   ```

## ❤️ Donations

If you find this extension useful, please consider supporting development:

- **Ko-fi:** [frederykabryan](https://ko-fi.com/frederykabryan)
- **PayPal:** [multimonitorbar](https://paypal.me/multimonitorbar)

## 📄 License

This program is free software; you can redistribute it and/or modify it under the terms of the [GNU General Public License v2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) (or any later version).

## 🙏 Credits

- **Original author:** [spin83](https://github.com/spin83/multi-monitors-add-on)
- **Forked & MOdify by:** Frederyk Abryan Palinoan — with extensive help from Claude, Gemini, ChatGPT and GitHub Copilot
