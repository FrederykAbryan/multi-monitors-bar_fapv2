import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { CATALOG_KEY, VISIBILITY_KEY, indicatorIsEnabled, setIndicatorEnabled } from './monitorIndicatorPolicy.js';

export class MonitorIndicatorPreferences {
    constructor(settings) {
        this._settings = settings;
        this.page = new Adw.PreferencesPage({
            title: _('Panel icons by monitor'), icon_name: 'video-display-symbolic',
        });
        this._groups = [];
        this._checks = [];
        this._signals = [
            settings.connect(`changed::${CATALOG_KEY}`, () => this.rebuild()),
            ...[VISIBILITY_KEY, 'show-activities', 'show-app-menu', 'show-date-time']
                .map(key => settings.connect(`changed::${key}`, () => this.syncChecks())),
        ];
        this.rebuild();
    }

    rebuild() {
        for (const group of this._groups)
            this.page.remove(group);
        this._groups = [];
        this._checks = [];
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
                description: _('Choose panel icons. Changes are saved automatically.'),
            });
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
