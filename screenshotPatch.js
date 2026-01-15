/*
Copyright (C) 2014  spin83

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.
*/

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

let _originalOpen = null;
let _originalClose = null;

function getMonitorAtCursor() {
    try {
        const [x, y] = global.get_pointer();
        const monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            const m = monitors[i];
            if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) return i;
        }
        return Main.layoutManager.primaryIndex;
    } catch (e) {
        return -1;
    }
}

export function patchScreenshotUI() {
    if (_originalOpen) return;
    if (!Main.screenshotUI) return;

    _originalOpen = Main.screenshotUI.open.bind(Main.screenshotUI);
    if (Main.screenshotUI.close) {
        _originalClose = Main.screenshotUI.close.bind(Main.screenshotUI);
    }

    Main.screenshotUI.open = async function (screenshotType, options = {}) {
        const targetIdx = getMonitorAtCursor();
        const originalPrimary = Main.layoutManager.primaryIndex;

        let changed = false;
        if (targetIdx >= 0 && targetIdx !== originalPrimary) {
            Main.layoutManager.primaryIndex = targetIdx;
            changed = true;
        }

        try {
            const ui = Main.screenshotUI;

            // Attempt to reset selection so it starts fresh on the new monitor
            if (ui._areaSelector) {
                try {
                    if (typeof ui._areaSelector.reset === 'function') {
                        ui._areaSelector.reset();
                    }
                    if (ui._areaSelector._selectionRect) {
                        ui._areaSelector._selectionRect = null;
                    }
                } catch (e) {
                    // ignore errors
                }
            }

            const openPromise = _originalOpen(screenshotType, options);
            await openPromise;
        } catch (e) {
            // ignore
        }

        // Restore primary monitor logic
        if (changed) Main.screenshotUI._restorePrimary = originalPrimary;
    };

    Main.screenshotUI.close = function () {
        let ret;
        if (_originalClose) ret = _originalClose.call(this);
        if (this._restorePrimary !== undefined) {
            Main.layoutManager.primaryIndex = this._restorePrimary;
            delete this._restorePrimary;
        }
        return ret;
    }
}

export function unpatchScreenshotUI() {
    if (_originalOpen && Main.screenshotUI) {
        Main.screenshotUI.open = _originalOpen;
        _originalOpen = null;
    }
    if (_originalClose && Main.screenshotUI) {
        Main.screenshotUI.close = _originalClose;
        _originalClose = null;
    }
}
