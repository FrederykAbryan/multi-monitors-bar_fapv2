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

function _destroyClones() {
    // Disconnect stage event handler
    if (_stageEventId) {
        try {
            global.stage.disconnect(_stageEventId);
        } catch (e) {
            // ignore
        }
        _stageEventId = null;
    }

    for (let clone of _screenshotClones) {
        if (clone) {
            try {
                if (clone.get_parent()) {
                    clone.get_parent().remove_child(clone);
                }
                clone.destroy();
            } catch (e) {
                // ignore
            }
        }
    }
    _screenshotClones = [];
    _cloneRects = [];
}

function _findToolbarActor(actor) {
    if (!actor) return null;

    // Direct properties that might be the toolbar
    if (actor._panel) return actor._panel;
    if (actor._bottomBar) return actor._bottomBar;
    if (actor._toolbar) return actor._toolbar;
    if (actor._buttonLayout) return actor._buttonLayout;

    // Check children for a widget that looks like a toolbar
    try {
        const children = actor.get_children();
        for (let child of children) {
            if (child instanceof St.BoxLayout || child instanceof St.Widget) {
                const childChildren = child.get_children ? child.get_children() : [];
                if (childChildren.length > 2) {
                    return child;
                }
            }
        }
    } catch (e) {
        // ignore
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
    // Calculate relative position within the clone
    const relX = stageX - rect.x;
    const relY = stageY - rect.y;

    // Calculate corresponding position on the original toolbar
    const targetX = rect.toolbarX + relX;
    const targetY = rect.toolbarY + relY;

    // Find the actor at this position on the original toolbar
    const targetActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, targetX, targetY);

    if (targetActor && targetActor !== global.stage) {
        log('[MultiMonitors] Forwarding click to: ' + targetActor + ' at (' + targetX + ', ' + targetY + ')');

        // Try different methods to activate the button
        try {
            // Method 1: emit clicked signal (for St.Button)
            if (typeof targetActor.emit === 'function') {
                targetActor.emit('clicked');
            }
        } catch (e) {
            // ignore
        }

        try {
            // Method 2: call activate (for some buttons)
            if (typeof targetActor.activate === 'function') {
                targetActor.activate(Clutter.get_current_event());
            }
        } catch (e) {
            // ignore  
        }

        try {
            // Method 3: Simulate button press/release events
            let pressEvent = Clutter.Event.new(Clutter.EventType.BUTTON_PRESS);
            pressEvent.set_coords(targetX, targetY);
            pressEvent.set_button(button);
            targetActor.emit('button-press-event', pressEvent);

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                try {
                    let releaseEvent = Clutter.Event.new(Clutter.EventType.BUTTON_RELEASE);
                    releaseEvent.set_coords(targetX, targetY);
                    releaseEvent.set_button(button);
                    targetActor.emit('button-release-event', releaseEvent);
                } catch (e) {
                    // ignore
                }
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            // ignore
        }

        return true;
    }

    return false;
}

