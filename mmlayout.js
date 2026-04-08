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
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';

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

		// Capture a stable panel height that won't fluctuate during overview or
		// fullscreen transitions on the main monitor.
		this._stableHeight = this._getStablePanelHeight();
		this.panelBox.set_size(monitor.width, this._stableHeight);

		Main.uiGroup.set_child_below_sibling(this.panelBox, Main.layoutManager.panelBox);
	}

	/**
	 * Get a stable panel height that doesn't change during overview/fullscreen.
	 * Tries multiple sources in order of reliability:
	 * 1. Main.panel's natural preferred height (theme-defined, stable)
	 * 2. Main.layoutManager.panelBox.height (only if > 0 and not mid-animation)
	 * 3. Hardcoded fallback of 30px
	 */
	_getStablePanelHeight() {
		// 1. Try to get the panel's natural preferred height from its theme node
		//    This is the CSS-defined height and doesn't change during animations
		try {
			if (Main.panel) {
				const [, natHeight] = Main.panel.get_preferred_height(-1);
				if (natHeight > 0)
					return natHeight;
			}
		} catch (e) {
			// Fallthrough
		}

		// 2. Try panelBox height (may be 0 during fullscreen or animations)
		const panelBoxHeight = Main.layoutManager.panelBox.height;
		if (panelBoxHeight > 0)
			return panelBoxHeight;

		// 3. Hardcoded fallback
		return 30;
	}

	destroy() {
		// Explicitly removeChrome before destroy so struts are cleared
		// synchronously — prevents stale geometry on suspend/wake.
		try {
			Main.layoutManager.removeChrome(this.panelBox);
		} catch (e) {
			// Already untracked or destroyed
		}
		this.panelBox.destroy();
	}

	updatePanel(monitor) {
		this.panelBox.set_position(monitor.x, monitor.y);
		// Re-check the stable height (only updates if we get a valid new value)
		const newHeight = this._getStablePanelHeight();
		if (newHeight > 0)
			this._stableHeight = newHeight;
		this.panelBox.set_size(monitor.width, this._stableHeight);
	}
}

/**
 * Force a synchronous layout region update so struts/work-areas are
 * recalculated immediately rather than waiting for the next idle.
 * This is critical to prevent the lock screen from using stale geometry.
 */
function _forceUpdateRegions() {
	try {
		// Try the synchronous private method first
		if (typeof Main.layoutManager._updateRegions === 'function') {
			Main.layoutManager._updateRegions();
			return;
		}
	} catch (e) {
		// Fall through to alternatives
	}
	try {
		// Fallback: queue the update (async, but better than nothing)
		if (typeof Main.layoutManager._queueUpdateRegions === 'function')
			Main.layoutManager._queueUpdateRegions();
	} catch (e) {
		// Ignore
	}
}

export class MultiMonitorsLayoutManager {
	constructor(settings) {
		this._settings = settings;
		this._desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });

		this._monitorIds = [];
		this._lastPrimaryIndex = Main.layoutManager.primaryIndex;
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
				this._showAppMenuId = this._settings.connect('changed::' + MMPanel.SHOW_APP_MENU_ID, this._showAppMenu.bind(this));
			}

			if (!this.statusIndicatorsController) {
				this.statusIndicatorsController = new MMPanel.StatusIndicatorsController(this._settings);
			}

			if (!this._layoutManager_updateHotCorners) {
				this._layoutManager_updateHotCorners = Main.layoutManager._updateHotCorners;

				const _this = this;
				Main.layoutManager._updateHotCorners = function () {
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
					this._changedEnableHotCornersId = this._desktopSettings.connect('changed::' + ENABLE_HOT_CORNERS,
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
			this._desktopSettings.disconnect(this._changedEnableHotCornersId);
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
			this._monitorIds.pop();
			this._popPanel();
		}

		// Force synchronous region update so the lock screen
		// (shown immediately after disable) uses correct geometry.
		if (panels2remove > 0)
			_forceUpdateRegions();
	}

	_monitorsChanged() {
		// If the primary monitor changed, do a full teardown + rebuild
		const currentPrimary = Main.layoutManager.primaryIndex;
		if (this._lastPrimaryIndex !== currentPrimary) {
			log('[MultiMonitors] Primary index changed: ' + this._lastPrimaryIndex + ' -> ' + currentPrimary + ', full rebuild');
			this._lastPrimaryIndex = currentPrimary;

			// Full teardown of existing panels
			let panels2remove = this._monitorIds.length;
			for (let i = 0; i < panels2remove; i++) {
				this._monitorIds.pop();
				this._popPanel();
			}

			// Force synchronous layout recalculation.
			_forceUpdateRegions();

			// Rebuild from scratch for all non-primary monitors
			for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
				if (i !== currentPrimary) {
					let monitor = Main.layoutManager.monitors[i];
					let monitorId = 'i' + i + 'x' + monitor.x + 'y' + monitor.y +
						'w' + monitor.width + 'h' + monitor.height;
					this._monitorIds.push(monitorId);
					this._pushPanel(i, monitor);
				}
			}

			this._showAppMenu();
			if (this.statusIndicatorsController) {
				this.statusIndicatorsController.transferIndicators();
			}
			return;
		}

		let monitorChange = Main.layoutManager.monitors.length - this._monitorIds.length - 1;
		if (monitorChange < 0) {
			for (let idx = 0; idx < -monitorChange; idx++) {
				this._monitorIds.pop();
				this._popPanel();
			}
			// Force synchronous layout recalculation.
			_forceUpdateRegions();
		}

		let j = 0;
		let tIndicators = false;
		for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
			if (i != Main.layoutManager.primaryIndex) {
				let monitor = Main.layoutManager.monitors[i];
				let monitorId = "i" + i + "x" + monitor.x + "y" + monitor.y + "w" + monitor.width + "h" + monitor.height;
				if (monitorChange > 0 && j == this._monitorIds.length) {
					this._monitorIds.push(monitorId);
					this._pushPanel(i, monitor);
					tIndicators = true;
				}
				else if (this._monitorIds[j] != monitorId) {
					this._monitorIds[j] = monitorId;
					this.mmPanelBox[j].updatePanel(monitor);
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
		if (i === Main.layoutManager.primaryIndex) {
			return;
		}

		let mmPanelBox = new MultiMonitorsPanelBox(monitor);
		let panel = new MMPanel.MultiMonitorsPanel(i, mmPanelBox, this._settings);

		const mmPanelRef = getMMPanelArray();
		if (mmPanelRef) {
			mmPanelRef.push(panel);
		}
		this.mmPanelBox.push(mmPanelBox);
	}

	_popPanel() {
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

	_showAppMenu() {
		// No-op for GNOME 45+
	}

	_hideAppMenu() {
		// No-op for GNOME 45+
	}
}
