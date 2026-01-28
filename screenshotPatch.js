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
import St from 'gi://St';

const SCREENSHOT_ON_ALL_MONITORS_ID = 'screenshot-on-all-monitors';

let _originalOpen = null;
let _originalClose = null;
let _settings = null;
let _originalPrimaryIndex = null;
let _screenshotClones = [];
let _stageEventId = null;
let _cloneRects = []; // Store clone bounding boxes for click detection

function getMonitorAtCursor() {
    const [x, y] = global.get_pointer();
    const monitors = Main.layoutManager.monitors;
    for (let i = 0; i < monitors.length; i++) {
        const m = monitors[i];
        if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) return i;
    }
    return Main.layoutManager.primaryIndex;
}

function _destroyClones() {
    // Disconnect stage event handler
    if (_stageEventId) {
        global.stage.disconnect(_stageEventId);
        _stageEventId = null;
    }

    for (let clone of _screenshotClones) {
        if (clone) {
            if (clone.get_parent()) {
                clone.get_parent().remove_child(clone);
            }
            clone.destroy();
        }
    }
    _screenshotClones = [];
    _cloneRects = [];
}

function _findToolbarActor(actor) {
    if (!actor) return null;

    // Try to find the main panel/toolbar container
    if (actor._panel) return actor._panel;
    if (actor._bottomBar) return actor._bottomBar;
    if (actor._toolbar) return actor._toolbar;
    if (actor._buttonLayout) return actor._buttonLayout;

    // Check children for the largest widget that looks like a toolbar
    const children = actor.get_children();
    let bestChild = null;
    let maxChildCount = 0;

    for (let child of children) {
        if (child instanceof St.BoxLayout || child instanceof St.Widget) {
            const childChildren = child.get_children ? child.get_children() : [];
            if (childChildren.length > maxChildCount) {
                maxChildCount = childChildren.length;
                bestChild = child;
            }
        }
    }

    if (bestChild && maxChildCount > 2) {
        return bestChild;
    }

    return null;
}

function _isClickInCloneArea(x, y) {
    for (let rect of _cloneRects) {
        if (x >= rect.x && x <= rect.x + rect.width &&
            y >= rect.y && y <= rect.y + rect.height) {
            return rect;
        }
    }
    return null;
}

function _forwardClickToToolbar(stageX, stageY, rect, eventType, button) {
    const relX = stageX - rect.x;
    const relY = stageY - rect.y;
    const targetX = rect.toolbarX + relX;
    const targetY = rect.toolbarY + relY;

    const targetActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, targetX, targetY);

    if (targetActor && targetActor !== global.stage) {
        // Try different activation methods
        if (typeof targetActor.emit === 'function') {
            targetActor.emit('clicked');
        }

        if (typeof targetActor.activate === 'function') {
            targetActor.activate(Clutter.get_current_event());
        }

        // Simulate button press/release events
        let pressEvent = Clutter.Event.new(Clutter.EventType.BUTTON_PRESS);
        pressEvent.set_coords(targetX, targetY);
        pressEvent.set_button(button);
        targetActor.emit('button-press-event', pressEvent);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            let releaseEvent = Clutter.Event.new(Clutter.EventType.BUTTON_RELEASE);
            releaseEvent.set_coords(targetX, targetY);
            releaseEvent.set_button(button);
            targetActor.emit('button-release-event', releaseEvent);
            return GLib.SOURCE_REMOVE;
        });

        return true;
    }

    return false;
}

