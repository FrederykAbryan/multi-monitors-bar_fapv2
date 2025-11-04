/**
 * New node file
 */

import St from 'gi://St';
import Meta from 'gi://Meta';
import * as ExtensionUtils from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelModule from 'resource:///org/gnome/shell/ui/panel.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import * as Convenience from './convenience.js';
import * as MMPanel from './mmpanel.js';

export const SHOW_PANEL_ID = 'show-panel';
export const ENABLE_HOT_CORNERS = 'enable-hot-corners';

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

export class MultiMonitorsPanelBox {
    constructor(monitor) {
		this.panelBox = new St.BoxLayout({
			name: 'panelBox',
			vertical: true,
			clip_to_allocation: true,
			visible: true
		});
        Main.layoutManager.addChrome(this.panelBox, { affectsStruts: true, trackFullscreen: true });
        this.panelBox.set_position(monitor.x, monitor.y);
        this.panelBox.set_size(monitor.width, -1);
        Main.uiGroup.set_child_below_sibling(this.panelBox, Main.layoutManager.panelBox);
        console.log('[PANEL BOX DEBUG] Created panel box at', monitor.x, monitor.y, 'size', monitor.width, 'visible:', this.panelBox.visible);
    }

    destroy() {
        this.panelBox.destroy();
    }

    updatePanel(monitor) {
        this.panelBox.set_position(monitor.x, monitor.y);
        this.panelBox.set_size(monitor.width, -1);
    }
}

export class MultiMonitorsLayoutManager {
	constructor() {
		console.log('[Multi Monitors Add-On] MultiMonitorsLayoutManager constructor called');
		this._settings = Convenience.getSettings();
		this._desktopSettings = Convenience.getSettings("org.gnome.desktop.interface");

		// Main.mmPanel is now initialized in extension.js constructor
		// to avoid "read-only" errors with ES6 module imports
		console.log('[Multi Monitors Add-On] MultiMonitorsLayoutManager constructor: Main.mmPanel is', typeof Main.mmPanel);

		this._monitorIds = [];
		this.mmPanelBox = [];
		this.mmappMenu = false;
		
		this._showAppMenuId = null;
		this._monitorsChangedId = null;
		
		this.statusIndicatorsController = null;
		this._layoutManager_updateHotCorners = null;
		this._changedEnableHotCornersId = null;
	}

    showPanel() {
        if (this._settings.get_boolean(SHOW_PANEL_ID)) {
            if (!this._monitorsChangedId) {
                this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', this._monitorsChanged.bind(this));
                this._monitorsChanged();
            }
            if (!this._showAppMenuId) {
                this._showAppMenuId = this._settings.connect('changed::'+MMPanel.SHOW_APP_MENU_ID, this._showAppMenu.bind(this));
            }

            if (!this.statusIndicatorsController) {
                this.statusIndicatorsController = new MMPanel.StatusIndicatorsController();
            }

            if (!this._layoutManager_updateHotCorners) {
                this._layoutManager_updateHotCorners = Main.layoutManager._updateHotCorners;

                const _this = this;
                Main.layoutManager._updateHotCorners = function() {
                    this.hotCorners.forEach((corner) => {
                        if (corner)
                            corner.destroy();
                    });
                    this.hotCorners = [];

                    if (!_this._desktopSettings.get_boolean(ENABLE_HOT_CORNERS)) {
                        this.emit('hot-corners-changed');
                        return;
                    }

                    let size = this.panelBox.height;

                    for (let i = 0; i < this.monitors.length; i++) {
                        let monitor = this.monitors[i];
                        let cornerX = this._rtl ? monitor.x + monitor.width : monitor.x;
                        let cornerY = monitor.y;

                        let corner = new Layout.HotCorner(this, monitor, cornerX, cornerY);
                        corner.setBarrierSize(size);
                        this.hotCorners.push(corner);
                    }

                    this.emit('hot-corners-changed');
                };

                if (!this._changedEnableHotCornersId) {
                    this._changedEnableHotCornersId = this._desktopSettings.connect('changed::'+ENABLE_HOT_CORNERS,
                            Main.layoutManager._updateHotCorners.bind(Main.layoutManager));
                }

                Main.layoutManager._updateHotCorners();
            }
        }
        else {
            this.hidePanel();
        }
    }

	hidePanel() {
		if (this._changedEnableHotCornersId) {
			global.settings.disconnect(this._changedEnableHotCornersId);
			this._changedEnableHotCornersId = null;
		}
		
		if (this._layoutManager_updateHotCorners) {
			Main.layoutManager['_updateHotCorners'] = this._layoutManager_updateHotCorners;
			this._layoutManager_updateHotCorners = null;
			Main.layoutManager._updateHotCorners();
		}
			
		if (this.statusIndicatorsController) {
			this.statusIndicatorsController.destroy();
			this.statusIndicatorsController = null;
		}
		
		if (this._showAppMenuId) {
			this._settings.disconnect(this._showAppMenuId);
			this._showAppMenuId = null;
		}
		this._hideAppMenu();
		
		if (this._monitorsChangedId) {
			Main.layoutManager.disconnect(this._monitorsChangedId);
			this._monitorsChangedId = null;
		}

		let panels2remove = this._monitorIds.length;
		for (let i = 0; i < panels2remove; i++) {
			let monitorId = this._monitorIds.pop();
			this._popPanel();
			console.log("remove: "+monitorId);
		}
	}

