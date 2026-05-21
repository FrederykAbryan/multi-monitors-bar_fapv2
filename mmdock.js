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

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DashModule from 'resource:///org/gnome/shell/ui/dash.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

/**
 * An overview-only bottom dock for one extended monitor.
 *
 * The dock wraps a native GNOME Shell Dash widget and is parented to
 * Main.layoutManager.overviewGroup so it is shown only while the overview
 * is open, mirroring the primary monitor's overview dash. It does not
 * reserve desktop space and is not visible on the regular desktop.
 */
export class MultiMonitorsDock {
    constructor(monitor) {
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

        // Native GNOME Shell Dash widget (same class used by the overview)
        this._dash = new DashModule.Dash();
        this._dash.add_style_class_name('multimonitor-dock');
        this._connectShowAppsButton();

        // Outer bin: full monitor-width, sits at the very bottom of the
        // extended monitor inside the overview layer.
        this._bin = new St.Bin({
            name: 'multiMonitorsDockBin',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            reactive: true,
        });
        this._bin.set_child(this._dash);

        Main.layoutManager.overviewGroup.add_child(this._bin);

        this._updatePosition();
        this._heightChangedId = this._dash.connect('notify::height',
            () => this._updatePosition());
        this._overviewShowingId = Main.overview.connect('showing',
            () => this._connectOverviewStateAdjustment());
        this._overviewHidingId = Main.overview.connect('hiding',
            () => this._setShowAppsChecked(false));
        this._connectOverviewStateAdjustment();
    }

    _connectShowAppsButton() {
        const button = this._dash?.showAppsButton;
        if (!button || this._showAppsButtonId)
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
        const adjustment = this._getOverviewStateAdjustment();
        if (!adjustment || adjustment === this._stateAdjustment)
            return;

        if (this._stateAdjustment && this._stateAdjustmentId) {
            try {
                this._stateAdjustment.disconnect(this._stateAdjustmentId);
            } catch (_e) {
            }
        }

        this._stateAdjustment = adjustment;
        this._stateAdjustmentId = adjustment.connect('notify::value',
            () => this._syncShowAppsButton());
        this._syncShowAppsButton();
    }

    _setShowAppsChecked(checked) {
        const button = this._dash?.showAppsButton;
        if (!button || button.checked === checked)
            return;

        this._ignoreShowAppsButtonToggle = true;
        button.checked = checked;
        this._ignoreShowAppsButtonToggle = false;
    }

    _syncShowAppsButton() {
        const adjustment = this._getOverviewStateAdjustment();
        if (!adjustment)
            return;

        const appGridState = OverviewControls.ControlsState?.APP_GRID ?? 2;
        this._setShowAppsChecked(adjustment.value >= appGridState - 0.5);
    }

    _onShowAppsButtonToggled() {
        if (this._ignoreShowAppsButtonToggle)
            return;

        const button = this._dash?.showAppsButton;
        if (!button)
            return;

        const controlsState = OverviewControls.ControlsState ?? {
            WINDOW_PICKER: 1,
            APP_GRID: 2,
        };
        const targetState = button.checked
            ? controlsState.APP_GRID
            : controlsState.WINDOW_PICKER;

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
        if (primaryButton && primaryButton !== button &&
            primaryButton.checked !== button.checked) {
            primaryButton.checked = button.checked;
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
        if (!this._bin || !this._dash)
            return;

        // Use the Dash's natural height; fall back to 60 px
        let [, natHeight] = this._dash.get_preferred_height(-1);
        if (!natHeight || natHeight <= 0)
            natHeight = 60;

        this._bin.set_size(this._monitor.width, natHeight);
        this._bin.set_position(
            this._monitor.x,
            this._monitor.y + this._monitor.height - natHeight
        );
    }

    updateMonitor(monitor) {
        this._monitor = {
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        };
        this._updatePosition();
    }

    destroy() {
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }

        if (this._overviewHidingId) {
            Main.overview.disconnect(this._overviewHidingId);
            this._overviewHidingId = null;
        }

        if (this._stateAdjustment && this._stateAdjustmentId) {
            try {
                this._stateAdjustment.disconnect(this._stateAdjustmentId);
            } catch (_e) {
            }
            this._stateAdjustment = null;
            this._stateAdjustmentId = null;
        }

        if (this._dash?.showAppsButton && this._showAppsButtonId) {
            this._dash.showAppsButton.disconnect(this._showAppsButtonId);
            this._showAppsButtonId = null;
        }

        if (this._heightChangedId) {
            this._dash.disconnect(this._heightChangedId);
            this._heightChangedId = null;
        }

        try {
            Main.layoutManager.overviewGroup.remove_child(this._bin);
        } catch (_e) {}

        this._bin.destroy();
        this._bin = null;
        this._dash = null;
    }
}
