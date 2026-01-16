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

const SCREENSHOT_ON_ALL_MONITORS_ID = 'screenshot-on-all-monitors';

let _originalOpen = null;
let _originalClose = null;
let _settings = null;
let _originalPrimaryIndex = null;

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

export function patchScreenshotUI(settings) {
    if (_originalOpen) return;
    if (!Main.screenshotUI) return;

    _settings = settings;
    // Save the original primary index when patching, so we can always restore to it
    _originalPrimaryIndex = Main.layoutManager.primaryIndex;

    _originalOpen = Main.screenshotUI.open.bind(Main.screenshotUI);
    if (Main.screenshotUI.close) {
        _originalClose = Main.screenshotUI.close.bind(Main.screenshotUI);
    }

    Main.screenshotUI.open = async function (screenshotType, options = {}) {
        // Check if screenshot should show on all monitors
        const showOnAllMonitors = _settings && _settings.get_boolean(SCREENSHOT_ON_ALL_MONITORS_ID);

        if (showOnAllMonitors) {
            // When showing on all monitors, just call the original open without any changes
            // Make sure we don't have leftover restore state
            delete Main.screenshotUI._restorePrimary;
            try {
                const openPromise = _originalOpen(screenshotType, options);
                await openPromise;
            } catch (e) {
                // ignore
            }
            return;
        }

        // Original behavior: show on cursor's monitor only
        const targetIdx = getMonitorAtCursor();
        const originalPrimary = Main.layoutManager.primaryIndex;

        // Save restore info BEFORE changing primaryIndex
        if (targetIdx >= 0 && targetIdx !== originalPrimary) {
            Main.screenshotUI._restorePrimary = originalPrimary;
            Main.layoutManager.primaryIndex = targetIdx;
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
            // If open fails, restore immediately
            if (Main.screenshotUI._restorePrimary !== undefined) {
                Main.layoutManager.primaryIndex = Main.screenshotUI._restorePrimary;
                delete Main.screenshotUI._restorePrimary;
            }
        }
    };

    Main.screenshotUI.close = function () {
        // Restore primary monitor BEFORE calling original close
        if (this._restorePrimary !== undefined) {
            Main.layoutManager.primaryIndex = this._restorePrimary;
            delete this._restorePrimary;
        }

        let ret;
        if (_originalClose) ret = _originalClose.call(this);
        return ret;
    }
}

export function unpatchScreenshotUI() {
    // Clean up any leftover restore state and restore primary if needed
    if (Main.screenshotUI && Main.screenshotUI._restorePrimary !== undefined) {
        Main.layoutManager.primaryIndex = Main.screenshotUI._restorePrimary;
        delete Main.screenshotUI._restorePrimary;
    }

    // Also restore to original primary if it was changed and not restored
    if (_originalPrimaryIndex !== null && Main.layoutManager.primaryIndex !== _originalPrimaryIndex) {
        Main.layoutManager.primaryIndex = _originalPrimaryIndex;
    }

    if (_originalOpen && Main.screenshotUI) {
        Main.screenshotUI.open = _originalOpen;
        _originalOpen = null;
    }
    if (_originalClose && Main.screenshotUI) {
        Main.screenshotUI.close = _originalClose;
        _originalClose = null;
    }
    _settings = null;
    _originalPrimaryIndex = null;
}

