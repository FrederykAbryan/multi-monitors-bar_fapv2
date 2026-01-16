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

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Params from 'resource:///org/gnome/shell/misc/params.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as Overview from 'resource:///org/gnome/shell/ui/overview.js';
import * as SearchController from 'resource:///org/gnome/shell/ui/searchController.js';
import * as LayoutManager from 'resource:///org/gnome/shell/ui/layout.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as WorkspacesView from 'resource:///org/gnome/shell/ui/workspacesView.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Search from 'resource:///org/gnome/shell/ui/search.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as MultiMonitors from './extension.js';
import * as Common from './common.js';
import { shellVersion } from './common.js';
import * as Constants from './mmPanelConstants.js';

// Re-export for backward compatibility
export const setMMPanelArrayRef = Constants.setMMPanelArrayRef;

export const THUMBNAILS_SLIDER_POSITION_ID = 'thumbnails-slider-position';

class MultiMonitorsWorkspaceThumbnailClass extends St.Widget {
    _init(metaWorkspace, monitorIndex) {
        super._init({
            clip_to_allocation: true,
            style_class: 'workspace-thumbnail',
        });
        this._delegate = this;

        this.metaWorkspace = metaWorkspace;
        this.monitorIndex = monitorIndex;

        this._removed = false;

        this._contents = new Clutter.Actor();
        this.add_child(this._contents);

        // Initialize _viewport for GNOME 46 compatibility
        this._viewport = new Clutter.Actor();
        this._contents.add_child(this._viewport);


        this._createBackground();

        let workArea = Main.layoutManager.getWorkAreaForMonitor(this.monitorIndex);
        this.setPorthole(workArea.x, workArea.y, workArea.width, workArea.height);

        let windows = global.get_window_actors().filter(actor => {
            let win = actor.meta_window;
            return win.located_on_workspace(metaWorkspace);
        });

        // Create clones for windows that should be visible in the Overview
        this._windows = [];
        this._allWindows = [];
        this._minimizedChangedIds = [];
        for (let i = 0; i < windows.length; i++) {
            let minimizedChangedId =
                windows[i].meta_window.connect('notify::minimized',
                    this._updateMinimized.bind(this));
            this._allWindows.push(windows[i].meta_window);
            this._minimizedChangedIds.push(minimizedChangedId);

            if (this._isMyWindow(windows[i]) && this._isOverviewWindow(windows[i]))
                this._addWindowClone(windows[i]);
        }

        // Track window changes
        this._windowAddedId = this.metaWorkspace.connect('window-added',
            this._windowAdded.bind(this));
        this._windowRemovedId = this.metaWorkspace.connect('window-removed',
            this._windowRemoved.bind(this));
        this._windowEnteredMonitorId = global.display.connect('window-entered-monitor',
            this._windowEnteredMonitor.bind(this));
        this._windowLeftMonitorId = global.display.connect('window-left-monitor',
            this._windowLeftMonitor.bind(this));

        this.state = WorkspaceThumbnail.ThumbnailState.NORMAL;
        this._slidePosition = 0; // Fully slid in
        this._collapseFraction = 0; // Not collapsed
    }

    _createBackground() {
        this._bgManager = new Background.BackgroundManager({
            monitorIndex: this.monitorIndex,
            container: this._contents,
            vignette: false
        });
    }
}

Common.copyClass(WorkspaceThumbnail.WorkspaceThumbnail, MultiMonitorsWorkspaceThumbnailClass);
export const MultiMonitorsWorkspaceThumbnail = GObject.registerClass({
    Properties: {
        'collapse-fraction': GObject.ParamSpec.double(
            'collapse-fraction', 'collapse-fraction', 'collapse-fraction',
            GObject.ParamFlags.READWRITE,
            0, 1, 0),
        'slide-position': GObject.ParamSpec.double(
            'slide-position', 'slide-position', 'slide-position',
            GObject.ParamFlags.READWRITE,
            0, 1, 0),
    },
}, MultiMonitorsWorkspaceThumbnailClass);

