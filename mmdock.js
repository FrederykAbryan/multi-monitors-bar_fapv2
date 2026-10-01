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

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DashModule from 'resource:///org/gnome/shell/ui/dash.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

/**
 * A native bottom dock revealed from the desktop's bottom edge when enabled.
 * Extended monitors also show it in overview; the primary uses GNOME's dash.
 * Neither the dock nor its edge trigger reserves desktop space.
 */
export class MultiMonitorsDock {
    constructor(monitor, settings, {showInOverview = true} = {}) {
        this._settings = settings;
        this._showInOverview = showInOverview;
        this._hideTimeoutId = 0;
        this._positionIdleId = 0;
        this._rearmTimeoutId = 0;
        this._hiding = false;
        this._inOverview = false;
        this._monitor = {
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        };

        this._heightChangedId = null;
        this._showAppsButtonId = null;
        this._stateAdjustment = null;
        this._stateAdjustmentId = null;
        this._overviewShowingId = null;
        this._overviewHidingId = null;
        this._ignoreShowAppsButtonToggle = false;
        this._destroying = false;

        // Native GNOME Shell Dash widget (same class used by the overview)
        this._dash = new DashModule.Dash();
        this._dash.add_style_class_name('multimonitor-dock');
        this._connectShowAppsButton();

        // Match the dock width so empty space beside it remains clickable.
        this._bin = new St.Bin({
            name: 'multiMonitorsDockBin',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            reactive: true,
            clip_to_allocation: true,
        });
        // Keep the input region stationary and clip the moving content at
        // the monitor edge, including when another display is below this one.
        this._slide = new St.Bin();
        this._slide.set_child(this._dash);
        this._bin.set_child(this._slide);
        this._dash._box.connectObject('child-added', (_box, item) =>
            this._connectAppItem(item), this._bin);
        for (const item of this._dash._box.get_children())
            this._connectAppItem(item);

        // Fullscreen visibility is managed below. Shell tracking would
        // forcibly show hidden chrome again whenever windows are restacked.
        this._bin.hide();
        Main.layoutManager.addChrome(this._bin, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        this._edge = new St.Widget({
            name: 'multiMonitorsDockEdge',
            reactive: true,
            height: 2,
        });
        Main.layoutManager.addChrome(this._edge, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        this._edge.connect('enter-event', () => {
            this._revealDock();
            return Clutter.EVENT_PROPAGATE;
        });

        this._updatePosition();
        this._heightChangedId = this._dash.connect('notify::height',
            () => this._queuePositionUpdate());
        this._widthChangedId = this._dash.connect('notify::width',
            () => this._queuePositionUpdate());
        this._overviewShowingId = Main.overview.connect('showing', () => {
            this._setOverviewMode(true);
            this._connectOverviewStateAdjustment();
        });
        this._overviewHidingId = Main.overview.connect('hiding',
            () => this._setShowAppsChecked(false));
        this._overviewHiddenId = Main.overview.connect('hidden',
            () => this._setOverviewMode(false));
        this._hoverSettingId = settings.connect('changed::reveal-dock-on-hover',
            () => this._syncEdge());
        this._sessionUpdatedId = Main.sessionMode.connect('updated',
            () => this._syncEdge());
        this._fullscreenChangedId = global.display.connect('in-fullscreen-changed',
            () => this._syncEdge());
        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            if (global.display.focus_window)
                this._dismissDock();
        });
        Main.layoutManager.connectObject('startup-complete',
            () => this._syncEdge(), this._bin);
        this._setOverviewMode(Main.overview.visible);
        this._connectOverviewStateAdjustment();
    }

    _canReveal() {
        return !this._destroying && !this._inOverview &&
            !Main.layoutManager._startingUp &&
            !Main.overview.visible && !Main.overview.animationInProgress &&
            !Main.sessionMode.isLocked && Main.sessionMode.currentMode === 'user' &&
            !Main.layoutManager.monitors.some(monitor =>
                monitor.x === this._monitor.x && monitor.y === this._monitor.y &&
                monitor.inFullscreen) &&
            this._settings.get_boolean('reveal-dock-on-hover');
    }

    _syncEdge() {
        this._edge.visible = this._canReveal();
        if (!this._edge.visible && !this._inOverview)
            this._hideDesktopDock();
    }

    _setOverviewMode(inOverview) {
        this._hideDesktopDock();
        if (this._inOverview !== inOverview) {
            if (this._inOverview)
                Main.layoutManager.overviewGroup.remove_child(this._bin);
            else
                Main.layoutManager.removeChrome(this._bin);

            this._inOverview = inOverview;
            if (inOverview)
                Main.layoutManager.overviewGroup.add_child(this._bin);
            else
                Main.layoutManager.addChrome(this._bin, {
                    affectsStruts: false,
                    trackFullscreen: false,
                });
        }
        this._bin.visible = inOverview && this._showInOverview;
        this._syncEdge();
        this._queuePositionUpdate();
    }

