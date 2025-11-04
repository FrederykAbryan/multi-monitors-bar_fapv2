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

console.log('[Multi Monitors Add-On] mmpanel.js loaded - VERSION TEST 123');

import St from 'gi://St';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Panel from 'resource:///org/gnome/shell/ui/panel.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as CtrlAltTab from 'resource:///org/gnome/shell/ui/ctrlAltTab.js';
import * as ExtensionSystem from 'resource:///org/gnome/shell/ui/extensionSystem.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';

import * as ExtensionUtils from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as MultiMonitors from './extension.js';
import * as Convenience from './convenience.js';
import * as MMCalendar from './mmcalendar.js';

// Import gettext for translations
import Gettext from 'gettext';
const _ = Gettext.gettext;

// Provide Main module reference to mmcalendar to avoid direct import there
MMCalendar.setMainRef(Main);

// Store reference to mmPanel array set by extension.js
let _mmPanelArrayRef = null;

// Helper function to set the mmPanel reference
export function setMMPanelArrayRef(mmPanelArray) {
	_mmPanelArrayRef = mmPanelArray;
}

// Helper function to safely access mmPanel array
function getMMPanelArray() {
	// First try Main.mmPanel if it exists
	if ('mmPanel' in Main && Main.mmPanel) {
		return Main.mmPanel;
	}
	// Fall back to stored reference
	return _mmPanelArrayRef;
}

export const SHOW_ACTIVITIES_ID = 'show-activities';
export const SHOW_APP_MENU_ID = 'show-app-menu';
export const SHOW_DATE_TIME_ID = 'show-date-time';
export const AVAILABLE_INDICATORS_ID = 'available-indicators';
export const TRANSFER_INDICATORS_ID = 'transfer-indicators';
export const EXCLUDE_INDICATORS_ID = 'exclude-indicators';