	_monitorsChanged () {
		let monitorChange = Main.layoutManager.monitors.length - this._monitorIds.length -1;
		if (monitorChange<0) {
			for (let idx = 0; idx<-monitorChange; idx++) {
				let monitorId = this._monitorIds.pop();
				this._popPanel();
				console.log("remove: "+monitorId);
			}
		}
		
		let j = 0;
		let tIndicators = false;
		for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
			if (i!=Main.layoutManager.primaryIndex) {
				let monitor = Main.layoutManager.monitors[i];
				let monitorId = "i"+i+"x"+monitor.x+"y"+monitor.y+"w"+monitor.width+"h"+monitor.height;
				if (monitorChange>0 && j==this._monitorIds.length) {
					this._monitorIds.push(monitorId);
					this._pushPanel(i, monitor);
					console.log("new: "+monitorId);
					tIndicators = true;
				}
				else if (this._monitorIds[j]>monitorId || this._monitorIds[j]<monitorId) {
					let oldMonitorId = this._monitorIds[j];
					this._monitorIds[j]=monitorId;
					this.mmPanelBox[j].updatePanel(monitor);
					console.log("update: "+oldMonitorId+">"+monitorId);
				}
				j++;
			}
		}
		this._showAppMenu();
		if (tIndicators && this.statusIndicatorsController) {
			this.statusIndicatorsController.transferIndicators();
		}
	}

	_pushPanel(i, monitor) {
		console.log('[Multi Monitors Add-On] _pushPanel: creating panel for monitor', i);
		let mmPanelBox = new MultiMonitorsPanelBox(monitor);
		console.log('[Multi Monitors Add-On] _pushPanel: mmPanelBox created');
		
		let panel;
		try {
			panel = new MMPanel.MultiMonitorsPanel(i, mmPanelBox);
			console.log('[Multi Monitors Add-On] _pushPanel: panel created successfully');
		} catch (e) {
			console.error('[Multi Monitors Add-On] _pushPanel: Error creating panel:', String(e));
			return;
		}

		// Use helper function to get mmPanel array
		const mmPanelRef = getMMPanelArray();
		console.log('[Multi Monitors Add-On] _pushPanel: mmPanelRef type:', typeof mmPanelRef);
		if (mmPanelRef) {
			mmPanelRef.push(panel);
		} else {
			console.error('[Multi Monitors Add-On] _pushPanel: mmPanelRef is null/undefined, cannot push panel!');
		}
		this.mmPanelBox.push(mmPanelBox);
	}

	_popPanel() {
		// Use helper function to get mmPanel array
		const mmPanelRef = getMMPanelArray();
		let panel = mmPanelRef ? mmPanelRef.pop() : null;
		if (panel && this.statusIndicatorsController) {
			this.statusIndicatorsController.transferBack(panel);
		}
		let mmPanelBox = this.mmPanelBox.pop();
		if (mmPanelBox) {
			mmPanelBox.destroy();
		}
    }

	_changeMainPanelAppMenuButton(appMenuButton) {
		// Guard: AppMenuButton might not exist in GNOME 46
		if (!appMenuButton) {
			return;
		}
		
		let role = "appMenu";
		let panel = Main.panel;
		let indicator = panel.statusArea[role];
		
		// Guard against undefined indicator
		if (indicator) {
			panel.menuManager.removeMenu(indicator.menu);
			indicator.destroy();
			if (indicator._actionGroupNotifyId) {
				indicator._targetApp.disconnect(indicator._actionGroupNotifyId);
				indicator._actionGroupNotifyId = 0;
	        }
	        if (indicator._busyNotifyId) {
	        	indicator._targetApp.disconnect(indicator._busyNotifyId);
	        	indicator._busyNotifyId = 0;
	        }
	        if (indicator.menu && indicator.menu._windowsChangedId) {
	        	indicator.menu._app.disconnect(indicator.menu._windowsChangedId);
	        	indicator.menu._windowsChangedId = 0;
	        }
		}
		
		indicator = new appMenuButton(panel);
		panel.statusArea[role] = indicator;
		let box = panel._leftBox;
		panel._addToPanelBox(role, indicator, box.get_n_children()+1, box);
	}

	_showAppMenu() {
		// Use helper function to get mmPanel array
		const mmPanelRef = getMMPanelArray();
		if (this._settings.get_boolean(MMPanel.SHOW_APP_MENU_ID) && mmPanelRef && mmPanelRef.length>0) {
			if (!this.mmappMenu) {
				this._changeMainPanelAppMenuButton(MMPanel.MultiMonitorsAppMenuButton);
				this.mmappMenu = true;
			}
		}
		else {
			this._hideAppMenu();
		}
	}

	_hideAppMenu() {
		if (this.mmappMenu) {
			// Only restore if PanelModule.AppMenuButton exists (it doesn't in GNOME 46)
			if (PanelModule.AppMenuButton) {
				this._changeMainPanelAppMenuButton(PanelModule.AppMenuButton);
			}
			this.mmappMenu = false;
			if (Main.panel._updatePanel) {
				Main.panel._updatePanel();
			}
		}
	}
}
