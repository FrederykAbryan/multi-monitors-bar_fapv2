/*
Copyright (C) 2014  spin83

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

MMCalendar.setMainRef(Main);

// Re-export for backward compatibility
export const setMMPanelArrayRef = Constants.setMMPanelArrayRef;
export const SHOW_ACTIVITIES_ID = Constants.SHOW_ACTIVITIES_ID;
export const SHOW_APP_MENU_ID = Constants.SHOW_APP_MENU_ID;
export const SHOW_DATE_TIME_ID = Constants.SHOW_DATE_TIME_ID;
export const AVAILABLE_INDICATORS_ID = Constants.AVAILABLE_INDICATORS_ID;
export const TRANSFER_INDICATORS_ID = Constants.TRANSFER_INDICATORS_ID;
export const EXCLUDE_INDICATORS_ID = Constants.EXCLUDE_INDICATORS_ID;


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

            // Call parent init if Panel.AppMenuButton exists
            if (typeof Panel !== 'undefined' && Panel.AppMenuButton && Panel.AppMenuButton.prototype._init) {
                Panel.AppMenuButton.prototype._init.call(this, panel);
            } else {
                super._init(0.0, null, false);
                this._startingApps = [];
                this._targetApp = null;
                this._busyNotifyId = 0;
                this._actionGroupNotifyId = 0;
            }

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
            // Call parent sync if Panel.AppMenuButton exists
            if (typeof Panel !== 'undefined' && Panel.AppMenuButton && Panel.AppMenuButton.prototype._sync) {
                Panel.AppMenuButton.prototype._sync.call(this);
            }
        }

        destroy() {
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

            return super.vfunc_event(event);
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
    // dateMenu is now mirrored instead of having its own implementation
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
                style_class: 'panel'
            });

            this.monitorIndex = monitorIndex;
            this._settings = settings;

            this.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

            this._sessionStyle = null;

            this.statusArea = {};

            this.menuManager = new PopupMenu.PopupMenuManager(this);

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

            // Wrapper inside center box to center its single child (dateMenu)
            this._centerBin = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                y_expand: true,  // Allow full height for dateMenu hover
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


            this._showingId = Main.overview.connect('showing', () => {
                this.add_style_pseudo_class('overview');
            });
            this._hidingId = Main.overview.connect('hiding', () => {
                this.remove_style_pseudo_class('overview');
            });

            mmPanelBox.panelBox.add_child(this);
            Main.ctrlAltTabManager.addGroup(this, _("Top Bar"), 'focus-top-bar-symbolic',
                { sortGroup: CtrlAltTab.SortGroup.TOP });

            // Themes like Yaru style the panel via #panel (CSS ID selector).
            // Having two actors named 'panel' can prevent the theme from applying
            // background-color to the secondary panel, leaving it transparent.
            // Copy the main panel's background color explicitly.
            this._syncPanelStyle();
            this._mainPanelStyleChangedId = Main.panel.connect('style-changed',
                () => this._syncPanelStyle());

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
            this._showDateTime();

            // Watch for late-loading extensions (like Apps and Places)
            this._startExtensionWatcher();

            this.connect('destroy', this.destroy.bind(this));
        }

        _startExtensionWatcher() {
            // Listen for extension state changes (enable/disable/load)
            this._extensionStateChangedId = Main.extensionManager.connect('extension-state-changed',
                this._onExtensionStateChanged.bind(this));

            // Multiple delayed checks to catch extensions that load at various times
            // Apps and Places extension can take several seconds to fully initialize
            this._initialCheckTimeouts = [];
            const delays = [1000, 2000, 3000, 5000, 8000];

            for (const delay of delays) {
                const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    this._updatePanel();
                    const idx = this._initialCheckTimeouts.indexOf(timeoutId);
                    if (idx >= 0) this._initialCheckTimeouts.splice(idx, 1);
                    return GLib.SOURCE_REMOVE;
                });
                this._initialCheckTimeouts.push(timeoutId);
            }
        }

        _onExtensionStateChanged(_extensionManager, _extension) {
            // An extension state changed - check if new indicators appeared
            // Use a small delay to let the extension fully initialize its indicators
            if (this._extensionUpdateTimeoutId) {
                GLib.source_remove(this._extensionUpdateTimeoutId);
                this._extensionUpdateTimeoutId = null;
            }
            this._extensionUpdateTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._updatePanel();
                this._extensionUpdateTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
        }

        _syncPanelStyle() {
            try {
                const mainNode = Main.panel.get_theme_node();
                if (!mainNode)
                    return;
                const bgColor = mainNode.get_background_color();
                if (bgColor) {
                    const r = bgColor.red, g = bgColor.green, b = bgColor.blue;
                    const a = (bgColor.alpha / 255.0).toFixed(2);
                    this.set_style(`background-color: rgba(${r},${g},${b},${a});`);
                }
            } catch(e) {
                // Fallback: don't override, let theme CSS handle it
            }
        }

        vfunc_map() {
            super.vfunc_map();
            this._updatePanel();
            this._showDateTime();
        }

        destroy() {
            // Clean up extension watcher
            if (this._extensionStateChangedId) {
                Main.extensionManager.disconnect(this._extensionStateChangedId);
                this._extensionStateChangedId = null;
            }
            if (this._initialCheckTimeouts) {
                for (const timeoutId of this._initialCheckTimeouts) {
                    GLib.source_remove(timeoutId);
                }
                this._initialCheckTimeouts = null;
            }
            if (this._extensionUpdateTimeoutId) {
                GLib.source_remove(this._extensionUpdateTimeoutId);
                this._extensionUpdateTimeoutId = null;
            }

            if (this._mainPanelStyleChangedId) {
                Main.panel.disconnect(this._mainPanelStyleChangedId);
                this._mainPanelStyleChangedId = null;
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

            Main.ctrlAltTabManager.removeGroup(this);

            if (this._updatedId) {
                Main.sessionMode.disconnect(this._updatedId);
                this._updatedId = null;
            }

            super.destroy();
        }

        _showActivities() {
            let name = 'activities';
            // Don't show activities button on primary monitor - it already has one
            if (this.monitorIndex === Main.layoutManager.primaryIndex) {
                // Remove any existing activities button on primary monitor
                if (this.statusArea[name]) {
                    let indicator = this.statusArea[name];
                    if (indicator.menu)
                        this.menuManager.removeMenu(indicator.menu);
                    indicator.destroy();
                    delete this.statusArea[name];
                }
                return;
            }

            if (this._settings.get_boolean(SHOW_ACTIVITIES_ID)) {
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
                if (this.statusArea[name]) {
                    let indicator = this.statusArea[name];
                    if (indicator.menu)
                        this.menuManager.removeMenu(indicator.menu);
                    indicator.destroy();
                    delete this.statusArea[name];
                }
            }
        }

        _showDateTime() {
            let name = 'dateMenu';
            if (this._settings.get_boolean(SHOW_DATE_TIME_ID)) {
                if (!this.statusArea[name]) {
                    let indicator = this._ensureIndicator(name);
                    if (indicator) {
                        let box = this._centerBox;
                        this._addToPanelBox(name, indicator, 0, box);
                    }
                }
                if (this.statusArea[name]) {
                    this.statusArea[name].visible = true;
                }
            } else {
                if (this.statusArea[name]) {
                    let indicator = this.statusArea[name];
                    this.menuManager.removeMenu(indicator.menu);
                    indicator.destroy();
                    delete this.statusArea[name];
                }
            }
        }

        _showAppMenu() {
            let name = 'appMenu';
            if (this._settings.get_boolean(SHOW_APP_MENU_ID)) {
                if (!this.statusArea[name]) {
                    let indicator = new MultiMonitorsAppMenuButton(this);
                    this.statusArea[name] = indicator;
                    let box = this._leftBox;
                    this._addToPanelBox(name, indicator, box.get_n_children() + 1, box);
                }
            }
            else {
                if (this.statusArea[name]) {
                    let indicator = this.statusArea[name];
                    this.menuManager.removeMenu(indicator.menu);
                    indicator.destroy();
                    delete this.statusArea[name];
                }
            }
        }

        vfunc_get_preferred_width(forHeight) {
            if (Main.layoutManager.monitors.length > this.monitorIndex)
                return [0, Main.layoutManager.monitors[this.monitorIndex].width];

            return [0, 0];
        }

        vfunc_allocate(box) {
            this.set_allocation(box);

            const themeNode = this.get_theme_node();
            const contentBox = themeNode.get_content_box(box);

            const allocWidth = contentBox.get_width();

            // Get natural widths of each box to prevent overflow
            const [leftMinWidth, leftNatWidth] = this._leftBox.get_preferred_width(-1);
            const [centerMinWidth, centerNatWidth] = this._centerBox.get_preferred_width(-1);
            const [rightMinWidth, rightNatWidth] = this._rightBox.get_preferred_width(-1);

            // Calculate widths for left and right based on which is larger
            const sideWidth = Math.max(leftNatWidth, rightNatWidth);

            let leftWidth, centerWidth, rightWidth;

            // Check if we have enough space for balanced layout
            if (sideWidth * 2 + centerNatWidth > allocWidth) {
                // Overflow case: use natural widths and clip
                leftWidth = Math.min(leftNatWidth, Math.floor(allocWidth * 0.33));
                rightWidth = Math.min(rightNatWidth, Math.floor(allocWidth * 0.33));
                centerWidth = Math.max(centerMinWidth, allocWidth - leftWidth - rightWidth);
            } else {
                // Normal case: balance sides to keep center truly centered
                leftWidth = sideWidth;
                rightWidth = sideWidth;
                centerWidth = allocWidth - leftWidth - rightWidth;
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
            this._centerBox.clip_to_allocation = false;  // Don't clip center
        }

        _hideIndicators() {
            for (let role in MULTI_MONITOR_PANEL_ITEM_IMPLEMENTATIONS) {
                let indicator = this.statusArea[role];
                if (!indicator)
                    continue;
                indicator.container.hide();
            }
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
                let constructor = MULTI_MONITOR_PANEL_ITEM_IMPLEMENTATIONS[role];
                if (!constructor) {
                    // For indicators not implemented here, mirror ANY indicator from main panel
                    const mainIndicator = Main.panel.statusArea[role];

                    if (mainIndicator) {
                        try {
                            indicator = new MirroredIndicatorButton(this, role);
                            this.statusArea[role] = indicator;
                            return indicator;
                        } catch (e) {
                            console.error('[Multi Monitors Add-On] Failed to create mirrored indicator for', role, ':', String(e));
                            return null;
                        }
                    }
                    // Otherwise, not supported
                    return null;
                }
                try {
                    indicator = new constructor(this);
                } catch (e) {
                    // Don't log the error object directly as it may contain circular references
                    console.error('[Multi Monitors Add-On] Error creating indicator for', role, ':', String(e));
                    throw e;
                }
                this.statusArea[role] = indicator;
            }
            return indicator;
        }

        _getDraggableWindowForPosition(stageX) {
            let workspaceManager = global.workspace_manager;
            const windows = workspaceManager.get_active_workspace().list_windows();
            const allWindowsByStacking =
                global.display.sort_windows_by_stacking(windows).reverse();

            return allWindowsByStacking.find(metaWindow => {
                let rect = metaWindow.get_frame_rect();
                return metaWindow.get_monitor() == this.monitorIndex &&
                    metaWindow.showing_on_its_workspace() &&
                    metaWindow.get_window_type() != Meta.WindowType.DESKTOP &&
                    metaWindow.maximized_vertically &&
                    stageX > rect.x && stageX < rect.x + rect.width;
            });
        }

        _addToPanelBox(role, indicator, position, box) {

            // Exactly mimic the main Panel._addToPanelBox behavior
            let container = indicator;
            if (indicator.container) {
                container = indicator.container;
            }


            this.statusArea[role] = indicator;

            // Connect signals (like main Panel does)
            indicator.connect('destroy', () => {
                delete this.statusArea[role];
            });

            // Handle menu-set signal
            indicator.connect('menu-set', () => {
                if (!indicator.menu)
                    return;
                this.menuManager.addMenu(indicator.menu);
            });

            // Critical: Remove from existing parent BEFORE adding (like main Panel)
            const parent = container.get_parent();
            if (parent)
                parent.remove_child(container);

            // Show container BEFORE adding (like main Panel)
            container.show();

            // If targeting center box, place the item in the center wrapper and center it
            if (box === this._centerBox && this._centerBin) {
                // Remove any existing children from centerBin first
                this._centerBin.remove_all_children();
                container.x_align = Clutter.ActorAlign.CENTER;
                // Use FILL for dateMenu so hover takes full panel height
                if (role === 'dateMenu') {
                    container.y_align = Clutter.ActorAlign.FILL;
                    container.y_expand = true;
                } else {
                    container.y_align = Clutter.ActorAlign.CENTER;
                }
                this._centerBin.add_child(container);
            } else {
                // Add to box at position
                box.insert_child_at_index(container, position);
            }


            // Add menu if it exists
            if (indicator.menu)
                this.menuManager.addMenu(indicator.menu);
        }

        _updatePanel() {
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

            // Indicators that should NOT be mirrored (system/accessibility indicators)
            const excludedIndicators = [
                'a11y',              // Accessibility menu
                'dwellClick',        // Dwell click accessibility
                'screencast',        // Screen recording indicator
                'screenRecording',   // Screen recording indicator (alternative name)
                'remoteAccess',      // Remote desktop indicator
                'screenSharing',     // Screen sharing indicator
                'keyboard',          // Keyboard layout (only needed on primary)
                'power',             // Power indicator (only needed on primary)
            ];

            // Get all indicators from main panel's three boxes
            const leftIndicators = [];
            const centerIndicators = [];
            const rightIndicators = [];

            // Helper function to find role for a child actor
            const findRoleForChild = (child) => {
                for (let role in mainPanel.statusArea) {
                    const indicator = mainPanel.statusArea[role];
                    if (!indicator) continue;

                    // Skip excluded indicators
                    if (excludedIndicators.includes(role)) {
                        continue;
                    }

                    // Check if this child IS the indicator or is the indicator's container
                    if (indicator === child || indicator.container === child) {
                        return role;
                    }
                }
                return null;
            };

            // Scan each box in main panel to preserve order
            if (mainPanel._leftBox) {
                const children = mainPanel._leftBox.get_children();
                for (let child of children) {
                    if (!child.visible) {
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
                    if (!child.visible) {
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
                    if (!child.visible) {
                        continue;
                    }

                    const role = findRoleForChild(child);
                    if (role) {
                        rightIndicators.push(role);
                    }
                }
            }


            // Now mirror them in order
            this._updateBox(leftIndicators, this._leftBox);
            this._updateBox(centerIndicators, this._centerBox);
            this._updateBox(rightIndicators, this._rightBox);
        }

        _updateBox(elements, box) {
            if (!elements) {
                return;
            }

            let nChildren = box.get_n_children();

            for (let i = 0; i < elements.length; i++) {
                let role = elements[i];

                // Skip activities button on primary monitor - it already has one
                if (role === 'activities' && this.monitorIndex === Main.layoutManager.primaryIndex) {
                    continue;
                }

                try {
                    let indicator = this._ensureIndicator(role);
                    if (indicator) {
                        this._addToPanelBox(role, indicator, i + nChildren, box);
                    } else {
                    }
                } catch (e) {
                    console.error('[Multi Monitors Add-On] _updateBox: ERROR for role', role, ':', e, e.stack);
                }
            }
        }
    });

// Helper methods injected into MultiMonitorsPanel prototype
MultiMonitorsPanel.prototype._findRoleByPattern = function (pattern) {
    try {
        const keys = Object.keys(Main.panel.statusArea || {});
        return keys.find(k => pattern.test(k)) || null;
    } catch (_e) {
        return null;
    }
};

// Ensure the mirrored Quick Settings (system tray) exists and is placed at the far right
MultiMonitorsPanel.prototype._ensureQuickSettingsRightmost = function () {
    const role = 'quickSettings';
    const mainQS = Main.panel.statusArea[role];
    if (!mainQS) {
        // No quick settings on main panel; remove mirror if any
        if (this.statusArea[role]) {
            const ind = this.statusArea[role];
            const cont = ind.container || ind;
            if (cont.get_parent()) cont.get_parent().remove_child(cont);
            ind.destroy();
            delete this.statusArea[role];
        }
        return;
    }

    let indicator = this.statusArea[role];
    if (!indicator) {
        try {
            indicator = new MirroredIndicatorButton(this, role);
            this.statusArea[role] = indicator;
        } catch (e) {
            return;
        }
    }

    // Move/add to be the last item in the right box
    const container = indicator.container ? indicator.container : indicator;
    const parent = container.get_parent();
    if (parent) parent.remove_child(container);
    this._rightBox.add_child(container);
};

export { StatusIndicatorsController, MultiMonitorsAppMenuButton, MultiMonitorsActivitiesButton, MultiMonitorsPanel };