var StatusIndicatorsController = class StatusIndicatorsController  {
    constructor() {
        this._transfered_indicators = [];
        this._settings = Convenience.getSettings();

        this._updatedSessionId = Main.sessionMode.connect('updated', this._updateSessionIndicators.bind(this));
        this._updateSessionIndicators();
        this._extensionStateChangedId = Main.extensionManager.connect('extension-state-changed', 
                                            this._extensionStateChanged.bind(this));

        this._transferIndicatorsId = this._settings.connect('changed::'+TRANSFER_INDICATORS_ID,
                                                                        this.transferIndicators.bind(this));
        this._excludeIndicatorsId = this._settings.connect('changed::'+EXCLUDE_INDICATORS_ID,
                                                                        this._onExcludeIndicatorsChanged.bind(this));

        // Note: Do not auto-transfer Vitals; user may want it on both panels.
    }

    _onExcludeIndicatorsChanged() {
        this._findAvailableIndicators();
        this.transferIndicators();
    }

    destroy() {
        this._settings.disconnect(this._transferIndicatorsId);
        this._settings.disconnect(this._excludeIndicatorsId);
        Main.extensionManager.disconnect(this._extensionStateChangedId);
        Main.sessionMode.disconnect(this._updatedSessionId);
        this._settings.set_strv(AVAILABLE_INDICATORS_ID, []);
        this._transferBack(this._transfered_indicators);
    }

	transferBack(panel) {
		let transfer_back = this._transfered_indicators.filter((element) => {
			return element.monitor==panel.monitorIndex;
		});
		
		this._transferBack(transfer_back, panel);
	}

	transferIndicators() {
		let boxs = ['_leftBox', '_centerBox', '_rightBox'];
    	let transfers = this._settings.get_value(TRANSFER_INDICATORS_ID).deep_unpack();
    	let show_app_menu = this._settings.get_value(SHOW_APP_MENU_ID);

    	let transfer_back = this._transfered_indicators.filter((element) => {
    		return !Object.prototype.hasOwnProperty.call(transfers, element.iname);
		});

    	this._transferBack(transfer_back);

		for(let iname in transfers) {
			if(Object.prototype.hasOwnProperty.call(transfers, iname) && Main.panel.statusArea[iname]) {
				let monitor = transfers[iname];
				
				let indicator = Main.panel.statusArea[iname];
				let panel = this._findPanel(monitor);
				boxs.forEach((box) => {
					if(Main.panel[box].contains(indicator.container) && panel) {
						console.log('a '+box+ " > " + iname + " : "+ monitor);
						this._transfered_indicators.push({iname:iname, box:box, monitor:monitor});
						Main.panel[box].remove_child(indicator.container);
						if (show_app_menu && box === '_leftBox')
							panel[box].insert_child_at_index(indicator.container, 1);
						else
							panel[box].insert_child_at_index(indicator.container, 0);
					}
				});
			}
		}
	}

	_findPanel(monitor) {
		// Use helper function to get mmPanel array
		const mmPanelRef = getMMPanelArray();
		if (!mmPanelRef) {
			return null;
		}
		for (let i = 0; i < mmPanelRef.length; i++) {
			if (mmPanelRef[i].monitorIndex == monitor) {
				return mmPanelRef[i];
			}
		}
		return null;
	}

	_transferBack(transfer_back, panel) {
    	transfer_back.forEach((element) => {
    		this._transfered_indicators.splice(this._transfered_indicators.indexOf(element));
			if(Main.panel.statusArea[element.iname]) {
				let indicator = Main.panel.statusArea[element.iname];
				if(!panel) {
					panel = this._findPanel(element.monitor);
				}
				if(panel[element.box].contains(indicator.container)) {
		    		console.log("r "+element.box+ " > " + element.iname + " : "+ element.monitor);
		    		panel[element.box].remove_child(indicator.container);
		    		if (element.box === '_leftBox')
		    			Main.panel[element.box].insert_child_at_index(indicator.container, 1);
		    		else
		    			Main.panel[element.box].insert_child_at_index(indicator.container, 0);
				}
			}
		});
	}

	_extensionStateChanged() {
		this._findAvailableIndicators();
        this.transferIndicators();
        // Ensure mirrored indicators are positioned correctly (e.g., Vitals)
        try {
            const panels = getMMPanelArray();
            if (panels) {
                for (const p of panels) {
                    if (p && typeof p._ensureVitalsMirrorRightSide === 'function')
                        p._ensureVitalsMirrorRightSide();
                }
            }
        } catch (e) {}
	}

	_updateSessionIndicators() {
        let session_indicators = [];
        session_indicators.push('MultiMonitorsAddOn');
        let sessionPanel = Main.sessionMode.panel;
        for (let sessionBox in sessionPanel){
        	sessionPanel[sessionBox].forEach((sesionIndicator) => {
        		session_indicators.push(sesionIndicator);
            });
        }
        this._session_indicators = session_indicators;
		this._available_indicators = [];
		
        this._findAvailableIndicators();
        this.transferIndicators();
	}

    _findAvailableIndicators() {
		let available_indicators = [];
		let excluded_indicators = this._settings.get_strv(EXCLUDE_INDICATORS_ID);
		let statusArea = Main.panel.statusArea;
		for(let indicator in statusArea) {
			if(Object.prototype.hasOwnProperty.call(statusArea, indicator) &&
			   this._session_indicators.indexOf(indicator)<0 &&
			   excluded_indicators.indexOf(indicator)<0){
				available_indicators.push(indicator);
			}
		}
		if(available_indicators.length!=this._available_indicators.length) {
			this._available_indicators = available_indicators;
//			console.log(this._available_indicators);
			this._settings.set_strv(AVAILABLE_INDICATORS_ID, this._available_indicators);
		}
	}

    _getFirstExternalMonitorIndex() {
        const primary = Main.layoutManager.primaryIndex;
        const n = Main.layoutManager.monitors?.length ?? 1;
        for (let i = 0; i < n; i++) {
            if (i !== primary)
                return i;
        }
        // Fallback to primary if no external found
        return primary;
    }

    _autoTransferIndicatorByPattern(pattern) {
        // Read the current available indicators list
        const available = this._settings.get_strv(AVAILABLE_INDICATORS_ID) || [];
        const name = available.find(n => pattern.test(n));
        if (!name)
            return; // not present

        // Don't override user choices
        let transfers = this._settings.get_value(TRANSFER_INDICATORS_ID).deep_unpack();
        if (Object.prototype.hasOwnProperty.call(transfers, name))
            return; // already configured by user

        const targetMonitor = this._getFirstExternalMonitorIndex();
        if (targetMonitor === Main.layoutManager.primaryIndex)
            return; // no external monitor to target

        // Apply the mapping and trigger transfer
        transfers[name] = targetMonitor;
        this._settings.set_value(TRANSFER_INDICATORS_ID, new GLib.Variant('a{si}', transfers));
    }
};