class MultiMonitorsThumbnailsBoxClass extends St.Widget {
    _init(scrollAdjustment, monitorIndex, settings) {

        super._init({
            reactive: true,
            style_class: 'workspace-thumbnails',
            request_mode: Clutter.RequestMode.WIDTH_FOR_HEIGHT
        });

        this._delegate = this;
        this._monitorIndex = monitorIndex;
        this._settings = settings;

        let indicator = new St.Bin({ style_class: 'workspace-thumbnail-indicator' });

        // We don't want the indicator to affect drag-and-drop
        Shell.util_set_hidden_from_pick(indicator, true);

        this._indicator = indicator;
        this.add_child(indicator);

        // The porthole is the part of the screen we're showing in the thumbnails
        this._porthole = {
            width: global.stage.width, height: global.stage.height,
            x: global.stage.x, y: global.stage.y
        };

        this._dropWorkspace = -1;
        this._dropPlaceholderPos = -1;
        this._dropPlaceholder = new St.Bin({ style_class: 'placeholder' });
        this.add_child(this._dropPlaceholder);
        this._spliceIndex = -1;

        this._targetScale = 0;
        this._scale = 0;
        this._pendingScaleUpdate = false;
        this._stateUpdateQueued = false;
        this._animatingIndicator = false;

        this._stateCounts = {};
        for (let key in WorkspaceThumbnail.ThumbnailState)
            this._stateCounts[WorkspaceThumbnail.ThumbnailState[key]] = 0;

        this._thumbnails = [];

        this._showingId = Main.overview.connect('showing',
            this._createThumbnails.bind(this));
        this._hiddenId = Main.overview.connect('hidden',
            this._destroyThumbnails.bind(this));

        this._itemDragBeginId = Main.overview.connect('item-drag-begin',
            this._onDragBegin.bind(this));
        this._itemDragEndId = Main.overview.connect('item-drag-end',
            this._onDragEnd.bind(this));
        this._itemDragCancelledId = Main.overview.connect('item-drag-cancelled',
            this._onDragCancelled.bind(this));
        this._windowDragBeginId = Main.overview.connect('window-drag-begin',
            this._onDragBegin.bind(this));
        this._windowDragEndId = Main.overview.connect('window-drag-end',
            this._onDragEnd.bind(this));
        this._windowDragCancelledId = Main.overview.connect('window-drag-cancelled',
            this._onDragCancelled.bind(this));

        // WorkspaceThumbnail.MUTTER_SCHEMA may not be exported or present
        // in all GNOME versions. Guard against it and fall back to a
        // reasonable default schema id string so we don't call
        // Gio.Settings with `undefined`.
        // Determine a safe schema id string. Coerce to string to avoid passing
        // undefined to Gio.Settings accidentally.
        let mutterSchemaId = (WorkspaceThumbnail && WorkspaceThumbnail.MUTTER_SCHEMA) || 'org.gnome.mutter';
        if (mutterSchemaId === undefined || mutterSchemaId === null) {
            mutterSchemaId = 'org.gnome.mutter';
        }
        // Ensure it's a string
        mutterSchemaId = String(mutterSchemaId);

        log('[Multi Monitors Add-On] mmoverview: using mutterSchemaId=' + mutterSchemaId);
        if (!this._settings) {
            try {
                this._settings = new Gio.Settings({ schema_id: mutterSchemaId });
            } catch (e) {
                // If creating Gio.Settings with the mutter schema fails,
                // fall back to org.gnome.mutter as a last resort
                this._settings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
            }
        }
        this._changedDynamicWorkspacesId = this._settings.connect('changed::dynamic-workspaces',
            this._updateSwitcherVisibility.bind(this));

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._destroyThumbnails();
            if (Main.overview.visible)
                this._createThumbnails();
        });

        this._workareasChangedPortholeId = global.display.connect('workareas-changed',
            this._updatePorthole.bind(this));

        this._switchWorkspaceNotifyId = 0;
        this._nWorkspacesNotifyId = 0;
        this._syncStackingId = 0;
        this._workareasChangedId = 0;

        this._scrollAdjustment = scrollAdjustment;

        this._scrollAdjustmentNotifyValueId = this._scrollAdjustment.connect('notify::value', adj => {
            let workspaceManager = global.workspace_manager;
            let activeIndex = workspaceManager.get_active_workspace_index();

            this._animatingIndicator = adj.value !== activeIndex;

            if (!this._animatingIndicator)
                this._queueUpdateStates();

            this.queue_relayout();
        });
    }

    destroy() {
        this._destroyThumbnails();
        this._scrollAdjustment.disconnect(this._scrollAdjustmentNotifyValueId);
        Main.overview.disconnect(this._showingId);
        Main.overview.disconnect(this._hiddenId);

        Main.overview.disconnect(this._itemDragBeginId);
        Main.overview.disconnect(this._itemDragEndId);
        Main.overview.disconnect(this._itemDragCancelledId);
        Main.overview.disconnect(this._windowDragBeginId);
        Main.overview.disconnect(this._windowDragEndId);
        Main.overview.disconnect(this._windowDragCancelledId);

        this._settings.disconnect(this._changedDynamicWorkspacesId);
        Main.layoutManager.disconnect(this._monitorsChangedId);
        global.display.disconnect(this._workareasChangedPortholeId);
        super.destroy();
    }

    addThumbnails(start, count) {
        let workspaceManager = global.workspace_manager;

        // Validate porthole before creating thumbnails to prevent NaN/zero dimension errors
        if (!this._porthole || this._porthole.width <= 0 || this._porthole.height <= 0) {
            this._updatePorthole();
            if (!this._porthole || this._porthole.width <= 0 || this._porthole.height <= 0) {
                log('[Multi Monitors Add-On] Invalid porthole dimensions, skipping thumbnail creation');
                return;
            }
        }

        for (let k = start; k < start + count; k++) {
            let metaWorkspace = workspaceManager.get_workspace_by_index(k);
            let thumbnail = new MultiMonitorsWorkspaceThumbnail(metaWorkspace, this._monitorIndex);
            thumbnail.setPorthole(this._porthole.x, this._porthole.y,
                this._porthole.width, this._porthole.height);
            this._thumbnails.push(thumbnail);
            this.add_child(thumbnail);

            if (start > 0 && this._spliceIndex == -1) {
                // not the initial fill, and not splicing via DND
                thumbnail.state = WorkspaceThumbnail.ThumbnailState.NEW;
                thumbnail.slide_position = 1; // start slid out
                this._haveNewThumbnails = true;
            } else {
                thumbnail.state = WorkspaceThumbnail.ThumbnailState.NORMAL;
            }

            this._stateCounts[thumbnail.state]++;
        }

        this._queueUpdateStates();

        // The thumbnails indicator actually needs to be on top of the thumbnails
        this.set_child_above_sibling(this._indicator, null);

        // Clear the splice index, we got the message
        this._spliceIndex = -1;
    }

    _updatePorthole() {
        this._porthole = Main.layoutManager.getWorkAreaForMonitor(this._monitorIndex);
        this.queue_relayout();
    }

    _updateSwitcherVisibility() {
        // Fallback implementation: Update thumbnail box visibility based on
        // dynamic workspaces setting. This is called when the user changes
        // the org.gnome.mutter dynamic-workspaces setting.
        // The upstream implementation may differ; this is a minimal fallback.
        if (!this._settings) return;

        // If dynamic workspaces are disabled and we only have one workspace,
        // we might want to hide the switcher. For now, keep it simple.
        // Upstream logic is more complex; this just prevents crashes.
    }
}

