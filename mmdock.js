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
        this._destroying = false;

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

    _getLocalShowAppsButton() {
        if (!this._dash)
            return null;

        try {
            return this._dash.showAppsButton ?? null;
        } catch (_e) {
            this._dash = null;
            return null;
        }
    }

    _connectShowAppsButton() {
        const button = this._getLocalShowAppsButton();
        if (this._destroying || !button || this._showAppsButtonId)
            return;

        try {
            this._showAppsButtonId = button.connect('notify::checked',
                () => this._onShowAppsButtonToggled());
        } catch (_e) {
            this._showAppsButtonId = null;
        }
    }

    _getOverviewControls() {
        try {
            return Main.overview?._overview?.controls ??
                Main.overview?._overview?._controls ??
                Main.overview?._controls ??
                null;
        } catch (_e) {
            return null;
        }
    }

    _getOverviewStateAdjustment() {
        return this._getOverviewControls()?._stateAdjustment ?? null;
    }

    _getPrimaryShowAppsButton() {
        try {
            const controls = this._getOverviewControls();
            return controls?.dash?.showAppsButton ??
                controls?._dash?.showAppsButton ??
                Main.overview?.dash?.showAppsButton ??
                null;
        } catch (_e) {
            return null;
        }
    }

    _connectOverviewStateAdjustment() {
        if (this._destroying)
            return;

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
        const button = this._getLocalShowAppsButton();
        if (this._destroying || !button)
            return;

        try {
            if (button.checked === checked)
                return;

            this._ignoreShowAppsButtonToggle = true;
            button.checked = checked;
        } catch (_e) {
            this._showAppsButtonId = null;
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
        try {
            this._setShowAppsChecked(adjustment.value >= appGridState - 0.5);
        } catch (_e) {
            this._stateAdjustment = null;
            this._stateAdjustmentId = null;
        }
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
        try {
            checked = button.checked;
        } catch (_e) {
            this._showAppsButtonId = null;
            return;
        }

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
            try {
                if (primaryButton.checked === checked)
                    return;
                primaryButton.checked = checked;
                return;
            } catch (_e) {
            }
        }

        const adjustment = this._getOverviewStateAdjustment();
        if (!adjustment)
            return;

        try {
            adjustment.remove_transition('value');
            adjustment.ease(targetState, {
                duration: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME ?? 250,
                mode: Clutter.AnimationMode.EASE_OUT_SINE,
            });
        } catch (_e) {
        }
    }

    _updatePosition() {
        if (this._destroying || !this._bin || !this._dash)
            return;

        try {
            // Use the Dash's natural height; fall back to 60 px
            let [, natHeight] = this._dash.get_preferred_height(-1);
            if (!natHeight || natHeight <= 0)
                natHeight = 60;

            this._bin.set_size(this._monitor.width, natHeight);
            this._bin.set_position(
                this._monitor.x,
                this._monitor.y + this._monitor.height - natHeight
            );
        } catch (_e) {
        }
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
        this._destroying = true;

        if (this._overviewShowingId) {
            try {
                Main.overview.disconnect(this._overviewShowingId);
            } catch (_e) {
            }
            this._overviewShowingId = null;
        }

        if (this._overviewHidingId) {
            try {
                Main.overview.disconnect(this._overviewHidingId);
            } catch (_e) {
            }
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

        const showAppsButton = this._getLocalShowAppsButton();
        if (showAppsButton && this._showAppsButtonId) {
            try {
                showAppsButton.disconnect(this._showAppsButtonId);
            } catch (_e) {
            }
            this._showAppsButtonId = null;
        }

        if (this._dash && this._heightChangedId) {
            try {
                this._dash.disconnect(this._heightChangedId);
            } catch (_e) {
            }
            this._heightChangedId = null;
        }

        try {
            Main.layoutManager.overviewGroup.remove_child(this._bin);
        } catch (_e) {}

        try {
            this._bin.destroy();
        } catch (_e) {}
        this._bin = null;
        this._dash = null;
    }
}