    _revealDock() {
        if (!this._canReveal() || this._hideTimeoutId || this._rearmTimeoutId)
            return;

        this._updatePosition();
        this._slide.remove_all_transitions();
        if (!this._bin.visible) {
            this._slide.opacity = 0;
            this._slide.translation_y = this._bin.height;
        }
        this._hiding = false;
        this._bin.show();
        this._slide.ease({
            opacity: 255,
            translation_y: 0,
            duration: 350,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        // Poll only while revealed. This also works while an icon's popup
        // menu owns the pointer grab and normal leave events are unavailable.
        let outsideSince = null;
        this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            const [x, y] = global.get_pointer();
            const inside = x >= this._bin.x && x < this._bin.x + this._bin.width &&
                y >= this._bin.y && y < this._monitor.y + this._monitor.height;
            const menuOpen = this._dash._box.get_children().some(
                item => item.child?.menu?.isOpen);
            const focus = global.stage.get_key_focus();
            // Mouse clicks can leave stale Shell key focus on an icon even
            // after a normal application owns the keyboard.
            const focused = !global.display.focus_window && focus && this._bin.contains(focus);
            const now = GLib.get_monotonic_time();
            if (inside || menuOpen || focused)
                outsideSince = null;
            else
                outsideSince ??= now;

            if (!this._canReveal() ||
                (outsideSince !== null && now - outsideSince >= 300000)) {
                this._hideTimeoutId = 0;
                this._hideDesktopDock(this._canReveal());
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _connectAppItem(item) {
        if (!item.child?._delegate?.app)
            return;
        item.child.connectObject('clicked', () => this._dismissDock(), this._bin);
    }

    _dismissDock() {
        if (this._destroying || this._inOverview || !this._bin.visible || this._hiding)
            return;
        this._hideDesktopDock(true);
        // Hiding uncovers the edge beneath the pointer. Do not interpret that
        // synthetic enter as another reveal; require a fresh approach.
        if (!this._rearmTimeoutId) {
            this._rearmTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                const [x, y] = global.get_pointer();
                if (x >= this._bin.x && x < this._bin.x + this._bin.width &&
                    y >= this._bin.y && y < this._monitor.y + this._monitor.height)
                    return GLib.SOURCE_CONTINUE;
                this._rearmTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _hideDesktopDock(animate = false) {
        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
        this._slide.remove_all_transitions();
        if (animate && this._bin.visible) {
            this._hiding = true;
            this._slide.ease({
                opacity: 0,
                translation_y: this._bin.height,
                duration: 280,
                mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
                onComplete: () => {
                    this._bin.hide();
                    this._hiding = false;
                    this._slide.opacity = 255;
                    this._slide.translation_y = 0;
                },
            });
        } else {
            this._hiding = false;
            this._bin.hide();
            this._slide.opacity = 255;
            this._slide.translation_y = 0;
            if (this._rearmTimeoutId) {
                GLib.source_remove(this._rearmTimeoutId);
                this._rearmTimeoutId = 0;
            }
        }
    }

    _queuePositionUpdate() {
        if (this._destroying || this._positionIdleId)
            return;
        // Size notifications can fire during allocation; defer layout changes.
        this._positionIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._positionIdleId = 0;
            this._updatePosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _getLocalShowAppsButton() {
        if (!this._dash)
            return null;

        return this._dash.showAppsButton ?? null;
    }

    _connectShowAppsButton() {
        const button = this._getLocalShowAppsButton();
        if (this._destroying || !button || this._showAppsButtonId)
            return;

        this._showAppsButtonId = button.connect('notify::checked',
            () => this._onShowAppsButtonToggled());
    }

    _getOverviewControls() {
        return Main.overview?._overview?.controls ??
            Main.overview?._overview?._controls ??
            Main.overview?._controls ??
            null;
    }

    _getOverviewStateAdjustment() {
        return this._getOverviewControls()?._stateAdjustment ?? null;
    }

    _getPrimaryShowAppsButton() {
        const controls = this._getOverviewControls();
        return controls?.dash?.showAppsButton ??
            controls?._dash?.showAppsButton ??
            Main.overview?.dash?.showAppsButton ??
            null;
    }

    _connectOverviewStateAdjustment() {
        if (this._destroying)
            return;

        const adjustment = this._getOverviewStateAdjustment();
        if (!adjustment || adjustment === this._stateAdjustment)
            return;

        if (this._stateAdjustment && this._stateAdjustmentId)
            this._stateAdjustment.disconnect(this._stateAdjustmentId);

        this._stateAdjustment = adjustment;
        this._stateAdjustmentId = adjustment.connect('notify::value',
            () => this._syncShowAppsButton());
        this._syncShowAppsButton();
    }

    _setShowAppsChecked(checked) {
        const button = this._getLocalShowAppsButton();
        if (this._destroying || !button)
            return;

        try {
            if (button.checked === checked)
                return;

            this._ignoreShowAppsButtonToggle = true;
            button.checked = checked;
        } finally {
            this._ignoreShowAppsButtonToggle = false;
        }
    }

    _syncShowAppsButton() {
        if (this._destroying)
            return;

        const adjustment = this._getOverviewStateAdjustment();
        if (!adjustment)
            return;

        const appGridState = OverviewControls.ControlsState?.APP_GRID ?? 2;
        this._setShowAppsChecked(adjustment.value >= appGridState - 0.5);
    }

    _onShowAppsButtonToggled() {
        if (this._destroying || this._ignoreShowAppsButtonToggle)
            return;

        const button = this._getLocalShowAppsButton();
        if (!button)
            return;

        const controlsState = OverviewControls.ControlsState ?? {
            WINDOW_PICKER: 1,
            APP_GRID: 2,
        };
        let checked = false;
        checked = button.checked;

        const targetState = checked ? controlsState.APP_GRID : controlsState.WINDOW_PICKER;

        if (!Main.overview.visible) {
            if (targetState === controlsState.APP_GRID) {
                if (Main.overview.showApps)
                    Main.overview.showApps();
                else
                    Main.overview.show(targetState);
            } else {
                Main.overview.show(targetState);
            }
            return;
        }

        const primaryButton = this._getPrimaryShowAppsButton();
        if (primaryButton && primaryButton !== button) {
            if (primaryButton.checked === checked)
                return;
            primaryButton.checked = checked;
            return;
        }

        const adjustment = this._getOverviewStateAdjustment();
        if (!adjustment)
            return;

        adjustment.remove_transition('value');
        adjustment.ease(targetState, {
            duration: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME ?? 250,
            mode: Clutter.AnimationMode.EASE_OUT_SINE,
        });
    }

    _updatePosition() {
        if (this._destroying || !this._bin || !this._dash)
            return;

        // Use the Dash's natural height; fall back to 60 px
        let [, natHeight] = this._dash.get_preferred_height(-1);
        if (!natHeight || natHeight <= 0)
            natHeight = 60;

        this._dash.setMaxSize(this._monitor.width, this._monitor.height);
        const [, natWidth] = this._dash.get_preferred_width(natHeight);
        const width = Math.min(this._monitor.width, Math.max(1, natWidth));
        this._bin.set_size(width, natHeight);
        this._bin.set_position(
            this._monitor.x + Math.floor((this._monitor.width - width) / 2),
            this._monitor.y + this._monitor.height - natHeight
        );
        this._edge.set_size(width, 2);
        this._edge.set_position(this._bin.x,
            this._monitor.y + this._monitor.height - 2);
    }

    updateMonitor(monitor) {
        if (!this._inOverview)
            this._hideDesktopDock();
        this._monitor = {
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        };
        this._updatePosition();
    }

    destroy() {
        this._destroying = true;
        this._hideDesktopDock();
        // `_hideDesktopDock(true)` keeps this source alive while the hide
        // animation finishes, so destruction must remove it explicitly.
        if (this._rearmTimeoutId) {
            GLib.source_remove(this._rearmTimeoutId);
            this._rearmTimeoutId = 0;
        }
        if (this._positionIdleId) {
            GLib.source_remove(this._positionIdleId);
            this._positionIdleId = 0;
        }
        this._settings.disconnect(this._hoverSettingId);
        Main.sessionMode.disconnect(this._sessionUpdatedId);
        global.display.disconnect(this._fullscreenChangedId);
        global.display.disconnect(this._focusWindowId);
        Main.overview.disconnect(this._overviewHiddenId);
        Main.layoutManager.removeChrome(this._edge);
        this._edge.destroy();
        this._edge = null;

        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }

        if (this._overviewHidingId) {
            Main.overview.disconnect(this._overviewHidingId);
            this._overviewHidingId = null;
        }

        if (this._stateAdjustment && this._stateAdjustmentId) {
            this._stateAdjustment.disconnect(this._stateAdjustmentId);
            this._stateAdjustment = null;
            this._stateAdjustmentId = null;
        }

        const showAppsButton = this._getLocalShowAppsButton();
        if (showAppsButton && this._showAppsButtonId) {
            showAppsButton.disconnect(this._showAppsButtonId);
            this._showAppsButtonId = null;
        }

        if (this._dash && this._heightChangedId) {
            this._dash.disconnect(this._heightChangedId);
            this._heightChangedId = null;
        }
        if (this._dash && this._widthChangedId)
            this._dash.disconnect(this._widthChangedId);

        if (this._inOverview)
            Main.layoutManager.overviewGroup.remove_child(this._bin);
        else
            Main.layoutManager.removeChrome(this._bin);

        this._bin.destroy();
        this._bin = null;
        this._slide = null;
        this._dash = null;
    }
}