// Lightweight mirrored indicator that visually clones an existing indicator
// (e.g., Vitals) from the main panel and opens its menu anchored to this button.
const MirroredIndicatorButton = GObject.registerClass(
class MirroredIndicatorButton extends PanelMenu.Button {
    _init(panel, role) {
        super._init(0.0, null, true);
        this.add_style_class_name('panel-button');
        this._role = role;
        this._sourceIndicator = Main.panel.statusArea[role] || null;

        // Visual clone of the source indicator's container
        let cloneChild = null;
        if (this._sourceIndicator && this._sourceIndicator.container) {
            try {
                cloneChild = new Clutter.Clone({ source: this._sourceIndicator.container });
            } catch (e) {
                // Fallback to a plain label if cloning fails
                cloneChild = new St.Label({ text: role });
            }
        } else {
            cloneChild = new St.Label({ text: role });
        }

        this.add_child(cloneChild);

        // Intercept clicks to open the original indicator's menu anchored here
        this.connect('button-press-event', (_actor, event) => {
            try {
                if (event.get_button && event.get_button() !== 1)
                    return Clutter.EVENT_PROPAGATE;
                if (this._sourceIndicator && this._sourceIndicator.menu) {
                    if (this._sourceIndicator.menu.setSourceActor)
                        this._sourceIndicator.menu.setSourceActor(this);
                    if (this._sourceIndicator.menu.isOpen)
                        this._sourceIndicator.menu.close();
                    else
                        this._sourceIndicator.menu.open();
                    return Clutter.EVENT_STOP;
                }
            } catch (e) {
                // ignore
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }
});

const MultiMonitorsAppMenuButton = GObject.registerClass(
class MultiMonitorsAppMenuButton extends PanelMenu.Button {
	    _init(panel) {
	    	if (panel.monitorIndex==undefined)
	    		this._monitorIndex = Main.layoutManager.primaryIndex;
	    	else
	    		this._monitorIndex = panel.monitorIndex;
	    	this._actionOnWorkspaceGroupNotifyId = 0;
	    	this._targetAppGroup = null;
	    	this._lastFocusedWindow = null;

	    	// Call parent init if Panel.AppMenuButton exists
	    	if (Panel.AppMenuButton && Panel.AppMenuButton.prototype._init) {
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
	    
	    _windowEnteredMonitor (metaScreen, monitorIndex, metaWin) {
	        if (monitorIndex == this._monitorIndex) {
	        	switch(metaWin.get_window_type()){
	        	case Meta.WindowType.NORMAL:
	        	case Meta.WindowType.DIALOG:
	        	case Meta.WindowType.MODAL_DIALOG:
	        	case Meta.WindowType.SPLASHSCREEN:
	        		this._sync();
	        		break;
	        	}
	        }
	    }
	
	    _windowLeftMonitor (metaScreen, monitorIndex, metaWin) {
	        if (monitorIndex == this._monitorIndex) {
	        	switch(metaWin.get_window_type()){
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
	        if (focusedApp && focusedApp.is_on_workspace(workspace)){
	        	let windows = focusedApp.get_windows();
	        	for (let i = 0; i < windows.length; i++) {
	        		let win = windows[i];
	        		if (win.located_on_workspace(workspace)){
	        			if (win.get_monitor() == this._monitorIndex){
	        				if (win.has_focus()){
	        					this._lastFocusedWindow = win;
	//    	        			console.log(this._monitorIndex+": focus :"+win.get_title()+" : "+win.has_focus());
		        			return focusedApp;	
	        				}
	        				else
	        					groupWindow = true;
	        			}
	        			else {
	        				if(win.has_focus())
	        					groupFocus = true;
	        			}
	        			if (groupFocus && groupWindow) {
							if(focusedApp != this._targetApp){
	    					this._targetAppGroup = focusedApp;
	    					this._actionOnWorkspaceGroupNotifyId = this._targetAppGroup.connect('notify::action-group',
	    																				this._sync.bind(this));
	//    				 	console.log(this._monitorIndex+": gConnect :"+win.get_title()+" : "+win.has_focus());
							}
	        				break;
	        			}
	        		}
	        	}
	        }
	
	        for (let i = 0; i < this._startingApps.length; i++)
	            if (this._startingApps[i].is_on_workspace(workspace)){
	//            	console.log(this._monitorIndex+": newAppFocus");
	                return this._startingApps[i];
	            }
	        
	        if (this._lastFocusedWindow && this._lastFocusedWindow.located_on_workspace(workspace) &&
	        											this._lastFocusedWindow.get_monitor() == this._monitorIndex){
	//			console.log(this._monitorIndex+": lastFocus :"+this._lastFocusedWindow.get_title());
				return tracker.get_window_app(this._lastFocusedWindow);
	        }
	
	        let windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace);
	
	        for (let i = 0; i < windows.length; i++) {
	        	if(windows[i].get_monitor() == this._monitorIndex){
	        		this._lastFocusedWindow = windows[i];
	//        		console.log(this._monitorIndex+": appFind :"+windows[i].get_title());
	    			return tracker.get_window_app(windows[i]);
	    		}
	        }
	
	        return null;
	    }
	    
	    _sync() {
	    	if (!this._switchWorkspaceNotifyId)
	    		return;
	    	// Call parent sync if Panel.AppMenuButton exists
	    	if (Panel.AppMenuButton && Panel.AppMenuButton.prototype._sync) {
	    		Panel.AppMenuButton.prototype._sync.call(this);
	    	}
	    }
	    
	    _onDestroy() {
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
            super._onDestroy();
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
            this._label = new St.Label({ text: _("Activities"),
                                         y_align: Clutter.ActorAlign.CENTER });
            this.add_child(this._label);

            this.label_actor = this._label;

            this._showingId = Main.overview.connect('showing', () => {
                this.add_style_pseudo_class('overview');
                this.add_accessible_state (Atk.StateType.CHECKED);
            });
            this._hidingId = Main.overview.connect('hiding', () => {
                this.remove_style_pseudo_class('overview');
                this.remove_accessible_state (Atk.StateType.CHECKED);
            });
            
            this._xdndTimeOut = 0;
        }

        _onDestroy() {
            Main.overview.disconnect(this._showingId);
            Main.overview.disconnect(this._hidingId);
            super._onDestroy();
        }
    });

const MULTI_MONITOR_PANEL_ITEM_IMPLEMENTATIONS = {
    'activities': MultiMonitorsActivitiesButton,
    'appMenu': MultiMonitorsAppMenuButton,
    'dateMenu': MMCalendar.MultiMonitorsDateMenuButton,
};

const MultiMonitorsPanel = GObject.registerClass(
class MultiMonitorsPanel extends St.Widget {
    _init(monitorIndex, mmPanelBox) {
        console.log('[Multi Monitors Add-On] MultiMonitorsPanel._init called for monitor', monitorIndex);
        console.log('[Multi Monitors Add-On] MultiMonitorsPanel._init mmPanelBox type:', typeof mmPanelBox);

        if (!mmPanelBox) {
            console.error('[Multi Monitors Add-On] ERROR: mmPanelBox is undefined in _init!');
            throw new Error('mmPanelBox parameter is required but was undefined');
        }

        super._init({
            name: 'panel',
            reactive: true,
            style_class: 'panel',
            style: 'background-color: rgba(255, 0, 0, 0.5);'  // TEMP: Red background for debugging
        });

        this.monitorIndex = monitorIndex;

        this.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

        this._sessionStyle = null;

        this.statusArea = {};

        this.menuManager = new PopupMenu.PopupMenuManager(this);

        // GNOME 46 FIX: Create boxes with proper expansion and alignment
        // Left box should expand and fill available space
        this._leftBox = new St.BoxLayout({
            name: 'panelLeft',
            x_expand: true,
            y_expand: false,
            x_align: Clutter.ActorAlign.START
        });
        this.add_child(this._leftBox);

        // Center box should be centered
        this._centerBox = new St.BoxLayout({
            name: 'panelCenter',
            x_expand: true,
            y_expand: false,
            x_align: Clutter.ActorAlign.CENTER
        });
        this.add_child(this._centerBox);

        // Right box should align to the end
        this._rightBox = new St.BoxLayout({
            name: 'panelRight',
            x_expand: true,
            y_expand: false,
            x_align: Clutter.ActorAlign.END
        });
        this.add_child(this._rightBox);

        console.log('[Multi Monitors Add-On] MultiMonitorsPanel boxes created');

        this._showingId = Main.overview.connect('showing', () => {
            this.add_style_pseudo_class('overview');
        });
        this._hidingId = Main.overview.connect('hiding', () => {
            this.remove_style_pseudo_class('overview');
        });

        console.log('[Multi Monitors Add-On] About to add panel to panelBox');
        mmPanelBox.panelBox.add_child(this);
        console.log('[Multi Monitors Add-On] MultiMonitorsPanel added to panelBox');
        Main.ctrlAltTabManager.addGroup(this, _("Top Bar"), 'focus-top-bar-symbolic',
                                        { sortGroup: CtrlAltTab.SortGroup.TOP });

        this._updatedId = Main.sessionMode.connect('updated', this._updatePanel.bind(this));

        this._workareasChangedId = global.display.connect('workareas-changed', () => this.queue_relayout());

        this._settings = Convenience.getSettings();
        this._showActivitiesId = this._settings.connect('changed::'+SHOW_ACTIVITIES_ID,
                                                            this._showActivities.bind(this));
        this._showActivities();

        this._showAppMenuId = this._settings.connect('changed::'+SHOW_APP_MENU_ID,
                                                            this._showAppMenu.bind(this));
        this._showAppMenu();

        this._showDateTimeId = this._settings.connect('changed::'+SHOW_DATE_TIME_ID,
                                                            this._showDateTime.bind(this));
        this._showDateTime();

        this.connect('destroy', this._onDestroy.bind(this));
    }

    vfunc_map() {
        super.vfunc_map();
        // Defer panel update until the panel is mapped and part of the scene graph.
        // This is the correct way to handle UI construction in modern GNOME.
        this._updatePanel();
        // Re-show datetime after _updatePanel to ensure it's visible
        this._showDateTime();
    }

    _onDestroy() {
        global.display.disconnect(this._workareasChangedId);
        Main.overview.disconnect(this._showingId);
        Main.overview.disconnect(this._hidingId);

        this._settings.disconnect(this._showActivitiesId);
        this._settings.disconnect(this._showAppMenuId);
        this._settings.disconnect(this._showDateTimeId);

        Main.ctrlAltTabManager.removeGroup(this);
        Main.sessionMode.disconnect(this._updatedId);
    }

    _showActivities() {
        let name = 'activities';
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
        console.log('[DATETIME DEBUG] _showDateTime called, setting:', this._settings.get_boolean(SHOW_DATE_TIME_ID));
        console.log('[DATETIME DEBUG] statusArea[dateMenu] exists?', !!this.statusArea[name]);
        if (this._settings.get_boolean(SHOW_DATE_TIME_ID)) {
            if (!this.statusArea[name]) {
                console.log('[DATETIME DEBUG] Creating new dateMenu indicator');
                let indicator = this._ensureIndicator(name);
                console.log('[DATETIME DEBUG] _ensureIndicator returned:', !!indicator);
                if (indicator) {
                    let box = this._centerBox;
                    console.log('[DATETIME DEBUG] centerBox children before add:', box.get_n_children());
                    this._addToPanelBox(name, indicator, 0, box);
                    console.log('[DATETIME DEBUG] centerBox children after add:', box.get_n_children());
                }
            }
            if (this.statusArea[name]) {
                console.log('[DATETIME DEBUG] Setting dateMenu visible');
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
                this._addToPanelBox(name, indicator, box.get_n_children()+1, box);
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
        if (Main.layoutManager.monitors.length>this.monitorIndex)
            return [0, Main.layoutManager.monitors[this.monitorIndex].width];

        return [0,  0];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const themeNode = this.get_theme_node();
        const contentBox = themeNode.get_content_box(box);

        const leftMinWidth = this._leftBox.get_preferred_width(-1)[0];
        const centerMinWidth = this._centerBox.get_preferred_width(-1)[0];
        const rightMinWidth = this._rightBox.get_preferred_width(-1)[0];

        const allocWidth = contentBox.get_width();
        const allocHeight = contentBox.get_height();

        // Allocate the left box
        const leftNaturalWidth = Math.min(this._leftBox.get_preferred_width(-1)[1], allocWidth / 3);
        const leftChildBox = new Clutter.ActorBox();
        leftChildBox.x1 = contentBox.x1;
        leftChildBox.y1 = contentBox.y1;
        leftChildBox.x2 = contentBox.x1 + leftNaturalWidth;
        leftChildBox.y2 = contentBox.y2;
        this._leftBox.allocate(leftChildBox);

        // Allocate the right box
        const rightNaturalWidth = Math.min(this._rightBox.get_preferred_width(-1)[1], allocWidth / 3);
        const rightChildBox = new Clutter.ActorBox();
        rightChildBox.x1 = contentBox.x2 - rightNaturalWidth;
        rightChildBox.y1 = contentBox.y1;
        rightChildBox.x2 = contentBox.x2;
        rightChildBox.y2 = contentBox.y2;
        this._rightBox.allocate(rightChildBox);

        // Allocate the center box in the remaining space
        const centerChildBox = new Clutter.ActorBox();
        centerChildBox.x1 = leftChildBox.x2;
        centerChildBox.y1 = contentBox.y1;
        centerChildBox.x2 = rightChildBox.x1;
        centerChildBox.y2 = contentBox.y2;
        this._centerBox.allocate(centerChildBox);
    }

    _hideIndicators() {
        console.log('[Multi Monitors Add-On] _hideIndicators called, statusArea keys:', Object.keys(this.statusArea));
        for (let role in MULTI_MONITOR_PANEL_ITEM_IMPLEMENTATIONS) {
            let indicator = this.statusArea[role];
            console.log('[Multi Monitors Add-On] _hideIndicators: checking role', role, 'indicator exists?', !!indicator);
            if (!indicator)
                continue;
            console.log('[Multi Monitors Add-On] _hideIndicators: hiding container for role', role);
            indicator.container.hide();
        }
    }

    _ensureIndicator(role) {
        console.log('[Multi Monitors Add-On] _ensureIndicator called for role:', role);
        let indicator = this.statusArea[role];
        if (indicator) {
            console.log('[Multi Monitors Add-On] indicator already exists for', role, ', showing container');
            indicator.container.show();
            // CRITICAL FIX: Return the existing indicator instead of null!
            return indicator;
        }
        else {
            let constructor = MULTI_MONITOR_PANEL_ITEM_IMPLEMENTATIONS[role];
            console.log('[Multi Monitors Add-On] constructor for', role, ':', constructor ? 'found' : 'NOT FOUND');
            if (!constructor) {
                // For indicators not implemented here, mirror specific core/extension roles
                // Supported mirrors: quickSettings (system tray) and Vitals (regex)
                const isVitals = /vitals/i.test(role);
                const isQuickSettings = role === 'quickSettings';
                const mainIndicator = Main.panel.statusArea[role];
                if ((isVitals || isQuickSettings) && mainIndicator) {
                    console.log('[Multi Monitors Add-On] Creating mirrored indicator for role:', role);
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
            console.log('[Multi Monitors Add-On] About to call new constructor for', role);
            try {
                indicator = new constructor(this);
            } catch (e) {
                // Don't log the error object directly as it may contain circular references
                console.error('[Multi Monitors Add-On] Error creating indicator for', role, ':', String(e));
                throw e;
            }
            console.log('[Multi Monitors Add-On] Constructor returned successfully for', role);
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
        console.log('[Multi Monitors Add-On] _addToPanelBox called for role:', role, 'position:', position);

        // Exactly mimic the main Panel._addToPanelBox behavior
        let container = indicator;
        if (indicator.container) {
            container = indicator.container;
        }

        console.log('[Multi Monitors Add-On] _addToPanelBox: container type:', container.constructor.name);
        console.log('[Multi Monitors Add-On] _addToPanelBox: container parent before:', container.get_parent() ? 'HAS PARENT' : 'NO PARENT');

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

        // Add to box at position
        box.insert_child_at_index(container, position);

        console.log('[Multi Monitors Add-On] _addToPanelBox: added to box, box has', box.get_n_children(), 'children');
        console.log('[Multi Monitors Add-On] _addToPanelBox: container parent after:', container.get_parent() ? 'HAS PARENT' : 'NO PARENT');
        console.log('[Multi Monitors Add-On] _addToPanelBox: container visible?', container.visible, 'width/height:', container.width, container.height);

        // Add menu if it exists
        if (indicator.menu)
            this.menuManager.addMenu(indicator.menu);
    }

    _updatePanel() {
        console.log('[Multi Monitors Add-On] _updatePanel called for monitor', this.monitorIndex);
        console.log('[Multi Monitors Add-On] Main.sessionMode.panel:', JSON.stringify(Main.sessionMode.panel));
        this._hideIndicators();
        this._updateBox(Main.sessionMode.panel.left, this._leftBox);
        this._updateBox(Main.sessionMode.panel.center, this._centerBox);
        this._updateBox(Main.sessionMode.panel.right, this._rightBox);
        console.log('[Multi Monitors Add-On] statusArea after update:', Object.keys(this.statusArea));

        // Ensure mirrored Vitals appears on the right side before system tray (if present)
        try {
            this._ensureVitalsMirrorRightSide();
        } catch (e) {
            console.log('[Multi Monitors Add-On] _ensureVitalsMirrorRightSide error:', String(e));
        }
    }

    _updateBox(elements, box) {
        if (!elements) {
            console.log('[Multi Monitors Add-On] _updateBox: elements is null/undefined');
            return;
        }

        console.log('[Multi Monitors Add-On] _updateBox: elements =', elements);
        let nChildren = box.get_n_children();

        for (let i = 0; i < elements.length; i++) {
            let role = elements[i];
            console.log('[Multi Monitors Add-On] _updateBox: processing role', role);
            try {
                let indicator = this._ensureIndicator(role);
                console.log('[Multi Monitors Add-On] _updateBox: _ensureIndicator returned', indicator ? 'truthy' : 'falsy', 'for role', role);
                if (indicator) {
                    console.log('[Multi Monitors Add-On] _updateBox: about to call _addToPanelBox for role', role);
                    this._addToPanelBox(role, indicator, i + nChildren, box);
                    console.log('[Multi Monitors Add-On] _updateBox: _addToPanelBox returned for role', role);
                } else {
                    console.log('[Multi Monitors Add-On] _updateBox: no indicator returned for role', role);
                }
            } catch (e) {
                console.error('[Multi Monitors Add-On] _updateBox: ERROR for role', role, ':', e, e.stack);
            }
        }
    }
});

// Helper methods injected into MultiMonitorsPanel prototype
MultiMonitorsPanel.prototype._findRoleByPattern = function(pattern) {
    try {
        const keys = Object.keys(Main.panel.statusArea || {});
        return keys.find(k => pattern.test(k)) || null;
    } catch (_e) {
        return null;
    }
};

MultiMonitorsPanel.prototype._getChildIndex = function(box, child) {
    const n = box.get_n_children();
    for (let i = 0; i < n; i++) {
        if (box.get_child_at_index(i) === child)
            return i;
    }
    return -1;
};

MultiMonitorsPanel.prototype._ensureVitalsMirrorRightSide = function() {
    const role = this._findRoleByPattern(/vitals/i);
    const mirrorRole = 'vitalsMirror';

    // If Vitals not present on main panel, remove any mirror we created
    if (!role) {
        if (this.statusArea[mirrorRole]) {
            const ind = this.statusArea[mirrorRole];
            if (ind.container && ind.container.get_parent())
                ind.container.get_parent().remove_child(ind.container);
            ind.destroy();
            delete this.statusArea[mirrorRole];
        }
        return;
    }

    // Create mirror if missing
    let indicator = this.statusArea[mirrorRole];
    if (!indicator) {
        try {
            indicator = new MirroredIndicatorButton(this, role);
            this.statusArea[mirrorRole] = indicator;
        } catch (e) {
            console.log('[Multi Monitors Add-On] Failed to create vitals mirror:', String(e));
            return;
        }
    }

    // Determine insertion index: before quickSettings if present, else at end
    let insertIndex = this._rightBox.get_n_children();
    const qs = this.statusArea['quickSettings'];
    if (qs) {
        const qsContainer = qs.container || qs;
        const idx = this._getChildIndex(this._rightBox, qsContainer);
        if (idx >= 0)
            insertIndex = idx; // place before quick settings
    }

    // Move/add the mirror container at desired position
    const container = indicator.container ? indicator.container : indicator;
    const parent = container.get_parent();
    if (parent)
        parent.remove_child(container);
    this._rightBox.insert_child_at_index(container, insertIndex);
};

export { StatusIndicatorsController, MultiMonitorsAppMenuButton, MultiMonitorsActivitiesButton, MultiMonitorsPanel };
