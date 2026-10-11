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
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Panel from 'resource:///org/gnome/shell/ui/panel.js';
import * as CtrlAltTab from 'resource:///org/gnome/shell/ui/ctrlAltTab.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as MultiMonitors from './extension.js';
import * as MMCalendar from './mmcalendar.js';
import * as Constants from './mmPanelConstants.js';
import { StatusIndicatorsController } from './statusIndicatorsController.js';
import { MirroredIndicatorButton } from './mirroredIndicatorButton.js';
import {
    CONTROL_ROLE, EXCLUDED_MIRROR_ROLES, indicatorIsEnabled, monitorKey, sourceIsVisible,
} from './monitorIndicatorPolicy.js';

MMCalendar.setMainRef(Main);

// Re-export for backward compatibility
export const setMMPanelArrayRef = Constants.setMMPanelArrayRef;
export const SHOW_ACTIVITIES_ID = Constants.SHOW_ACTIVITIES_ID;
export const SHOW_APP_MENU_ID = Constants.SHOW_APP_MENU_ID;
export const SHOW_DATE_TIME_ID = Constants.SHOW_DATE_TIME_ID;
export const DATE_TIME_POSITION_ID = 'date-time-position';
export const AVAILABLE_INDICATORS_ID = Constants.AVAILABLE_INDICATORS_ID;
export const TRANSFER_INDICATORS_ID = Constants.TRANSFER_INDICATORS_ID;
export const EXCLUDE_INDICATORS_ID = Constants.EXCLUDE_INDICATORS_ID;
export const PANEL_COLOR_ID = 'panel-color';
export const SHOW_APP_INDICATORS_ID = 'show-app-indicators';


const MultiMonitorsAppMenuButton = GObject.registerClass(
    class MultiMonitorsAppMenuButton extends PanelMenu.Button {
        _init(panel) {
            if (panel.monitorIndex == undefined)
                this._monitorIndex = Main.layoutManager.primaryIndex;
            else
                this._monitorIndex = panel.monitorIndex;
            this._actionOnWorkspaceGroupNotifyId = 0;
            this._targetAppGroup = null;
            this._lastFocusedWindow = null;

            // Panel.AppMenuButton exists on GNOME 45 but was removed in 46.
            if (Panel.AppMenuButton) {
                Panel.AppMenuButton.prototype._init.call(this, panel);
            } else {
                super._init(0.0, null, false);
                this._startingApps = [];
                this._targetApp = null;
                this._busyNotifyId = 0;
                this._actionGroupNotifyId = 0;
            }

            this._syncAppMenuIconGeometry();
            this._iconGeometryTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._syncAppMenuIconGeometry();
                this._iconGeometryTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            });

            this._windowEnteredMonitorId = global.display.connect('window-entered-monitor',
                this._windowEnteredMonitor.bind(this));
            this._windowLeftMonitorId = global.display.connect('window-left-monitor',
                this._windowLeftMonitor.bind(this));
        }

        _windowEnteredMonitor(metaScreen, monitorIndex, metaWin) {
            if (monitorIndex == this._monitorIndex) {
                switch (metaWin.get_window_type()) {
                    case Meta.WindowType.NORMAL:
                    case Meta.WindowType.DIALOG:
                    case Meta.WindowType.MODAL_DIALOG:
                    case Meta.WindowType.SPLASHSCREEN:
                        this._sync();
                        break;
                }
            }
        }

        _windowLeftMonitor(metaScreen, monitorIndex, metaWin) {
            if (monitorIndex == this._monitorIndex) {
                switch (metaWin.get_window_type()) {
                    case Meta.WindowType.NORMAL:
                    case Meta.WindowType.DIALOG:
                    case Meta.WindowType.MODAL_DIALOG:
                    case Meta.WindowType.SPLASHSCREEN:
                        this._sync();
                        break;
                }
            }
        }

        _findTargetApp() {

            if (this._actionOnWorkspaceGroupNotifyId) {
                this._targetAppGroup.disconnect(this._actionOnWorkspaceGroupNotifyId);
                this._actionOnWorkspaceGroupNotifyId = 0;
                this._targetAppGroup = null;
            }
            let groupWindow = false;
            let groupFocus = false;

            let workspaceManager = global.workspace_manager;
            let workspace = workspaceManager.get_active_workspace();
            let tracker = Shell.WindowTracker.get_default();
            let focusedApp = tracker.focus_app;
            if (focusedApp && focusedApp.is_on_workspace(workspace)) {
                let windows = focusedApp.get_windows();
                for (let i = 0; i < windows.length; i++) {
                    let win = windows[i];
                    if (win.located_on_workspace(workspace)) {
                        if (win.get_monitor() == this._monitorIndex) {
                            if (win.has_focus()) {
                                this._lastFocusedWindow = win;
                                return focusedApp;
                            }
                            else
                                groupWindow = true;
                        }
                        else {
                            if (win.has_focus())
                                groupFocus = true;
                        }
                        if (groupFocus && groupWindow) {
                            if (focusedApp != this._targetApp) {
                                this._targetAppGroup = focusedApp;
                                this._actionOnWorkspaceGroupNotifyId = this._targetAppGroup.connect('notify::action-group',
                                    this._sync.bind(this));
                            }
                            break;
                        }
                    }
                }
            }

            for (let i = 0; i < this._startingApps.length; i++)
                if (this._startingApps[i].is_on_workspace(workspace)) {
                    return this._startingApps[i];
                }

            if (this._lastFocusedWindow && this._lastFocusedWindow.located_on_workspace(workspace) &&
                this._lastFocusedWindow.get_monitor() == this._monitorIndex) {
                return tracker.get_window_app(this._lastFocusedWindow);
            }

            let windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace);

            for (let i = 0; i < windows.length; i++) {
                if (windows[i].get_monitor() == this._monitorIndex) {
                    this._lastFocusedWindow = windows[i];
                    return tracker.get_window_app(windows[i]);
                }
            }

            return null;
        }

        _sync() {
            if (!this._switchWorkspaceNotifyId)
                return;
            // Panel.AppMenuButton exists on GNOME 45 but was removed in 46.
            if (Panel.AppMenuButton)
                Panel.AppMenuButton.prototype._sync.call(this);

            this._syncAppMenuIconGeometry();
        }

        _syncAppMenuIconGeometry() {
            const iconSize = Panel.PANEL_ICON_SIZE || 16;
            const iconBox = this._iconBox || this._findChildByStyleClass(this, 'app-menu-icon');
            if (!iconBox)
                return;

            this.y_expand = true;
            this.y_align = Clutter.ActorAlign.FILL;

            iconBox.set_size(iconSize, iconSize);
            iconBox.x_expand = false;
            iconBox.y_expand = false;
            iconBox.x_align = Clutter.ActorAlign.CENTER;
            iconBox.y_align = Clutter.ActorAlign.CENTER;

            const icon = iconBox.child || iconBox.get_first_child();
            if (icon) {
                icon.set_size(iconSize, iconSize);
                icon.x_expand = false;
                icon.y_expand = false;
                icon.x_align = Clutter.ActorAlign.CENTER;
                icon.y_align = Clutter.ActorAlign.CENTER;
            }
        }

        _findChildByStyleClass(actor, styleClass) {
            // Style classes are St.Widget-only; the tree also contains plain Clutter actors.
            if (actor instanceof St.Widget && actor.has_style_class_name(styleClass))
                return actor;

            const children = actor.get_children();
            for (const child of children) {
                const found = this._findChildByStyleClass(child, styleClass);
                if (found)
                    return found;
            }

            return null;
        }

        destroy() {
            if (this._iconGeometryTimeoutId) {
                GLib.source_remove(this._iconGeometryTimeoutId);
                this._iconGeometryTimeoutId = 0;
            }

            if (this._actionGroupNotifyId) {
                this._targetApp.disconnect(this._actionGroupNotifyId);
                this._actionGroupNotifyId = 0;
            }

            global.display.disconnect(this._windowEnteredMonitorId);
            global.display.disconnect(this._windowLeftMonitorId);

            if (this._busyNotifyId) {
                this._targetApp.disconnect(this._busyNotifyId);
                this._busyNotifyId = 0;
            }

            if (this.menu._windowsChangedId) {
                this.menu._app.disconnect(this.menu._windowsChangedId);
                this.menu._windowsChangedId = 0;
            }
            super.destroy();
        }
    });