Common.copyClass(WorkspaceThumbnail.ThumbnailsBox, MultiMonitorsThumbnailsBoxClass);
export const MultiMonitorsThumbnailsBox = GObject.registerClass({
    Properties: {
        'indicator-y': GObject.ParamSpec.double(
            'indicator-y', 'indicator-y', 'indicator-y',
            GObject.ParamFlags.READWRITE,
            0, Infinity, 0),
        'scale': GObject.ParamSpec.double(
            'scale', 'scale', 'scale',
            GObject.ParamFlags.READWRITE,
            0, Infinity, 0),
        // Required by methods copied from ThumbnailsBox via copyClass
        'should-show': GObject.ParamSpec.boolean(
            'should-show', 'should-show', 'should-show',
            GObject.ParamFlags.READWRITE,
            true),
    },
}, MultiMonitorsThumbnailsBoxClass);

/* This isn't compatible with GNOME 40 and i don't know how to fix it -- TH
var MultiMonitorsSlidingControl = (() => {
    let MultiMonitorsSlidingControl = class MultiMonitorsSlidingControl extends St.Widget {
    _init(params) {
        params = Params.parse(params, { slideDirection: OverviewControls.SlideDirection.LEFT });

        this.layout = new OverviewControls.SlideLayout();
        this.layout.slideDirection = params.slideDirection;
        super._init({
            layout_manager: this.layout,
            style_class: 'overview-controls',
            clip_to_allocation: true,
        });

        this._visible = true;
        this._inDrag = false;

        this._hidingId = Main.overview.connect('hiding', this._onOverviewHiding.bind(this));

        this._itemDragBeginId = Main.overview.connect('item-drag-begin', this._onDragBegin.bind(this));
        this._itemDragEndId = Main.overview.connect('item-drag-end', this._onDragEnd.bind(this));
        this._itemDragCancelledId = Main.overview.connect('item-drag-cancelled', this._onDragEnd.bind(this));

        this._windowDragBeginId = Main.overview.connect('window-drag-begin', this._onWindowDragBegin.bind(this));
        this._windowDragCancelledId = Main.overview.connect('window-drag-cancelled', this._onWindowDragEnd.bind(this));
        this._windowDragEndId = Main.overview.connect('window-drag-end', this._onWindowDragEnd.bind(this));
    }

    destroy() {
        Main.overview.disconnect(this._hidingId);

        Main.overview.disconnect(this._itemDragBeginId);
        Main.overview.disconnect(this._itemDragEndId);
        Main.overview.disconnect(this._itemDragCancelledId);

        Main.overview.disconnect(this._windowDragBeginId);
        Main.overview.disconnect(this._windowDragCancelledId);
        Main.overview.disconnect(this._windowDragEndId);
        super.destroy();
    }};

    Common.copyClass(OverviewControls.SlidingControl, MultiMonitorsSlidingControl);
    return GObject.registerClass(MultiMonitorsSlidingControl);
})();

var MultiMonitorsThumbnailsSlider = (() => {
    let MultiMonitorsThumbnailsSlider = class MultiMonitorsThumbnailsSlider extends MultiMonitorsSlidingControl {
    _init(thumbnailsBox) {
        super._init({ slideDirection: OverviewControls.SlideDirection.RIGHT });

        this._thumbnailsBox = thumbnailsBox;

        this.request_mode = Clutter.RequestMode.WIDTH_FOR_HEIGHT;
        this.reactive = true;
        this.track_hover = true;
        this.add_child(this._thumbnailsBox);

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', this._updateSlide.bind(this));
        this._activeWorkspaceChangedId = global.workspace_manager.connect('active-workspace-changed',
                                         this._updateSlide.bind(this));
        this._notifyNWorkspacesId = global.workspace_manager.connect('notify::n-workspaces',
                                         this._updateSlide.bind(this));
        this.connect('notify::hover', this._updateSlide.bind(this));
        this._thumbnailsBox.bind_property('visible', this, 'visible', GObject.BindingFlags.SYNC_CREATE);
    }

    destroy() {
        global.workspace_manager.disconnect(this._activeWorkspaceChangedId);
        global.workspace_manager.disconnect(this._notifyNWorkspacesId);
        Main.layoutManager.disconnect(this._monitorsChangedId);
        super.destroy();
    }};

    Common.copyClass(OverviewControls.ThumbnailsSlider, MultiMonitorsThumbnailsSlider);
    return GObject.registerClass(MultiMonitorsThumbnailsSlider);
})();
*/

