/*
Copyright (C) 2025-2026  Frederyk Abryan Palinoan

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, visit https://www.gnu.org/licenses/.
*/

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const ISOLATE_DOCK_MONITORS_ID = 'isolate-dock-monitors';

/**
 * Restricts a native GNOME Dash to the windows on one monitor: running dots,
 * non-favorite running apps and click-to-focus only consider windows on that
 * monitor. Apps running without any window belong to the primary monitor.
 *
 * Everything is patched per instance (the Dash's `_appSystem` and each icon's
 * `_updateRunningStyle`/`activate`), so other dashes are unaffected and
 * `destroy()` restores the stock behavior.
 */
export class DashMonitorIsolation {
    constructor(dash, settings, getMonitorIndex) {
        this._dash = dash;
        this._settings = settings;
        this._getMonitorIndex = getMonitorIndex;
        this._appSystem = dash._appSystem;
        this._active = false;
        this._syncIdleId = 0;

        this._settings.connectObject(`changed::${ISOLATE_DOCK_MONITORS_ID}`,
            () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const active = this._settings.get_boolean(ISOLATE_DOCK_MONITORS_ID);
        if (active === this._active)
            return;
        this._active = active;
        if (active)
            this._enable();
        else
            this._disable();
        this._dash._queueRedisplay();
    }

    _enable() {
        const appSystem = this._appSystem;
        // Dash._redisplay() only calls get_running(); forward everything else.
        this._dash._appSystem = new Proxy(appSystem, {
            get: (target, prop) => {
                if (prop === 'get_running')
                    return () => target.get_running().filter(app => this._belongsHere(app));
                const value = target[prop];
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });

        this._dash._box.connectObject('child-added',
            (_box, item) => this._patchItem(item), this);
        for (const item of this._dash._box.get_children())
            this._patchItem(item);

        global.display.connectObject(
            'window-entered-monitor', () => this._queueRefresh(),
            'window-left-monitor', () => this._queueRefresh(),
            this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._queueRefresh(), this);
    }

    _disable() {
        if (this._syncIdleId) {
            GLib.source_remove(this._syncIdleId);
            this._syncIdleId = 0;
        }
        this._dash._box.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._dash._appSystem = this._appSystem;
        for (const item of this._dash._box.get_children())
            this._unpatchItem(item);
    }

    _windowsHere(app) {
        const index = this._getMonitorIndex();
        return app.get_windows().filter(w =>
            !w.skip_taskbar && w.get_monitor() === index);
    }

    _belongsHere(app) {
        if (this._windowsHere(app).length > 0)
            return true;
        // Windowless (background) apps are shown on the primary monitor only.
        return !app.get_windows().some(w => !w.skip_taskbar) &&
            this._getMonitorIndex() === Main.layoutManager.primaryIndex;
    }

    _patchItem(item) {
        const icon = item.child;
        if (!icon?.app || icon._mmIsolationActivate)
            return;

        const stockActivate = icon.activate;
        icon._mmIsolationActivate = stockActivate;
        icon._updateRunningStyle = () => {
            if (icon.app.state !== Shell.AppState.STOPPED && this._belongsHere(icon.app))
                icon._dot.show();
            else
                icon._dot.hide();
        };
        icon.activate = button => this._activate(icon, stockActivate, button);
        icon._updateRunningStyle();
    }

    _unpatchItem(item) {
        const icon = item.child;
        if (!icon?._mmIsolationActivate)
            return;
        delete icon._mmIsolationActivate;
        delete icon._updateRunningStyle;
        delete icon.activate;
        icon._updateRunningStyle();
    }

    _activate(icon, stockActivate, button) {
        const app = icon.app;
        const event = Clutter.get_current_event();
        const modifiers = event ? event.get_state() : 0;
        const wantsNewWindow = button === Clutter.BUTTON_MIDDLE ||
            (modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (app.state !== Shell.AppState.RUNNING || wantsNewWindow) {
            stockActivate.call(icon, button);
            return;
        }

        const windows = this._windowsHere(app);
        if (windows.length > 0) {
            // ShellApp sorts windows most-recently-used first.
            Main.activateWindow(windows[0]);
        } else if (app.can_open_new_window()) {
            // Running elsewhere only: open a window here instead of jumping
            // to another monitor. New windows follow the pointer's monitor.
            icon.animateLaunch();
            app.open_new_window(-1);
        } else {
            stockActivate.call(icon, button);
            return;
        }
        Main.overview.hide();
    }

    _queueRefresh() {
        if (this._syncIdleId)
            return;
        // Idle: ShellWindowTracker may assign a new window to its app only
        // after the monitor signal fires.
        this._syncIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncIdleId = 0;
            this._dash._queueRedisplay();
            for (const item of this._dash._box.get_children()) {
                if (item.child?._mmIsolationActivate)
                    item.child._updateRunningStyle();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._settings.disconnectObject(this);
        if (this._active) {
            this._disable();
            this._dash._queueRedisplay();
        }
        this._active = false;
        this._dash = null;
    }
}
