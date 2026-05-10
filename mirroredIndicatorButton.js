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
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const MMWorkspacePreviewLayout = GObject.registerClass(
    class MMWorkspacePreviewLayout extends Clutter.LayoutManager {
        vfunc_get_preferred_width() {
            return [0, 0];
        }

        vfunc_get_preferred_height() {
            return [18, 18];
        }

        vfunc_allocate(container, box) {
            const monitorIndex = Main.layoutManager.findIndexForActor(container);
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
            if (!workArea)
                return;

            const hscale = box.get_width() / workArea.width;
            const vscale = box.get_height() / workArea.height;
            const children = container.get_children ? container.get_children() : [];

            for (const child of children) {
                if (!child.metaWindow)
                    continue;

                const childBox = new Clutter.ActorBox();
                const frameRect = child.metaWindow.get_frame_rect();

                childBox.set_size(
                    Math.max(1, Math.round(Math.min(frameRect.width, workArea.width) * hscale)),
                    Math.max(1, Math.round(Math.min(frameRect.height, workArea.height) * vscale)));
                childBox.set_origin(
                    Math.round((frameRect.x - workArea.x) * hscale),
                    Math.round((frameRect.y - workArea.y) * vscale));
                child.allocate(childBox);
            }
        }
    });

// Lightweight mirrored indicator that visually clones an existing indicator
// (e.g., Vitals) from the main panel and opens its menu anchored to this button.
export const MirroredIndicatorButton = GObject.registerClass(
    class MirroredIndicatorButton extends PanelMenu.Button {
        _init(panel, role) {
            // dontCreateMenu=true: on GNOME 50 PanelMenu.Button installs a
            // Clutter.ClickGesture that toggles the default menu, which would
            // swallow clicks before _onButtonPress can forward them to the
            // source indicator's real menu. We never use the default menu.
            super._init(0.0, null, true);

            this._role = role;
            this._panel = panel;

            // Ensure cleanup happens when the underlying Clutter object is destroyed
            // This captures cases where mmpanel implicitely destroys children
            this.connect('destroy', this._cleanup.bind(this));

            if (role === 'activities') {
                this._initActivitiesButton();
            } else {
                this._initGenericIndicator(role);
            }
        }

        _initActivitiesButton() {
            // Create the activities indicator with workspace dots like main panel
            this.accessible_role = Atk.Role.TOGGLE_BUTTON;
            this.name = 'mmPanelActivities';
            this.add_style_class_name('panel-button');
            this.add_style_class_name('mm-activities');

            // Set up for full height hover
            this.y_expand = true;
            this.y_align = Clutter.ActorAlign.FILL;

            // Container for workspace dots - centered vertically
            this._workspaceDotsBox = new St.BoxLayout({
                style_class: 'workspace-dots',
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
            });

            this.add_child(this._workspaceDotsBox);
            this.label_actor = this._workspaceDotsBox;

            // Store workspace manager reference first
            this._workspaceManager = global.workspace_manager;

            // Build initial workspace dots
            this._updateWorkspaceDots();

            // Connect to workspace changes
            this._activeWsChangedId = this._workspaceManager.connect('active-workspace-changed',
                this._updateWorkspaceDots.bind(this));
            this._nWorkspacesChangedId = this._workspaceManager.connect('notify::n-workspaces',
                this._updateWorkspaceDots.bind(this));

            // Sync with overview state
            this._showingId = Main.overview.connect('showing', () => {
                this.add_style_pseudo_class('overview');
                this.add_accessible_state(Atk.StateType.CHECKED);
            });

            this._hidingId = Main.overview.connect('hiding', () => {
                this.remove_style_pseudo_class('overview');
                this.remove_accessible_state(Atk.StateType.CHECKED);
            });

            this._sourceIndicator = null;
        }

        _updateWorkspaceDots() {
            if (!this._workspaceDotsBox || !this._workspaceManager)
                return;

            // Remove existing dots
            this._workspaceDotsBox.remove_all_children();

            const nWorkspaces = this._workspaceManager.n_workspaces;
            const activeIndex = this._workspaceManager.get_active_workspace_index();

            for (let i = 0; i < nWorkspaces; i++) {
                const isActive = (i === activeIndex);
                const dot = new St.Widget({
                    style_class: isActive ? 'workspace-dot active' : 'workspace-dot',
                    width: isActive ? 34 : 7,
                    height: isActive ? 8 : 7,
                    style: `border-radius: 6px; background-color: rgba(255, 255, 255, ${isActive ? '1' : '0.5'}); margin: 0 2px;`,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this._workspaceDotsBox.add_child(dot);
            }
        }

        _initGenericIndicator(role) {
            this._sourceIndicator = Main.panel.statusArea[role] || null;

            if (this._sourceIndicator) {
                // Check if the source indicator has any visible content
                const sourceChild = this._sourceIndicator.get_first_child();
                if (!sourceChild) {
                    // No child content - mark as empty and hide
                    this._isEmpty = true;
                    this.visible = false;
                    return;
                }

                // Additional check: if the source indicator or its child is not visible, skip
                if (!this._sourceIndicator.visible) {
                    this._isEmpty = true;
                    this.visible = false;
                    return;
                }

                // Check for empty BoxLayout with no visible children
                if (sourceChild instanceof St.BoxLayout) {
                    const visibleChildren = sourceChild.get_children().filter(c => c.visible);
                    if (visibleChildren.length === 0) {
                        this._isEmpty = true;
                        this.visible = false;
                        return;
                    }
                }

                this._createIndicatorClone();
            } else {
                this._createFallbackIcon();
            }
        }

        _createIndicatorClone() {
            try {
                const sourceChild = this._sourceIndicator.get_first_child();
                if (!sourceChild) {
                    this._createFallbackIcon();
                    return;
                }

                // Astra Monitor: Treat as independent multi-component container 
                // so components have separate hover and interaction.
                if (this._role && this._role.toLowerCase().includes('astra')) {
                    this.add_style_class_name('mm-astra-monitor');
                    this.y_expand = true;
                    this.y_align = Clutter.ActorAlign.FILL;
                    
                    // Crucial: remove base panel-button so the whole thing doesn't 
                    // light up like one giant button.
                    this.remove_style_class_name('panel-button');
                    
                    this._createAstraMultiComponentClone(sourceChild);
                    return;
                }

                // 1. Quick Settings (Handle explicitly regardless of structure)
                if (this._role === 'quickSettings') {
                    this.add_style_class_name('mm-quick-settings');
                    // Use FILL for full panel height hover detection
                    this.y_expand = true;
                    this.y_align = Clutter.ActorAlign.FILL;
                    const container = new St.BoxLayout({
                        style_class: 'mm-quick-settings-box',
                        y_align: Clutter.ActorAlign.FILL,
                        y_expand: true,
                    });
                    this._createQuickSettingsClone(container, sourceChild);
                    this.add_child(container);
                    return;
                }

                // 2. Official Workspace Indicator. Its embedded preview mode
                // uses real child actors for switching workspaces, so a plain
                // Clutter.Clone looks correct but cannot receive those clicks.
                if (this._role === 'workspace-indicator') {
                    this.add_style_class_name('workspace-indicator');
                    this.add_style_class_name('mm-workspace-indicator');
                    this.y_expand = true;
                    this.y_align = Clutter.ActorAlign.FILL;

                    if (this._sourceIndicator?._thumbnails?.visible) {
                        this.add_style_class_name('previews');
                        this._createWorkspacePreviewMirror();
                        return;
                    }

                    this.add_style_class_name('name-label');

                    const container = new St.Widget({
                        layout_manager: new Clutter.BinLayout(),
                        y_align: Clutter.ActorAlign.CENTER,
                        x_align: Clutter.ActorAlign.CENTER,
                    });

                    this._createAllocationMatchedClone(container, sourceChild);
                    this.add_child(container);
                    return;
                }

                // 3. Date Menu (Try optimizing with Label copy, fallback to simple clone)
                if (this._role === 'dateMenu' && this._sourceIndicator._clockDisplay) {
                    // Create clock label directly - no extra container
                    const clockDisplay = new St.Label({
                        style_class: 'clock',
                        y_align: Clutter.ActorAlign.CENTER,
                        y_expand: true,
                    });

                    const updateClock = () => {
                        if (this._sourceIndicator._clockDisplay) {
                            clockDisplay.text = this._sourceIndicator._clockDisplay.text;
                        }
                    };

                    updateClock();

                    // Remove existing timeout before creating new one
                    if (this._clockUpdateId) {
                        GLib.source_remove(this._clockUpdateId);
                        this._clockUpdateId = null;
                    }

                    this._clockUpdateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                        try {
                            updateClock();
                            return GLib.SOURCE_CONTINUE;
                        } catch (e) {
                            this._clockUpdateId = null;
                            return GLib.SOURCE_REMOVE;
                        }
                    });

                    this.add_child(clockDisplay);
                    this._clockDisplay = clockDisplay;
                    return;
                }

                // 4. Favorites Menu (Special handling)
                if (this._role === 'favorites-menu' || (this._role && (this._role.toLowerCase().includes('favorites') || this._role.toLowerCase().includes('favorite')))) {
                    this.add_style_class_name('mm-favorites-menu');
                    this.y_expand = true;
                    this.y_align = Clutter.ActorAlign.FILL;
                    const container = new St.BoxLayout({
                        style_class: 'mm-favorites-menu-box',
                        y_align: Clutter.ActorAlign.FILL,
                        y_expand: true,
                    });
                    this._createFillClone(container, sourceChild);
                    this.add_child(container);
                    return;
                }

                // 5. Generic Handling
                if (sourceChild instanceof St.BoxLayout) {
                    // Container is FILL to get full-height hover, but clone inside is centered
                    const container = new St.BoxLayout({
                        style_class: sourceChild.get_style_class_name() || 'panel-status-menu-box',
                        y_align: Clutter.ActorAlign.FILL,
                        y_expand: true,
                    });
                    this._createSimpleClone(container, sourceChild);
                    this.add_child(container);
                } else {
                    this._createSimpleClone(this, sourceChild);
                }

            } catch (e) {
                console.debug('[Multi Monitors Add-On] Failed to create mirrored indicator:', String(e));
                this._createFallbackIcon();
            }
        }

        _createWorkspacePreviewMirror() {
            this.set_height(30);

            this._workspacePreviewBox = new St.BoxLayout({
                style_class: 'workspaces-box',
                y_expand: true,
                y_align: Clutter.ActorAlign.FILL,
                x_expand: false,
            });

            this.add_child(this._workspacePreviewBox);
            this._connectWorkspacePreviewSignals();
            this._updateWorkspacePreviewMirror();
        }

        _connectWorkspacePreviewSignals() {
            if (this._workspacePreviewSignalIds)
                return;

            this._workspacePreviewSignalIds = [];

            const schedule = this._scheduleWorkspacePreviewUpdate.bind(this);
            const connectSignal = (object, signal) => {
                if (!object)
                    return;

                try {
                    const id = object.connect(signal, schedule);
                    this._workspacePreviewSignalIds.push({ object, id });
                } catch (_e) {
                    // Shell signal availability differs between GNOME versions.
                }
            };

            connectSignal(global.workspace_manager, 'active-workspace-changed');
            connectSignal(global.workspace_manager, 'workspace-switched');
            connectSignal(global.workspace_manager, 'notify::n-workspaces');
            connectSignal(global.display, 'notify::focus-window');
            connectSignal(global.display, 'restacked');
            connectSignal(global.display, 'window-created');
            connectSignal(global.display, 'window-entered-monitor');
            connectSignal(global.display, 'window-left-monitor');
        }

        _scheduleWorkspacePreviewUpdate() {
            if (this._workspacePreviewUpdateId)
                return;

            this._workspacePreviewUpdateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                this._workspacePreviewUpdateId = 0;
                this._updateWorkspacePreviewMirror();
                return GLib.SOURCE_REMOVE;
            });
        }

        _disconnectWorkspaceWindowSignals() {
            if (!this._workspacePreviewWindowSignalIds)
                return;

            for (const { object, id } of this._workspacePreviewWindowSignalIds) {
                try {
                    object.disconnect(id);
                } catch (_e) {
                }
            }

            this._workspacePreviewWindowSignalIds = [];
        }

        _connectWorkspaceWindowSignal(window, signal) {
            if (!this._workspacePreviewWindowSignalIds)
                this._workspacePreviewWindowSignalIds = [];

            try {
                const id = window.connect(signal, this._scheduleWorkspacePreviewUpdate.bind(this));
                this._workspacePreviewWindowSignalIds.push({ object: window, id });
            } catch (_e) {
            }
        }

        _updateWorkspacePreviewMirror() {
            if (!this._workspacePreviewBox)
                return;

            this._disconnectWorkspaceWindowSignals();
            this._workspacePreviewBox.remove_all_children();
            this._workspacePreviewButtons = [];

            const workspaceManager = global.workspace_manager;
            const nWorkspaces = workspaceManager.n_workspaces;
            const activeIndex = workspaceManager.get_active_workspace_index();

            for (let i = 0; i < nWorkspaces; i++) {
                const thumbnail = this._createWorkspacePreviewThumbnail(i, i === activeIndex);
                this._workspacePreviewButtons.push(thumbnail);
                this._workspacePreviewBox.add_child(thumbnail);
            }
        }

        _createWorkspacePreviewThumbnail(index, active) {
            const thumbnail = new St.Button({
                reactive: false,
                y_expand: true,
                y_align: Clutter.ActorAlign.FILL,
                x_expand: false,
            });
            thumbnail.set_size(62, 30);
            thumbnail._mmWorkspaceIndex = index;

            const box = new St.BoxLayout({
                style_class: 'workspace-box',
                y_expand: true,
                y_align: Clutter.ActorAlign.FILL,
                x_expand: false,
                orientation: Clutter.Orientation.VERTICAL,
            });
            thumbnail.set_child(box);

            const previewLayer = new Clutter.Actor({
                layout_manager: new MMWorkspacePreviewLayout(),
                clip_to_allocation: true,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
            });

            const preview = new St.Bin({
                style_class: active ? 'workspace active' : 'workspace',
                child: previewLayer,
                y_expand: true,
                y_align: Clutter.ActorAlign.FILL,
                x_expand: false,
            });
            preview.set_size(52, 18);

            box.add_child(preview);
            this._populateWorkspacePreviewLayer(previewLayer, index, active);

            return thumbnail;
        }

        _populateWorkspacePreviewLayer(previewLayer, workspaceIndex, activeWorkspace) {
            const monitorIndex = this._panel?.monitorIndex ?? Main.layoutManager.primaryIndex;
            const workspace = global.workspace_manager.get_workspace_by_index(workspaceIndex);
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
            if (!workspace || !workArea)
                return;

            const windows = workspace.list_windows();

            for (const window of windows) {
                if (window.skip_taskbar || window.minimized)
                    continue;
                if (window.get_monitor() !== monitorIndex)
                    continue;

                const frameRect = window.get_frame_rect();
                if (frameRect.overlap && !frameRect.overlap(workArea))
                    continue;

                const preview = new St.Widget({
                    style_class: activeWorkspace
                        ? 'workspace-indicator-window-preview active'
                        : 'workspace-indicator-window-preview',
                });
                preview.metaWindow = window;
                previewLayer.add_child(preview);

                this._connectWorkspaceWindowSignal(window, 'size-changed');
                this._connectWorkspaceWindowSignal(window, 'position-changed');
                this._connectWorkspaceWindowSignal(window, 'notify::minimized');
                this._connectWorkspaceWindowSignal(window, 'notify::skip-taskbar');
            }
        }

        _createClockDisplay(container) {
            const clockDisplay = new St.Label({
                style_class: 'clock',
                y_align: Clutter.ActorAlign.CENTER,
            });

            const updateClock = () => {
                if (this._sourceIndicator._clockDisplay) {
                    clockDisplay.text = this._sourceIndicator._clockDisplay.text;
                }
            };

            updateClock();

            // Remove existing timeout before creating new one
            if (this._clockUpdateId) {
                GLib.source_remove(this._clockUpdateId);
                this._clockUpdateId = null;
            }

            this._clockUpdateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                try {
                    updateClock();
                    return GLib.SOURCE_CONTINUE;
                } catch (e) {
                    this._clockUpdateId = null;
                    return GLib.SOURCE_REMOVE;
                }
            });

            container.add_child(clockDisplay);
            this._clockDisplay = clockDisplay;
        }

        _createSimpleClone(parent, source) {
            // Check if this is a problematic extension that needs static icon copies
            // (Extensions that resize during fullscreen or shrink on GNOME < 49)
            // This includes:
            // - Tiling extensions: resize during fullscreen
            // - System Monitor extensions: shrink icons on GNOME < 49
            // - AppIndicator extensions: shrink icons on GNOME < 49
            const problematicExtensions = [
                // Tiling extensions
                'tiling', 'tilingshell', 'forge', 'pop-shell',
                // System monitor extensions (shrink on GNOME < 49)
                'system-monitor', 'system_monitor', 'vitals', 'tophat',
                // AppIndicator/tray extensions (shrink on GNOME < 49)
                'appindicator', 'ubuntu-appindicator', 'kstatusnotifier', 'tray',
                // ArcMenu (squished icon fix) - checks loose 'arc' to catch variations
                'arcmenu', 'arc-menu', 'arc',
                // Clipboard extensions (resize during overview/fullscreen)
                'clipboard', 'clipboard-indicator', 'clipman',
            ];
            const isProblematic = problematicExtensions.some(name =>
                this._role && this._role.toLowerCase().includes(name)
            );

            if (isProblematic) {
                // Use static icon copies for problematic extensions
                this._createStaticIconCopy(parent, source);
                return;
            }

            this._createAllocationMatchedClone(parent, source);
        }

        _getActorAllocationSize(actor) {
            if (!actor)
                return [0, 0];

            try {
                const alloc = actor.get_allocation_box();
                const width = Math.round(alloc.get_width());
                const height = Math.round(alloc.get_height());
                if (width > 0 && height > 0)
                    return [width, height];
            } catch (e) {
                // Fall back to preferred size below.
            }

            try {
                const [, natWidth] = actor.get_preferred_width(-1);
                const [, natHeight] = actor.get_preferred_height(-1);
                return [Math.round(natWidth), Math.round(natHeight)];
            } catch (e) {
                return [0, 0];
            }
        }

        _createAllocationMatchedClone(parent, source) {
            const wrapper = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: false,
                y_expand: false,
                reactive: false,
            });

            const clone = new Clutter.Clone({
                source,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
                x_expand: true,
                y_expand: true,
            });

            wrapper.add_child(clone);
            parent.add_child(wrapper);

            const syncSize = () => {
                const [width, height] = this._getActorAllocationSize(source);
                if (width <= 0 || height <= 0)
                    return;

                wrapper.set_size(width, height);
                clone.set_size(width, height);
            };

            syncSize();

            const allocationId = source.connect('notify::allocation', syncSize);
            if (!this._allocationCloneSignals)
                this._allocationCloneSignals = [];
            this._allocationCloneSignals.push({ source, id: allocationId });

            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                try {
                    syncSize();
                } catch (e) {
                    // Source actor may have disappeared during panel rebuild.
                }
                if (this._allocationCloneTimeouts)
                    this._allocationCloneTimeouts = this._allocationCloneTimeouts.filter(id => id !== timeoutId);
                return GLib.SOURCE_REMOVE;
            });

            if (!this._allocationCloneTimeouts)
                this._allocationCloneTimeouts = [];
            this._allocationCloneTimeouts.push(timeoutId);

            return clone;
        }

        _createAstraMultiComponentClone(source) {
            const root = new St.BoxLayout({
                style_class: source.get_style_class_name() || 'panel-status-menu-box',
                y_align: Clutter.ActorAlign.FILL,
                y_expand: true,
            });

            // Prevent outer wrapper (this) from swallowing all pointer events,
            // dropping monolithic hover block while retaining alignment.
            this.reactive = false;
            this.track_hover = false;
            
            const children = source.get_children ? source.get_children() : [];
            if (children.length === 0) {
                // Base clone fallback if structure not as expected
                this._createSimpleClone(root, source);
                this.add_child(root);
                return;
            }

            for (const child of children) {
                // Skip components hidden by Astra's config
                if (child.visible === false) continue;

                // Create transparent proxy wrapper sized exactly like the sub-child
                const proxy = new St.Button({
                    reactive: child.reactive !== false, 
                    track_hover: child.track_hover !== false,
                    style_class: child.get_style_class_name ? child.get_style_class_name() : 'panel-button',
                    y_expand: true,
                    y_align: Clutter.ActorAlign.FILL,
                    x_expand: child.x_expand !== false,
                    layout_manager: new Clutter.BinLayout()
                });

                // Keep proxy visibly synced with the source component dynamically
                const visId = child.connect('notify::visible', () => {
                    proxy.visible = child.visible;
                });
                
                this.connect('destroy', () => {
                    if (child && visId) {
                        try { child.disconnect(visId); } catch(e) {}
                    }
                    // Restore source state modified by _setupAstraProxyEvents.
                    // Astra children are shared by every mirrored panel, so only
                    // unhook the tooltip after the last proxy is gone.
                    try {
                        this._unregisterAstraTooltipProxy(proxy, child);
                        child._mmp_proxyHovering = false;
                    } catch(e) {}
                });

                // Clone the inner content (child.box) instead of the outer widget.
                // This way the clone shows data (icons, graphs, labels) without the
                // panel-button hover background, so Clutter.Clone doesn't bleed the
                // source's :hover visual to the extended monitor.
                const cloneSource = child.box || child;
                const clone = new Clutter.Clone({
                    source: cloneSource,
                    x_align: Clutter.ActorAlign.FILL,
                    y_align: Clutter.ActorAlign.FILL
                });
                proxy.add_child(clone);

                // Pipe component-specific interactions
                this._setupAstraProxyEvents(proxy, child);
                root.add_child(proxy);
            }

            this.add_child(root);
            this._astraProxyContainer = root;
        }

        _registerAstraTooltipProxy(proxy, targetChild) {
            const tooltipMenu = targetChild.tooltipMenu;
            if (!tooltipMenu)
                return null;

            let state = targetChild._mmp_tooltipHookState;
            if (state && state.tooltipMenu !== tooltipMenu) {
                this._restoreAstraTooltipHook(targetChild, state);
                state = null;
            }

            if (!state) {
                const originalSourceActor = tooltipMenu.sourceActor;
                const originalOpen = tooltipMenu.open.bind(tooltipMenu);
                const originalClose = tooltipMenu.close.bind(tooltipMenu);

                state = {
                    tooltipMenu,
                    originalSourceActor,
                    originalOpen,
                    originalClose,
                    proxies: [],
                };

                targetChild._mmp_tooltipHookState = state;
                targetChild._mmp_tooltipHooked = true;
                tooltipMenu._mmp_origOpen = originalOpen;
                tooltipMenu._mmp_origClose = originalClose;

                tooltipMenu.open = (...args) => {
                    const activeProxy = targetChild._mmp_activeTooltipProxy;
                    if (activeProxy)
                        tooltipMenu.sourceActor = activeProxy;

                    originalOpen(...args);
                };

                tooltipMenu.close = (...args) => {
                    originalClose(...args);

                    if (!targetChild._mmp_activeTooltipProxy)
                        tooltipMenu.sourceActor = originalSourceActor;
                };
            }

            if (!state.proxies.includes(proxy))
                state.proxies.push(proxy);

            return state;
        }

        _unregisterAstraTooltipProxy(proxy, targetChild) {
            const state = targetChild._mmp_tooltipHookState;
            if (!state)
                return;

            state.proxies = state.proxies.filter(p => p !== proxy);

            if (targetChild._mmp_activeTooltipProxy === proxy)
                targetChild._mmp_activeTooltipProxy = null;

            if (state.proxies.length === 0)
                this._restoreAstraTooltipHook(targetChild, state);
        }

        _restoreAstraTooltipHook(targetChild, state) {
            const tooltipMenu = state.tooltipMenu;
            if (tooltipMenu) {
                tooltipMenu.open = state.originalOpen;
                tooltipMenu.close = state.originalClose;
                tooltipMenu.sourceActor = state.originalSourceActor;
            }

            targetChild._mmp_activeTooltipProxy = null;
            targetChild._mmp_proxyHovering = false;
            targetChild._mmp_tooltipHooked = false;
            targetChild._mmp_tooltipHookState = null;
        }

        _setupAstraProxyEvents(proxy, targetChild) {
            if (!proxy.reactive) return;

            // Hover visual is handled by cloning child.box (inner content) instead
            // of child (outer panel-button). This decouples hover: the proxy provides
            // its own panel-button:hover, and the clone only shows data content.

            // Astra reuses one tooltip menu for the real source child. Every
            // mirrored panel needs that shared menu to anchor to the proxy that
            // is currently hovered, not the first proxy that installed the hook.
            this._registerAstraTooltipProxy(proxy, targetChild);

            // ── Fix 3: Proxy enter/leave → show/hide tooltip on extended monitor ──
            // Astra Monitor shows tooltips via enter-event/leave-event handlers
            // on the Header (see header.js lines 75-80). We replicate this by
            // directly calling showTooltip()/hideTooltip() when the proxy is
            // hovered, with a flag so our tooltipMenu.open hook knows to redirect.
            proxy.connect('enter-event', () => {
                targetChild._mmp_proxyHovering = true;
                targetChild._mmp_activeTooltipProxy = proxy;
                if (typeof targetChild.showTooltip === 'function') {
                    targetChild.showTooltip();
                }
                return Clutter.EVENT_PROPAGATE;
            });

            proxy.connect('leave-event', () => {
                targetChild._mmp_proxyHovering = false;
                if (targetChild._mmp_activeTooltipProxy === proxy)
                    targetChild._mmp_activeTooltipProxy = null;
                if (typeof targetChild.hideTooltip === 'function') {
                    targetChild.hideTooltip();
                }
                return Clutter.EVENT_PROPAGATE;
            });

            // Active sync (proxy only — don't propagate to source)
            proxy.connect('notify::active', () => {
                if (proxy.active) {
                    proxy.add_style_pseudo_class('active');
                } else {
                    proxy.remove_style_pseudo_class('active');
                }
            });

            // Click/scroll event forwarding (NOT enter/leave — those are handled above)
            const forwardSpec = (eventName, vfuncName, event) => {
                let handled = false;

                if ((eventName === 'button-press-event' || eventName === 'touch-event') && (targetChild.menu || targetChild._menu)) {
                    if (this._openAstraProxyMenu(proxy, targetChild)) {
                        return Clutter.EVENT_STOP;
                    }
                }

                try {
                    targetChild._mmp_inForwardSpec = true;
                    const vfunc = targetChild[vfuncName];
                    if (typeof vfunc === 'function') {
                        try {
                            const result = vfunc.call(targetChild, event);
                            if (result === Clutter.EVENT_STOP) handled = true;
                        } catch (e) {}
                    }
                    if (!handled && typeof targetChild.emit === 'function') {
                        try {
                            targetChild.emit(eventName, event);
                            handled = true;
                        } catch (e) {}
                    }
                } finally {
                    targetChild._mmp_inForwardSpec = false;
                }

                return handled ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
            };

            proxy.connect('button-press-event', (_, event) => forwardSpec('button-press-event', 'vfunc_button_press_event', event));
            proxy.connect('button-release-event', (_, event) => forwardSpec('button-release-event', 'vfunc_button_release_event', event));
            proxy.connect('scroll-event', (_, event) => forwardSpec('scroll-event', 'vfunc_scroll_event', event));
            proxy.connect('touch-event', (_, event) => forwardSpec('touch-event', 'vfunc_touch_event', event));
        }

        _openAstraProxyMenu(proxy, targetChild) {
            const monitorIndex = Main.layoutManager.findIndexForActor(this);
            const menu = targetChild.menu || targetChild._menu;
            
            if (!menu || menu.isOpen === undefined) return false;

            let originalSourceActor = menu.sourceActor;
            let originalBoxPointer = menu.box?._sourceActor;
            let originalSetActive = targetChild.setActive?.bind(targetChild);
            let originalAddPseudoClass = targetChild.add_style_pseudo_class?.bind(targetChild);

            let menuBoxState = null;
            let openStateId = 0;

            if (menu.isOpen) {
                menu.close();
                return true;
            }

            // Prevent active state on main panel indicator
            if (targetChild.setActive) {
                targetChild.setActive = () => { };
            }
            if (targetChild.add_style_pseudo_class) {
                const orig = targetChild.add_style_pseudo_class.bind(targetChild);
                targetChild.add_style_pseudo_class = (p) => {
                    if (p !== 'active' && p !== 'checked') orig(p);
                };
            }
            if (targetChild.remove_style_pseudo_class) {
                targetChild.remove_style_pseudo_class('active');
                targetChild.remove_style_pseudo_class('checked');
            }

            // Activate proxy
            proxy.add_style_pseudo_class('active');
            proxy.add_style_pseudo_class('checked');

            menu.sourceActor = proxy;

            menuBoxState = this._updateMenuPositioning(menu, monitorIndex, proxy);

            openStateId = menu.connect('open-state-changed', (m, isOpen) => {
                if (isOpen) {
                    proxy.add_style_pseudo_class('active');
                    proxy.add_style_pseudo_class('checked');
                } else {
                    if (originalSourceActor) menu.sourceActor = originalSourceActor;
                    if (menu.box && originalBoxPointer) menu.box._sourceActor = originalBoxPointer;
                    if (originalSetActive) targetChild.setActive = originalSetActive;
                    if (originalAddPseudoClass) targetChild.add_style_pseudo_class = originalAddPseudoClass;

                    if (menuBoxState?.menuBox) {
                        if (menuBoxState.originalSetPosition)
                            menuBoxState.menuBox.setPosition = menuBoxState.originalSetPosition;
                        else
                            delete menuBoxState.menuBox.setPosition;

                        if (menuBoxState.removedConstraints?.length > 0) {
                            menuBoxState.removedConstraints.forEach(c => menuBoxState.menuBox.add_constraint(c));
                        }
                        if (menuBoxState.sourceActorState) {
                            for (const state of menuBoxState.sourceActorState) {
                                state.actor._sourceActor = state.sourceActor;
                                state.actor._sourceAllocation = state.sourceAllocation;
                            }
                        }
                    }

                    if (targetChild.remove_style_pseudo_class) {
                        targetChild.remove_style_pseudo_class('active');
                        targetChild.remove_style_pseudo_class('checked');
                    }
                    if (proxy.remove_style_pseudo_class) {
                        proxy.remove_style_pseudo_class('active');
                        proxy.remove_style_pseudo_class('checked');
                    }

                    menu.disconnect(openStateId);
                }
            });

            menu.open();
            return true;
        }

        _createQuickSettingsClone(parent, source) {
            // Clutter.Clone paints the source at the source's ALLOCATION size,
            // but get_preferred_width/height returns the source's PREFERRED size.
            // On the primary panel, allocation ≠ preferred (panel constrains the source).
            // - CENTER/y_expand:false → clone gets preferred height → too short → compresses
            // - FILL/y_expand:true → clone fills secondary panel → too tall → stretches
            //
            // The ONLY correct approach: explicitly set the clone's size to match
            // the source's actual allocation dimensions, then track changes.
            const clone = new Clutter.Clone({
                source: source,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: false,
                y_expand: false,
            });

            parent.add_child(clone);

            this._quickSettingsClone = clone;
            this._quickSettingsSource = source;
            this._quickSettingsContainer = parent;
            this._lastSourceW = 0;
            this._lastSourceH = 0;

            // Sync clone size to source's actual allocation (not preferred size)
            const syncSize = () => {
                if (!this._quickSettingsSource || !this._quickSettingsClone)
                    return;
                try {
                    const alloc = this._quickSettingsSource.get_allocation_box();
                    const w = alloc.get_width();
                    const h = alloc.get_height();

                    if (w > 0 && h > 0 &&
                        (Math.abs(w - this._lastSourceW) > 0.5 ||
                            Math.abs(h - this._lastSourceH) > 0.5)) {
                        this._lastSourceW = w;
                        this._lastSourceH = h;
                        this._quickSettingsClone.set_size(Math.round(w), Math.round(h));
                    }
                } catch (e) {
                    // Source may not have allocation yet
                }
            };

            // Disconnect previous signal if any
            if (this._sourceSizeChangedId && this._quickSettingsSource) {
                this._quickSettingsSource.disconnect(this._sourceSizeChangedId);
                this._sourceSizeChangedId = null;
            }

            // Track source allocation changes
            this._sourceSizeChangedId = source.connect('notify::allocation', syncSize);

            // Initial sync after first layout pass
            this._qsInitialSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                try { syncSize(); } catch (e) { }
                this._qsInitialSyncId = null;
                return GLib.SOURCE_REMOVE;
            });

            // Monitor fullscreen state changes on primary monitor
            this._fullscreenChangedId = global.display.connect('in-fullscreen-changed',
                this._onQuickSettingsFullscreenChanged.bind(this));
        }

        _onQuickSettingsFullscreenChanged() {
            if (!this._quickSettingsClone) return;
            // The allocation sync will handle size changes from fullscreen
            // Just queue a relayout to pick up the new source allocation
            this._quickSettingsClone.queue_relayout();
        }

        _applyNormalMode() {
            // Not used
        }

        _applyOverviewMode() {
            // Not used
        }

        _monitorSize(duration) {
            // Since we removed the clipping container and use FILL,
            // this just tracks the max observed width for reference
            if (this._monitorTimeoutId) {
                GLib.source_remove(this._monitorTimeoutId);
                this._monitorTimeoutId = null;
            }

            const startTime = GLib.get_monotonic_time();
            const endTime = startTime + (duration * 1000);

            const checkSize = () => {
                try {
                    if (!this._quickSettingsSource) {
                        return GLib.SOURCE_REMOVE;
                    }

                    // Get source size (max of actual and preferred)
                    const [minW, natW] = this._quickSettingsSource.get_preferred_width(-1);
                    const [actW] = this._quickSettingsSource.get_size();
                    const sourceWidth = Math.max(natW, minW, actW);

                    // Track max observed width
                    if (sourceWidth > (this._cachedWidth || 0)) {
                        this._cachedWidth = sourceWidth;
                    }

                    // Stop after duration
                    if (GLib.get_monotonic_time() > endTime) {
                        this._monitorTimeoutId = null;
                        return GLib.SOURCE_REMOVE;
                    }

                    return GLib.SOURCE_CONTINUE;
                } catch (e) {
                    this._monitorTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }
            };

            this._monitorTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, checkSize);
        }

        _onSourceWidthChanged() {
            // Do nothing if width is locked (initial size captured)
            if (this._widthLocked) {
                return;
            }
            // Before locked, track the width
            if (this._monitorTimeoutId) {
                // Already monitoring, let it handle
            } else {
                this._monitorSize(500);
            }
        }

        _detectAndLockWidth() {
            // Unused - replaced by initial size capture
        }

        _isPrimaryMonitorFullscreen() {
            // Check if any window is fullscreen on the primary monitor
            const primaryIndex = Main.layoutManager.primaryIndex;
            const windows = global.get_window_actors();

            for (const actor of windows) {
                const metaWindow = actor.get_meta_window();
                if (metaWindow &&
                    metaWindow.is_fullscreen() &&
                    metaWindow.get_monitor() === primaryIndex) {
                    return true;
                }
            }
            return false;
        }

        _createStaticIconCopy(parent, source) {
            // Create static icon copies for problematic extensions (Tiling Shell, etc.)
            // These are immune to source changes during fullscreen
            const isClipboard = this._isClipboardIndicator();
            const container = new St.BoxLayout({
                // Preserve source classes (e.g., vitals-panel-menu) so mirrored
                // indicators keep extension-specific spacing on secondary monitors.
                style_class: isClipboard
                    ? 'panel-status-menu-box mm-static-indicator-copy mm-clipboard-indicator-copy'
                    : `${source.get_style_class_name() || 'panel-status-menu-box'} mm-static-indicator-copy`,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: false,
                reactive: false,
            });

            // Copy all icons from the source
            this._copyIconsFromSource(container, source);
            this._syncStaticCopyContainerSize(container, source);
            parent.add_child(container);
            this._iconContainer = container;
            this._iconSource = source;

            // Periodically sync icons (every 5 seconds) to catch icon changes
            this._startIconSync();
        }

        _copyIconsFromSource(container, source) {
            // Remove existing children
            container.remove_all_children();

            if (this._isClipboardIndicator()) {
                this._copyClipboardIconFromSource(container, source);
                return;
            }

            // Preserve one level of grouping for indicators like Vitals where
            // spacing is defined on each child metric box.
            if (source instanceof St.BoxLayout) {
                const sourceChildren = source.get_children();
                let preservedAnyGroups = false;

                for (const child of sourceChildren) {
                    if (!(child instanceof St.BoxLayout))
                        continue;

                    const groupCopy = new St.BoxLayout({
                        style_class: child.get_style_class_name() || '',
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                        y_expand: false,
                        reactive: false,
                    });

                    const widgets = this._findAllDisplayWidgets(child);
                    for (const widget of widgets) {
                        if (widget instanceof St.Icon) {
                            const iconCopy = new St.Icon({
                                gicon: widget.gicon,
                                icon_name: widget.icon_name,
                                icon_size: this._getSourceIconSize(widget),
                                style_class: widget.get_style_class_name() || 'system-status-icon',
                                x_align: Clutter.ActorAlign.CENTER,
                                y_align: Clutter.ActorAlign.CENTER,
                                x_expand: false,
                                y_expand: false,
                            });
                            groupCopy.add_child(iconCopy);
                        } else if (widget instanceof St.Label) {
                            // Keep existing exclusion behavior for Arc/clipboard labels.
                            if (this._role && (
                                this._role.toLowerCase().includes('arc') ||
                                this._role.toLowerCase().includes('clipboard') ||
                                this._role.toLowerCase().includes('clipman')
                            )) {
                                continue;
                            }

                            const labelCopy = new St.Label({
                                text: widget.text,
                                style_class: widget.get_style_class_name() || '',
                                y_align: Clutter.ActorAlign.CENTER,
                            });
                            labelCopy._sourceLabel = widget;
                            groupCopy.add_child(labelCopy);
                        }
                    }

                    if (groupCopy.get_n_children() > 0) {
                        container.add_child(groupCopy);
                        preservedAnyGroups = true;
                    } else {
                        groupCopy.destroy();
                    }
                }

                if (preservedAnyGroups)
                    return;
            }

            // Find all display widgets (icons and labels) in the source and create copies
            const widgets = this._findAllDisplayWidgets(source);

            if (widgets.length > 0) {
                for (const widget of widgets) {
                    if (widget instanceof St.Icon) {
                        const iconCopy = new St.Icon({
                            gicon: widget.gicon,
                            icon_name: widget.icon_name,
                            icon_size: this._getSourceIconSize(widget),
                            style_class: widget.get_style_class_name() || 'system-status-icon',
                            x_align: Clutter.ActorAlign.CENTER,
                            y_align: Clutter.ActorAlign.CENTER,
                            x_expand: false,
                            y_expand: false,
                        });
                        container.add_child(iconCopy);
                    } else if (widget instanceof St.Label) {
                        // Skip labels for ArcMenu and Clipboard indicators
                        // ArcMenu: user request; Clipboard: shows clipboard content as label
                        if (this._role && (
                            this._role.toLowerCase().includes('arc') ||
                            this._role.toLowerCase().includes('clipboard') ||
                            this._role.toLowerCase().includes('clipman')
                        )) {
                            continue;
                        }

                        // Copy labels (like Vitals' numbers/text values)
                        const labelCopy = new St.Label({
                            text: widget.text,
                            style_class: widget.get_style_class_name() || '',
                            y_align: Clutter.ActorAlign.CENTER,
                        });
                        // Store reference to sync text later
                        labelCopy._sourceLabel = widget;
                        container.add_child(labelCopy);
                    }
                }
            } else {
                // Fallback: use a clone but wrap it to prevent resize
                const clone = new Clutter.Clone({
                    source: source,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_expand: false,
                    y_expand: false,
                });
                container.add_child(clone);
            }
        }

        _copyClipboardIconFromSource(container, source) {
            const icon = this._sourceIndicator?.icon || this._findIconInActor(source);
            if (!icon) {
                const fallbackIcon = new St.Icon({
                    icon_name: 'edit-paste-symbolic',
                    style_class: 'system-status-icon',
                    icon_size: 16,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                container.add_child(fallbackIcon);
                return;
            }

            const iconCopy = new St.Icon({
                gicon: icon.gicon,
                icon_name: icon.icon_name || 'edit-paste-symbolic',
                icon_size: Math.min(this._getSourceIconSize(icon), 16),
                style_class: icon.get_style_class_name?.() || 'system-status-icon',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: false,
                y_expand: false,
            });
            container.add_child(iconCopy);
        }

        _getSourceIconSize(icon) {
            if (icon.icon_size && icon.icon_size > 0)
                return icon.icon_size;

            const [width, height] = this._getActorAllocationSize(icon);
            const size = Math.min(width, height);
            return size > 0 ? size : 16;
        }

        _syncStaticCopyContainerSize(container, source) {
            const syncSize = () => {
                if (this._isClipboardIndicator()) {
                    const [minWidth, natWidth] = container.get_preferred_width(-1);
                    const [, natHeight] = container.get_preferred_height(-1);
                    const width = Math.round(natWidth || minWidth);
                    const height = Math.round(natHeight);

                    if (width > 0 && height > 0)
                        container.set_size(width, height);
                    return;
                }

                const [width, height] = this._getActorAllocationSize(source);
                if (width > 0 && height > 0)
                    container.set_size(width, height);
            };

            syncSize();

            const allocationId = source.connect('notify::allocation', syncSize);
            if (!this._allocationCloneSignals)
                this._allocationCloneSignals = [];
            this._allocationCloneSignals.push({ source, id: allocationId });
        }

        _findAllDisplayWidgets(actor) {
            // Recursively find all St.Icon and St.Label instances in an actor tree
            // This preserves their order for proper display (e.g., Vitals: icon + number)
            const widgets = [];
            if (actor instanceof St.Icon || actor instanceof St.Label) {
                widgets.push(actor);
            }
            const children = actor.get_children ? actor.get_children() : [];
            for (const child of children) {
                widgets.push(...this._findAllDisplayWidgets(child));
            }
            return widgets;
        }

        _startIconSync() {
            if (this._iconSyncId) {
                GLib.source_remove(this._iconSyncId);
                this._iconSyncId = null;
            }
            if (this._labelSyncId) {
                GLib.source_remove(this._labelSyncId);
                this._labelSyncId = null;
            }

            // Full rebuild every 5 seconds to catch added/removed icons
            this._iconSyncId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                try {
                    if (this._iconContainer && this._iconSource) {
                        this._copyIconsFromSource(this._iconContainer, this._iconSource);
                    }
                    return GLib.SOURCE_CONTINUE;
                } catch (e) {
                    this._iconSyncId = null;
                    return GLib.SOURCE_REMOVE;
                }
            });

            // Sync label text more frequently (every 2 seconds) for Vitals-like extensions
            this._labelSyncId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                try {
                    if (this._iconContainer) {
                        this._syncLabelTexts(this._iconContainer);
                    }
                    return GLib.SOURCE_CONTINUE;
                } catch (e) {
                    this._labelSyncId = null;
                    return GLib.SOURCE_REMOVE;
                }
            });
        }

        _syncLabelTexts(container) {
            if (container instanceof St.Label && container._sourceLabel) {
                container.text = container._sourceLabel.text;
                return;
            }

            const children = container.get_children ? container.get_children() : [];
            for (const child of children) {
                this._syncLabelTexts(child);
            }
        }

        _createFillClone(parent, source) {
            // For favorites-menu@fthx - create real widget copy instead of Clutter.Clone
            // This prevents visual glitches when the main panel hides during fullscreen
            const container = new St.BoxLayout({
                style_class: source.get_style_class_name ? source.get_style_class_name() : 'panel-status-menu-box',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
                reactive: false,
            });

            // Find and copy the icon from the source (favorites-menu uses starred-symbolic icon)
            const icon = this._findIconInActor(source);
            if (icon) {
                const iconCopy = new St.Icon({
                    gicon: icon.gicon,
                    icon_name: icon.icon_name || 'starred-symbolic',
                    icon_size: icon.icon_size || 16,
                    style_class: icon.get_style_class_name() || 'system-status-icon',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                container.add_child(iconCopy);
            } else {
                // Fallback: create the starred icon directly
                const fallbackIcon = new St.Icon({
                    icon_name: 'starred-symbolic',
                    style_class: 'system-status-icon',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                container.add_child(fallbackIcon);
            }

            parent.add_child(container);
            this._favoritesContainer = container;
        }

        _findIconInActor(actor) {
            // Recursively find St.Icon in an actor tree
            if (actor instanceof St.Icon) {
                return actor;
            }
            const children = actor.get_children ? actor.get_children() : [];
            for (const child of children) {
                const found = this._findIconInActor(child);
                if (found) return found;
            }
            return null;
        }

        _createFallbackIcon() {
            const label = new St.Label({
                text: '⚙',
                y_align: Clutter.ActorAlign.CENTER
            });
            this.add_child(label);
        }

        vfunc_button_press_event(buttonEvent) {
            return this._onButtonPress(buttonEvent);
        }

        vfunc_scroll_event(scrollEvent) {
            if (this._role === 'workspace-indicator') {
                Main.wm.handleWorkspaceScroll(scrollEvent);
                return Clutter.EVENT_STOP;
            }

            if (super.vfunc_scroll_event)
                return super.vfunc_scroll_event(scrollEvent);

            return Clutter.EVENT_PROPAGATE;
        }

        vfunc_event(event) {
            if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                return this.vfunc_button_press_event(event);
            }
            if (event.type() === Clutter.EventType.SCROLL) {
                return this.vfunc_scroll_event(event);
            }
            return super.vfunc_event(event);
        }

        _onButtonPress(event = null) {
            if (this._role === 'activities') {
                Main.overview.toggle();
                return Clutter.EVENT_STOP;
            }

            if (this._role === 'workspace-indicator') {
                if (event?.get_button?.() === Clutter.BUTTON_SECONDARY &&
                    this._sourceIndicator?.menu) {
                    return this._openMirroredMenu();
                }

                if (this._sourceIndicator?._thumbnails?.visible &&
                    event?.get_button?.() === Clutter.BUTTON_PRIMARY &&
                    this._activateWorkspacePreviewAt(event)) {
                    return Clutter.EVENT_STOP;
                }

                if (this._sourceIndicator?.menu)
                    return this._openMirroredMenu();
            }

            if (this._isClipboardIndicator() && this._sourceIndicator?.menu) {
                return this._openClipboardIndicatorMenu();
            }

            // Check for standard menu first
            if (this._sourceIndicator && this._sourceIndicator.menu) {
                return this._openMirroredMenu();
            }

            // Handle extensions with custom popup menus (like favorite-apps-menu@venovar)
            // These extensions have _popupFavoriteAppsMenu or similar custom menus
            if (this._sourceIndicator) {
                // ArcMenu specific: try toggleMenu method directly
                if (typeof this._sourceIndicator.toggleMenu === 'function') {
                    return this._openArcMenu();
                }

                // ArcMenu specific: try arcMenu property
                if (this._sourceIndicator.arcMenu && typeof this._sourceIndicator.arcMenu.toggle === 'function') {
                    return this._openArcMenu();
                }

                // ArcMenu specific: try _menuButton.toggleMenu
                if (this._sourceIndicator._menuButton && typeof this._sourceIndicator._menuButton.toggleMenu === 'function') {
                    return this._openArcMenu();
                }

                // Try to find and open custom popup menus
                const customMenus = [
                    '_popupFavoriteAppsMenu',
                    '_popupPowerItemsMenu',
                    '_popup',
                    '_popupMenu'
                ];

                for (const menuName of customMenus) {
                    if (this._sourceIndicator[menuName]?.toggle) {
                        return this._openCustomPopupMenu(this._sourceIndicator[menuName]);
                    }
                }

                // If no menu found, try to emit a button press on the source indicator
                // This allows the source indicator to handle the click itself
                if (this._sourceIndicator.vfunc_button_press_event || this._sourceIndicator.emit) {
                    return this._forwardClickToSource();
                }
            }

            return Clutter.EVENT_PROPAGATE;
        }

        _isClipboardIndicator() {
            const role = this._role ? this._role.toLowerCase() : '';
            if (role.includes('clipboard') || role.includes('clipman'))
                return true;

            return !!(this._sourceIndicator?.registry &&
                this._sourceIndicator?.clipItemsRadioGroup &&
                typeof this._sourceIndicator?._toggleMenu === 'function');
        }

        _isClipboardMenuReady() {
            if (!this._isClipboardIndicator())
                return true;

            return !!(this._sourceIndicator?.searchEntry ||
                this._sourceIndicator?.privateModeMenuItem ||
                this._sourceIndicator?.emptyStateSection);
        }

        _clearSourceIndicatorActiveState() {
            for (const actor of [this._sourceIndicator, this._sourceIndicator?.container]) {
                if (!actor)
                    continue;

                actor.remove_style_pseudo_class?.('active');
                actor.remove_style_pseudo_class?.('checked');
            }
        }

        _activateWorkspacePreviewAt(event) {
            if (this._workspacePreviewButtons?.length > 0) {
                const [stageX, stageY] = event.get_coords();

                for (const previewButton of this._workspacePreviewButtons) {
                    const [buttonX, buttonY] = previewButton.get_transformed_position();
                    const [buttonWidth, buttonHeight] = previewButton.get_transformed_size();

                    if (stageX >= buttonX && stageX <= buttonX + buttonWidth &&
                        stageY >= buttonY && stageY <= buttonY + buttonHeight) {
                        const workspace = global.workspace_manager.get_workspace_by_index(
                            previewButton._mmWorkspaceIndex);
                        workspace?.activate(event.get_time());
                        return true;
                    }
                }
            }

            const thumbnailsBox = this._sourceIndicator?._thumbnails?._thumbnailsBox;
            const sourceChild = this._sourceIndicator?.get_first_child?.();
            if (!thumbnailsBox || !sourceChild || !event?.get_coords)
                return false;

            const previews = thumbnailsBox.get_children ? thumbnailsBox.get_children() : [];
            if (previews.length === 0)
                return false;

            const [stageX] = event.get_coords();
            const [mirrorX] = this.get_transformed_position();
            const [mirrorWidth] = this.get_transformed_size();
            const [sourceX] = sourceChild.get_transformed_position();
            const [sourceWidth] = sourceChild.get_transformed_size();

            if (mirrorWidth <= 0 || sourceWidth <= 0)
                return false;

            const sourceLocalX = ((stageX - mirrorX) / mirrorWidth) * sourceWidth;

            for (let i = 0; i < previews.length; i++) {
                const preview = previews[i];
                if (!preview.visible)
                    continue;

                const [previewX] = preview.get_transformed_position();
                const [previewWidth] = preview.get_transformed_size();
                const previewLocalX = previewX - sourceX;

                if (sourceLocalX >= previewLocalX &&
                    sourceLocalX <= previewLocalX + previewWidth) {
                    const workspace = global.workspace_manager.get_workspace_by_index(i);
                    workspace?.activate(event.get_time());
                    return true;
                }
            }

            return false;
        }

        _forwardClickToSource() {
            // Forward the click to the source indicator
            // This makes the source indicator handle the click as if it was clicked directly
            this.add_style_pseudo_class('active');

            // Emit button-press-event on the source
            const event = Clutter.get_current_event();
            if (event && this._sourceIndicator.emit) {
                this._sourceIndicator.emit('button-press-event', event);
            }

            // Also try button-release-event which some extensions use
            if (event && this._sourceIndicator.emit) {
                // Clean up any existing timeout before creating a new one
                if (this._forwardClickTimeoutId) {
                    GLib.source_remove(this._forwardClickTimeoutId);
                    this._forwardClickTimeoutId = null;
                }
                this._forwardClickTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    try {
                        this._sourceIndicator.emit('button-release-event', event);
                        this.remove_style_pseudo_class('active');
                    } catch (e) { }
                    this._forwardClickTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                });
            }

            return Clutter.EVENT_STOP;
        }

        _openArcMenu() {
            // Find ArcMenu's internal menu object
            let arcMenu = null;
            let toggleFunc = null;

            if (this._sourceIndicator.arcMenu) {
                arcMenu = this._sourceIndicator.arcMenu;
                toggleFunc = () => this._sourceIndicator.arcMenu.toggle();
            } else if (this._sourceIndicator._menuButton?.arcMenu) {
                arcMenu = this._sourceIndicator._menuButton.arcMenu;
                toggleFunc = () => this._sourceIndicator._menuButton.toggleMenu();
            } else if (typeof this._sourceIndicator.toggleMenu === 'function') {
                // Try to find arcMenu property on the indicator
                arcMenu = this._sourceIndicator.arcMenu || this._sourceIndicator.menu;
                toggleFunc = () => this._sourceIndicator.toggleMenu();
            }
            if (arcMenu && !toggleFunc && typeof arcMenu.toggle === 'function')
                toggleFunc = () => arcMenu.toggle();

            // If we found a menu, anchor it to the mirrored button on this
            // monitor, using the same BoxPointer override as normal menus.
            if (arcMenu && arcMenu.sourceActor) {
                const monitorIndex = Main.layoutManager.findIndexForActor(this);
                const originalSourceActor = arcMenu.sourceActor;
                const originalBoxPointer = arcMenu.box?._sourceActor;
                const originalSetActive = this._sourceIndicator.setActive?.bind(this._sourceIndicator);
                const originalAddPseudoClass = this._sourceIndicator.add_style_pseudo_class?.bind(this._sourceIndicator);
                let menuBoxState = null;

                if (arcMenu.isOpen) {
                    arcMenu.close();
                    return Clutter.EVENT_STOP;
                }

                // Prevent active state on main panel indicator
                this._preventMainPanelActiveState(originalAddPseudoClass);

                // Add active style to THIS button
                this.add_style_pseudo_class('active');

                // Temporarily change sourceActor to this button for positioning
                arcMenu.sourceActor = this;

                if (arcMenu.box) {
                    menuBoxState = this._updateMenuPositioning(arcMenu, monitorIndex);
                }

                // Connect to menu close to restore state
                const openStateId = arcMenu.connect('open-state-changed', (_m, isOpen) => {
                    if (isOpen) {
                        this.add_style_pseudo_class('active');
                        return;
                    }

                    if (!isOpen) {
                        this._restoreMenuState(arcMenu, originalSourceActor, originalBoxPointer,
                            originalSetActive, originalAddPseudoClass, menuBoxState);
                        arcMenu.disconnect(openStateId);
                    }
                });

                // Toggle the menu
                if (toggleFunc) {
                    toggleFunc();
                } else {
                    this._restoreMenuState(arcMenu, originalSourceActor, originalBoxPointer,
                        originalSetActive, originalAddPseudoClass, menuBoxState);
                }
            } else {
                // Fallback: just toggle without repositioning
                this.add_style_pseudo_class('active');

                if (typeof this._sourceIndicator.toggleMenu === 'function') {
                    this._sourceIndicator.toggleMenu();
                } else if (this._sourceIndicator.arcMenu?.toggle) {
                    this._sourceIndicator.arcMenu.toggle();
                } else if (this._sourceIndicator._menuButton?.toggleMenu) {
                    this._sourceIndicator._menuButton.toggleMenu();
                }

                // Clean up active state after a short delay
                if (this._arcMenuTimeoutId) {
                    GLib.source_remove(this._arcMenuTimeoutId);
                    this._arcMenuTimeoutId = null;
                }
                this._arcMenuTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    try {
                        this.remove_style_pseudo_class('active');
                    } catch (e) { }
                    this._arcMenuTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                });
            }

            return Clutter.EVENT_STOP;
        }

        _openClipboardIndicatorMenu() {
            const menu = this._sourceIndicator.menu;
            if (!menu || menu.isOpen === undefined)
                return Clutter.EVENT_PROPAGATE;

            if (!this._isClipboardMenuReady()) {
                if (!this._clipboardOpenRetries)
                    this._clipboardOpenRetries = 0;

                if (this._clipboardOpenRetries < 20) {
                    this._clipboardOpenRetries++;
                    this.add_style_pseudo_class('active');
                    if (this._clipboardOpenRetryId)
                        GLib.source_remove(this._clipboardOpenRetryId);
                    this._clipboardOpenRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                        this._clipboardOpenRetryId = 0;
                        this._openClipboardIndicatorMenu();
                        return GLib.SOURCE_REMOVE;
                    });
                    return Clutter.EVENT_STOP;
                }
            }

            this._clipboardOpenRetries = 0;
            if (this._clipboardOpenRetryId) {
                GLib.source_remove(this._clipboardOpenRetryId);
                this._clipboardOpenRetryId = 0;
            }

            if (menu.isOpen) {
                menu.close();
                return Clutter.EVENT_STOP;
            }

            const originalSourceActor = menu.sourceActor;
            const originalBoxPointer = menu.box?._sourceActor;
            let openStateId = 0;
            const sourceActorState = [];

            this.add_style_pseudo_class('active');
            menu.sourceActor = this;

            for (const actor of [menu.box, menu._boxPointer]) {
                if (!actor)
                    continue;

                sourceActorState.push({
                    actor,
                    sourceActor: actor._sourceActor,
                    sourceAllocation: actor._sourceAllocation,
                });
                actor._sourceActor = this;
                actor._sourceAllocation = null;
            }

            const restore = () => {
                menu.sourceActor = originalSourceActor;
                if (menu.box)
                    menu.box._sourceActor = originalBoxPointer;

                for (const state of sourceActorState) {
                    state.actor._sourceActor = state.sourceActor;
                    state.actor._sourceAllocation = state.sourceAllocation;
                }

                this.remove_style_pseudo_class('active');
                this.remove_style_pseudo_class('checked');

                this._clearSourceIndicatorActiveState();
                if (this._clipboardActiveCleanupId) {
                    GLib.source_remove(this._clipboardActiveCleanupId);
                    this._clipboardActiveCleanupId = 0;
                }

                if (openStateId) {
                    try {
                        menu.disconnect(openStateId);
                    } catch (_e) {
                    }
                    openStateId = 0;
                }
            };

            openStateId = menu.connect('open-state-changed', (_m, isOpen) => {
                if (isOpen) {
                    this.add_style_pseudo_class('active');
                    this._clearSourceIndicatorActiveState();
                    if (this._clipboardActiveCleanupId)
                        GLib.source_remove(this._clipboardActiveCleanupId);
                    this._clipboardActiveCleanupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                        this._clearSourceIndicatorActiveState();
                        this._clipboardActiveCleanupId = 0;
                        return GLib.SOURCE_REMOVE;
                    });
                    return;
                }

                restore();
            });

            try {
                if (typeof this._sourceIndicator._toggleMenu === 'function')
                    this._sourceIndicator._toggleMenu();
                else
                    menu.toggle();
            } catch (e) {
                restore();
                console.debug('[Multi Monitors Add-On] Failed to open clipboard indicator menu:', String(e));
                return Clutter.EVENT_STOP;
            }

            if (!menu.isOpen)
                restore();

            return Clutter.EVENT_STOP;
        }

        _openCustomPopupMenu(popupMenu) {
            const monitorIndex = Main.layoutManager.findIndexForActor(this);
            const originalSourceActor = popupMenu.sourceActor;

            // Close the menu if it's already open
            if (popupMenu.isOpen) {
                popupMenu.close();
                return Clutter.EVENT_STOP;
            }

            // Add active style to this button
            this.add_style_pseudo_class('active');

            // Update popup's sourceActor to position correctly
            popupMenu.sourceActor = this;

            // Update positioning for the correct monitor
            if (popupMenu.box) {
                const monitor = Main.layoutManager.monitors[monitorIndex];
                if (monitor && popupMenu.box._updateFlip) {
                    popupMenu.box._updateFlip(monitor);
                }
            }

            // Setup cleanup on menu close
            const openStateId = popupMenu.connect('open-state-changed', (_m, isOpen) => {
                if (isOpen) {
                    this.add_style_pseudo_class('active');
                } else {
                    this.remove_style_pseudo_class('active');
                    popupMenu.sourceActor = originalSourceActor;
                    popupMenu.disconnect(openStateId);
                }
            });

            popupMenu.open();

            return Clutter.EVENT_STOP;
        }

        _openMirroredMenu() {
            const monitorIndex = Main.layoutManager.findIndexForActor(this);
            const menu = this._sourceIndicator.menu;

            // Store original state variables
            let originalSourceActor = menu.sourceActor;
            let originalBoxPointer = menu.box?._sourceActor;
            let originalSetActive = this._sourceIndicator.setActive?.bind(this._sourceIndicator);
            let originalAddPseudoClass = this._sourceIndicator.add_style_pseudo_class?.bind(this._sourceIndicator);

            // State for restoring menu box modifications
            let menuBoxState = null;

            let openStateId = 0;

            if (menu.isOpen) {
                menu.close();
                return Clutter.EVENT_STOP;
            }

            // Prevent active state on main panel indicator
            this._preventMainPanelActiveState(originalAddPseudoClass);

            // Add active style to THIS button
            this.add_style_pseudo_class('active');

            // Update menu's sourceActor
            menu.sourceActor = this;

            // Update BoxPointer positioning and save state for restoration
            if (menu.box) {
                menuBoxState = this._updateMenuPositioning(menu, monitorIndex);
            }

            // Setup cleanup on menu close
            openStateId = menu.connect('open-state-changed', (m, isOpen) => {
                if (isOpen) {
                    this.add_style_pseudo_class('active');
                } else {
                    this._restoreMenuState(menu, originalSourceActor, originalBoxPointer, originalSetActive, originalAddPseudoClass, menuBoxState);
                    menu.disconnect(openStateId);
                }
            });

            menu.open();

            return Clutter.EVENT_STOP;
        }

        _preventMainPanelActiveState(originalAddPseudoClass) {
            if (this._sourceIndicator.setActive) {
                this._sourceIndicator.setActive = () => { };
            }

            if (this._sourceIndicator.add_style_pseudo_class) {
                const originalMethod = this._sourceIndicator.add_style_pseudo_class.bind(this._sourceIndicator);
                this._sourceIndicator.add_style_pseudo_class = (pseudoClass) => {
                    if (pseudoClass !== 'active' && pseudoClass !== 'checked') {
                        originalMethod(pseudoClass);
                    }
                };
            }

            if (this._sourceIndicator.remove_style_pseudo_class) {
                this._sourceIndicator.remove_style_pseudo_class('active');
                this._sourceIndicator.remove_style_pseudo_class('checked');
            }
        }

        _updateMenuPositioning(menu, monitorIndex, sourceActor = this) {
            const menuBox = menu._boxPointer || menu.box;
            if (!menuBox)
                return null;

            // 1. Save original source actor
            const sourceActorState = [];
            for (const actor of [menu.box, menu._boxPointer]) {
                if (!actor)
                    continue;

                sourceActorState.push({
                    actor,
                    sourceActor: actor._sourceActor,
                    sourceAllocation: actor._sourceAllocation,
                });
                actor._sourceActor = sourceActor;
                actor._sourceAllocation = null;
            }

            // 2. Handle constraints
            const removedConstraints = [];
            const constraints = menuBox.get_constraints ? menuBox.get_constraints() : [];
            for (let constraint of constraints) {
                if (constraint.constructor.name === 'BindConstraint' ||
                    constraint.constructor.name === 'AlignConstraint') {
                    menuBox.remove_constraint(constraint);
                    removedConstraints.push(constraint);
                }
            }

            // 3. Handle setPosition override - FULL MANUAL REPLACEMENT
            // We do NOT call oldSetPosition because it likely crashes/fails on extended monitors
            const originalSetPosition = menuBox.setPosition;

            const monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;

            menuBox.setPosition = function (sourceActor, alignment) {
                // Calculate position manually
                const [btnX, btnY] = sourceActor.get_transformed_position();
                const [btnW, btnH] = sourceActor.get_transformed_size();
                const prefW = this.get_preferred_width(-1);
                const prefH = this.get_preferred_height(-1);
                const finalMenuW = prefW[1]; // Use natural width
                // Height might be dynamic, use current size or preferred?
                // BoxPointer usually has size by now.
                const [currW, currH] = this.get_size();
                const finalMenuH = currH > 0 ? currH : prefH[1];

                // Center horizontally on the button
                let newX = btnX + (btnW / 2) - (finalMenuW / 2);
                let newY = btnY + btnH; // Below the button

                // Constraint to monitor bounds
                if (newX + finalMenuW > monitor.x + monitor.width) {
                    newX = monitor.x + monitor.width - finalMenuW;
                }
                if (newX < monitor.x) {
                    newX = monitor.x;
                }

                // Vertical constraint (flip if needed, though usually bar is top)
                if (newY + finalMenuH > monitor.y + monitor.height) {
                    newY = btnY - finalMenuH;
                    if (this.setArrowSide) this.setArrowSide(St.Side.BOTTOM);
                } else {
                    if (this.setArrowSide) this.setArrowSide(St.Side.TOP);
                }

                this.set_position(Math.round(newX), Math.round(newY));
            };

            return {
                menuBox,
                originalSetPosition,
                removedConstraints,
                sourceActorState,
            };
        }

        _restoreMenuState(menu, originalSourceActor, originalBoxPointer, originalSetActive, originalAddPseudoClass, menuBoxState) {
            // 1. Restore standard menu properties
            if (originalSourceActor) {
                menu.sourceActor = originalSourceActor;
            }

            if (menu.box && originalBoxPointer) {
                menu.box._sourceActor = originalBoxPointer;
            }
            if (menuBoxState?.sourceActorState) {
                for (const state of menuBoxState.sourceActorState) {
                    state.actor._sourceActor = state.sourceActor;
                    state.actor._sourceAllocation = state.sourceAllocation;
                }
            }

            // 2. Restore hijacked indicator methods
            if (originalSetActive && this._sourceIndicator) {
                this._sourceIndicator.setActive = originalSetActive;
            }

            if (originalAddPseudoClass && this._sourceIndicator) {
                this._sourceIndicator.add_style_pseudo_class = originalAddPseudoClass;
            }

            // 3. Restore menu box modifications (setPosition and constraints)
            if (menuBoxState?.menuBox) {
                if (menuBoxState.originalSetPosition)
                    menuBoxState.menuBox.setPosition = menuBoxState.originalSetPosition;
                else
                    delete menuBoxState.menuBox.setPosition;

                if (menuBoxState.removedConstraints && menuBoxState.removedConstraints.length > 0) {
                    menuBoxState.removedConstraints.forEach(constraint => {
                        menuBoxState.menuBox.add_constraint(constraint);
                    });
                }
            }

            // 4. Reset style classes on source
            if (this._sourceIndicator && this._sourceIndicator.remove_style_pseudo_class) {
                this._sourceIndicator.remove_style_pseudo_class('active');
                this._sourceIndicator.remove_style_pseudo_class('checked');
            }

            // Always try to reset this button's state
            if (this.remove_style_pseudo_class) {
                this.remove_style_pseudo_class('active');
                this.remove_style_pseudo_class('checked');
            }
        }

        _cleanup() {
            if (this._isCleanedUp) return;
            this._isCleanedUp = true;

            if (this._clockUpdateId) {
                GLib.source_remove(this._clockUpdateId);
                this._clockUpdateId = null;
            }

            if (this._forwardClickTimeoutId) {
                GLib.source_remove(this._forwardClickTimeoutId);
                this._forwardClickTimeoutId = null;
            }

            if (this._iconSyncId) {
                GLib.source_remove(this._iconSyncId);
                this._iconSyncId = null;
            }

            if (this._labelSyncId) {
                GLib.source_remove(this._labelSyncId);
                this._labelSyncId = null;
            }

            if (this._arcMenuTimeoutId) {
                GLib.source_remove(this._arcMenuTimeoutId);
                this._arcMenuTimeoutId = null;
            }

            if (this._clipboardOpenRetryId) {
                GLib.source_remove(this._clipboardOpenRetryId);
                this._clipboardOpenRetryId = null;
            }

            if (this._clipboardActiveCleanupId) {
                GLib.source_remove(this._clipboardActiveCleanupId);
                this._clipboardActiveCleanupId = null;
            }

            if (this._lockSizeTimeoutId) {
                GLib.source_remove(this._lockSizeTimeoutId);
                this._lockSizeTimeoutId = null;
            }

            if (this._monitorTimeoutId) {
                GLib.source_remove(this._monitorTimeoutId);
                this._monitorTimeoutId = null;
            }

            if (this._qsInitialSyncId) {
                GLib.source_remove(this._qsInitialSyncId);
                this._qsInitialSyncId = null;
            }

            if (this._overviewShowingId) {
                Main.overview.disconnect(this._overviewShowingId);
                this._overviewShowingId = null;
            }

            if (this._fullscreenChangedId) {
                global.display.disconnect(this._fullscreenChangedId);
                this._fullscreenChangedId = null;
            }

            if (this._sourceSizeChangedId && this._quickSettingsSource) {
                this._quickSettingsSource.disconnect(this._sourceSizeChangedId);
                this._sourceSizeChangedId = null;
            }

            if (this._sizeDebounceId) {
                GLib.source_remove(this._sizeDebounceId);
                this._sizeDebounceId = null;
            }

            if (this._workspacePreviewUpdateId) {
                GLib.source_remove(this._workspacePreviewUpdateId);
                this._workspacePreviewUpdateId = 0;
            }

            if (this._workspacePreviewSignalIds) {
                for (const { object, id } of this._workspacePreviewSignalIds) {
                    try {
                        object.disconnect(id);
                    } catch (_e) {
                    }
                }
                this._workspacePreviewSignalIds = null;
            }

            this._disconnectWorkspaceWindowSignals();

            if (this._allocationCloneTimeouts) {
                for (const timeoutId of this._allocationCloneTimeouts) {
                    GLib.source_remove(timeoutId);
                }
                this._allocationCloneTimeouts = null;
            }

            if (this._allocationCloneSignals) {
                for (const signal of this._allocationCloneSignals) {
                    try {
                        signal.source.disconnect(signal.id);
                    } catch (e) {
                    }
                }
                this._allocationCloneSignals = null;
            }



            if (this._role === 'activities') {
                if (this._showingId) {
                    Main.overview.disconnect(this._showingId);
                    this._showingId = null;
                }
                if (this._hidingId) {
                    Main.overview.disconnect(this._hidingId);
                    this._hidingId = null;
                }
                if (this._activeWsChangedId) {
                    this._workspaceManager.disconnect(this._activeWsChangedId);
                    this._activeWsChangedId = null;
                }
                if (this._nWorkspacesChangedId) {
                    this._workspaceManager.disconnect(this._nWorkspacesChangedId);
                    this._nWorkspacesChangedId = null;
                }
            }
        }

        destroy() {
            this._cleanup();
            super.destroy();
        }
    });
