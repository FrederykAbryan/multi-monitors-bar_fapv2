/*
Copyright (C) 2025-2026  Frederyk Abryan Palinoan

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.
*/

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

const SCREENSHOT_ON_ALL_MONITORS_ID = 'screenshot-on-all-monitors';

let _originalOpen = null;
let _originalClose = null;
let _settings = null;
let _screenshotClones = [];
let _pendingTimeouts = [];  // Track all one-shot timeouts for cleanup

function getMonitorAtCursor() {
    const [x, y] = global.get_pointer();
    const monitors = Main.layoutManager.monitors;
    for (let i = 0; i < monitors.length; i++) {
        const m = monitors[i];
        if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) return i;
    }
    return Main.layoutManager.primaryIndex;
}

// Restore the primary index only if this patch has an in-flight screenshot
// change recorded on the screenshot UI, and only if the saved index is still
// valid for the *current* monitor set. The monitor index->physical mapping can
// change across suspend/resume and monitor (dis)connect, so a stale saved index
// must never be force-applied over GNOME's recomputed primary.
function _restorePendingPrimary(ui) {
    if (!ui || ui._restorePrimary === undefined)
        return;

    const saved = ui._restorePrimary;
    delete ui._restorePrimary;

    if (!Number.isInteger(saved))
        return;

    const monitorCount = Main.layoutManager.monitors.length;
    if (saved >= 0 && saved < monitorCount &&
        Main.layoutManager.primaryIndex !== saved) {
        Main.layoutManager.primaryIndex = saved;
    }
}

function _destroyClones() {
    // Remove all pending timeouts per EGO guidelines
    for (let timeoutId of _pendingTimeouts) {
        if (timeoutId) {
            GLib.source_remove(timeoutId);
        }
    }
    _pendingTimeouts = [];

    for (let clone of _screenshotClones) {
        if (clone) {
            if (clone.get_parent()) {
                clone.get_parent().remove_child(clone);
            }
            clone.destroy();
        }
    }
    _screenshotClones = [];
}

/**
 * Flash the capture button's pressed style, then click it.
 *
 * @param {St.Button} button - the screenshot UI capture button
 */
function _clickCaptureButton(button) {
    button.add_style_pseudo_class('active');
    const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        _pendingTimeouts = _pendingTimeouts.filter(id => id !== timeoutId);
        button.remove_style_pseudo_class('active');
        button.emit('clicked', 0);
        return GLib.SOURCE_REMOVE;
    });
    _pendingTimeouts.push(timeoutId);
}

function _createToolbarClonesForAllMonitors() {
    _destroyClones();

    const screenshotUI = Main.screenshotUI;
    if (!screenshotUI) return;

    const primaryIndex = Main.layoutManager.primaryIndex;
    const monitors = Main.layoutManager.monitors;
    const primaryMonitor = monitors[primaryIndex];

    // Private ScreenshotUI fields; skip any that a Shell release lacks.
    const elements = [
        screenshotUI._panel,
        screenshotUI._captureButton,
        screenshotUI._shotCastContainer,
        screenshotUI._showPointerButtonContainer,
        screenshotUI._closeButton,
    ].filter(e => e != null);

    if (elements.length === 0) {
        console.debug('[MultiMonitors] No screenshot UI elements found to clone');
        return;
    }

    // Bounding box of the toolbar on the primary monitor.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const elem of elements) {
        const [x, y] = elem.get_transformed_position();
        const w = elem.get_width();
        const h = elem.get_height();
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w);
        maxY = Math.max(maxY, y + h);
    }

    const toolbarWidth = maxX - minX;
    const toolbarHeight = maxY - minY;

    // Keep the primary monitor's gap between the toolbar and the screen edge.
    const marginBottom = (primaryMonitor.y + primaryMonitor.height) - maxY;

    console.debug(`[MultiMonitors] Toolbar bounds: x=${minX}, y=${minY}, w=${toolbarWidth}, h=${toolbarHeight}, bottomMargin=${marginBottom}`);

    for (let monitorIdx = 0; monitorIdx < monitors.length; monitorIdx++) {
        if (monitorIdx === primaryIndex) continue;

        const monitor = monitors[monitorIdx];

        // Centre the toolbar copy horizontally and lift it slightly above
        // the primary monitor's bottom margin.
        const extraBottomPadding = 40;
        const destOriginX = monitor.x + (monitor.width - toolbarWidth) / 2;
        const destOriginY = monitor.y + monitor.height - toolbarHeight - marginBottom - extraBottomPadding;
        const shiftX = destOriginX - minX;
        const shiftY = destOriginY - minY;

        for (const elem of elements) {
            const [origX, origY] = elem.get_transformed_position();

            // An explicit size keeps the clone from stretching.
            const clone = new Clutter.Clone({
                source: elem,
                x: origX + shiftX,
                y: origY + shiftY,
                width: elem.get_width(),
                height: elem.get_height(),
                reactive: true,
            });

            // The panel clone already paints these children, so their own
            // clones stay invisible and only take clicks.
            const isPaintedByPanel = elem === screenshotUI._captureButton ||
                elem === screenshotUI._shotCastContainer ||
                elem === screenshotUI._showPointerButtonContainer;

            if (isPaintedByPanel) {
                clone.opacity = 0;
                clone.set_z_position(9999);
            }

            if (elem === screenshotUI._captureButton) {
                clone.connect('button-release-event', () => {
                    _clickCaptureButton(elem);
                    return Clutter.EVENT_STOP;
                });
            } else if (elem === screenshotUI._closeButton) {
                clone.connect('button-release-event', () => {
                    elem.emit('clicked', 0);
                    return Clutter.EVENT_STOP;
                });
            }

            screenshotUI.add_child(clone);
            _screenshotClones.push(clone);
        }

        // Transparent overlay that maps clicks on the copy back to the
        // buttons of the real toolbar.
        const overlay = new St.Widget({
            x: minX + shiftX,
            y: minY + shiftY,
            width: toolbarWidth,
            height: toolbarHeight,
            reactive: true,
            can_focus: true,
            track_hover: true,
            style: 'background-color: transparent;',
        });

        overlay.connect('button-press-event', () => Clutter.EVENT_STOP);

        overlay.connect('button-release-event', (_actor, event) => {
            const [stageX, stageY] = event.get_coords();
            const targetX = Math.round(stageX - shiftX);
            const targetY = Math.round(stageY - shiftY);

            console.debug(`[MultiMonitors] Overlay click at (${stageX},${stageY}) -> finding button at (${targetX},${targetY})`);

            const targetActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, targetX, targetY);
            if (!targetActor || targetActor === global.stage)
                return Clutter.EVENT_STOP;

            // The pick may land on a button's child; walk up to the button.
            let button = targetActor;
            for (let depth = 0; depth < 10 && button && !(button instanceof St.Button); depth++)
                button = button.get_parent();

            if (!(button instanceof St.Button))
                return Clutter.EVENT_STOP;

            if (button.toggle_mode) {
                // The pointer toggle flips; mode buttons behave like radios.
                const isPointerButton = button === screenshotUI._showPointerButton ||
                    button.get_parent() === screenshotUI._showPointerButtonContainer;
                button.checked = isPointerButton ? !button.checked : true;
                button.emit('clicked', 0);
            } else if (button === screenshotUI._captureButton) {
                _clickCaptureButton(button);
            } else {
                button.emit('clicked', 0);
            }

            return Clutter.EVENT_STOP;
        });

        screenshotUI.add_child(overlay);
        _screenshotClones.push(overlay);
    }
}

