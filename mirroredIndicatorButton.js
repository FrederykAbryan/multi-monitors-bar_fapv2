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
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

export const MirroredIndicatorButton = GObject.registerClass(
    class MirroredIndicatorButton extends PanelMenu.Button {
        _init(panel, role) {
            super._init(0.0, null, false);

            this._role = role;
            this._panel = panel;
            this._destroyed = false;
            this.visible = true;
            this.opacity = 255;

            if (role === 'activities') {
                const container = new St.Widget({
                    layout_manager: new Clutter.BinLayout(),
                    y_align: Clutter.ActorAlign.CENTER,
                });
                container.y_expand = false;
                this.add_child(container);

                this._dotContainer = new St.Widget({
                    layout_manager: new Clutter.BoxLayout({
                        orientation: Clutter.Orientation.HORIZONTAL,
                    }),
                    y_expand: false,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                container.add_child(this._dotContainer);

                this._workspaceManager = global.workspace_manager;
                this._updateWorkspaceDots();
                this._nWorkspacesChangedId = this._workspaceManager.connect('notify::n-workspaces',
                    this._updateWorkspaceDots.bind(this));
                
                this._showingId = Main.overview.connect('showing', () => {
                    this.add_style_pseudo_class('overview');
                    this.add_accessible_state(Atk.StateType.CHECKED);
                });

                this._hidingId = Main.overview.connect('hiding', () => {
                    this.remove_style_pseudo_class('overview');
                    this.remove_accessible_state(Atk.StateType.CHECKED);
                });

                this._sourceIndicator = null;
            } else {
                this._initGenericIndicator(role);
            }
        }

        _updateWorkspaceDots() {
            if (!this._dotContainer || this._destroyed) {
                return;
            }
            this._dotContainer.remove_all_children();

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
                this._dotContainer.add_child(dot);
            }
        }

        _initGenericIndicator(role) {
            this._sourceIndicator = Main.panel.statusArea[role] || null;

            if (this._sourceIndicator) {
                this._createIndicatorClone();
            } else {
                this._createFallbackIcon();
            }
        }

        _createIndicatorClone() {
            try {
                const sourceChild = this._sourceIndicator.get_first_child();
                
                if (this._role === 'dateMenu' && this._sourceIndicator._clockDisplay) {
                    const clockDisplay = new St.Label({
                        style_class: 'clock',
                        y_align: Clutter.ActorAlign.CENTER,
                        y_expand: false,
                    });
                    clockDisplay.visible = true;
                    clockDisplay.opacity = 255;

                    const updateClock = () => {
                        if (this._destroyed) return;
                        try {
                            if (this._sourceIndicator && this._sourceIndicator._clockDisplay && 
                                clockDisplay && clockDisplay.get_stage() !== null) {
                                clockDisplay.text = this._sourceIndicator._clockDisplay.text;
                            }
                        } catch (e) {}
                    };

                    updateClock();
                    if (this._clockUpdateId) {
                        GLib.source_remove(this._clockUpdateId);
                        this._clockUpdateId = null;
                    }

                    this._clockUpdateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                        if (this._destroyed) return GLib.SOURCE_REMOVE;
                        updateClock();
                        return GLib.SOURCE_CONTINUE;
                    });

                    this.add_child(clockDisplay);
                    this._clockDisplay = clockDisplay;
                    console.log('[Multi Monitors Add-On] Created dateMenu clock, text:', clockDisplay.text);
                }
                else if (this._role === 'quickSettings') {
                    this.add_style_class_name('mm-quick-settings');
                    this.y_expand = false;
                    this.y_align = Clutter.ActorAlign.CENTER;
                    const container = new St.BoxLayout({
                        style_class: 'mm-quick-settings-box',
                        y_align: Clutter.ActorAlign.CENTER,
                        y_expand: false,
                    });
                    this._createQuickSettingsClone(container, sourceChild);
                    this.add_child(container);
                }
                else if (sourceChild) {
                    this._createSimpleClone(this, sourceChild);
                } else {
                    this._createFallbackIcon();
                }
            } catch (e) {
                console.error('[Multi Monitors Add-On] Failed to create mirrored indicator:', String(e));
                this._createFallbackIcon();
            }
        }



        _createSimpleClone(parent, source) {
            if (this._role === 'window-controls') {
                console.log('[Multi Monitors Add-On] Using BoxLayout mirror for window-controls');
                this._createWindowControlsMirror(parent, source);
                return;
            }

            if (this._role && this._role.startsWith('appindicator-')) {
                console.log('[Multi Monitors Add-On] Using static icon copy for AppIndicator:', this._role);
                this._createStaticIconCopy(parent, source);
                return;
            }

            const giconBasedExtensions = ['kiwimenu', 'kiwi'];
            const needsGIconMirror = giconBasedExtensions.some(name =>
                this._role && this._role.toLowerCase().includes(name)
            );

            if (needsGIconMirror) {
                console.log('[Multi Monitors Add-On] Using GIcon mirror for:', this._role);
                this._createGIconMirror(parent, source);
                return;
            }
            
            const clone = new Clutter.Clone({
                source: source,
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: false,
            });

            parent.add_child(clone);
            this._clone = clone;
            this._cloneSource = source;
            this._connectClonePaintSignal(source, clone);
            this._syncIndicatorStates(source);
        }

        _createGIconMirror(parent, source) {
            let sourceIcon = null;
            if (source instanceof St.Icon) {
                sourceIcon = source;
            } else if (source.get_children) {
                // Search for St.Icon in children
                const findIcon = (actor) => {
                    if (actor instanceof St.Icon) {
                        return actor;
                    }
                    if (actor.get_children) {
                        for (const child of actor.get_children()) {
                            const found = findIcon(child);
                            if (found) return found;
                        }
                    }
                    return null;
                };
                sourceIcon = findIcon(source);
            }

            if (!sourceIcon) {
                // Fallback to regular clone if we can't find an icon
                console.debug('[Multi Monitors Add-On] Could not find St.Icon in source, using regular clone');
                const clone = new Clutter.Clone({
                    source: source,
                    y_align: Clutter.ActorAlign.CENTER,
                    y_expand: false,
                });
                parent.add_child(clone);
                this._clone = clone;
                this._cloneSource = source;
                this._connectClonePaintSignal(source, clone);
                this._syncIndicatorStates(source);
                return;
            }

            // Create a new St.Icon that mirrors the source icon
            const mirroredIcon = new St.Icon({
                style_class: sourceIcon.style_class,
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: false,
            });

            this._updateGIcon(sourceIcon, mirroredIcon);

            parent.add_child(mirroredIcon);
            this._mirroredIcon = mirroredIcon;
            this._sourceIcon = sourceIcon;

            this._iconChangedId = sourceIcon.connect('notify::gicon', () => {
                if (this._destroyed) return;
                this._updateGIcon(sourceIcon, mirroredIcon);
            });

            this._iconSizeChangedId = sourceIcon.connect('notify::icon-size', () => {
                if (this._destroyed) return;
                if (sourceIcon.icon_size) {
                    mirroredIcon.icon_size = sourceIcon.icon_size;
                }
            });

            this._iconUpdateTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                if (this._destroyed) {
                    return GLib.SOURCE_REMOVE;
                }
                this._updateGIcon(sourceIcon, mirroredIcon);
                return GLib.SOURCE_CONTINUE;
            });

            // Sync visual states from source indicator to this button
            this._syncIndicatorStates(source);
        }

        _updateGIcon(sourceIcon, mirroredIcon) {
            if (!sourceIcon || !mirroredIcon || this._destroyed) return;

            try {
                if (sourceIcon.gicon) {
                    mirroredIcon.gicon = sourceIcon.gicon;
                }

                if (sourceIcon.icon_name) {
                    mirroredIcon.icon_name = sourceIcon.icon_name;
                }

                if (sourceIcon.icon_size) {
                    mirroredIcon.icon_size = sourceIcon.icon_size;
                }

                if (sourceIcon.style_class) {
                    mirroredIcon.style_class = sourceIcon.style_class;
                }
            } catch (e) {
                console.debug('[Multi Monitors Add-On] Error updating GIcon:', String(e));
            }
        }

        _createWindowControlsMirror(parent, source) {
            // Window controls (traffic lights) are a BoxLayout containing 3 buttons
            // Each button has a child St.Icon with GIcon that changes frequently
            // We need to mirror the entire structure with proper alignment
            
            if (!source || !source.get_children) {
                console.debug('[Multi Monitors Add-On] Invalid source for window controls');
                return;
            }

            // Create a mirrored BoxLayout with same properties as source
            const mirroredBox = new St.BoxLayout({
                style_class: source.style_class || 'window-controls-box',
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: false,
                x_align: Clutter.ActorAlign.START,
            });

            parent.add_child(mirroredBox);
            this._mirroredBox = mirroredBox;
            this._windowControlButtons = [];

            // Get source buttons
            const sourceButtons = source.get_children();
            
            // Mirror each button (close, minimize, maximize)
            for (const sourceButton of sourceButtons) {
                if (!(sourceButton instanceof St.Button)) continue;

                // Create mirrored button with same style class
                const mirroredButton = new St.Button({
                    style_class: sourceButton.style_class,
                    track_hover: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    y_expand: false,
                });

                // Create initial icon
                const sourceIcon = sourceButton.child;
                if (sourceIcon && sourceIcon instanceof St.Icon) {
                    const mirroredIcon = new St.Icon({
                        style_class: sourceIcon.style_class || 'window-control-icon',
                        y_align: Clutter.ActorAlign.CENTER,
                        y_expand: false,
                    });

                    if (sourceIcon.gicon) {
                        mirroredIcon.gicon = sourceIcon.gicon;
                    }

                    mirroredButton.set_child(mirroredIcon);

                    this._windowControlButtons.push({
                        sourceButton,
                        mirroredButton,
                        sourceIcon,
                        mirroredIcon,
                    });
                }

                mirroredBox.add_child(mirroredButton);
            }

            this._windowControlsUpdateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                if (this._destroyed) {
                    return GLib.SOURCE_REMOVE;
                }

                // Update each button's icon
                for (const buttonData of this._windowControlButtons) {
                    const { sourceButton, mirroredButton, mirroredIcon } = buttonData;
                    
                    if (!sourceButton || !mirroredButton) continue;

                    // Get current source icon (might have changed)
                    const currentSourceIcon = sourceButton.child;
                    if (currentSourceIcon && currentSourceIcon instanceof St.Icon) {
                        // Update gicon if changed
                        if (currentSourceIcon.gicon && currentSourceIcon.gicon !== mirroredIcon.gicon) {
                            mirroredIcon.gicon = currentSourceIcon.gicon;
                        }

                        // Update style class if changed
                        if (currentSourceIcon.style_class !== mirroredIcon.style_class) {
                            mirroredIcon.style_class = currentSourceIcon.style_class;
                        }

                        // Update icon-size if present
                        if (currentSourceIcon.icon_size) {
                            mirroredIcon.icon_size = currentSourceIcon.icon_size;
                        }

                        buttonData.sourceIcon = currentSourceIcon;
                    }

                    // Mirror visibility
                    if (sourceButton.visible !== mirroredButton.visible) {
                        mirroredButton.visible = sourceButton.visible;
                    }

                    // Mirror reactive state
                    if (sourceButton.reactive !== mirroredButton.reactive) {
                        mirroredButton.reactive = sourceButton.reactive;
                    }
                }

                return GLib.SOURCE_CONTINUE;
            });

            // Sync visual states from source indicator to this button
            this._syncIndicatorStates(source);
        }

        _createStaticIconCopy(parent, source) {
            // Create static copies of icons/labels from source
            // Used for AppIndicators and system monitor extensions to prevent stretching
            
            if (!source) {
                console.debug('[Multi Monitors Add-On] No source for static icon copy');
                return;
            }

            // Create a container for the copied icons
            const container = new St.BoxLayout({
                style_class: 'system-status-icon-box',
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: false,
            });

            parent.add_child(container);
            this._iconContainer = container;
            this._iconSource = source;

            // Initial copy
            this._copyIconsFromSource(container, source);

            // Update periodically (every 5 seconds for AppIndicators)
            this._startIconSync(5);
        }

        _connectClonePaintSignal(source, clone) {
            // Connect to the source's paint signal to ensure clone updates
            // This is the proper way to make Clutter.Clone stay synchronized
            if (!source || !clone) return;

            try {
                // Connect to queue-redraw signal on source
                this._cloneSourceRedrawId = source.connect('queue-redraw', () => {
                    if (this._destroyed) return;
                    
                    // Force clone to update when source redraws
                    if (clone && clone.queue_redraw) {
                        clone.queue_redraw();
                    }
                });

                this._connectChildrenPaintSignals(source, clone);

                // Set up periodic full refresh for widgets that don't signal properly
                this._setupPeriodicRefresh(source, clone);
            } catch (e) {
                console.debug('[Multi Monitors Add-On] Could not connect paint signals:', String(e));
            }
        }

        _connectChildrenPaintSignals(source, clone) {
            // Recursively connect to all children's paint signals
            // This ensures complex widgets (meters, graphs) update in the clone
            if (!source || !source.get_children) return;

            try {
                const children = source.get_children();
                for (const child of children) {
                    if (child && child.connect) {
                        const id = child.connect('queue-redraw', () => {
                            if (this._destroyed) return;
                            if (clone && clone.queue_redraw) {
                                clone.queue_redraw();
                            }
                        });
                        
                        if (!this._childPaintSignals) {
                            this._childPaintSignals = [];
                        }
                        this._childPaintSignals.push({ actor: child, signalId: id });
                    }

                    // Recurse for nested children
                    this._connectChildrenPaintSignals(child, clone);
                }
            } catch (e) {
                // Ignore errors
            }
        }

        _setupPeriodicRefresh(source, clone) {
            // Some widgets (like TopHat meters) update internally without signaling
            // Set up a periodic refresh to catch these updates
            if (this._periodicRefreshId) {
                GLib.source_remove(this._periodicRefreshId);
                this._periodicRefreshId = null;
            }

            // Check every 500ms - fast enough for smooth updates, slow enough to not impact performance
            this._periodicRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                if (this._destroyed) {
                    return GLib.SOURCE_REMOVE;
                }

                if (!clone || !source) {
                    return GLib.SOURCE_REMOVE;
                }

                try {
                    if (clone.get_stage() === null) {
                        return GLib.SOURCE_REMOVE;
                    }

                    // Force both source and clone to redraw
                    if (source.queue_redraw) {
                        source.queue_redraw();
                    }
                    if (clone.queue_redraw) {
                        clone.queue_redraw();
                    }
                } catch (e) {
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            });
        }

        _syncIndicatorStates(source) {
            // Track the source indicator's visual state changes
            // and mirror them on this mirrored button

            if (!this._sourceIndicator) {
                return;
            }

            this._sourceStyleChangedId = this._sourceIndicator.connect('style-changed', () => {
                this._updateMirroredState();
            });

            this._sourceVisibleChangedId = this._sourceIndicator.connect('notify::visible', () => {
                this.visible = this._sourceIndicator.visible;
            });

            // Sync initial state
            this._updateMirroredState();
            this.visible = this._sourceIndicator.visible;
        }

        _updateMirroredState() {
            if (!this._sourceIndicator) {
                return;
            }

            try {
                if (this._sourceIndicator.get_stage() === null) {
                    return; // Source indicator removed from stage
                }
            } catch (e) {
                return; // Source indicator destroyed
            }

            // Sync pseudo-classes (hover, active, checked, etc.)
            const pseudoClasses = ['hover', 'active', 'checked', 'focus', 'insensitive'];
            
            try {
                for (const pseudoClass of pseudoClasses) {
                    if (this._sourceIndicator.has_style_pseudo_class(pseudoClass)) {
                        if (!this.has_style_pseudo_class(pseudoClass)) {
                            this.add_style_pseudo_class(pseudoClass);
                        }
                    } else {
                        if (this.has_style_pseudo_class(pseudoClass)) {
                            this.remove_style_pseudo_class(pseudoClass);
                        }
                    }
                }

                // Sync reactive state
                if (this._sourceIndicator.reactive !== undefined) {
                    this.reactive = this._sourceIndicator.reactive;
                }
            } catch (e) {
                // Source indicator destroyed during sync
                return;
            }
        }

        _createQuickSettingsClone(parent, source) {
            // Create the clone
            const clone = new Clutter.Clone({
                source: source,
                y_align: Clutter.ActorAlign.FILL,
                y_expand: true,
                x_align: Clutter.ActorAlign.START,
                x_expand: false,
            });

            // Add clone directly to parent (no container in normal mode)
            parent.add_child(clone);

            this._quickSettingsClone = clone;
            this._quickSettingsClipContainer = null;
            this._quickSettingsSource = source;
            this._quickSettingsContainer = parent;
            this._normalCloneHeight = 0;

            // When overview shows - capture height and wrap in clipping container
            this._overviewShowingId = Main.overview.connect('showing', () => {
                if (this._quickSettingsClone && !this._quickSettingsClipContainer) {
                    // Capture current height only
                    const [, h] = this._quickSettingsClone.get_size();
                    this._normalCloneHeight = h;

                    // Create clipping container - height locked, width dynamic
                    const clipContainer = new St.Widget({
                        style_class: 'mm-quick-settings-clip',
                        x_expand: true,  // Allow width to grow
                        y_expand: false,
                        y_align: Clutter.ActorAlign.FILL,
                        clip_to_allocation: true,
                    });

                    // Lock only the height, let width be auto
                    if (h > 0) {
                        clipContainer.set_height(h);
                    }

                    // Reparent clone into container
                    this._quickSettingsContainer.remove_child(this._quickSettingsClone);
                    clipContainer.add_child(this._quickSettingsClone);
                    this._quickSettingsContainer.add_child(clipContainer);
                    this._quickSettingsClipContainer = clipContainer;
                }
            });

            // When overview hides - remove clipping container, put clone back directly
            this._overviewHiddenId = Main.overview.connect('hidden', () => {
                if (this._quickSettingsClipContainer && this._quickSettingsClone) {
                    // Reparent clone back to parent directly
                    this._quickSettingsClipContainer.remove_child(this._quickSettingsClone);
                    this._quickSettingsContainer.remove_child(this._quickSettingsClipContainer);
                    this._quickSettingsContainer.add_child(this._quickSettingsClone);

                    // Destroy clip container
                    this._quickSettingsClipContainer.destroy();
                    this._quickSettingsClipContainer = null;

                    this._quickSettingsClone.queue_relayout();
                }
            });

            this._fullscreenChangedId = global.display.connect('in-fullscreen-changed',
                this._onQuickSettingsFullscreenChanged.bind(this));
        }

        _onQuickSettingsFullscreenChanged() {
            // Handle fullscreen state changes separately from overview
            if (!this._quickSettingsClone) return;

            const isPrimaryFullscreen = this._isPrimaryMonitorFullscreen();

            if (isPrimaryFullscreen) {
                // Entering fullscreen on primary - apply clipping container if not already
                if (!this._quickSettingsClipContainer) {
                    const [, h] = this._quickSettingsClone.get_size();
                    this._normalCloneHeight = h;

                    // Make container taller than the clone to give room for alignment
                    const containerHeight = h + 10; // Add 10px for downward shift

                    const clipContainer = new St.Widget({
                        style_class: 'mm-quick-settings-clip',
                        x_expand: true,
                        y_expand: false,
                        y_align: Clutter.ActorAlign.FILL,
                        clip_to_allocation: true,
                    });

                    clipContainer.set_height(containerHeight);

                    this._quickSettingsContainer.remove_child(this._quickSettingsClone);
                    clipContainer.add_child(this._quickSettingsClone);
                    this._quickSettingsContainer.add_child(clipContainer);
                    this._quickSettingsClipContainer = clipContainer;
                } else {
                    // Container already exists, just update height for fullscreen mode
                    if (this._normalCloneHeight > 0) {
                        this._quickSettingsClipContainer.set_height(this._normalCloneHeight + 10);
                    }
                }

                // Adjust alignment for fullscreen - move down
                this._quickSettingsClone.y_align = Clutter.ActorAlign.END;
            } else {
                // Exiting fullscreen on primary - restore alignment and height
                // but KEEP the clipping container to prevent size issues
                this._quickSettingsClone.y_align = Clutter.ActorAlign.FILL;

                if (this._quickSettingsClipContainer && this._normalCloneHeight > 0) {
                    // Restore original height (no extra padding)
                    this._quickSettingsClipContainer.set_height(this._normalCloneHeight);
                }
            }
        }



        _isPrimaryMonitorFullscreen() {
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





        _copyIconsFromSource(container, source) {
            if (!container || !source) {
                return;
            }
            
            try {
                if (container.get_stage() === null) {
                    return; // Container removed from stage
                }
            } catch (e) {
                return; // Container destroyed
            }
            
            try {
                container.remove_all_children();
            } catch (e) {
                return; // Container destroyed
            }

            // Find all display widgets (icons and labels) in the source and create copies
            const widgets = this._findAllDisplayWidgets(source);

            if (widgets.length > 0) {
                for (const widget of widgets) {
                    try {
                        if (!widget || widget.get_stage() === null) {
                            continue; // Widget destroyed or removed
                        }
                    } catch (e) {
                        continue; // Widget destroyed
                    }
                    
                    if (widget instanceof St.Icon) {
                        const iconCopy = new St.Icon({
                            gicon: widget.gicon,
                            icon_name: widget.icon_name,
                            icon_size: widget.icon_size || 16,
                            style_class: widget.get_style_class_name() || 'system-status-icon',
                            y_align: Clutter.ActorAlign.CENTER,
                        });
                        iconCopy.visible = true;
                        iconCopy.opacity = 255;
                        try {
                            container.add_child(iconCopy);
                        } catch (e) {
                            // Container destroyed while adding children
                            iconCopy.destroy();
                            return;
                        }
                    } else if (widget instanceof St.Label) {
                        // Skip labels for ArcMenu (user request)
                        // Use loose check to catch any variation
                        if (this._role && this._role.toLowerCase().includes('arc')) {
                            continue;
                        }

                        const labelCopy = new St.Label({
                            text: widget.text,
                            style_class: widget.get_style_class_name() || '',
                            y_align: Clutter.ActorAlign.CENTER,
                        });
                        labelCopy.visible = true;
                        labelCopy.opacity = 255;
                        labelCopy._sourceLabel = widget;
                        try {
                            container.add_child(labelCopy);
                        } catch (e) {
                            // Container destroyed while adding children
                            labelCopy.destroy();
                            return;
                        }
                    }
                }
            } else {
                // Fallback: use a clone but wrap it to prevent resize
                const clone = new Clutter.Clone({
                    source: source,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                try {
                    container.add_child(clone);
                } catch (e) {
                    // Container destroyed
                    clone.destroy();
                }
            }
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

        _startIconSync(iconSyncInterval = 5) {
            if (this._iconSyncId) {
                GLib.source_remove(this._iconSyncId);
                this._iconSyncId = null;
            }
            if (this._labelSyncId) {
                GLib.source_remove(this._labelSyncId);
                this._labelSyncId = null;
            }

            // Full rebuild at specified interval (1s for system monitors, 5s for others)
            this._iconSyncId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, iconSyncInterval, () => {
                if (this._destroyed) {
                    return GLib.SOURCE_REMOVE;
                }
                
                if (!this._iconContainer || !this._iconSource) {
                    return GLib.SOURCE_REMOVE;
                }
                
                try {
                    if (this._iconContainer.get_stage() === null) {
                        // Container has been removed from stage - stop syncing
                        return GLib.SOURCE_REMOVE;
                    }
                    this._copyIconsFromSource(this._iconContainer, this._iconSource);
                } catch (e) {
                    // Container likely destroyed, stop syncing
                    return GLib.SOURCE_REMOVE;
                }
                
                return GLib.SOURCE_CONTINUE;
            });

            // Sync label text at half the interval (more frequent for real-time values)
            const labelSyncInterval = Math.max(1, Math.floor(iconSyncInterval / 2));
            this._labelSyncId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, labelSyncInterval, () => {
                if (this._destroyed) {
                    return GLib.SOURCE_REMOVE;
                }
                
                if (!this._iconContainer) {
                    return GLib.SOURCE_REMOVE;
                }
                
                try {
                    if (this._iconContainer.get_stage() === null) {
                        // Container has been removed from stage - stop syncing
                        return GLib.SOURCE_REMOVE;
                    }
                    this._syncLabelTexts(this._iconContainer);
                } catch (e) {
                    // Container likely destroyed, stop syncing
                    return GLib.SOURCE_REMOVE;
                }
                
                return GLib.SOURCE_CONTINUE;
            });
        }

        _syncLabelTexts(container) {
            if (!container) {
                return;
            }
            
            // Update label text from source labels
            try {
                const children = container.get_children();
                for (const child of children) {
                    if (child instanceof St.Label && child._sourceLabel) {
                        try {
                            if (child.get_stage() !== null && child._sourceLabel.get_stage() !== null) {
                                child.text = child._sourceLabel.text;
                            }
                        } catch (e) {
                            // One of the labels was destroyed, skip
                            continue;
                        }
                    }
                }
            } catch (e) {
                // Container was destroyed, ignore
            }
        }



        _createFallbackIcon() {
            const label = new St.Label({
                text: '⚙',
                y_align: Clutter.ActorAlign.CENTER
            });
            this.add_child(label);
        }

        vfunc_button_press_event(buttonEvent) {
            this._onButtonPress();
            return Clutter.EVENT_STOP;
        }

        vfunc_event(event) {
            if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                return this.vfunc_button_press_event(event);
            }
            return super.vfunc_event(event);
        }

        _onButtonPress() {
            if (this._role === 'activities') {
                Main.overview.toggle();
                return Clutter.EVENT_STOP;
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

        _forwardClickToSource() {
            // Forward the click to the source indicator
            // This makes the source indicator handle the click as if it was clicked directly
            this.add_style_pseudo_class('active');

            // Emit button-press-event on the source
            const event = Clutter.get_current_event();
            if (event && this._sourceIndicator.emit) {
                this._sourceIndicator.emit('button-press-event', event);
            }

            if (event && this._sourceIndicator.emit) {
                // Clean up any existing timeout before creating a new one
                if (this._forwardClickTimeoutId) {
                    GLib.source_remove(this._forwardClickTimeoutId);
                    this._forwardClickTimeoutId = null;
                }
                this._forwardClickTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    this._sourceIndicator.emit('button-release-event', event);
                    this.remove_style_pseudo_class('active');
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

            // If we found a menu, try to reposition it
            if (arcMenu && arcMenu.sourceActor) {
                const originalSourceActor = arcMenu.sourceActor;
                const originalAddPseudoClass = this._sourceIndicator.add_style_pseudo_class?.bind(this._sourceIndicator);

                // Prevent active state on main panel indicator
                this._preventMainPanelActiveState(originalAddPseudoClass);

                // Add active style to THIS button
                this.add_style_pseudo_class('active');

                // Temporarily change sourceActor to this button for positioning
                arcMenu.sourceActor = this;

                // Connect to menu close to restore state
                const openStateId = arcMenu.connect('open-state-changed', (_m, isOpen) => {
                    if (!isOpen) {
                        this.remove_style_pseudo_class('active');
                        arcMenu.sourceActor = originalSourceActor;

                        // Restore main panel indicator methods
                        if (originalAddPseudoClass) {
                            this._sourceIndicator.add_style_pseudo_class = originalAddPseudoClass;
                        }

                        arcMenu.disconnect(openStateId);
                    }
                });

                // Toggle the menu
                if (toggleFunc) {
                    toggleFunc();
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
                    this.remove_style_pseudo_class('active');
                    this._arcMenuTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                });
            }

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

        _updateMenuPositioning(menu, monitorIndex) {
            const menuBox = menu.box;

            // 1. Save original source actor
            menuBox._sourceActor = this;
            menuBox._sourceAllocation = null;

            // 2. Handle constraints
            const removedConstraints = [];
            const constraints = menuBox.get_constraints();
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
                const [menuW, menuH] = this.get_preferred_size(); // Get preferred size (min, nat)
                const finalMenuW = menuW[1]; // Use natural width
                // Height might be dynamic, use current size or preferred?
                // BoxPointer usually has size by now.
                const [currW, currH] = this.get_size();
                const finalMenuH = currH > 0 ? currH : menuH[1];

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
                originalSetPosition: originalSetPosition,
                removedConstraints: removedConstraints
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

            // 2. Restore hijacked indicator methods
            if (originalSetActive && this._sourceIndicator) {
                this._sourceIndicator.setActive = originalSetActive;
            }

            if (originalAddPseudoClass && this._sourceIndicator) {
                this._sourceIndicator.add_style_pseudo_class = originalAddPseudoClass;
            }

            // 3. Restore menu box modifications (setPosition and constraints)
            if (menu.box && menuBoxState) {
                if (menuBoxState.originalSetPosition) {
                    menu.box.setPosition = menuBoxState.originalSetPosition;
                }

                if (menuBoxState.removedConstraints && menuBoxState.removedConstraints.length > 0) {
                    menuBoxState.removedConstraints.forEach(constraint => {
                        menu.box.add_constraint(constraint);
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

        destroy() {
            // Mark as destroyed to stop all async operations
            this._destroyed = true;
            
            if (this._clockUpdateId) {
                GLib.source_remove(this._clockUpdateId);
                this._clockUpdateId = null;
            }

            if (this._forwardClickTimeoutId) {
                GLib.source_remove(this._forwardClickTimeoutId);
                this._forwardClickTimeoutId = null;
            }

            if (this._periodicRefreshId) {
                GLib.source_remove(this._periodicRefreshId);
                this._periodicRefreshId = null;
            }

            // Disconnect clone source paint signal
            if (this._cloneSourceRedrawId && this._cloneSource) {
                try {
                    this._cloneSource.disconnect(this._cloneSourceRedrawId);
                } catch (e) {
                    // Source already destroyed
                }
                this._cloneSourceRedrawId = null;
            }

            // Disconnect all child paint signals
            if (this._childPaintSignals) {
                for (const { actor, signalId } of this._childPaintSignals) {
                    try {
                        if (actor && signalId) {
                            actor.disconnect(signalId);
                        }
                    } catch (e) {
                        // Actor already destroyed
                    }
                }
                this._childPaintSignals = null;
            }

            if (this._arcMenuTimeoutId) {
                GLib.source_remove(this._arcMenuTimeoutId);
                this._arcMenuTimeoutId = null;
            }

            if (this._lockSizeTimeoutId) {
                GLib.source_remove(this._lockSizeTimeoutId);
                this._lockSizeTimeoutId = null;
            }

            if (this._monitorTimeoutId) {
                GLib.source_remove(this._monitorTimeoutId);
                this._monitorTimeoutId = null;
            }

            if (this._captureNormalSizeId) {
                GLib.source_remove(this._captureNormalSizeId);
                this._captureNormalSizeId = null;
            }

            if (this._overviewShowingId) {
                Main.overview.disconnect(this._overviewShowingId);
                this._overviewShowingId = null;
            }

            if (this._overviewHidingId) {
                Main.overview.disconnect(this._overviewHidingId);
                this._overviewHidingId = null;
            }

            if (this._overviewHiddenId) {
                Main.overview.disconnect(this._overviewHiddenId);
                this._overviewHiddenId = null;
            }

            if (this._sourceSizeChangedId && this._quickSettingsSource) {
                this._quickSettingsSource.disconnect(this._sourceSizeChangedId);
                this._sourceSizeChangedId = null;
            }

            if (this._sizeDebounceId) {
                GLib.source_remove(this._sizeDebounceId);
                this._sizeDebounceId = null;
            }

            if (this._overviewShowingId) {
                Main.overview.disconnect(this._overviewShowingId);
                this._overviewShowingId = null;
            }

            if (this._overviewShownId) {
                Main.overview.disconnect(this._overviewShownId);
                this._overviewShownId = null;
            }

            // Disconnect state synchronization signals
            if (this._sourceStyleChangedId && this._sourceIndicator) {
                this._sourceIndicator.disconnect(this._sourceStyleChangedId);
                this._sourceStyleChangedId = null;
            }

            if (this._sourceVisibleChangedId && this._sourceIndicator) {
                this._sourceIndicator.disconnect(this._sourceVisibleChangedId);
                this._sourceVisibleChangedId = null;
            }

            // Disconnect GIcon mirror signals
            if (this._iconChangedId && this._sourceIcon) {
                try {
                    this._sourceIcon.disconnect(this._iconChangedId);
                } catch (e) {
                    // Source already destroyed
                }
                this._iconChangedId = null;
            }

            if (this._iconSizeChangedId && this._sourceIcon) {
                try {
                    this._sourceIcon.disconnect(this._iconSizeChangedId);
                } catch (e) {
                    // Source already destroyed
                }
                this._iconSizeChangedId = null;
            }

            if (this._iconUpdateTimeoutId) {
                GLib.source_remove(this._iconUpdateTimeoutId);
                this._iconUpdateTimeoutId = null;
            }

            // Cleanup window controls mirror
            if (this._windowControlsUpdateId) {
                GLib.source_remove(this._windowControlsUpdateId);
                this._windowControlsUpdateId = null;
            }

            if (this._windowControlButtons) {
                this._windowControlButtons = null;
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
            super.destroy();
        }
    });
