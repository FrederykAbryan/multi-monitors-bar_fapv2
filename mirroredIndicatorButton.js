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
            this._createIndicatorClone();
        } else {
            this._createFallbackIcon();
        }
    }

    _createIndicatorClone() {
        try {
            const sourceChild = this._sourceIndicator.get_first_child();
            if (sourceChild && sourceChild instanceof St.BoxLayout) {
                // For dateMenu, create a real label (not a clone) for independent hover
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
                } else {
                    // For quickSettings, use FILL to match panel height
                    if (this._role === 'quickSettings') {
                        this.add_style_class_name('mm-quick-settings');
                        this.y_expand = true;
                        this.y_align = Clutter.ActorAlign.FILL;
                        const container = new St.BoxLayout({
                            style_class: 'mm-quick-settings-box',
                            y_align: Clutter.ActorAlign.FILL,
                            y_expand: true,
                        });
                        this._createQuickSettingsClone(container, sourceChild);
                        this.add_child(container);
                    } else {
                        // For other indicators, use clone approach
                        // Container is FILL to get full-height hover, but clone inside is centered
                        const container = new St.BoxLayout({
                            style_class: sourceChild.get_style_class_name() || 'panel-status-menu-box',
                            y_align: Clutter.ActorAlign.FILL,
                            y_expand: true,
                        });
                        this._createSimpleClone(container, sourceChild);
                        this.add_child(container);
                    }
                }
            } else {
                this._createSimpleClone(this, sourceChild);
            }
        } catch (e) {
            console.error('[Multi Monitors Add-On] Failed to create mirrored indicator:', String(e));
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
        const clone = new Clutter.Clone({
            source: source,
            y_align: Clutter.ActorAlign.CENTER,  // Center vertically, don't stretch
            y_expand: false,  // Prevent vertical stretching
        });

        parent.add_child(clone);
    }

    _createQuickSettingsClone(parent, source) {
        // For quick settings (system tray), use FILL to match panel height
        const clone = new Clutter.Clone({
            source: source,
            y_align: Clutter.ActorAlign.FILL,
            y_expand: true,
        });

        parent.add_child(clone);
        this._quickSettingsClone = clone;
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
        try {
            if (this._role === 'activities') {
                Main.overview.toggle();
                return Clutter.EVENT_STOP;
            }
            
            if (this._sourceIndicator && this._sourceIndicator.menu) {
                return this._openMirroredMenu();
            }
        } catch (e) {
            console.error('[Multi Monitors Add-On] Error opening mirrored menu:', String(e), e.stack);
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _openMirroredMenu() {
        const monitorIndex = Main.layoutManager.findIndexForActor(this);
        const menu = this._sourceIndicator.menu;

        if (menu.isOpen) {
            menu.close();
            return Clutter.EVENT_STOP;
        }

        // Store original state
        const originalSourceActor = menu.sourceActor;
        const originalBoxPointer = menu.box?._sourceActor;
        const originalSetActive = this._sourceIndicator.setActive?.bind(this._sourceIndicator);
        const originalAddPseudoClass = this._sourceIndicator.add_style_pseudo_class?.bind(this._sourceIndicator);
        
        // Prevent active state on main panel indicator
        this._preventMainPanelActiveState(originalAddPseudoClass);
        
        // Add active style to THIS button
        this.add_style_pseudo_class('active');

        // Update menu's sourceActor
        menu.sourceActor = this;

        // Update BoxPointer positioning
        if (menu.box) {
            this._updateMenuPositioning(menu, monitorIndex);
        }

        // Setup cleanup on menu close
        const openStateId = menu.connect('open-state-changed', (m, isOpen) => {
            if (isOpen) {
                this.add_style_pseudo_class('active');
            } else {
                this._restoreMenuState(menu, originalSourceActor, originalBoxPointer, originalSetActive, originalAddPseudoClass);
                menu.disconnect(openStateId);
            }
        });

        menu.open();
        return Clutter.EVENT_STOP;
    }

    _preventMainPanelActiveState(originalAddPseudoClass) {
        if (this._sourceIndicator.setActive) {
            this._sourceIndicator.setActive = () => {};
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
        menu.box._sourceActor = this;
        menu.box._sourceAllocation = null;

        const monitor = Main.layoutManager.monitors[monitorIndex];

        // Remove existing constraints
        const constraints = menu.box.get_constraints();
        for (let constraint of constraints) {
            if (constraint.constructor.name === 'BindConstraint' ||
                constraint.constructor.name === 'AlignConstraint') {
                menu.box.remove_constraint(constraint);
            }
        }

        // Override setPosition to keep menu within monitor bounds
        try {
            const oldSetPosition = menu.box.setPosition.bind(menu.box);
            menu.box.setPosition = function(sourceActor, alignment) {
                oldSetPosition(sourceActor, alignment);

                const [x, y] = this.get_position();
                const [w, h] = this.get_size();

                if (x < monitor.x || x + w > monitor.x + monitor.width ||
                    y < monitor.y || y + h > monitor.y + monitor.height) {
                    
                    const [btnX, btnY] = sourceActor.get_transformed_position();
                    const [btnW, btnH] = sourceActor.get_transformed_size();

                    let newX = btnX;
                    let newY = btnY + btnH;

                    if (newX + w > monitor.x + monitor.width) {
                        newX = monitor.x + monitor.width - w;
                    }
                    if (newX < monitor.x) {
                        newX = monitor.x;
                    }
                    if (newY + h > monitor.y + monitor.height) {
                        newY = btnY - h;
                    }

                    this.set_position(newX, newY);
                }
            };
        } catch (e) {
            console.error('[Multi Monitors Add-On] Failed to override setPosition:', String(e));
        }
    }

    _restoreMenuState(menu, originalSourceActor, originalBoxPointer, originalSetActive, originalAddPseudoClass) {
        menu.sourceActor = originalSourceActor;
        if (menu.box) {
            menu.box._sourceActor = originalBoxPointer;
        }
        
        if (originalSetActive) {
            this._sourceIndicator.setActive = originalSetActive;
        }
        if (originalAddPseudoClass) {
            this._sourceIndicator.add_style_pseudo_class = originalAddPseudoClass;
        }
        
        if (this._sourceIndicator && this._sourceIndicator.remove_style_pseudo_class) {
            this._sourceIndicator.remove_style_pseudo_class('active');
            this._sourceIndicator.remove_style_pseudo_class('checked');
        }
        if (this.remove_style_pseudo_class) {
            this.remove_style_pseudo_class('active');
            this.remove_style_pseudo_class('checked');
        }
    }

    destroy() {
        if (this._clockUpdateId) {
            GLib.source_remove(this._clockUpdateId);
            this._clockUpdateId = null;
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
