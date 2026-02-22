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

// Lightweight mirrored indicator that visually clones an existing indicator
// (e.g., Vitals) from the main panel and opens its menu anchored to this button.
export const MirroredIndicatorButton = GObject.registerClass(
    class MirroredIndicatorButton extends PanelMenu.Button {
        _init(panel, role) {
            super._init(0.0, null, false);

            this._role = role;
            this._panel = panel;

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
                        // Ensure width expands
                        x_align: Clutter.ActorAlign.FILL,
                        x_expand: true
                    });
                    this._createQuickSettingsClone(container, sourceChild);
                    this.add_child(container);
                    return;
                }

                // 2. Date Menu (Try optimizing with Label copy, fallback to simple clone)
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
                        updateClock();
                        return GLib.SOURCE_CONTINUE;
                    });

                    this.add_child(clockDisplay);
                    this._clockDisplay = clockDisplay;
                    return;
                }

                // 3. Favorites Menu (Special handling)
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

                // 4. Generic Handling
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
                updateClock();
                return GLib.SOURCE_CONTINUE;
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
                'system-monitor', 'system_monitor', 'vitals', 'tophat', 'astra-monitor',
                // AppIndicator/tray extensions (shrink on GNOME < 49)
                'appindicator', 'ubuntu-appindicator', 'kstatusnotifier', 'tray',
                // ArcMenu (squished icon fix) - checks loose 'arc' to catch variations
                'arcmenu', 'arc-menu', 'arc'
            ];
            const isProblematic = problematicExtensions.some(name =>
                this._role && this._role.toLowerCase().includes(name)
            );

            if (isProblematic) {
                // Use static icon copies for problematic extensions
                this._createStaticIconCopy(parent, source);
                return;
            }

            // For regular indicators, use Clutter.Clone (works fine)
            const clone = new Clutter.Clone({
                source: source,
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: false,
            });

            parent.add_child(clone);
        }

        _createQuickSettingsClone(parent, source) {
            // Create the clone
            const clone = new Clutter.Clone({
                source: source,
                y_align: Clutter.ActorAlign.FILL,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                x_expand: true,
            });

            // Add clone directly to parent
            parent.add_child(clone);

            this._quickSettingsClone = clone;
            this._quickSettingsSource = source;
            this._quickSettingsContainer = parent;
            this._normalCloneSize = { width: 0, height: 0 };
            this._sizeCaptured = false;
            this._isInOverview = false;

            // Capture normal size IMMEDIATELY on first allocation (before any overview)
            const captureSize = () => {
                if (!this._sizeCaptured && this._quickSettingsClone) {
                    const [w, h] = this._quickSettingsClone.get_size();
                    if (w > 0 && h > 0) {
                        this._normalCloneSize = { width: w, height: h };
                        this._sizeCaptured = true;
                    }
                }
            };

            // Try to capture size after a brief delay (once layout settles)
            if (this._captureHeightTimeoutId) {
                GLib.source_remove(this._captureHeightTimeoutId);
                this._captureHeightTimeoutId = null;
            }
            this._captureHeightTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                captureSize();
                this._captureHeightTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });

            // When overview shows - apply counter-scale to maintain visual size
            this._overviewShowingId = Main.overview.connect('showing', () => {
                if (this._quickSettingsClone && !this._isInOverview) {
                    this._isInOverview = true;

                    // Capture size if not yet captured
                    if (!this._sizeCaptured) {
                        captureSize();
                    }

                    // Set fixed size on container to prevent shrinking
                    // Add horizontal padding (16px total - 8px each side) to maintain visual padding
                    const horizontalPadding = 16;
                    if (this._sizeCaptured) {
                        this._quickSettingsContainer.set_size(
                            this._normalCloneSize.width + horizontalPadding,
                            this._normalCloneSize.height
                        );
                    }

                    // Monitor clone size changes during overview and apply counter-scale
                    this._startOverviewSizeMonitor();
                }
            });

            // When overview hides - remove fixed size and scale
            this._overviewHiddenId = Main.overview.connect('hidden', () => {
                if (this._quickSettingsClone && this._isInOverview) {
                    this._isInOverview = false;

                    // Stop size monitoring
                    this._stopOverviewSizeMonitor();

                    // Remove fixed size
                    this._quickSettingsContainer.set_size(-1, -1);

                    // Reset any scale transform
                    this._quickSettingsClone.set_scale(1.0, 1.0);
                    this._quickSettingsClone.set_pivot_point(0, 0);

                    // Re-capture size for next overview
                    if (this._captureNormalHeightTimeoutId) {
                        GLib.source_remove(this._captureNormalHeightTimeoutId);
                        this._captureNormalHeightTimeoutId = null;
                    }
                    this._captureNormalHeightTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                        if (this._quickSettingsClone) {
                            const [w, h] = this._quickSettingsClone.get_size();
                            if (w > 0 && h > 0) {
                                this._normalCloneSize = { width: w, height: h };
                            }
                        }
                        this._captureNormalHeightTimeoutId = null;
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });

            // Monitor fullscreen state changes on primary monitor
            this._fullscreenChangedId = global.display.connect('in-fullscreen-changed',
                this._onQuickSettingsFullscreenChanged.bind(this));
        }

        _startOverviewSizeMonitor() {
            // Monitor clone size continuously during overview and apply counter-scale
            if (this._overviewSizeMonitorId) {
                GLib.source_remove(this._overviewSizeMonitorId);
            }

            const updateScale = () => {
                if (!this._quickSettingsClone || !this._isInOverview || !this._sizeCaptured) {
                    return GLib.SOURCE_REMOVE;
                }

                const [currentW, currentH] = this._quickSettingsClone.get_size();
                const targetW = this._normalCloneSize.width;
                const targetH = this._normalCloneSize.height;

                if (currentW > 0 && currentH > 0 && targetW > 0 && targetH > 0) {
                    // Calculate scale needed to restore visual size
                    let scaleX = targetW / currentW;
                    let scaleY = targetH / currentH;

                    // Cap maximum scale to 1.1 (10% increase) to prevent explosion on GNOME 49
                    // This means we only correct small shrinking, and accept larger shrinking
                    // to avoid visual glitches or huge icons
                    const maxScale = 1.1;
                    scaleX = Math.min(scaleX, maxScale);
                    scaleY = Math.min(scaleY, maxScale);

                    // Only apply if shrinking detected (and significant enough to matter)
                    if (scaleX > 1.01 || scaleY > 1.01) {
                        this._quickSettingsClone.set_pivot_point(0.5, 0.5);
                        this._quickSettingsClone.set_scale(scaleX, scaleY);
                    } else {
                        // Reset if no significant shrinking
                        this._quickSettingsClone.set_scale(1.0, 1.0);
                    }
                }

                return this._isInOverview ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
            };

            // Check every 50ms during overview transition
            this._overviewSizeMonitorId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, updateScale);
        }

        _stopOverviewSizeMonitor() {
            if (this._overviewSizeMonitorId) {
                GLib.source_remove(this._overviewSizeMonitorId);
                this._overviewSizeMonitorId = null;
            }
        }

        _onQuickSettingsFullscreenChanged() {
            // Handle fullscreen state changes separately from overview
            if (!this._quickSettingsClone) return;

            const isPrimaryFullscreen = this._isPrimaryMonitorFullscreen();

            if (isPrimaryFullscreen) {
                // Entering fullscreen on primary - adjust alignment
                this._quickSettingsClone.y_align = Clutter.ActorAlign.END;

                // Set fixed size if captured
                if (this._sizeCaptured) {
                    this._quickSettingsContainer.set_size(
                        this._normalCloneSize.width,
                        this._normalCloneSize.height + 10  // Add padding for downward shift
                    );
                }
            } else {
                // Exiting fullscreen on primary - restore alignment
                this._quickSettingsClone.y_align = Clutter.ActorAlign.FILL;

                // Remove fixed size if not in overview
                if (!this._isInOverview) {
                    this._quickSettingsContainer.set_size(-1, -1);
                }
            }
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
            const container = new St.BoxLayout({
                style_class: 'panel-status-menu-box',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: false,
                reactive: false,
            });

            // Copy all icons from the source
            this._copyIconsFromSource(container, source);
            parent.add_child(container);
            this._iconContainer = container;
            this._iconSource = source;

            // Periodically sync icons (every 5 seconds) to catch icon changes
            this._startIconSync();
        }

        _copyIconsFromSource(container, source) {
            // Guard against accessing disposed actors
            try {
                if (!container || !source) return;
                // Test if the actor is still alive by accessing a property
                container.visible;
                source.visible;
            } catch (e) {
                return; // Actor already disposed
            }

            // Remove existing children
            container.remove_all_children();

            // Find all display widgets (icons and labels) in the source and create copies
            const widgets = this._findAllDisplayWidgets(source);

            if (widgets.length > 0) {
                for (const widget of widgets) {
                    if (widget instanceof St.Icon) {
                        const iconCopy = new St.Icon({
                            gicon: widget.gicon,
                            icon_name: widget.icon_name,
                            icon_size: widget.icon_size || 16,
                            style_class: widget.get_style_class_name() || 'system-status-icon',
                            y_align: Clutter.ActorAlign.CENTER,
                        });
                        container.add_child(iconCopy);
                    } else if (widget instanceof St.Label) {
                        // Skip labels for ArcMenu (user request)
                        // Use loose check to catch any variation
                        if (this._role && this._role.toLowerCase().includes('arc')) {
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
                    y_align: Clutter.ActorAlign.CENTER,
                });
                container.add_child(clone);
            }
        }

        _findAllDisplayWidgets(actor) {
            // Recursively find all St.Icon and St.Label instances in an actor tree
            // This preserves their order for proper display (e.g., Vitals: icon + number)
            const widgets = [];
            try {
                if (actor instanceof St.Icon || actor instanceof St.Label) {
                    widgets.push(actor);
                }
                const children = actor.get_children ? actor.get_children() : [];
                for (const child of children) {
                    widgets.push(...this._findAllDisplayWidgets(child));
                }
            } catch (e) {
                // Actor disposed during traversal, return what we have
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
                        // Verify actors are still alive before accessing
                        this._iconContainer.visible;
                        this._iconSource.visible;
                        this._copyIconsFromSource(this._iconContainer, this._iconSource);
                    }
                } catch (e) {
                    // Container or source disposed, stop syncing
                    this._iconSyncId = null;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });

            // Sync label text more frequently (every 2 seconds) for Vitals-like extensions
            this._labelSyncId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                try {
                    if (this._iconContainer) {
                        this._iconContainer.visible;
                        this._syncLabelTexts(this._iconContainer);
                    }
                } catch (e) {
                    // Container disposed, stop syncing
                    this._labelSyncId = null;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }

        _syncLabelTexts(container) {
            // Update label text from source labels
            try {
                const children = container.get_children();
                for (const child of children) {
                    if (child instanceof St.Label && child._sourceLabel) {
                        try {
                            child.text = child._sourceLabel.text;
                        } catch (e) {
                            // Source label disposed, skip
                        }
                    }
                }
            } catch (e) {
                // Container disposed
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
            try {
                if (actor instanceof St.Icon) {
                    return actor;
                }
                const children = actor.get_children ? actor.get_children() : [];
                for (const child of children) {
                    const found = this._findIconInActor(child);
                    if (found) return found;
                }
            } catch (e) {
                // Actor disposed during traversal
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

            // Also try button-release-event which some extensions use
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
            this._isDestroyed = true;

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

            if (this._captureHeightTimeoutId) {
                GLib.source_remove(this._captureHeightTimeoutId);
                this._captureHeightTimeoutId = null;
            }

            if (this._captureNormalHeightTimeoutId) {
                GLib.source_remove(this._captureNormalHeightTimeoutId);
                this._captureNormalHeightTimeoutId = null;
            }

            if (this._overviewSizeMonitorId) {
                GLib.source_remove(this._overviewSizeMonitorId);
                this._overviewSizeMonitorId = null;
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

            if (this._overviewShowingId) {
                Main.overview.disconnect(this._overviewShowingId);
                this._overviewShowingId = null;
            }

            if (this._overviewShownId) {
                Main.overview.disconnect(this._overviewShownId);
                this._overviewShownId = null;
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
