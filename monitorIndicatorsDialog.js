import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    CATALOG_KEY, CONTROL_ROLE, EXCLUDED_MIRROR_ROLES, VISIBILITY_KEY,
    indicatorIsEnabled, monitorKey, primaryVisibility,
} from './monitorIndicatorPolicy.js';

export class MonitorIndicatorsController {
    constructor(settings, panels) {
        this.settings = settings;
        this._panels = panels;
        this._signals = [];
        this._sources = new Map();
        this._connect(settings, `changed::${VISIBILITY_KEY}`, () => this.sync());
        for (const key of ['show-activities', 'show-app-menu', 'show-date-time'])
            this._connect(settings, `changed::${key}`, () => this.sync());
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this.queueSync();
        });
        this._connect(Main.extensionManager, 'extension-state-changed', () => this.queueSync());
        for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]) {
            for (const signal of ['child-added', 'child-removed', 'actor-added', 'actor-removed']) {
                if (GObject.signal_lookup(signal, box.constructor.$gtype))
                    this._connect(box, signal, () => this.queueSync());
            }
        }
        this.queueSync();
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    roles() {
        return Object.keys(Main.panel.statusArea).filter(role =>
            Main.panel.statusArea[role] && role !== CONTROL_ROLE && !EXCLUDED_MIRROR_ROLES.includes(role))
            .sort((a, b) => this.label(a).localeCompare(this.label(b)));
    }

    label(role) {
        const known = {activities: _('Activities'), dateMenu: _('Date and time'),
            quickSettings: _('Quick Settings'), appMenu: _('App menu')};
        if (known[role])
            return known[role];
        const indicator = Main.panel.statusArea[role];
        const name = indicator?.accessible_name;
        return name ? `${name} (${role})` : role;
    }

    enabled(index, role) {
        const primary = Main.layoutManager.primaryIndex;
        let fallback = true;
        if (index !== primary) {
            const legacyKey = {activities: 'show-activities', appMenu: 'show-app-menu', dateMenu: 'show-date-time'}[role];
            if (legacyKey)
                fallback = this.settings.get_boolean(legacyKey);
        }
        return indicatorIsEnabled(this.settings, monitorKey(global.display, index, primary), role, fallback);
    }

    queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._syncId = 0;
            this.sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    sync() {
        const primary = Main.layoutManager.primaryIndex;
        const current = new Set();
        for (const role of this.roles()) {
            const indicator = Main.panel.statusArea[role];
            const actor = indicator.container || indicator;
            current.add(actor);
            let state = this._sources.get(actor);
            if (!state) {
                state = {visible: actor.visible, hidden: false, updating: false};
                this._sources.set(actor, state);
                primaryVisibility.set(actor, state);
                state.visibilityId = actor.connect('notify::visible', () => {
                    if (state.updating)
                        return;
                    state.visible = actor.visible;
                    if (state.hidden && actor.visible)
                        this._apply(actor, state, true);
                    this.queueSync();
                });
                state.destroyId = actor.connect('destroy', () => {
                    this._sources.delete(actor);
                    primaryVisibility.delete(actor);
                    this.queueSync();
                });
            }
            this._apply(actor, state, !this.enabled(primary, role));
        }
        for (const [actor, state] of this._sources) {
            if (!current.has(actor))
                this._release(actor, state);
        }
        for (const panel of this._panels())
            panel?._updatePanel();
        this._publishCatalog();
    }

    _apply(actor, state, hidden) {
        state.hidden = hidden;
        state.updating = true;
        actor.visible = hidden ? false : state.visible;
        state.updating = false;
    }

    _release(actor, state) {
        actor.disconnect(state.visibilityId);
        actor.disconnect(state.destroyId);
        primaryVisibility.delete(actor);
        this._sources.delete(actor);
        actor.visible = state.visible;
    }

    _publishCatalog() {
        const primary = Main.layoutManager.primaryIndex;
        const monitors = Main.layoutManager.monitors;
        const order = [primary, ...monitors.map((_, index) => index).filter(index => index !== primary)]
            .filter(index => monitors[index]);
        const catalog = JSON.stringify({
            monitors: order.map(index => ({
                key: monitorKey(global.display, index, primary),
                primary: index === primary,
                width: monitors[index].width,
                height: monitors[index].height,
            })),
            roles: this.roles().map(role => ({role, label: this.label(role)})),
        });
        // Preferences run in a separate process and cannot access Shell actors.
        if (this.settings.get_string(CATALOG_KEY) !== catalog)
            this.settings.set_string(CATALOG_KEY, catalog);
    }

    destroy() {
        if (this._syncId)
            GLib.source_remove(this._syncId);
        this._syncId = 0;
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        for (const [actor, state] of this._sources)
            this._release(actor, state);
        this.settings.set_string(CATALOG_KEY, '{}');
        this.settings = null;
    }
}
