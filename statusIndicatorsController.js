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

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Constants from './mmPanelConstants.js';

export class StatusIndicatorsController {
	constructor(settings) {
		this._transfered_indicators = [];
		this._settings = settings;

		this._updatedSessionId = Main.sessionMode.connect('updated', this._updateSessionIndicators.bind(this));
		this._updateSessionIndicators();
		this._extensionStateChangedId = Main.extensionManager.connect('extension-state-changed',
			this._extensionStateChanged.bind(this));

		this._transferIndicatorsId = this._settings.connect('changed::' + Constants.TRANSFER_INDICATORS_ID,
			this.transferIndicators.bind(this));
		this._excludeIndicatorsId = this._settings.connect('changed::' + Constants.EXCLUDE_INDICATORS_ID,
			this._onExcludeIndicatorsChanged.bind(this));
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
		this._settings.set_strv(Constants.AVAILABLE_INDICATORS_ID, []);
		this._transferBack(this._transfered_indicators);
	}

	transferBack(panel) {
		let transfer_back = this._transfered_indicators.filter((element) => {
			return element.monitor == panel.monitorIndex;
		});

		this._transferBack(transfer_back, panel);
	}

	transferIndicators() {
		let boxs = ['_leftBox', '_centerBox', '_rightBox'];
		let transfers = this._settings.get_value(Constants.TRANSFER_INDICATORS_ID).deep_unpack();
		let show_app_menu = this._settings.get_value(Constants.SHOW_APP_MENU_ID);

		let transfer_back = this._transfered_indicators.filter((element) => {
			return !Object.prototype.hasOwnProperty.call(transfers, element.iname);
		});

		this._transferBack(transfer_back);

		for (let iname in transfers) {
			if (Object.prototype.hasOwnProperty.call(transfers, iname) && Main.panel.statusArea[iname]) {
				let monitor = transfers[iname];

				let indicator = Main.panel.statusArea[iname];
				let panel = this._findPanel(monitor);
				boxs.forEach((box) => {
					if (Main.panel[box].contains(indicator.container) && panel) {
						this._transfered_indicators.push({ iname: iname, box: box, monitor: monitor });
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
		const mmPanelRef = Constants.getMMPanelArray();
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
			if (Main.panel.statusArea[element.iname]) {
				let indicator = Main.panel.statusArea[element.iname];
				if (!panel) {
					panel = this._findPanel(element.monitor);
				}
				if (panel && panel[element.box].contains(indicator.container)) {
					panel[element.box].remove_child(indicator.container);

					// IMPORTANT: Be more careful about insertion position to avoid extra widgets
					if (element.box === '_leftBox') {
						// For left box, try to insert after activities (if it exists) or at the end
						let insertIndex = 1; // Default after activities
						const leftBoxChildren = Main.panel[element.box].get_n_children();
						if (leftBoxChildren > 1) {
							insertIndex = leftBoxChildren; // Insert at end to avoid conflicts
						}
						Main.panel[element.box].insert_child_at_index(indicator.container, insertIndex);
					} else {
						Main.panel[element.box].insert_child_at_index(indicator.container, 0);
					}
				}
			}
		});
	}

	_extensionStateChanged() {
		this._findAvailableIndicators();
		this.transferIndicators();
		// Ensure mirrored indicators are positioned correctly (e.g., Vitals)
		const panels = Constants.getMMPanelArray();
		if (panels) {
			for (const p of panels) {
				if (p && typeof p._ensureVitalsMirrorRightSide === 'function')
					p._ensureVitalsMirrorRightSide();
				if (p && typeof p._ensureQuickSettingsRightmost === 'function')
					p._ensureQuickSettingsRightmost();
			}
		}
	}

	_updateSessionIndicators() {
		let session_indicators = [];
		session_indicators.push('MultiMonitorsAddOn');
		let sessionPanel = Main.sessionMode.panel;
		for (let sessionBox in sessionPanel) {
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
		let excluded_indicators = this._settings.get_strv(Constants.EXCLUDE_INDICATORS_ID);
		let statusArea = Main.panel.statusArea;
		for (let indicator in statusArea) {
			if (Object.prototype.hasOwnProperty.call(statusArea, indicator) &&
				this._session_indicators.indexOf(indicator) < 0 &&
				excluded_indicators.indexOf(indicator) < 0) {
				available_indicators.push(indicator);
			}
		}
		if (available_indicators.length != this._available_indicators.length) {
			this._available_indicators = available_indicators;
			this._settings.set_strv(Constants.AVAILABLE_INDICATORS_ID, this._available_indicators);
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
		const available = this._settings.get_strv(Constants.AVAILABLE_INDICATORS_ID) || [];
		const name = available.find(n => pattern.test(n));
		if (!name)
			return; // not present

		// Don't override user choices
		let transfers = this._settings.get_value(Constants.TRANSFER_INDICATORS_ID).deep_unpack();
		if (Object.prototype.hasOwnProperty.call(transfers, name))
			return; // already configured by user

		const targetMonitor = this._getFirstExternalMonitorIndex();
		if (targetMonitor === Main.layoutManager.primaryIndex)
			return; // no external monitor to target

		// Apply the mapping and trigger transfer
		transfers[name] = targetMonitor;
		this._settings.set_value(Constants.TRANSFER_INDICATORS_ID, new GLib.Variant('a{si}', transfers));
	}
}