const MultiMonitorsActivitiesButton = GObject.registerClass(
    class MultiMonitorsActivitiesButton extends PanelMenu.Button {
        _init() {
            super._init(0.0, null, true);
            this.accessible_role = Atk.Role.TOGGLE_BUTTON;

            this.name = 'mmPanelActivities';

            /* Translators: If there is no suitable word for "Activities"
               in your language, you can use the word for "Overview". */
            this._label = new St.Label({
                text: _("Activities"),
                y_align: Clutter.ActorAlign.CENTER
            });
            this.add_child(this._label);

            this.label_actor = this._label;

            this._showingId = Main.overview.connect('showing', () => {
                this.add_style_pseudo_class('overview');
                this.add_accessible_state(Atk.StateType.CHECKED);
            });
            this._hidingId = Main.overview.connect('hiding', () => {
                this.remove_style_pseudo_class('overview');
                this.remove_accessible_state(Atk.StateType.CHECKED);
            });

            this._xdndTimeOut = 0;
        }

        vfunc_event(event) {
            if (event.type() === Clutter.EventType.BUTTON_PRESS ||
                event.type() === Clutter.EventType.TOUCH_BEGIN) {
                Main.overview.toggle();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        }

        destroy() {
            if (this._showingId) {
                Main.overview.disconnect(this._showingId);
                this._showingId = null;
            }
            if (this._hidingId) {
                Main.overview.disconnect(this._hidingId);
                this._hidingId = null;
            }
            super.destroy();
        }
    });

const MULTI_MONITOR_PANEL_ITEM_IMPLEMENTATIONS = {
    // activities is now mirrored instead of having its own implementation
    'appMenu': MultiMonitorsAppMenuButton,
    'dateMenu': MMCalendar.MultiMonitorsDateMenuButton,
};

const MultiMonitorsPanel = GObject.registerClass(
    class MultiMonitorsPanel extends St.Widget {
        _init(monitorIndex, mmPanelBox, settings) {
            if (!mmPanelBox) {
                throw new Error('mmPanelBox parameter is required but was undefined');
            }

            super._init({
                name: 'panel',
                reactive: true,
                style_class: 'panel multimonitor-panel',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
                clip_to_allocation: true,
            });

            this.monitorIndex = monitorIndex;
            this._settings = settings;


            this.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

            this._sessionStyle = null;

            this.statusArea = {};

            this.menuManager = new PopupMenu.PopupMenuManager(this);
            this._primaryPanelBoxes = [];
            this._panelRefreshTimeouts = [];

            // GNOME 46 FIX: Create boxes with proper expansion and alignment
            // Left box should expand and fill available space
            this._leftBox = new St.BoxLayout({
                name: 'panelLeft',
                x_expand: true,
                y_expand: true,  // Allow full height for activities hover
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.FILL
            });
            this.add_child(this._leftBox);

            // Center box should be centered
            this._centerBox = new St.BoxLayout({
                name: 'panelCenter',
                x_expand: true,
                y_expand: true,  // Allow full height
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.FILL  // Fill height
            });
            this.add_child(this._centerBox);

            // Horizontal row inside center box so multiple center items
            // (e.g. dateMenu + weather) sit side by side instead of stacking
            this._centerBin = new St.BoxLayout({
                x_expand: true,
                y_expand: true,  // Allow full height for dateMenu hover
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.FILL,
            });
            this._centerBox.add_child(this._centerBin);

            // Right box should align to the end
            this._rightBox = new St.BoxLayout({
                name: 'panelRight',
                x_expand: true,
                y_expand: false,
                x_align: Clutter.ActorAlign.END
            });
            this.add_child(this._rightBox);

            // Connect drag signals for dragging maximized windows off the panel.
            if (Clutter.ClickGesture) {
                this._clickGesture = new Clutter.ClickGesture({
                    recognize_on_press: true,
                });
                this._clickGestureRecognizeId = this._clickGesture.connect(
                    'recognize', this._onWindowDragGestureRecognize.bind(this));
                this.add_action_full(
                    'window-drag', Clutter.EventPhase.TARGET, this._clickGesture);
            } else {
                this.connect('button-press-event', this._onButtonPress.bind(this));
                this.connect('touch-event', this._onTouchEvent.bind(this));
            }


            this._showingId = Main.overview.connect('showing', () => {
                this.add_style_pseudo_class('overview');
            });
            this._hidingId = Main.overview.connect('hiding', () => {
                this.remove_style_pseudo_class('overview');
            });

            mmPanelBox.panelBox.add_child(this);
            Main.ctrlAltTabManager.addGroup(this, _("Top Bar"), 'focus-top-bar-symbolic',
                { sortGroup: CtrlAltTab.SortGroup.TOP });

            this._updatedId = Main.sessionMode.connect('updated', this._updatePanel.bind(this));

            this._workareasChangedId = global.display.connect('workareas-changed', () => this.queue_relayout());

            this._showActivitiesId = this._settings.connect('changed::' + SHOW_ACTIVITIES_ID,
                this._showActivities.bind(this));
            this._showActivities();

            this._showAppMenuId = this._settings.connect('changed::' + SHOW_APP_MENU_ID,
                this._showAppMenu.bind(this));
            this._showAppMenu();

            this._showDateTimeId = this._settings.connect('changed::' + SHOW_DATE_TIME_ID,
                this._showDateTime.bind(this));
            this._dateTimePositionId = this._settings.connect('changed::' + DATE_TIME_POSITION_ID,
                this._showDateTime.bind(this));
            this._showDateTime();

            this._showAppIndicatorsId = this._settings.connect('changed::' + SHOW_APP_INDICATORS_ID,
                () => this._updatePanel());

            // Watch for late-loading extensions (like Apps and Places)
            this._startExtensionWatcher();

            // Apply custom panel color
            this._panelColorId = this._settings.connect('changed::' + PANEL_COLOR_ID,
                this._applyPanelColor.bind(this));
            this._applyPanelColor();

        }

        _startExtensionWatcher() {
            // Listen for extension state changes (enable/disable/load)
            this._extensionStateChangedId = Main.extensionManager.connect('extension-state-changed',
                this._onExtensionStateChanged.bind(this));

            this._connectPrimaryPanelBoxWatchers();

            // Multiple delayed checks to catch extensions that load at various times
            // Apps and Places extension can take several seconds to fully initialize
            this._initialCheckTimeouts = [];
            const delays = [1000, 2000, 3000, 5000, 8000];

            for (const delay of delays) {
                const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    const idx = this._initialCheckTimeouts?.indexOf(timeoutId) ?? -1;
                    if (idx >= 0) this._initialCheckTimeouts.splice(idx, 1);
                    this._updatePanel();
                    return GLib.SOURCE_REMOVE;
                });
                this._initialCheckTimeouts.push(timeoutId);
            }
        }

        _onExtensionStateChanged(_extensionManager, _extension) {
            this._schedulePanelRefresh([100, 500, 1500]);
        }

        _connectPrimaryPanelBoxWatchers() {
            const mainPanel = Main.panel;
            if (!mainPanel)
                return;

            const scheduleUpdate = () => {
                this._schedulePanelRefresh([50, 250, 1000]);
            };

            // connectObject ties these handlers on the surviving Main.panel
            // boxes to THIS panel's lifetime, so they auto-disconnect when the
            // panel is destroyed (even from C on a monitor change). Otherwise
            // they keep firing scheduleUpdate against a disposed panel.
            const signals = ['child-added', 'child-removed', 'actor-added', 'actor-removed'];
            for (const boxName of ['_leftBox', '_centerBox', '_rightBox']) {
                const box = mainPanel[boxName];
                if (!box)
                    continue;

                this._primaryPanelBoxes.push(box);
                box.connectObject('destroy', () => {
                    this._primaryPanelBoxes = this._primaryPanelBoxes.filter(actor => actor !== box);
                }, this);
                // Clutter renamed actor-added/removed to child-added/removed.
                for (const signal of signals) {
                    if (GObject.signal_lookup(signal, box.constructor.$gtype))
                        box.connectObject(signal, scheduleUpdate, this);
                }
            }
        }

        _schedulePanelRefresh(delays) {
            if (!this._settings)
                return;
            for (const timeoutId of this._panelRefreshTimeouts)
                GLib.source_remove(timeoutId);
            this._panelRefreshTimeouts = [];

            for (const delay of delays) {
                const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    this._panelRefreshTimeouts = this._panelRefreshTimeouts.filter(id => id !== timeoutId);
                    this._updatePanel();
                    return GLib.SOURCE_REMOVE;
                });
                this._panelRefreshTimeouts.push(timeoutId);
            }
        }

        vfunc_map() {
            super.vfunc_map();
            this._updatePanel();
        }

        _cleanup() {

            // Clean up extension watcher
            if (this._extensionStateChangedId) {
                Main.extensionManager.disconnect(this._extensionStateChangedId);
                this._extensionStateChangedId = null;
            }
            // Handlers were connected with connectObject(this); auto-disconnect
            // on destroy covers it, but disconnect explicitly for completeness.
            if (this._primaryPanelBoxes) {
                for (const box of this._primaryPanelBoxes) {
                    box.disconnectObject(this);
                }
                this._primaryPanelBoxes = [];
            }
            if (this._initialCheckTimeouts) {
                for (const timeoutId of this._initialCheckTimeouts) {
                    GLib.source_remove(timeoutId);
                }
                this._initialCheckTimeouts = null;
            }
            if (this._panelRefreshTimeouts) {
                for (const timeoutId of this._panelRefreshTimeouts)
                    GLib.source_remove(timeoutId);
                this._panelRefreshTimeouts = [];
            }

            if (this._clickGestureRecognizeId && this._clickGesture) {
                this._clickGesture.disconnect(this._clickGestureRecognizeId);
                this._clickGestureRecognizeId = null;
            }

            if (this._workareasChangedId) {
                global.display.disconnect(this._workareasChangedId);
                this._workareasChangedId = null;
            }
            if (this._showingId) {
                Main.overview.disconnect(this._showingId);
                this._showingId = null;
            }
            if (this._hidingId) {
                Main.overview.disconnect(this._hidingId);
                this._hidingId = null;
            }
            if (this._showActivitiesId) {
                this._settings.disconnect(this._showActivitiesId);
                this._showActivitiesId = null;
            }
            if (this._showAppMenuId) {
                this._settings.disconnect(this._showAppMenuId);
                this._showAppMenuId = null;
            }
            if (this._showDateTimeId) {
                this._settings.disconnect(this._showDateTimeId);
                this._showDateTimeId = null;
            }
            if (this._dateTimePositionId) {
                this._settings.disconnect(this._dateTimePositionId);
                this._dateTimePositionId = null;
            }
            if (this._showAppIndicatorsId) {
                this._settings.disconnect(this._showAppIndicatorsId);
                this._showAppIndicatorsId = null;
            }
            if (this._panelColorId) {
                this._settings.disconnect(this._panelColorId);
                this._panelColorId = null;
            }

            Main.ctrlAltTabManager.removeGroup(this);

            if (this._updatedId) {
                Main.sessionMode.disconnect(this._updatedId);
                this._updatedId = null;
            }

            for (const role in this.statusArea) {
                this._destroyIndicator(role);
            }
            this.statusArea = {};
            this._settings = null;
            this._leftBox = null;
            this._centerBox = null;
            this._centerBin = null;
            this._rightBox = null;
            this._clickGesture = null;
        }

        destroy() {
            this._cleanup();
            super.destroy();
        }

        _showActivities() {
            let name = 'activities';
            // Don't show activities button on primary monitor - it already has one
            if (this.monitorIndex === Main.layoutManager.primaryIndex ||
                this._shouldSuppressActivitiesForArcMenu()) {
                // Remove any existing activities button on primary monitor
                this._destroyIndicator(name);
                return;
            }

            if (this._roleIsEnabled(name, this._settings.get_boolean(SHOW_ACTIVITIES_ID))) {
                if (!this.statusArea[name]) {
                    let indicator = this._ensureIndicator(name);
                    if (indicator) {
                        let box = this._leftBox;
                        this._addToPanelBox(name, indicator, 0, box);
                    }
                }
                if (this.statusArea[name])
                    this.statusArea[name].visible = true;
            } else {
                this._destroyIndicator(name);
            }
        }

        _applyPanelColor() {
            let color = this._settings.get_string(PANEL_COLOR_ID);
            if (color && color !== '') {
                this.set_style('background-color: ' + color + ' !important;');
            } else {
                this.set_style(null);
            }
        }

        _showDateTime() {
            const name = 'dateMenu';
            if (this._roleIsEnabled(name, this._settings.get_boolean(SHOW_DATE_TIME_ID))) {
                const indicator = this._ensureIndicator(name);
                if (!indicator)
                    return;

                const position = this._settings.get_string(DATE_TIME_POSITION_ID);
                let box = this._centerBox;
                let index = 0;
                if (position === 'left') {
                    box = this._leftBox;
                    index = box.get_n_children();
                } else if (position === 'right-before-tray' || position === 'right-after-tray') {
                    box = this._rightBox;
                    index = box.get_n_children();
                    if (position === 'right-before-tray') {
                        const tray = this.statusArea.quickSettings;
                        const trayContainer = tray?.container || tray;
                        const trayIndex = box.get_children().indexOf(trayContainer);
                        if (trayIndex >= 0)
                            index = trayIndex;
                    }
                }
                const container = indicator.container || indicator;
                if (box === this._centerBox && container.get_parent() === this._centerBin) {
                    container.show();
                    indicator.visible = true;
                    return;
                }
                if (box !== this._centerBox && container.get_parent() === box &&
                    box.get_children().indexOf(container) < index)
                    index--;
                if (box !== this._centerBox && container.get_parent() === box &&
                    box.get_children().indexOf(container) === index) {
                    container.show();
                    indicator.visible = true;
                    return;
                }
                this._addToPanelBox(name, indicator, index, box);
                indicator.visible = true;
            } else {
                this._destroyIndicator(name);
            }
        }

        _showAppMenu() {
            let name = 'appMenu';
            if (this._roleIsEnabled(name, this._settings.get_boolean(SHOW_APP_MENU_ID))) {
                if (!this.statusArea[name]) {
                    let indicator = new MultiMonitorsAppMenuButton(this);
                    this.statusArea[name] = indicator;
                    let box = this._leftBox;
                    this._addToPanelBox(name, indicator, box.get_n_children() + 1, box);
                }
            }
            else {
                this._destroyIndicator(name);
            }
        }

        vfunc_get_preferred_width(forHeight) {
            if (Main.layoutManager.monitors.length > this.monitorIndex)
                return [0, Main.layoutManager.monitors[this.monitorIndex].width];

            return [0, 0];
        }

        vfunc_allocate(box) {
            if (!this._settings)
                return;
            this.set_allocation(box);

            const themeNode = this.get_theme_node();
            const contentBox = themeNode.get_content_box(box);

            const allocWidth = contentBox.get_width();

            // Get natural widths of each box to prevent overflow
            const [, leftNatWidth] = this._leftBox.get_preferred_width(-1);
            const [centerMinWidth, centerNatWidth] = this._centerBox.get_preferred_width(-1);
            const [, rightNatWidth] = this._rightBox.get_preferred_width(-1);

            let leftWidth, centerWidth, rightWidth;

            // Keep the normal GNOME-like balanced layout while there is room.
            // On narrow/portrait monitors the status area can exceed one third
            // of the panel width; reserve it first so Quick Settings stays
            // anchored to the monitor edge instead of being clipped away.
            const sideWidth = Math.max(leftNatWidth, rightNatWidth);
            if (sideWidth * 2 + centerNatWidth <= allocWidth) {
                leftWidth = sideWidth;
                rightWidth = sideWidth;
                centerWidth = allocWidth - leftWidth - rightWidth;
            } else {
                rightWidth = Math.min(rightNatWidth, allocWidth);
                const remainingAfterRight = allocWidth - rightWidth;
                const centerFloor = Math.min(centerMinWidth, remainingAfterRight);
                leftWidth = Math.min(leftNatWidth, Math.max(0, remainingAfterRight - centerFloor));
                centerWidth = Math.max(0, allocWidth - leftWidth - rightWidth);
            }

            // Left box - aligned to start
            const leftChildBox = new Clutter.ActorBox();
            leftChildBox.x1 = contentBox.x1;
            leftChildBox.y1 = contentBox.y1;
            leftChildBox.x2 = contentBox.x1 + leftWidth;
            leftChildBox.y2 = contentBox.y2;
            this._leftBox.allocate(leftChildBox);
            this._leftBox.clip_to_allocation = true;

            // Right box - aligned to end
            const rightChildBox = new Clutter.ActorBox();
            rightChildBox.x1 = contentBox.x2 - rightWidth;
            rightChildBox.y1 = contentBox.y1;
            rightChildBox.x2 = contentBox.x2;
            rightChildBox.y2 = contentBox.y2;
            this._rightBox.allocate(rightChildBox);
            this._rightBox.clip_to_allocation = true;

            // Center box - perfectly centered between left and right
            const centerChildBox = new Clutter.ActorBox();
            centerChildBox.x1 = leftChildBox.x2;
            centerChildBox.y1 = contentBox.y1;
            centerChildBox.x2 = rightChildBox.x1;
            centerChildBox.y2 = contentBox.y2;
            this._centerBox.allocate(centerChildBox);
            // Keep the center actor from painting outside monitor bounds.
            this._centerBox.clip_to_allocation = true;
        }

        _hideIndicators() {
            for (let role in this.statusArea) {
                let indicator = this.statusArea[role];
                if (!indicator)
                    continue;
                const container = indicator.container || indicator;
                if (container?.hide)
                    container.hide();
            }
        }

        _disconnectIndicatorSignals(indicator) {
            if (!indicator)
                return;

            if (indicator._mmDestroyId) {
                indicator.disconnect(indicator._mmDestroyId);
                indicator._mmDestroyId = 0;
            }

            if (indicator._mmMenuSetId) {
                indicator.disconnect(indicator._mmMenuSetId);
                indicator._mmMenuSetId = 0;
            }
        }

        _destroyIndicator(role) {
            const indicator = this.statusArea[role];
            if (!indicator)
                return;

            delete this.statusArea[role];
            if (indicator.menu)
                this.menuManager.removeMenu(indicator.menu);
            this._disconnectIndicatorSignals(indicator);
            indicator.destroy();
        }

        _roleIsEnabled(role, fallback = true) {
            return indicatorIsEnabled(this._settings,
                monitorKey(global.display, this.monitorIndex, Main.layoutManager.primaryIndex),
                role, fallback);
        }

        _ensureIndicator(role) {

            // CRITICAL FIX: Never create activities indicator on primary monitor
            if (role === 'activities' && this.monitorIndex === Main.layoutManager.primaryIndex) {
                return null;
            }

            let indicator = this.statusArea[role];
            if (indicator) {
                indicator.container.show();
                // CRITICAL FIX: Return the existing indicator instead of null!
                return indicator;
            }
            else {
                if (role === CONTROL_ROLE) {
                    indicator = Main.panel.statusArea[role]?.createMirrorButton();
                    if (indicator)
                        this.statusArea[role] = indicator;
                    return indicator;
                }
                let constructor = MULTI_MONITOR_PANEL_ITEM_IMPLEMENTATIONS[role];
                if (!constructor) {
                    // For indicators not implemented here, mirror ANY indicator from main panel
                    const mainIndicator = Main.panel.statusArea[role];

                    if (mainIndicator) {
                        indicator = new MirroredIndicatorButton(this, role);
                        this.statusArea[role] = indicator;
                        return indicator;
                    }
                    // Otherwise, not supported
                    return null;
                }
                indicator = new constructor(this);
                this.statusArea[role] = indicator;
            }
            return indicator;
        }

        _getMonitorIndexForPosition(stageX, stageY) {
            const monitors = Main.layoutManager.monitors || [];
            for (let i = 0; i < monitors.length; i++) {
                const monitor = monitors[i];
                if (stageX >= monitor.x && stageX < monitor.x + monitor.width &&
                    stageY >= monitor.y && stageY < monitor.y + monitor.height) {
                    return i;
                }
            }

            // Fallbacks when pointer is outside monitor bounds during transitions.
            const actorMonitor = Main.layoutManager.findIndexForActor(this);
            if (actorMonitor !== -1)
                return actorMonitor;

            return this.monitorIndex;
        }

        _getDraggableWindowForPosition(stageX, monitorIndex = this.monitorIndex) {
            let workspaceManager = global.workspace_manager;
            const windows = workspaceManager.get_active_workspace().list_windows();
            const allWindowsByStacking =
                global.display.sort_windows_by_stacking(windows).reverse();

            return allWindowsByStacking.find(metaWindow => {
                let rect = metaWindow.get_frame_rect();
                return metaWindow.get_monitor() == monitorIndex &&
                    metaWindow.showing_on_its_workspace() &&
                    metaWindow.get_window_type() != Meta.WindowType.DESKTOP &&
                    metaWindow.maximized_vertically &&
                    stageX > rect.x && stageX < rect.x + rect.width;
            });
        }

        _isInteractiveEventTarget(event) {
            // Walk up the actor tree from the event target to check if we
            // hit an interactive child (button/menu) before reaching the panel.
            const targetActor = global.stage.get_event_actor(event);
            let actor = targetActor;
            while (actor && actor !== this) {
                if (actor !== this._leftBox &&
                    actor !== this._centerBox &&
                    actor !== this._rightBox &&
                    actor !== this._centerBin &&
                    actor.reactive) {
                    return true;
                }
                actor = actor.get_parent();
            }

            return false;
        }

        _getGrabSprite(event) {
            const backend = global.stage.get_context().get_backend();
            if (backend && typeof backend.get_sprite === 'function')
                return backend.get_sprite(global.stage, event);

            return null;
        }

        _beginWindowGrab(dragWindow, event, x, y, button = -1) {
            // GNOME 50 moved begin_grab_op onto Meta.Window with a Graphene.Point;
            // 45-49 only have the older Meta.Display signature below.
            if (typeof dragWindow.begin_grab_op === 'function') {
                const coords = new Graphene.Point({ x, y });
                dragWindow.begin_grab_op(
                    Meta.GrabOp.MOVING,
                    this._getGrabSprite(event),
                    event.get_time(),
                    coords);
                return true;
            }

            if (typeof global.display.begin_grab_op === 'function') {
                return global.display.begin_grab_op(
                    dragWindow,
                    Meta.GrabOp.MOVING,
                    false, /* pointer grab */
                    true,  /* frame action */
                    button,
                    event.get_state(),
                    event.get_time(),
                    x, y);
            }

            return false;
        }

        _onWindowDragGestureRecognize() {
            if (Main.modalCount > 0)
                return;

            const event = this._clickGesture.get_point_event(0);
            if (!event || this._isInteractiveEventTarget(event))
                return;

            const coords = this._clickGesture.get_coords_abs();
            const monitorIndex = this._getMonitorIndexForPosition(coords.x, coords.y);
            const dragWindow = this._getDraggableWindowForPosition(coords.x, monitorIndex);
            if (!dragWindow)
                return;

            this._beginWindowGrab(dragWindow, event, coords.x, coords.y);
        }

        _tryDragWindow(event) {
            // GNOME 45-49 (no Clutter.ClickGesture): prefer the running shell's
            // own Panel._tryDragWindow so the grab uses the exact begin_grab_op
            // signature for this version. Our _beginWindowGrab below assumes the
            // GNOME 50 window-level API and does not match older shells.
            if (Main.panel && typeof Main.panel._tryDragWindow === 'function') {
                return Main.panel._tryDragWindow.call(this, event);
            }

            if (Main.modalCount > 0)
                return Clutter.EVENT_PROPAGATE;

            if (event.get_source && event.get_source() !== this)
                return Clutter.EVENT_PROPAGATE;

            if (this._isInteractiveEventTarget(event))
                return Clutter.EVENT_PROPAGATE;

            const type = event.type();
            const isPress = type === Clutter.EventType.BUTTON_PRESS;
            if (!isPress && type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;

            const [x, y] = event.get_coords();
            const monitorIndex = this._getMonitorIndexForPosition(x, y);
            const dragWindow = this._getDraggableWindowForPosition(x, monitorIndex);
            if (!dragWindow)
                return Clutter.EVENT_PROPAGATE;

            const button = event.type() === Clutter.EventType.BUTTON_PRESS
                ? event.get_button()
                : -1;

            return this._beginWindowGrab(dragWindow, event, x, y, button)
                ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }

        _onButtonPress(_actor, event) {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            return this._tryDragWindow(event);
        }

        _onTouchEvent(_actor, event) {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;

            return this._tryDragWindow(event);
        }

        _getMainCenterRank(role) {
            // Index of the role's actor in the main panel's center box, or -1
            const mainBox = Main.panel?._centerBox;
            const mainIndicator = Main.panel?.statusArea?.[role];
            if (!mainBox || !mainIndicator)
                return -1;
            const mainContainer = mainIndicator.container || mainIndicator;
            return mainBox.get_children().findIndex(child =>
                child === mainContainer || (child.contains && child.contains(mainContainer)));
        }

        _getCenterInsertIndex(role, position) {
            // Keep center items in the main panel's center order. The dateMenu
            // is placed separately, so list positions alone are not enough.
            const children = this._centerBin.get_children();
            const rank = this._getMainCenterRank(role);
            if (rank < 0)
                return Math.max(0, Math.min(position, children.length));
            let index = 0;
            for (const child of children) {
                const childRank = child._mmRole ? this._getMainCenterRank(child._mmRole) : -1;
                if (childRank >= 0 && childRank < rank)
                    index++;
            }
            return index;
        }

        _addToPanelBox(role, indicator, position, box) {

            // Exactly mimic the main Panel._addToPanelBox behavior
            let container = indicator;
            if (indicator.container) {
                container = indicator.container;
            }


            this.statusArea[role] = indicator;

            // Connect signals (like main Panel does)
            if (!indicator._mmDestroyId) {
                indicator._mmDestroyId = indicator.connect('destroy', () => {
                    indicator._mmDestroyId = 0;
                    indicator._mmMenuSetId = 0;
                    delete this.statusArea[role];
                });
            }

            // Handle menu-set signal
            if (!indicator._mmMenuSetId) {
                indicator._mmMenuSetId = indicator.connect('menu-set', () => {
                    if (!indicator.menu)
                        return;
                    this.menuManager.addMenu(indicator.menu);
                });
            }

            // Critical: Remove from existing parent BEFORE adding (like main Panel)
            const parent = container.get_parent();
            if (parent)
                parent.remove_child(container);

            // Show container BEFORE adding (like main Panel)
            container.show();

            // If targeting center box, place the item in the center wrapper and center it
            if (box === this._centerBox && this._centerBin) {
                container.x_align = Clutter.ActorAlign.CENTER;
                // Use FILL for dateMenu so hover takes full panel height
                if (role === 'dateMenu') {
                    container.y_align = Clutter.ActorAlign.FILL;
                    container.y_expand = true;
                } else {
                    container.y_align = Clutter.ActorAlign.CENTER;
                }
                container._mmRole = role;
                this._centerBin.insert_child_at_index(container,
                    this._getCenterInsertIndex(role, position));
            } else {
                // Add to box at position
                box.insert_child_at_index(container, position);
            }


            // Add menu if it exists
            if (indicator.menu)
                this.menuManager.addMenu(indicator.menu);
        }

        _updatePanel() {
            if (!this._settings)
                return;
            this._hideIndicators();

            // Clone ALL indicators from main panel instead of just the default ones
            this._cloneAllMainPanelIndicators();


            // Ensure system tray is rightmost
            this._ensureQuickSettingsRightmost();

        }

        _cloneAllMainPanelIndicators() {

            const mainPanel = Main.panel;
            if (!mainPanel || !mainPanel.statusArea) {
                return;
            }

            // Indicators that should NOT be mirrored (system/accessibility indicators and GNOME 46 phantom indicators)
            const excludedIndicators = EXCLUDED_MIRROR_ROLES;

            // Get all indicators from main panel's three boxes
            const leftIndicators = [];
            const centerIndicators = [];
            const rightIndicators = [];

            // Helper function to find role for a child actor
            const findRoleForChild = (child) => {
                for (let role in mainPanel.statusArea) {
                    // The date menu has its own visibility and placement setting.
                    if (role === 'dateMenu')
                        continue;
                    const indicator = mainPanel.statusArea[role];
                    if (!indicator) continue;

                    // Skip excluded indicators
                    const fallback = role === 'activities' ? this._settings.get_boolean(SHOW_ACTIVITIES_ID)
                        : role === 'appMenu' ? this._settings.get_boolean(SHOW_APP_MENU_ID) : true;
                    if (excludedIndicators.includes(role) || !this._roleIsEnabled(role, fallback)) {
                        continue;
                    }

                    const container = indicator.container || indicator;

                    // Match direct ownership and wrapped/containerized indicators.
                    // Some tray providers insert wrappers around the real container,
                    // so strict equality misses them and causes skipped mirrors.
                    if (indicator === child ||
                        container === child ||
                        (child.contains && child.contains(container)) ||
                        (container.contains && container.contains(child))) {
                        return role;
                    }
                }
                return null;
            };

            // Scan each box in main panel to preserve order
            if (mainPanel._leftBox) {
                const children = mainPanel._leftBox.get_children();
                for (let child of children) {
                    if (!sourceIsVisible(child)) {
                        continue;
                    }

                    const role = findRoleForChild(child);
                    if (role) {
                        leftIndicators.push(role);
                    }
                }
            }

            if (mainPanel._centerBox) {
                const children = mainPanel._centerBox.get_children();
                for (let child of children) {
                    if (!sourceIsVisible(child)) {
                        continue;
                    }

                    const role = findRoleForChild(child);
                    if (role) {
                        centerIndicators.push(role);
                    }
                }
            }

            if (mainPanel._rightBox) {
                const children = mainPanel._rightBox.get_children();
                for (let child of children) {
                    if (!sourceIsVisible(child)) {
                        continue;
                    }

                    const role = findRoleForChild(child);
                    if (role) {
                        rightIndicators.push(role);
                    }
                }
            }

            // ArcMenu replaces GNOME's Activities entry on the primary panel.
            // Mirror that behavior on extended panels by dropping our synthetic
            // activities/workspace-dot role whenever ArcMenu is present.
            if (this._hasArcMenuRole([...leftIndicators, ...centerIndicators, ...rightIndicators])) {
                this._removeRole(leftIndicators, 'activities');
                this._removeRole(centerIndicators, 'activities');
                this._removeRole(rightIndicators, 'activities');
            }

            // Hide AppIndicator/tray icons (AppIndicator extension roles) if disabled
            if (!this._settings.get_boolean(SHOW_APP_INDICATORS_ID)) {
                const isAppIndicator = role => role.startsWith('appindicator');
                for (const list of [leftIndicators, centerIndicators, rightIndicators]) {
                    for (let i = list.length - 1; i >= 0; i--) {
                        if (isAppIndicator(list[i]))
                            list.splice(i, 1);
                    }
                }
            }

            // Now mirror them in order
            const desiredRoles = new Set([...leftIndicators, ...centerIndicators, ...rightIndicators]);
            if (this._roleIsEnabled('dateMenu', this._settings.get_boolean(SHOW_DATE_TIME_ID)))
                desiredRoles.add('dateMenu');
            this._removeStaleIndicators(desiredRoles);

            this._updateBox(leftIndicators, this._leftBox);
            this._updateBox(centerIndicators, this._centerBox);
            this._updateBox(rightIndicators, this._rightBox);
        }

        _isArcMenuRole(role) {
            if (role !== 'ArcMenu')
                return false;

            const indicator = Main.panel?.statusArea?.[role];
            return !!indicator?.arcMenu || !!indicator?.menuButtonWidget ||
                typeof indicator?.toggleMenu === 'function';
        }

        _hasArcMenuRole(roles) {
            return roles.some(role => this._isArcMenuRole(role));
        }

        _shouldSuppressActivitiesForArcMenu() {
            return this._isArcMenuRole('ArcMenu');
        }

        _removeRole(roles, roleToRemove) {
            let index = roles.indexOf(roleToRemove);
            while (index !== -1) {
                roles.splice(index, 1);
                index = roles.indexOf(roleToRemove);
            }
        }

        _removeStaleIndicators(desiredRoles) {
            for (const role in this.statusArea) {
                const indicator = this.statusArea[role];
                const mainIndicator = Main.panel.statusArea[role] || null;

                if (!desiredRoles.has(role)) {
                    this._destroyIndicator(role);
                    continue;
                }

                if (indicator instanceof MirroredIndicatorButton &&
                    role !== 'activities' &&
                    indicator._sourceIndicator !== mainIndicator) {
                    this._destroyIndicator(role);
                }
            }
        }

        _updateBox(elements, box) {
            if (!elements || !box) {
                return;
            }

            let nChildren = box.get_n_children();

            for (let i = 0; i < elements.length; i++) {
                let role = elements[i];

                // Skip activities button on primary monitor - it already has one
                if (role === 'activities' && this.monitorIndex === Main.layoutManager.primaryIndex) {
                    continue;
                }

                let indicator = this._ensureIndicator(role);
                if (indicator) {
                    // Skip indicators that are marked as empty (phantom buttons)
                    if (indicator._isEmpty) {
                        // Destroy the empty indicator to clean up
                        this._destroyIndicator(role);
                        continue;
                    }
                    const position = box === this._centerBox ? i : i + nChildren;
                    this._addToPanelBox(role, indicator, position, box);
                } else {
                }
            }
        }
    });