export const MultiMonitorsControlsManager = GObject.registerClass(
    class MultiMonitorsControlsManager extends St.Widget {
        _init(index, settings) {
            this._monitorIndex = index;
            this._settings = settings;
            this._workspacesViews = null;
            this._spacer_height = 0;
            this._fixGeometry = 0;
            this._visible = false;

            // Use a simple BinLayout to ensure we have full control over the child placement
            // The OverviewControls layouts are too complex and tied to primary monitor state
            let layout = new Clutter.BinLayout();

            super._init({
                layout_manager: layout,
                x_expand: true,
                y_expand: true,
                clip_to_allocation: true,
            });

            this._workspaceAdjustment = Main.overview._overview._controls._workspaceAdjustment;

            this._thumbnailsBox =
                new MultiMonitorsThumbnailsBox(this._workspaceAdjustment, this._monitorIndex, this._settings);
            //this._thumbnailsSlider = new MultiMonitorsThumbnailsSlider(this._thumbnailsBox);

            // Create functional search entry
            this._searchEntry = new St.Entry({
                hint_text: 'Type to search...',
                style_class: 'search-entry',
                can_focus: true,
                x_expand: false,
                x_align: Clutter.ActorAlign.CENTER,
                style: 'width: 400px; border-radius: 8px;',
            });

            // Connect search entry to filter app grid locally
            this._searchEntry.clutter_text.connect('text-changed', () => {
                const text = this._searchEntry.get_text();
                // Filter the local app grid based on search text
                this._filterAppGrid(text);
            });

            // Handle Enter key to activate focused app
            this._searchEntry.clutter_text.connect('activate', () => {
                if (this._focusedApp && this._focusedApp._appInfo) {
                    this._focusedApp._appInfo.activate();
                    Main.overview.hide();
                }
            });

            // Handle arrow keys to navigate between apps
            this._searchEntry.clutter_text.connect('key-press-event', (actor, event) => {
                const symbol = event.get_key_symbol();
                if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Right ||
                    symbol === Clutter.KEY_Up || symbol === Clutter.KEY_Down) {
                    this._navigateApps(symbol);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            // Create scrollable app grid
            this._appGridScrollView = new St.ScrollView({
                style_class: 'mm-app-grid-scroll',
                x_expand: true,
                y_expand: true,
                overlay_scrollbars: true,
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
            });

            this._appGridContainer = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style: 'spacing: 10px;',
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._appGridScrollView.set_child(this._appGridContainer);

            // Create app grid with horizontal flow layout (3 columns x 2 rows = 6 apps max)
            this._appGrid = new St.Widget({
                layout_manager: new Clutter.FlowLayout({
                    orientation: Clutter.Orientation.HORIZONTAL,
                    homogeneous: true,
                    column_spacing: 20,
                    row_spacing: 20,
                }),
                x_expand: true,
                y_expand: false,
                visible: true,
                style: 'padding: 20px;',
            });
            this._appGridContainer.add_child(this._appGrid);

            // Ensure scroll view is hidden by default
            this._appGridScrollView.visible = false;

            // Populate app grid with installed applications
            try {
                this._populateAppGrid();
            } catch (e) {
                log('[MultiMonitors] Error populating app grid: ' + e);
            }

            this._searchController = new St.Widget({ visible: false, x_expand: true, y_expand: true, clip_to_allocation: true });

            this._contentArea = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                y_expand: true
            });
            this._contentArea.add_child(this._searchController);
            this._contentArea.add_child(this._appGridScrollView);


            // 'page-changed' and 'page-empty' signals exist in GNOME < 46
            this._pageChangedId = 0;
            this._pageEmptyId = 0;
            if (Main.overview.searchController) {
                // Determine signal source based on shell version or object capability
                // Modern GNOME uses state-changed or similar, but page-changed is common in 40-45
                // We'll try to connect to available signals or use the existing logic check
                if (Main.overview.searchController.connect) {
                    // Ensure we catch page changes to toggle App Grid
                    // Even in 46, we might need these signals if they exist
                    try {
                        this._pageChangedId = Main.overview.searchController.connect('page-changed', this._setVisibility.bind(this));
                    } catch (e) { log(e); }
                    try {
                        this._pageEmptyId = Main.overview.searchController.connect('page-empty', this._onPageEmpty.bind(this));
                    } catch (e) { log(e); }
                }
            }

            this._group = new St.BoxLayout({
                name: 'mm-overview-group-' + index,
                x_expand: true, y_expand: true,
                vertical: true,
                style: 'padding: 30px;' // Add some padding so it doesn't touch edges
            });
            this.add_child(this._group);

            // Add search entry
            this._group.add_child(this._searchEntry);

            // Add content area (Grid/Thumbnails)
            this._group.add_child(this._contentArea);
            //this._group.add_actor(this._thumbnailsSlider);

            this._monitorsChanged();
            //this._thumbnailsSlider.slideOut();
            this._thumbnailsBox._updatePorthole();

            this.connect('notify::allocation', this._updateSpacerVisibility.bind(this));
            //this._thumbnailsSelectSideId = this._settings.connect('changed::'+THUMBNAILS_SLIDER_POSITION_ID,
            //                                                this._thumbnailsSelectSide.bind(this));
            this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', this._monitorsChanged.bind(this));
        }

        _populateAppGrid() {
            // Get all installed applications
            const appSystem = Shell.AppSystem.get_default();
            const apps = appSystem.get_installed().filter(app => {
                return app.should_show();
            });

            log('[MultiMonitors] Found ' + apps.length + ' apps to display');

            // Sort alphabetically
            apps.sort((a, b) => a.get_name().localeCompare(b.get_name()));

            // Create app icons (limit to reasonable number for performance)
            const maxApps = 100;
            for (let i = 0; i < Math.min(apps.length, maxApps); i++) {
                const app = apps[i];
                const appButton = this._createAppButton(app);
                this._appGrid.add_child(appButton);
            }

            log('[MultiMonitors] App grid populated with ' + Math.min(apps.length, maxApps) + ' buttons');
        }

        _createAppButton(app) {
            const button = new St.Button({
                style_class: 'app-well-app',
                reactive: true,
                button_mask: St.ButtonMask.ONE,
                can_focus: true,
                x_expand: false,
                y_expand: false,
                style: 'padding: 16px; margin: 8px; border-radius: 16px; min-width: 120px;',
            });

            // Store app reference for filtering
            button._appInfo = app;

            const box = new St.BoxLayout({
                vertical: true, // Vertical layout for grid icon style
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 8px;',
            });
            button.set_child(box);

            // App icon - use the app's GIcon for proper icon display
            let icon = null;
            try {
                const gIcon = app.get_icon();
                if (gIcon) {
                    icon = new St.Icon({
                        gicon: gIcon,
                        icon_size: 86,
                        style_class: 'app-icon',
                    });
                }
            } catch (e) {
                log('[MultiMonitors] Error getting app GIcon: ' + e);
            }

            // Fallback if GIcon didn't work
            if (!icon) {
                try {
                    icon = app.create_icon_texture(64);
                } catch (e) {
                    log('[MultiMonitors] Error creating icon texture: ' + e);
                }
            }

            // Final fallback to generic icon
            if (!icon) {
                icon = new St.Icon({
                    icon_name: 'application-x-executable',
                    icon_size: 64,
                });
            }

            box.add_child(icon);

            // App name - centered below icon
            const label = new St.Label({
                text: app.get_name(),
                x_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 12px; font-weight: bold; color: white; max-width: 100px;',
            });
            label.clutter_text.set_ellipsize(3); // PANGO_ELLIPSIZE_END
            label.clutter_text.set_line_wrap(false);
            box.add_child(label);

            // Click handler to launch app
            button.connect('clicked', () => {
                app.activate();
                Main.overview.hide();
            });

            // Hover handler to set focus on this app
            button.connect('notify::hover', () => {
                if (button.hover) {
                    this._setFocusedApp(button);
                }
            });

            return button;
        }

        _setFocusedApp(app) {
            // Remove highlight from previous focused app
            if (this._focusedApp && this._focusedApp !== app) {
                this._focusedApp.remove_style_pseudo_class('focus');
                this._focusedApp.set_style('padding: 16px; margin: 8px; border-radius: 16px; min-width: 120px;');
            }

            // Set new focused app
            this._focusedApp = app;

            // Add highlight to focused app
            if (this._focusedApp) {
                this._focusedApp.add_style_pseudo_class('focus');
                this._focusedApp.set_style('padding: 16px; margin: 8px; border-radius: 16px; min-width: 120px; border: 3px solid #3584e4; background-color: rgba(53, 132, 228, 0.3);');
            }
        }

        _navigateApps(keySymbol) {
            if (!this._appGrid) return;

            // Get visible apps
            const children = this._appGrid.get_children();
            const visibleApps = children.filter(child => child.visible && child._appInfo);

            if (visibleApps.length === 0) return;

            // Find current focused index
            let currentIndex = -1;
            if (this._focusedApp) {
                currentIndex = visibleApps.indexOf(this._focusedApp);
            }

            // Calculate new index based on key
            let newIndex = currentIndex;
            if (keySymbol === Clutter.KEY_Right || keySymbol === Clutter.KEY_Down) {
                newIndex = (currentIndex + 1) % visibleApps.length;
            } else if (keySymbol === Clutter.KEY_Left || keySymbol === Clutter.KEY_Up) {
                newIndex = currentIndex - 1;
                if (newIndex < 0) newIndex = visibleApps.length - 1;
            }

            // Set focus to new app
            this._setFocusedApp(visibleApps[newIndex]);
        }

        _filterAppGrid(searchText) {
            // Filter the app grid based on search text
            const normalizedSearch = searchText.toLowerCase().trim();

            if (!this._appGrid) return;

            const children = this._appGrid.get_children();
            const maxVisibleApps = 6; // Maximum apps to show when searching
            let visibleCount = 0;
            let firstVisibleApp = null;

            for (const child of children) {
                if (!child._appInfo) {
                    child.visible = normalizedSearch === '';
                    continue;
                }

                const appName = child._appInfo.get_name().toLowerCase();
                const appId = child._appInfo.get_id() ? child._appInfo.get_id().toLowerCase() : '';

                if (normalizedSearch === '') {
                    // When clearing search, hide all apps (show windows instead)
                    child.visible = false;
                } else {
                    // Show only first 6 matching apps horizontally
                    const matches = appName.includes(normalizedSearch) || appId.includes(normalizedSearch);
                    if (matches && visibleCount < maxVisibleApps) {
                        child.visible = true;
                        if (!firstVisibleApp) {
                            firstVisibleApp = child;
                        }
                        visibleCount++;
                    } else {
                        child.visible = false;
                    }
                }
            }

            // Set focus on first visible app using the shared method
            this._setFocusedApp(firstVisibleApp);

            // Toggle visibility of the entire scroll view based on search text
            if (this._appGridScrollView) {
                const hasText = normalizedSearch.length > 0;
                log('[MultiMonitors] _filterAppGrid: hasText=' + hasText + ', visibleApps=' + visibleCount);

                // Always re-discover workspacesViews to ensure we have a valid reference
                this._tryFindWorkspacesViews();

                this._appGridScrollView.visible = hasText;

                // When searching (hasText is true), hide workspace views
                // When not searching (hasText is false), show workspace views
                if (this._workspacesViews) {
                    this._workspacesViews.visible = !hasText;
                    this._workspacesViews.opacity = hasText ? 0 : 255;
                    log('[MultiMonitors] Set workspacesViews visible=' + !hasText + ', opacity=' + (hasText ? 0 : 255));
                }

                // Also hide our own thumbnails box when searching
                if (this._thumbnailsBox) {
                    this._thumbnailsBox.visible = !hasText;
                }

                // Hide the searchController placeholder when searching (we use our own grid)
                if (this._searchController) {
                    this._searchController.visible = false;
                }
            }
        }

        _tryFindWorkspacesViews() {
            // Helper to find workspaces view if not found on initial show()
            let workspacesDisplay = null;

            if (Main.overview.searchController && Main.overview.searchController._workspacesDisplay) {
                workspacesDisplay = Main.overview.searchController._workspacesDisplay;
            }
            else if (Main.overview._overview && Main.overview._overview._controls && Main.overview._overview._controls._workspacesDisplay) {
                workspacesDisplay = Main.overview._overview._controls._workspacesDisplay;
            }
            else if (Main.overview._controls && Main.overview._controls._workspacesDisplay) {
                workspacesDisplay = Main.overview._controls._workspacesDisplay;
            }

            if (workspacesDisplay && workspacesDisplay._workspacesViews && workspacesDisplay._workspacesViews[this._monitorIndex]) {
                this._workspacesViews = workspacesDisplay._workspacesViews[this._monitorIndex];
                log('[MultiMonitors] Lazy discovery: Found workspacesView for monitor ' + this._monitorIndex);
            } else if (workspacesDisplay && workspacesDisplay._primaryWorkspacesView && this._monitorIndex === Main.layoutManager.primaryIndex) {
                this._workspacesViews = workspacesDisplay._primaryWorkspacesView;
                log('[MultiMonitors] Lazy discovery: Found primary workspacesView');
            }
        }

        show() {
            // Called when overview is shown - nothing special needed
            this._visible = true;
        }

        hide() {
            // Called when overview is closed - clear the search input
            this._visible = false;
            if (this._searchEntry) {
                this._searchEntry.set_text('');
            }
            // Reset app grid visibility
            if (this._appGridScrollView) {
                this._appGridScrollView.visible = false;
            }
            // Clear the first visible app reference
            this._firstVisibleApp = null;
        }

        destroy() {
            if (this._pageChangedId && Main.overview.searchController) {
                Main.overview.searchController.disconnect(this._pageChangedId);
            }
            if (this._pageEmptyId && Main.overview.searchController) {
                Main.overview.searchController.disconnect(this._pageEmptyId);
            }
            if (this._thumbnailsSelectSideId && this._settings) {
                this._settings.disconnect(this._thumbnailsSelectSideId);
            }
            if (this._monitorsChangedId) {
                Main.layoutManager.disconnect(this._monitorsChangedId);
            }
            super.destroy();
        }

        _monitorsChanged() {
            this._primaryMonitorOnTheLeft = Main.layoutManager.monitors[this._monitorIndex].x > Main.layoutManager.primaryMonitor.x;
            this._thumbnailsSelectSide();
        }

        _thumbnailsSelectSide() {
            // Thumbnails slider functionality is disabled/commented in this version
            // This stub prevents crashes when the method is called
            // Original implementation would position thumbnails on left or right side
            return;
        }

        /*
        // Original thumbnailsSelectSide implementation (disabled)
        _thumbnailsSelectSide() {
            let thumbnailsSlider;
            thumbnailsSlider = this._thumbnailsSlider;
     
            let sett = this._settings.get_string(THUMBNAILS_SLIDER_POSITION_ID);
            let onLeftSide = sett === 'left' || (sett === 'auto' && this._primaryMonitorOnTheLeft);
     
            if (onLeftSide) {
                let first = this._group.get_first_child();
                if (first != thumbnailsSlider) {
                    this._thumbnailsSlider.layout.slideDirection = OverviewControls.SlideDirection.LEFT;
                    this._thumbnailsBox.remove_style_class_name('workspace-thumbnails');
                    this._thumbnailsBox.set_style_class_name('workspace-thumbnails workspace-thumbnails-left');
                    this._group.set_child_below_sibling(thumbnailsSlider, first)
                }
            }
            else {
                let last = this._group.get_last_child();
                if (last != thumbnailsSlider) {
                    this._thumbnailsSlider.layout.slideDirection = OverviewControls.SlideDirection.RIGHT;
                    this._thumbnailsBox.remove_style_class_name('workspace-thumbnails workspace-thumbnails-left');
                    this._thumbnailsBox.set_style_class_name('workspace-thumbnails');
                    this._group.set_child_above_sibling(thumbnailsSlider, last);
                }
            }
            this._fixGeometry = 3;
        }
        */

        _updateSpacerVisibility() {
            if (Main.layoutManager.monitors.length < this._monitorIndex)
                return;

            let top_spacer_height = Main.layoutManager.primaryMonitor.height;

            let panelGhost_height = 0;
            const mmOverviewRef = ('mmOverview' in Main) ? Main.mmOverview : MultiMonitors.mmOverview;
            if (mmOverviewRef && mmOverviewRef[this._monitorIndex]._overview._panelGhost)
                panelGhost_height = mmOverviewRef[this._monitorIndex]._overview._panelGhost.get_height();

            let allocation = Main.overview._overview._controls.allocation;
            let primaryControl_height = allocation.get_height();
            let bottom_spacer_height = Main.layoutManager.primaryMonitor.height - allocation.y2;

            top_spacer_height -= primaryControl_height + panelGhost_height + bottom_spacer_height;
            top_spacer_height = Math.round(top_spacer_height);

            let spacer = mmOverviewRef ? mmOverviewRef[this._monitorIndex]._overview._spacer : null;
            if (!spacer) return;
            if (spacer.get_height() != top_spacer_height) {
                this._spacer_height = top_spacer_height;
                spacer.set_height(top_spacer_height);
            }
        }

        getWorkspacesActualGeometry() {
            return this._overview._controls.getWorkspacesActualGeometry();
        }

        /*
        getWorkspacesActualGeometry() {
            // ... (Duplicate/unused)
        }
        */
    });

