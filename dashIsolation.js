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
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {DASH_ANIMATION_TIME} from 'resource:///org/gnome/shell/ui/dash.js';

export const ISOLATE_DOCK_MONITORS_ID = 'isolate-dock-monitors';
export const ISOLATE_DOCK_WORKSPACES_ID = 'isolate-dock-workspaces';

// Slow launchers (Electron, Flatpak cold starts) can take several seconds.
const PLACEMENT_TIMEOUT_US = 15 * GLib.USEC_PER_SEC;
// After the first window appears, also place a follow-up main window
// (Electron splash/bootstrap windows) shown within this period.
const PLACEMENT_FOLLOWUP_US = 3 * GLib.USEC_PER_SEC;
// How long a placed window is kept on the dock's monitor against the app
// restoring its saved position.
const PLACEMENT_SETTLE_MS = 1500;
const PLACEMENT_HOLD_CAP_MS = 10000;

// Live instances, so the most recent dock launch of an app wins over an
// older pending launch of the same app from another dock.
const instances = new Set();

/**
 * Restricts a native GNOME Dash to the windows on its own monitor and/or the
 * active workspace: running dots, non-favorite running apps and click-to-focus
 * only consider those windows. Apps running without any window belong to the
 * primary monitor.
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
        this._isolateMonitors = false;
        this._isolateWorkspaces = false;
        this._windows = new Set();
        // app -> monotonic deadline (µs) for moving its next window here.
        this._pendingPlacements = new Map();
        this._refreshLaterId = 0;
        this._settleTimeoutId = 0;
        // Cancel functions for per-window work that outlives the call that
        // started it: first-frame waits and placement holds (timeouts plus
        // window/display handlers). All of it must stop with this instance.
        this._frameWaits = new Set();
        this._holds = new Set();
        instances.add(this);

        this._settings.connectObject(
            `changed::${ISOLATE_DOCK_MONITORS_ID}`, () => this._sync(),
            `changed::${ISOLATE_DOCK_WORKSPACES_ID}`, () => this._sync(),
            this);
        // The overview dash can be destroyed by the Shell at logout before
        // disable(); never let a pending refresh touch a disposed dash.
        this._dash.connectObject('destroy', () => this._cancelPending(), this);
        this._sync();
    }

    _sync() {
        this._isolateMonitors = this._settings.get_boolean(ISOLATE_DOCK_MONITORS_ID);
        this._isolateWorkspaces = this._settings.get_boolean(ISOLATE_DOCK_WORKSPACES_ID);
        const active = this._isolateMonitors || this._isolateWorkspaces;
        if (active !== this._active) {
            this._active = active;
            if (active)
                this._enable();
            else
                this._disable();
        } else if (active) {
            this._refreshDots();
        }
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
            'window-created', (_display, window) => {
                this._trackWindow(window);
                this._watchPlacement(window);
                this._queueRefresh();
            },
            'window-entered-monitor', () => this._queueRefresh(),
            'window-left-monitor', () => this._queueRefresh(),
            this);
        global.workspace_manager.connectObject('active-workspace-changed',
            () => this._queueRefresh(), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._queueRefresh(), this);
        // Moving a window to another workspace has no display-wide signal.
        for (const actor of global.get_window_actors())
            this._trackWindow(actor.meta_window);
    }

    _cancelPending() {
        if (this._refreshLaterId) {
            global.compositor.get_laters().remove(this._refreshLaterId);
            this._refreshLaterId = 0;
        }
        if (this._settleTimeoutId) {
            GLib.source_remove(this._settleTimeoutId);
            this._settleTimeoutId = 0;
        }
        // Copy first: each cancel removes itself from its set.
        for (const stop of [...this._holds])
            stop();
        for (const cancel of [...this._frameWaits])
            cancel();
    }

    _disable() {
        this._cancelPending();
        this._dash._box.disconnectObject(this);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const window of this._windows)
            window.disconnectObject(this);
        this._windows.clear();
        this._pendingPlacements.clear();
        this._dash._appSystem = this._appSystem;
        for (const item of this._dash._box.get_children())
            this._unpatchItem(item);
    }

    _trackWindow(window) {
        if (!window || this._windows.has(window))
            return;
        this._windows.add(window);
        window.connectObject(
            'workspace-changed', () => this._queueRefresh(),
            'unmanaged', () => {
                window.disconnectObject(this);
                this._windows.delete(window);
                this._queueRefresh();
            },
            this);
    }

    // Apps choose where their windows open: Mutter only uses the pointer's
    // monitor as a hint, and many apps (Chromium/Electron, apps restoring
    // their last geometry) ignore it. After launching from this dock, move
    // the app's next normal window onto the dock's monitor.
    _expectWindow(app) {
        for (const other of instances)
            other._pendingPlacements.delete(app);
        if (!this._isolateMonitors || this._getMonitorIndex() < 0)
            return;
        this._pendingPlacements.set(app,
            GLib.get_monotonic_time() + PLACEMENT_TIMEOUT_US);
    }

    _pendingAppFor(window) {
        const now = GLib.get_monotonic_time();
        for (const [app, deadline] of this._pendingPlacements) {
            if (now > deadline)
                this._pendingPlacements.delete(app);
        }
        const tracked = Shell.WindowTracker.get_default().get_window_app(window);
        if (this._pendingPlacements.has(tracked))
            return tracked;
        // The tracker can miss (late WM_CLASS / app_id); compare identifiers.
        const ids = [window.get_wm_class(), window.get_wm_class_instance(),
            window.get_gtk_application_id(), window.get_sandboxed_app_id()]
            .filter(Boolean).map(s => s.toLowerCase());
        for (const app of this._pendingPlacements.keys()) {
            const names = [app.get_id().replace(/\.desktop$/, ''),
                app.get_app_info()?.get_startup_wm_class()]
                .filter(Boolean).map(s => s.toLowerCase());
            if (names.some(n => ids.includes(n)))
                return app;
        }
        return null;
    }

    _watchPlacement(window) {
        if (this._pendingPlacements.size === 0 ||
            window.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        // Do not wait for MetaWindow::shown: it is not emitted for every
        // client (e.g. Electron on XWayland). The tracker usually knows the
        // app already; otherwise retry once the first frame is drawn, when
        // a Wayland app_id is reliably set.
        const app = this._pendingAppFor(window);
        if (app) {
            this._claimWindow(app, window);
            return;
        }
        this._onFirstFrame(window, () => {
            const lateApp = this._pendingAppFor(window);
            if (lateApp)
                this._claimWindow(lateApp, window);
        });
    }

    _claimWindow(app, window) {
        // Keep the launch armed briefly for the real window after a
        // splash/bootstrap window (Electron), then stop so windows the user
        // opens later are left alone.
        this._pendingPlacements.set(app, Math.min(
            this._pendingPlacements.get(app),
            GLib.get_monotonic_time() + PLACEMENT_FOLLOWUP_US));
        this._holdOnMonitor(window);
    }

    // Calls `callback` once when the window's first frame is drawn (or it is
    // already visible). The actor may not exist yet at window-created.
    // Returns a function that cancels the wait; destroy() cancels it too.
    _onFirstFrame(window, callback) {
        const laters = global.compositor.get_laters();
        // Owns this wait's handler. connectObject drops it by itself if the
        // window closes before drawing (the actor is destroyed).
        const owner = {};
        let actor = null;
        let laterId = 0;
        const cancel = () => {
            this._frameWaits.delete(cancel);
            if (laterId) {
                laters.remove(laterId);
                laterId = 0;
            }
            actor?.disconnectObject(owner);
        };
        const fire = () => {
            cancel();
            callback();
        };
        laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            laterId = 0;
            actor = window.get_compositor_private();
            if (!actor)
                cancel();
            else if (actor.mapped && actor.visible)
                fire();
            else
                actor.connectObject('first-frame', fire, owner);
            return GLib.SOURCE_REMOVE;
        });
        this._frameWaits.add(cancel);
        return cancel;
    }

    _holdOnMonitor(window) {
        let moving = false;
        const moveHere = () => {
            const index = this._getMonitorIndex();
            if (moving || index < 0 || window.get_monitor() === index)
                return;
            moving = true;
            window.move_to_monitor(index);
            moving = false;
        };
        moveHere();
        // Mutter's initial placement and apps restoring saved bounds
        // (Electron on XWayland) move the window afterwards; re-apply until a
        // short settle period after the first frame (or a hard cap).
        let settleId = 0;
        // Owns this hold's window and display handlers.
        const owner = {};
        // Everything that could call back is removed here, so stop() needs no
        // "stopped" flag: a second call finds nothing left to remove.
        const stop = () => {
            this._holds.delete(stop);
            cancelFirstFrame();
            window.disconnectObject(owner);
            global.display.disconnectObject(owner);
            if (settleId) {
                GLib.source_remove(settleId);
                settleId = 0;
            }
        };
        const cancelFirstFrame = this._onFirstFrame(window, () => {
            moveHere();
            if (settleId)
                GLib.source_remove(settleId);
            settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PLACEMENT_SETTLE_MS, () => {
                settleId = 0;
                stop();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._holds.add(stop);
        window.connectObject(
            'position-changed', () => moveHere(),
            'unmanaged', () => stop(),
            owner);
        // Never fight the user dragging the window elsewhere.
        global.display.connectObject('grab-op-begin', (_display, grabbed) => {
            if (grabbed === window)
                stop();
        }, owner);
        // Hard cap in case no first frame ever arrives (replaced by the
        // shorter settle timer once it does).
        if (!settleId) {
            settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PLACEMENT_HOLD_CAP_MS, () => {
                settleId = 0;
                stop();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _isRelevant(window) {
        if (window.skip_taskbar)
            return false;
        if (this._isolateMonitors && window.get_monitor() !== this._getMonitorIndex())
            return false;
        // located_on_workspace() also accepts windows shown on all workspaces,
        // e.g. extended-monitor windows with workspaces-only-on-primary.
        if (this._isolateWorkspaces &&
            !window.located_on_workspace(global.workspace_manager.get_active_workspace()))
            return false;
        return true;
    }

    _relevantWindows(app) {
        return app.get_windows().filter(w => this._isRelevant(w));
    }

    _belongsHere(app) {
        if (this._relevantWindows(app).length > 0)
            return true;
        // Windowless (background) apps are shown on the primary monitor only.
        return !app.get_windows().some(w => !w.skip_taskbar) &&
            (!this._isolateMonitors ||
                this._getMonitorIndex() === Main.layoutManager.primaryIndex);
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
            this._expectWindow(app);
            stockActivate.call(icon, button);
            return;
        }

        const windows = this._relevantWindows(app);
        if (windows.length > 0) {
            // ShellApp sorts windows most-recently-used first.
            Main.activateWindow(windows[0]);
        } else if (app.can_open_new_window()) {
            // Running elsewhere only: open a window here instead of jumping
            // to another monitor or workspace. New windows follow the
            // pointer's monitor and the active workspace.
            icon.animateLaunch();
            this._expectWindow(app);
            app.open_new_window(-1);
        } else {
            stockActivate.call(icon, button);
            return;
        }
        Main.overview.hide();
    }

    _refreshDots() {
        for (const item of this._dash._box.get_children()) {
            if (item.child?._mmIsolationActivate)
                item.child._updateRunningStyle();
        }
    }

    _queueRefresh() {
        if (this._refreshLaterId)
            return;
        // Deferred to just before the next frame: ShellWindowTracker may
        // assign a new window to its app only after the window signals fire.
        // Unlike an idle source, this is not starved by the workspace-switch
        // animation's frame clock.
        this._refreshLaterId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._refreshLaterId = 0;
                this._redisplayNow();
                this._queueSettle();
                return GLib.SOURCE_REMOVE;
            });
    }

    _queueSettle() {
        // Dash._redisplay() still counts icons that are animating out, so an
        // app that returns during that animation (fast workspace switches in
        // the overview) is not re-added. Redisplay once more after it ends.
        if (this._settleTimeoutId)
            GLib.source_remove(this._settleTimeoutId);
        this._settleTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            DASH_ANIMATION_TIME + 50, () => {
                this._settleTimeoutId = 0;
                this._redisplayNow();
                return GLib.SOURCE_REMOVE;
            });
    }

    _redisplayNow() {
        // Bypass Main.queueDeferredWork(): it waits until the dash is mapped
        // (or a 20 s timeout), and its before-redraw queue can drop requests,
        // which left extended-monitor docks stale after workspace switches.
        // Dash._redisplay() is an idempotent diff, so running it directly is
        // what the deferred work would do anyway.
        this._dash._redisplay();
        this._refreshDots();
    }

    destroy() {
        instances.delete(this);
        this._settings.disconnectObject(this);
        this._dash.disconnectObject(this);
        // Unconditionally, so no timeout, later or handler outlives us.
        this._cancelPending();
        if (this._active) {
            this._disable();
            this._dash._queueRedisplay();
        }
        this._active = false;
        this._dash = null;
    }
}
