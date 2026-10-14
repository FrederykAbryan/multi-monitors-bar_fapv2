import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { CATALOG_KEY, VISIBILITY_KEY, indicatorIsEnabled, setIndicatorEnabled } from './monitorIndicatorPolicy.js';
import {
    PANEL_COLOR_KEY, PANEL_LAYOUT_KEY, PANEL_POSITIONS,
    hasMonitorColor, panelColor, panelPosition, setPanelLayoutValue,
} from './monitorPanelPolicy.js';

export class MonitorIndicatorPreferences {
    constructor(settings) {
        this._settings = settings;
        this.page = new Adw.PreferencesPage({
            title: _('Panels by monitor'), icon_name: 'video-display-symbolic',
        });
        this._groups = [];
        this._checks = [];
        this._layoutRows = [];
        this._signals = [
            settings.connect(`changed::${CATALOG_KEY}`, () => this.rebuild()),
            ...[VISIBILITY_KEY, 'show-activities', 'show-app-menu', 'show-date-time']
                .map(key => settings.connect(`changed::${key}`, () => this.syncChecks())),
            ...[PANEL_LAYOUT_KEY, PANEL_COLOR_KEY]
                .map(key => settings.connect(`changed::${key}`, () => this.syncLayout())),
        ];
        this.rebuild();
    }

    rebuild() {
        for (const group of this._groups)
            this.page.remove(group);
        this._groups = [];
        this._checks = [];
        this._layoutRows = [];
        let catalog;
        try {
            catalog = JSON.parse(this._settings.get_string(CATALOG_KEY));
        } catch {
            catalog = null;
        }
        const monitors = Array.isArray(catalog?.monitors) ? catalog.monitors : [];
        const roles = Array.isArray(catalog?.roles) ? catalog.roles : [];
        if (!monitors.length) {
            this._addGroup(new Adw.PreferencesGroup({
                title: _('Panel icons by monitor'),
                description: _('Enable the extension to configure icons on connected monitors.'),
            }));
            return;
        }
        let extended = 0;
        for (const monitor of monitors) {
            const title = monitor.primary ? _('Main monitor') : `${_('Extended')} ${++extended}`;
            const group = new Adw.PreferencesGroup({
                title: `${title} · ${monitor.width} × ${monitor.height}`,
                description: monitor.primary
                    ? _('Choose the bar color and panel icons. Changes are saved automatically.')
                    : _('Choose the bar position, color and icons. Changes are saved automatically.'),
            });
            this._addLayoutRows(group, monitor);
            for (const {role, label} of roles) {
                const row = new Adw.ActionRow({title: label});
                const checkbox = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
                const check = {checkbox, monitor, role};
                checkbox.active = this._enabled(check);
                checkbox.connect('toggled', () => {
                    if (!this._syncing)
                        setIndicatorEnabled(this._settings, monitor.key, role, checkbox.active);
                });
                row.add_suffix(checkbox);
                row.activatable_widget = checkbox;
                group.add(row);
                this._checks.push(check);
            }
            this._addGroup(group);
        }
    }

    _addLayoutRows(group, monitor) {
        // The main monitor keeps GNOME's own top bar, so only its color changes.
        let positionRow = null;
        if (!monitor.primary) {
            const labels = {top: _('Top'), bottom: _('Bottom'), left: _('Left'), right: _('Right')};
            positionRow = new Adw.ComboRow({
                title: _('Bar position'),
                model: Gtk.StringList.new(PANEL_POSITIONS.map(position => labels[position])),
            });
            positionRow.connect('notify::selected', () => {
                if (!this._syncing)
                    setPanelLayoutValue(this._settings, monitor.key, 'position', PANEL_POSITIONS[positionRow.selected]);
            });
            group.add(positionRow);
        }

        const colorRow = new Adw.ActionRow({title: _('Bar color')});
        const colorButton = new Gtk.ColorButton({valign: Gtk.Align.CENTER, use_alpha: true, title: _('Bar color')});
        colorButton.connect('color-set', () =>
            setPanelLayoutValue(this._settings, monitor.key, 'color', colorButton.get_rgba().to_string()));
        const resetButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: monitor.primary ? _('Use the theme color') : _('Use the shared panel color'),
            css_classes: ['flat'],
        });
        resetButton.connect('clicked', () => setPanelLayoutValue(this._settings, monitor.key, 'color', null));
        colorRow.add_suffix(colorButton);
        colorRow.add_suffix(resetButton);
        group.add(colorRow);

        const layoutRow = {monitor, positionRow, colorRow, colorButton, resetButton};
        this._layoutRows.push(layoutRow);
        this._syncing = true;
        try {
            this._syncLayoutRow(layoutRow);
        } finally {
            this._syncing = false;
        }
    }

    _syncLayoutRow({monitor, positionRow, colorRow, colorButton, resetButton}) {
        if (positionRow)
            positionRow.selected = PANEL_POSITIONS.indexOf(panelPosition(this._settings, monitor.key));
        const custom = hasMonitorColor(this._settings, monitor.key);
        const color = panelColor(this._settings, monitor.key);
        const rgba = new Gdk.RGBA();
        rgba.parse(color || 'rgba(0,0,0,0)');
        colorButton.set_rgba(rgba);
        colorRow.subtitle = custom ? '' : color ? _('Shared panel color') : _('Theme default');
        resetButton.sensitive = custom;
    }

    syncLayout() {
        this._syncing = true;
        try {
            for (const layoutRow of this._layoutRows)
                this._syncLayoutRow(layoutRow);
        } finally {
            this._syncing = false;
        }
    }

    _addGroup(group) {
        this._groups.push(group);
        this.page.add(group);
    }

    _enabled({monitor, role}) {
        const legacyKey = {activities: 'show-activities', appMenu: 'show-app-menu', dateMenu: 'show-date-time'}[role];
        const fallback = !monitor.primary && legacyKey ? this._settings.get_boolean(legacyKey) : true;
        return indicatorIsEnabled(this._settings, monitor.key, role, fallback);
    }

    syncChecks() {
        this._syncing = true;
        try {
            for (const check of this._checks)
                check.checkbox.active = this._enabled(check);
        } finally {
            this._syncing = false;
        }
    }

    destroy() {
        for (const id of this._signals)
            this._settings.disconnect(id);
        this._signals = [];
    }
}