export const MultiMonitorsOverviewActor = GObject.registerClass(
    class MultiMonitorsOverviewActor extends St.BoxLayout {
        _init(index, settings) {
            this._monitorIndex = index;
            this._settings = settings;
            super._init({
                name: 'mm-overview-' + index,
                /* Translators: This is the main view to select
                    activities. See also note for "Activities" string. */
                accessible_name: _("MMOverview@" + index),
                vertical: true,
            });

            this.add_constraint(new LayoutManager.MonitorConstraint({ index: this._monitorIndex }));

            this._panelGhost = null;
            // Use helper function to get mmPanel array
            const mmPanelRef = Constants.getMMPanelArray();
            if (mmPanelRef) {
                for (let idx in mmPanelRef) {
                    if (mmPanelRef[idx].monitorIndex !== this._monitorIndex)
                        continue
                    // Add a clone of the panel to the overview so spacing and such is
                    // automatic
                    this._panelGhost = new St.Bin({
                        child: new Clutter.Clone({ source: mmPanelRef[idx] }),
                        reactive: false,
                        opacity: 0,
                    });
                    this.add_child(this._panelGhost);
                    break;
                }
            }

            this._spacer = new St.Widget();
            this.add_child(this._spacer);

            this._controls = new MultiMonitorsControlsManager(this._monitorIndex, this._settings);

            // Add our same-line elements after the search entry
            this.add_child(this._controls);
        }
    });


export class MultiMonitorsOverview {
    constructor(index, settings) {
        this.monitorIndex = index;
        this._settings = settings;

        this._initCalled = true;
        this._overview = new MultiMonitorsOverviewActor(this.monitorIndex, this._settings);
        this._overview._delegate = this;
        Main.layoutManager.overviewGroup.add_child(this._overview);

        this._showingId = Main.overview.connect('showing', this._show.bind(this));
        this._hidingId = Main.overview.connect('hiding', this._hide.bind(this));
    }

    getWorkspacesActualGeometry() {
        return this._overview._controls.getWorkspacesActualGeometry();
    }

    _show() {
        this._overview._controls.show();
    }

    _hide() {
        this._overview._controls.hide();
    }

    destroy() {
        Main.overview.disconnect(this._showingId);
        Main.overview.disconnect(this._hidingId);

        Main.layoutManager.overviewGroup.remove_child(this._overview);
        this._overview._delegate = null;
        this._overview.destroy();
    }

    addAction(action) {
        this._overview.add_action(action);
    }

    removeAction(action) {
        if (action.get_actor())
            this._overview.remove_action(action);
    }
}
