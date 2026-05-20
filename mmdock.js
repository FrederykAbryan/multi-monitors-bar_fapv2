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

        // Native GNOME Shell Dash widget (same class used by the overview)
        this._dash = new DashModule.Dash();
        this._dash.add_style_class_name('multimonitor-dock');

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