function _createToolbarClonesForAllMonitors() {
    _destroyClones();

    const screenshotUI = Main.screenshotUI;
    if (!screenshotUI) return;

    const toolbar = _findToolbarActor(screenshotUI);
    if (!toolbar) {
        log('[MultiMonitors] Could not find toolbar in screenshot UI');
        return;
    }

    const primaryIndex = Main.layoutManager.primaryIndex;
    const monitors = Main.layoutManager.monitors;
    const primaryMonitor = monitors[primaryIndex];

    const [toolbarX, toolbarY] = toolbar.get_transformed_position();
    const toolbarWidth = toolbar.get_width();
    const toolbarHeight = toolbar.get_height();
    const offsetFromBottom = primaryMonitor.height - (toolbarY - primaryMonitor.y) - toolbarHeight;

    // Set up a capture handler on the stage to intercept clicks before screenshot UI handles them
    _stageEventId = global.stage.connect('captured-event', (actor, event) => {
        log('[MultiMonitors] captured-event fired, type: ' + event.type());
        if (event.type() !== Clutter.EventType.BUTTON_PRESS &&
            event.type() !== Clutter.EventType.BUTTON_RELEASE) {
            return Clutter.EVENT_PROPAGATE;
        }

        const [stageX, stageY] = event.get_coords();
        const rect = _isClickInCloneArea(stageX, stageY);

        if (rect) {
            log('[MultiMonitors] Captured click in clone area at (' + stageX + ', ' + stageY + ')');

            if (event.type() === Clutter.EventType.BUTTON_RELEASE) {
                _forwardClickToToolbar(stageX, stageY, rect, event.type(), event.get_button());
            }

            // Stop propagation so screenshot UI doesn't close
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    });

    // Create clones for each non-primary monitor
    for (let i = 0; i < monitors.length; i++) {
        if (i === primaryIndex) continue;

        const monitor = monitors[i];

        try {
            const cloneX = monitor.x + (monitor.width - toolbarWidth) / 2;
            const cloneY = monitor.y + monitor.height - toolbarHeight - offsetFromBottom;

            // Store rect info for click detection
            _cloneRects.push({
                x: cloneX,
                y: cloneY,
                width: toolbarWidth,
                height: toolbarHeight,
                toolbarX: toolbarX,
                toolbarY: toolbarY,
                monitorIndex: i
            });

            // Create just a visual clone
            const clone = new Clutter.Clone({
                source: toolbar,
                x: cloneX,
                y: cloneY,
                reactive: false,
            });

            clone.visible = true;
            clone.opacity = 255;
            clone.show();

            // Add clone to the screenshot UI so it's within its event context
            screenshotUI.add_child(clone);

            // Create an invisible reactive overlay on top of the clone to capture input
            const overlay = new St.Widget({
                x: cloneX,
                y: cloneY,
                width: toolbarWidth,
                height: toolbarHeight,
                reactive: true,
                can_focus: true,
                track_hover: true,
                style: 'background-color: transparent;',
            });

            // Store reference to rect for this overlay
            const rectRef = _cloneRects[_cloneRects.length - 1];

            // Function to forward click to corresponding button on original toolbar (WITHOUT moving cursor)
            const forwardClickToButton = (stageX, stageY, button) => {
                const relX = stageX - cloneX;
                const relY = stageY - cloneY;
                const targetX = Math.round(toolbarX + relX);
                const targetY = Math.round(toolbarY + relY);

                log('[MultiMonitors] Forwarding click from clone (' + stageX + ',' + stageY + ') to (' + targetX + ',' + targetY + ')');

                // Find the actor at target position on original toolbar
                let targetActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, targetX, targetY);

                if (!targetActor || targetActor === global.stage) {
                    log('[MultiMonitors] No actor found at target position');
                    return false;
                }

                log('[MultiMonitors] Found target actor: ' + targetActor);

                // Traverse up parent chain to find a clickable button
                let actorToClick = targetActor;
                for (let i = 0; i < 5 && actorToClick; i++) {
                    log('[MultiMonitors] Trying actor: ' + actorToClick.constructor.name);

                    // Check if this is an St.Button
                    if (actorToClick instanceof St.Button) {
                        log('[MultiMonitors] Found St.Button, simulating click');
                        try {
                            // Simulate a proper button click by setting pressed state
                            actorToClick.set_pressed(true);
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                                try {
                                    actorToClick.set_pressed(false);
                                    // The button should emit 'clicked' when going from pressed to unpressed
                                    log('[MultiMonitors] Button click simulated successfully');
                                } catch (e) {
                                    log('[MultiMonitors] set_pressed(false) failed: ' + e);
                                }
                                return GLib.SOURCE_REMOVE;
                            });
                            return true;
                        } catch (e) {
                            log('[MultiMonitors] set_pressed failed: ' + e);
                        }

                        // Alternative: try to set checked for toggle buttons
                        try {
                            if (typeof actorToClick.get_checked === 'function') {
                                const isChecked = actorToClick.get_checked();
                                actorToClick.set_checked(!isChecked);
                                log('[MultiMonitors] Toggled checked state');
                                return true;
                            }
                        } catch (e) {
                            log('[MultiMonitors] toggle checked failed: ' + e);
                        }
                    }

                    // Try fake_release for buttons
                    if (typeof actorToClick.fake_release === 'function') {
                        log('[MultiMonitors] Trying fake_release');
                        try {
                            actorToClick.fake_release();
                            return true;
                        } catch (e) {
                            log('[MultiMonitors] fake_release failed: ' + e);
                        }
                    }

                    actorToClick = actorToClick.get_parent();
                }

                // Last resort: simulate button press/release events on original actor
                try {
                    log('[MultiMonitors] Simulating button events');

                    // Create and emit synthetic events
                    let pressEvent = Clutter.Event.new(Clutter.EventType.BUTTON_PRESS);
                    pressEvent.set_coords(targetX, targetY);
                    pressEvent.set_button(1);
                    targetActor.event(pressEvent, false);

                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                        let releaseEvent = Clutter.Event.new(Clutter.EventType.BUTTON_RELEASE);
                        releaseEvent.set_coords(targetX, targetY);
                        releaseEvent.set_button(1);
                        targetActor.event(releaseEvent, false);
                        return GLib.SOURCE_REMOVE;
                    });

                    return true;
                } catch (e) {
                    log('[MultiMonitors] Synthetic event failed: ' + e);
                }

                return false;
            };

            // Handle clicks on the overlay
            overlay.connect('button-press-event', (actor, event) => {
                log('[MultiMonitors] Clone overlay button-press');
                return Clutter.EVENT_STOP;
            });

            overlay.connect('button-release-event', (actor, event) => {
                const [stageX, stageY] = event.get_coords();
                log('[MultiMonitors] Clone overlay button-release at (' + stageX + ', ' + stageY + ')');
                forwardClickToButton(stageX, stageY, event.get_button());
                return Clutter.EVENT_STOP;
            });

            // Add overlay to the screenshot UI so it receives events
            screenshotUI.add_child(overlay);
            screenshotUI.set_child_above_sibling(overlay, clone);

            _screenshotClones.push(clone);
            _screenshotClones.push(overlay);

            log('[MultiMonitors] Created toolbar clone for monitor ' + i);
            log('[MultiMonitors]   Position: (' + cloneX + ', ' + cloneY + ')');
            log('[MultiMonitors]   Size: ' + toolbarWidth + 'x' + toolbarHeight);
        } catch (e) {
            log('[MultiMonitors] Error creating toolbar clone for monitor ' + i + ': ' + e);
        }
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

            try {
                const openPromise = _originalOpen(screenshotType, options);
                await openPromise;

                // Create clones after UI opens
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    _createToolbarClonesForAllMonitors();
                    return GLib.SOURCE_REMOVE;
                });
            } catch (e) {
                log('[MultiMonitors] Error opening screenshot UI: ' + e);
            }
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
                try {
                    if (typeof ui._areaSelector.reset === 'function') {
                        ui._areaSelector.reset();
                    }
                    if (ui._areaSelector._selectionRect) {
                        ui._areaSelector._selectionRect = null;
                    }
                } catch (e) {
                    // ignore
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