export function patchScreenshotUI(settings) {
    if (_originalOpen) return;
    if (!Main.screenshotUI) return;

    _settings = settings;

    _originalOpen = Main.screenshotUI.open.bind(Main.screenshotUI);
    _originalClose = Main.screenshotUI.close.bind(Main.screenshotUI);

    Main.screenshotUI.open = async function (screenshotType, options = {}) {
        const showOnAllMonitors = _settings && _settings.get_boolean(SCREENSHOT_ON_ALL_MONITORS_ID);

        if (showOnAllMonitors) {
            delete Main.screenshotUI._restorePrimary;

            await _originalOpen(screenshotType, options);

            // Create clones after UI opens
            const cloneTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                _pendingTimeouts = _pendingTimeouts.filter(id => id !== cloneTimeoutId);
                _createToolbarClonesForAllMonitors();
                return GLib.SOURCE_REMOVE;
            });
            _pendingTimeouts.push(cloneTimeoutId);
            return;
        }

        // Original behavior: show on cursor's monitor only
        const targetIdx = getMonitorAtCursor();
        const originalPrimary = Main.layoutManager.primaryIndex;

        if (targetIdx >= 0 && targetIdx !== originalPrimary) {
            Main.screenshotUI._restorePrimary = originalPrimary;
            Main.layoutManager.primaryIndex = targetIdx;
        }

        const ui = Main.screenshotUI;
        if (ui._areaSelector) {
            ui._areaSelector.reset();
            if (ui._areaSelector._selectionRect)
                ui._areaSelector._selectionRect = null;
        }

        // Capture can reject; restore the temporary monitor override on failure.
        try {
            await _originalOpen(screenshotType, options);
        } catch (e) {
            _restorePendingPrimary(ui);
            throw e;
        }
    };

    Main.screenshotUI.close = function () {
        // Destroy clones first
        _destroyClones();

        _restorePendingPrimary(this);

        return _originalClose.call(this);
    };
}

export function unpatchScreenshotUI() {
    _destroyClones();

    // Only undo an in-flight screenshot change (validated against the current
    // monitor set). Never force a snapshot taken at patch time over GNOME's
    // primary index -- across suspend/resume that snapshot is stale and would
    // move the primary monitor to the wrong (e.g. external) display.
    _restorePendingPrimary(Main.screenshotUI);

    if (_originalOpen && Main.screenshotUI) {
        Main.screenshotUI.open = _originalOpen;
        _originalOpen = null;
    }
    if (_originalClose && Main.screenshotUI) {
        Main.screenshotUI.close = _originalClose;
        _originalClose = null;
    }
    _settings = null;
}