function _createToolbarClonesForAllMonitors() {
    _destroyClones();

    const screenshotUI = Main.screenshotUI;
    if (!screenshotUI) return;

    const primaryIndex = Main.layoutManager.primaryIndex;
    const monitors = Main.layoutManager.monitors;
    const primaryMonitor = monitors[primaryIndex];

    // DEFINITION OF ELEMENTS
    // interactiveElements: Used to calculate the total clickable area (overlay size)
    // visualElements: Used to create the visual clones (can be a subset to avoid duplicates)

    const interactiveElements = [
        screenshotUI._panel,
        screenshotUI._captureButton,
        screenshotUI._shotCastContainer, // Restoring toggle 1
        screenshotUI._showPointerButtonContainer, // Restoring toggle 2
        screenshotUI._closeButton
    ].filter(e => e != null);

    // For visuals, we RE-ADD _captureButton because the user said "that version worked".
    // We prioritize functionality over the visual duplicate for now.
    const visualElements = [
        screenshotUI._panel,
        screenshotUI._captureButton, // Restored to fix functionality
        screenshotUI._shotCastContainer, // Restoring toggle 1
        screenshotUI._showPointerButtonContainer, // Restoring toggle 2
        screenshotUI._closeButton
    ].filter(e => e != null);

    if (interactiveElements.length === 0) {
        console.debug('[MultiMonitors] No screenshot UI elements found to clone');
        return;
    }

    // 1. Calculate the bounding box using INTERACTIVE elements (max coverage)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let elem of interactiveElements) {
        try {
            const [x, y] = elem.get_transformed_position();
            const w = elem.get_width();
            const h = elem.get_height();
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + w);
            maxY = Math.max(maxY, y + h);
        } catch (e) {
            // ignore
        }
    }

    const toolbarWidth = maxX - minX;
    const toolbarHeight = maxY - minY;

    // Calculate bottom margin from primary monitor to preserve vertical spacing
    const marginBottom = (primaryMonitor.y + primaryMonitor.height) - maxY;

    console.debug('[MultiMonitors] Toolbar bounds: x=' + minX + ', y=' + minY + ', w=' + toolbarWidth + ', h=' + toolbarHeight + ', bottomMargin=' + marginBottom);

    // Create clones for each non-primary monitor
    for (let monitorIdx = 0; monitorIdx < monitors.length; monitorIdx++) {
        if (monitorIdx === primaryIndex) continue;

        const monitor = monitors[monitorIdx];

        // Calculate Centered Position for this monitor
        // New Origin X = Monitor X + (Monitor Width - Toolbar Width) / 2
        const destOriginX = monitor.x + (monitor.width - toolbarWidth) / 2;

        // New Origin Y = Monitor Y + Monitor Height - Toolbar Height - Bottom Margin
        // User requested extra padding ("no bottom margin from screen")
        // Adding 40px extra spacing to lift it up.
        const extraBottomPadding = 40;
        const destOriginY = monitor.y + monitor.height - toolbarHeight - marginBottom - extraBottomPadding;

        // Calculate offset from PRIMARY origin to DESTINATION origin
        // We use this to shift each element
        const shiftX = destOriginX - minX;
        const shiftY = destOriginY - minY;

        // We do NOT use the simple offsetX/Y anymore because that was just screen-to-screen delta.
        // We want to force centering.
        const offsetX = shiftX;
        const offsetY = shiftY;

        // 2. Create VISUAL clones using only the visualElements list
        for (let elem of visualElements) {
            const [origX, origY] = elem.get_transformed_position();
            // Apply the shift calculated from the bounding box origin
            const cloneX = origX + shiftX;
            const cloneY = origY + shiftY;

            // Fix stretch: Set explicit size, remove offset, debug opacity
            const clone = new Clutter.Clone({
                source: elem,
                x: cloneX,
                y: cloneY,
                width: elem.get_width(), // Force exact width
                height: elem.get_height(), // Force exact height to fix stretching
                reactive: true,
            });

            const isDuplicateToken = (elem === screenshotUI._captureButton) ||
                (elem === screenshotUI._shotCastContainer) ||
                (elem === screenshotUI._showPointerButtonContainer);

            const isCloseButton = (elem === screenshotUI._closeButton);

            if (isDuplicateToken) {
                clone.opacity = 0;   // Hidden but reactive!
                clone.set_z_position(9999);
            } else {
                clone.opacity = 255;
            }

            // Add direct click handler
            if (isDuplicateToken || isCloseButton) {
                clone.connect('button-release-event', () => {
                    if (elem === screenshotUI._captureButton) {
                        elem.set_pressed(true);
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                            elem.set_pressed(false);
                            return GLib.SOURCE_REMOVE;
                        });
                    } else if (elem.toggle_mode) {
                        const isPointerButton = (elem === screenshotUI._showPointerButtonContainer);

                        if (isPointerButton) {
                            if (elem.get_checked) {
                                elem.set_checked(!elem.get_checked());
                            }
                        } else {
                            if (elem.set_checked) {
                                elem.set_checked(true);
                            }
                        }
                        elem.emit('clicked', 0);
                    } else {
                        elem.emit('clicked', 0);
                    }
                    return Clutter.EVENT_STOP;
                });
            }

            clone.visible = true;
            screenshotUI.add_child(clone);
            _screenshotClones.push(clone);
        }

        // 3. Keep Overlay for background clicks / drag?
        // Reset correction since overlay is just fallback now.
        const interactionCorrectionY = 0;

        const overlayX = minX + offsetX;
        const overlayY = minY + offsetY;

        // Store rect info for this monitor
        _cloneRects.push({
            x: overlayX,
            y: overlayY,
            width: toolbarWidth,
            height: toolbarHeight,
            origX: minX,
            origY: minY,
            offsetX: offsetX,
            offsetY: offsetY + interactionCorrectionY, // Include correction in mapping offset
            monitorIndex: monitorIdx
        });

        const overlay = new St.Widget({
            x: overlayX,
            y: overlayY,
            width: toolbarWidth,
            height: toolbarHeight,
            reactive: true,
            can_focus: true,
            track_hover: true,
            style: 'background-color: transparent;',
        });

        overlay.connect('button-press-event', (actor, event) => {
            return Clutter.EVENT_STOP;
        });

        overlay.connect('button-release-event', (actor, event) => {
            const [stageX, stageY] = event.get_coords();

            // Calculate corresponding position on original toolbar
            const targetX = Math.round(stageX - offsetX);
            const targetY = Math.round(stageY - offsetY);

            console.debug('[MultiMonitors] Overlay click at (' + stageX + ',' + stageY + ') -> finding button at (' + targetX + ',' + targetY + ')');

            // Find the actor at target position on original toolbar
            let targetActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, targetX, targetY);

            if (!targetActor || targetActor === global.stage) {
                return Clutter.EVENT_STOP;
            }

            let actorToClick = targetActor;
            for (let j = 0; j < 10 && actorToClick; j++) {

                // Check for St.Button, IconLabelButton, or specific capture button style class
                const isButton = actorToClick instanceof St.Button ||
                    actorToClick.constructor.name === 'IconLabelButton' ||
                    (actorToClick.has_style_class_name && actorToClick.has_style_class_name('screenshot-ui-capture-button'));

                if (isButton) {

                    if (actorToClick.toggle_mode) {
                        if (typeof actorToClick.set_checked === 'function') {
                            actorToClick.set_checked(true);
                            actorToClick.emit('clicked', 0);
                            return Clutter.EVENT_STOP;
                        }
                    }

                    // --- CASE 2: Capture Button ---
                    // The user said this USED to work with simple logic. 
                    // We identify it by class and force the simple path.

                    const isCaptureButton = (actorToClick === screenshotUI._captureButton) ||
                        (actorToClick.has_style_class_name && actorToClick.has_style_class_name('screenshot-ui-capture-button'));

                    if (isCaptureButton) {
                        actorToClick.set_pressed(true);
                        actorToClick.add_style_pseudo_class('active');

                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                            actorToClick.set_pressed(false);
                            actorToClick.remove_style_pseudo_class('active');
                            return GLib.SOURCE_REMOVE;
                        });
                        return Clutter.EVENT_STOP;
                    }

                    if (typeof actorToClick.clicked === 'function') {
                        actorToClick.clicked(0);
                        return Clutter.EVENT_STOP;
                    }

                    actorToClick.emit('clicked', 0);
                    return Clutter.EVENT_STOP;
                }

                actorToClick = actorToClick.get_parent();
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
    _originalPrimaryIndex = Main.layoutManager.primaryIndex;

    _originalOpen = Main.screenshotUI.open.bind(Main.screenshotUI);
    if (Main.screenshotUI.close) {
        _originalClose = Main.screenshotUI.close.bind(Main.screenshotUI);
    }

    Main.screenshotUI.open = async function (screenshotType, options = {}) {
        const showOnAllMonitors = _settings && _settings.get_boolean(SCREENSHOT_ON_ALL_MONITORS_ID);

        if (showOnAllMonitors) {
            delete Main.screenshotUI._restorePrimary;

            const openPromise = _originalOpen(screenshotType, options);
            await openPromise;

            // Create clones after UI opens
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                _createToolbarClonesForAllMonitors();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        // Original behavior: show on cursor's monitor only
        const targetIdx = getMonitorAtCursor();
        const originalPrimary = Main.layoutManager.primaryIndex;

        if (targetIdx >= 0 && targetIdx !== originalPrimary) {
            Main.screenshotUI._restorePrimary = originalPrimary;
            Main.layoutManager.primaryIndex = targetIdx;
        }

        try {
            const ui = Main.screenshotUI;

            if (ui._areaSelector) {
                if (typeof ui._areaSelector.reset === 'function') {
                    ui._areaSelector.reset();
                }
                if (ui._areaSelector._selectionRect) {
                    ui._areaSelector._selectionRect = null;
                }
            }

            const openPromise = _originalOpen(screenshotType, options);
            await openPromise;
        } catch (e) {
            if (Main.screenshotUI._restorePrimary !== undefined) {
                Main.layoutManager.primaryIndex = Main.screenshotUI._restorePrimary;
                delete Main.screenshotUI._restorePrimary;
            }
        }
    };

    Main.screenshotUI.close = function () {
        // Destroy clones first
        _destroyClones();

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
    _destroyClones();

    if (Main.screenshotUI && Main.screenshotUI._restorePrimary !== undefined) {
        Main.layoutManager.primaryIndex = Main.screenshotUI._restorePrimary;
        delete Main.screenshotUI._restorePrimary;
    }

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
