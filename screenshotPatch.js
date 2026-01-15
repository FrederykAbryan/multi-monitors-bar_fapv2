/*
Copyright (C) 2014  spin83
*/

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let _originalOpen = null;
let _originalClose = null;
const LOG_FILE = GLib.get_home_dir() + '/mm_debug.log';

function log(msg) {
    try {
        const timestamp = new Date().toISOString();
        const output = `${timestamp}: ${msg}\n`;
        const file = Gio.File.new_for_path(LOG_FILE);
        let existing = '';
        if (file.query_exists(null)) {
            const [s, c] = file.load_contents(null);
            if (s) existing = new TextDecoder().decode(c);
        }
        file.replace_contents(new TextEncoder().encode(existing + output), null, false, Gio.FileCreateFlags.NONE, null);
    } catch (e) { }
}

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
    // Try to bind close if it exists, otherwise we wrap the close method if we can find it
    // Most likely it's `close`
    _originalClose = Main.screenshotUI.close.bind(Main.screenshotUI);

    Main.screenshotUI.open = async function (screenshotType, options = {}) {
        const targetIdx = getMonitorAtCursor();
        const originalPrimary = Main.layoutManager.primaryIndex;

        log(`\n========== Screenshot Open (V5 Probe) ==========`);
        log(`Cursor Monitor: ${targetIdx} (Original Primary: ${originalPrimary})`);

        // FAKE PRIMARY MONITOR STRATEGY
        // We set the primary monitor to the cursor monitor for the duration of the screenshot session.
        if (targetIdx >= 0 && targetIdx !== originalPrimary) {
            log(`Switching primary index to ${targetIdx} temporarily`);
            Main.layoutManager.primaryIndex = targetIdx;
        }

        let result;
        try {
            result = await _originalOpen(screenshotType, options);
        } catch (e) {
            log(`Error in open: ${e}`);
        }

        // We do NOT restore primary index immediately. We wait for close.
        // But what if it crashes or doesn't close? Safety timeout?
        // Let's set a safety restoration after 60 seconds just in case.
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            if (Main.layoutManager.primaryIndex !== originalPrimary) {
                log(`Safety timeout: restoring primary index to ${originalPrimary}`);
                Main.layoutManager.primaryIndex = originalPrimary;
            }
            return GLib.SOURCE_REMOVE;
        });

        // Debug Probe: Check Parents
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            try {
                const panel = Main.screenshotUI._panel;
                const closeBtn = Main.screenshotUI._closeButton;
                if (panel) {
                    const parent = panel.get_parent();
                    log(`Panel Parent: ${parent} (Type: ${parent?.constructor?.name})`);
                    log(`Panel Position: ${panel.x}, ${panel.y}`);
                    // Check if parent is uiGroup
                    const uiGroup = Main.layoutManager.uiGroup;
                    log(`Is parent uiGroup? ${parent === uiGroup}`);
                }
            } catch (e) { log(`Probe error: ${e}`); }
            return GLib.SOURCE_REMOVE;
        });

        return result;
    };

    Main.screenshotUI.close = function () {
        log(`Screenshot Close called`);

        // Restore Primary Monitor
        // We need to know what the original was. 
        // Since we can't easily pass state from open to close without properties, 
        // let's assume we want to restore to the "real" primary.
        // But wait, the "real" primary might be different if user changed settings?
        // Let's assume 0 is usually primary, or we check existing config?
        // Actually, for now, let's just use a global var or property

        // BETTER: Just reset to what we think is right? No, that's dangerous.
        // Ideally we stored it.
        // Let's try to restore based on a stored variable if we are the ones who changed it.

        // For this V5 probe, let's just run original close. 
        // The safety timeout will handle it, OR we rely on the fact that `open` is async 
        // and usually `await`s the screenshot process? 
        // No, `open` returns when the UI opens, `result` is the screenshot *image* (maybe?) or undefined?
        // Actually `screenshotUI.open` is `async`... does it wait for the screenshot to be taken?
        // If it waits for selection, then `await _originalOpen` blocks until done.

        const res = _originalClose.call(this);
        return res;
    };

    // RE-OVERRIDE OPEN TO HANDLE SYNC RESTORE
    Main.screenshotUI.open = async function (screenshotType, options = {}) {
        const targetIdx = getMonitorAtCursor();
        const originalPrimary = Main.layoutManager.primaryIndex;

        log(`\n========== Screenshot Open (V5 FakePrimary) ==========`);

        let changed = false;
        if (targetIdx >= 0 && targetIdx !== originalPrimary) {
            Main.layoutManager.primaryIndex = targetIdx;
            changed = true;
            log(`Switched primary to ${targetIdx}`);
        }

        try {
            // Await the entire session
            // NOTE: If `open` returns immediately after logic but *before* user selects, 
            // then we revert too early. 
            // We need to know if `open` blocks.
            // Usually `Main.screenshotUI.open` just shows the UI. It returns `Promise<void>` likely.

            await _originalOpen(screenshotType, options);

            // If it returns immediately, we must NOT revert yet.
            // We verify if UI is visible.

        } catch (e) {
            log(`Error: ${e}`);
        }

        // Hook into visibility/closing to revert.
        // We can check `Main.screenshotUI.visible` or connect to a signal?
        // But Main.screenshotUI is a JS object, not a pure Actor. 
        // It likely has `_selection` or something.

        if (changed) {
            // We need a way to restore it when it closes.
            // Let's override `close` properly.
            Main.screenshotUI._restorePrimary = originalPrimary;
        }
    };

    Main.screenshotUI.close = function () {
        log(`Screenshot closing...`);
        const ret = _originalClose.call(this);

        if (this._restorePrimary !== undefined) {
            log(`Restoring primary to ${this._restorePrimary}`);
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