// Helper methods injected into MultiMonitorsPanel prototype
MultiMonitorsPanel.prototype._findRoleByPattern = function (pattern) {
    const keys = Object.keys(Main.panel.statusArea || {});
    return keys.find(k => pattern.test(k)) || null;
};

// Ensure the mirrored Quick Settings (system tray) exists and is placed at the far right
MultiMonitorsPanel.prototype._ensureQuickSettingsRightmost = function () {
    const role = 'quickSettings';
    const mainQS = Main.panel.statusArea[role];
    if (!mainQS || !this._roleIsEnabled(role)) {
        // No quick settings on main panel; remove mirror if any
        if (this.statusArea[role]) {
            const ind = this.statusArea[role];
            const cont = ind.container || ind;
            if (cont.get_parent()) cont.get_parent().remove_child(cont);
        }
        this._destroyIndicator(role);
        this._showDateTime();
        return;
    }

    let indicator = this.statusArea[role];
    if (!indicator) {
        indicator = new MirroredIndicatorButton(this, role);
        this.statusArea[role] = indicator;
    }

    // Move/add to be the last item in the right box
    const container = indicator.container ? indicator.container : indicator;
    const parent = container.get_parent();
    if (parent) parent.remove_child(container);
    this._addToPanelBox(role, indicator, this._rightBox.get_n_children(), this._rightBox);
    this._showDateTime();
};

export { StatusIndicatorsController, MultiMonitorsAppMenuButton, MultiMonitorsActivitiesButton, MultiMonitorsPanel };
