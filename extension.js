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

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ANIMATION_TIME } from 'resource:///org/gnome/shell/ui/overview.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelModule from 'resource:///org/gnome/shell/ui/panel.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';

// Shell version for feature detection - centralized here and exported for other modules

import * as Common from './common.js';
export const shellVersion = Common.shellVersion;
export const patchAddActorMethod = Common.patchAddActorMethod;
export const copyClass = Common.copyClass;

import * as MMLayout from './mmlayout.js';
import * as MMOverview from './mmoverview.js';
import * as MMPanel from './mmpanel.js';
import * as ScreenshotPatch from './screenshotPatch.js';

const MUTTER_SCHEMA = 'org.gnome.mutter';
const WORKSPACES_ONLY_ON_PRIMARY_ID = 'workspaces-only-on-primary';

const THUMBNAILS_SLIDER_POSITION_ID = 'thumbnails-slider-position';

export let mmPanel = [];
export let mmOverview = null;
export let mmLayoutManager = null;

export default class MultiMonitorsExtension extends Extension {
	constructor(metadata) {
		super(metadata);
		this._settings = null;
		this._mu_settings = null;
		this._mmMonitors = 0;
		this._primaryIndex = -1;
		this.syncWorkspacesActualGeometry = null;

		this._switchOffThumbnailsMuId = null;
		this._showPanelId = null;
		this._thumbnailsSliderPositionId = null;
		this._relayoutId = null;
		this._prepareForSleepId = null;
	}

	_showThumbnailsSlider() {
		// We now allow mmOverview even if thumbnails are 'none', because we want Search and App Grid
		// if (this._settings.get_string(THUMBNAILS_SLIDER_POSITION_ID) === 'none') {
		// 	this._hideThumbnailsSlider();
		// 	return;
		// }

		log('[MultiMonitors] _showThumbnailsSlider called');

		if (this._settings.get_boolean('force-workspaces-on-all-displays')) {
			if (this._mu_settings.get_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID))
				this._mu_settings.set_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID, false);
		} else {
			if (!this._mu_settings.get_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID))
				this._mu_settings.set_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID, true);
		}

		if (!this._settings.get_boolean('show-overview-on-extended-monitors')) {
			this._hideThumbnailsSlider();
			return;
		}

		if (mmOverview) {
			log('[MultiMonitors] mmOverview already exists, returning');
			return;
		}

		mmOverview = [];
		log('[MultiMonitors] Creating mmOverview array');

		for (let idx = 0; idx < Main.layoutManager.monitors.length; idx++) {
			if (idx != Main.layoutManager.primaryIndex) {
				log('[MultiMonitors] Creating overview for monitor ' + idx);
				mmOverview[idx] = new MMOverview.MultiMonitorsOverview(idx, this._settings);
			}
		}

		if (Main.overview.searchController &&
			Main.overview.searchController._workspacesDisplay &&
			Main.overview.searchController._workspacesDisplay._syncWorkspacesActualGeometry) {
			this.syncWorkspacesActualGeometry = Main.overview.searchController._workspacesDisplay._syncWorkspacesActualGeometry;
			Main.overview.searchController._workspacesDisplay._syncWorkspacesActualGeometry = function () {
				if (this._inWindowFade)
					return;

				const primaryView = this._getPrimaryView();
				if (primaryView) {
					primaryView.ease({
						...this._actualGeometry,
						duration: Main.overview.animationInProgress ? ANIMATION_TIME : 0,
						mode: Clutter.AnimationMode.EASE_OUT_QUAD,
					});
				}

				if (mmOverview) {
					for (let idx = 0; idx < mmOverview.length; idx++) {
						if (!mmOverview[idx])
							continue;
						if (!mmOverview[idx]._overview)
							continue;
						const mmView = mmOverview[idx]._overview._controls._workspacesViews;
						if (!mmView)
							continue;

						const mmGeometry = mmOverview[idx].getWorkspacesActualGeometry();
						mmView.ease({
							...mmGeometry,
							duration: Main.overview.animationInProgress ? ANIMATION_TIME : 0,
							mode: Clutter.AnimationMode.EASE_OUT_QUAD,
						});
					}
				}
			}
		} else {
			this.syncWorkspacesActualGeometry = null;
		}
	}

	_hideThumbnailsSlider() {
		if (!mmOverview)
			return;

		for (let idx = 0; idx < mmOverview.length; idx++) {
			if (mmOverview[idx])
				mmOverview[idx].destroy();
		}
		mmOverview = null;

		if (this.syncWorkspacesActualGeometry &&
			Main.overview.searchController &&
			Main.overview.searchController._workspacesDisplay) {
			Main.overview.searchController._workspacesDisplay._syncWorkspacesActualGeometry = this.syncWorkspacesActualGeometry;
		}
	}

	_relayout() {
		const newCount = Main.layoutManager.monitors.length;
		const newPrimary = Main.layoutManager.primaryIndex;
		if (this._mmMonitors !== newCount || this._primaryIndex !== newPrimary) {
			log('[MultiMonitors] _relayout: monitors ' + this._mmMonitors + '->' + newCount +
				', primary ' + this._primaryIndex + '->' + newPrimary);
			this._mmMonitors = newCount;
			this._primaryIndex = newPrimary;
			this._hideThumbnailsSlider();
			this._showThumbnailsSlider();
		}
	}

	_switchOffThumbnails() {
		if (this._settings.get_boolean('force-workspaces-on-all-displays') && this._mu_settings.get_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID)) {
			this._settings.set_string(THUMBNAILS_SLIDER_POSITION_ID, 'none');
		}
	}

	enable() {
		this._mmMonitors = 0;
		this._primaryIndex = -1;

		this._settings = this.getSettings();
		this._mu_settings = new Gio.Settings({ schema: MUTTER_SCHEMA });

		this._switchOffThumbnailsMuId = this._mu_settings.connect('changed::' + WORKSPACES_ONLY_ON_PRIMARY_ID,
			this._switchOffThumbnails.bind(this));
		this._forceWorkspacesId = this._settings.connect('changed::force-workspaces-on-all-displays', () => {
			if (this._settings.get_boolean('force-workspaces-on-all-displays')) {
				if (this._mu_settings.get_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID))
					this._mu_settings.set_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID, false);
			} else {
				if (!this._mu_settings.get_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID))
					this._mu_settings.set_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID, true);
			}
			this._hideThumbnailsSlider();
			this._showThumbnailsSlider();
		});

		this._showOverviewId = this._settings.connect('changed::show-overview-on-extended-monitors', () => {
			this._hideThumbnailsSlider();
			this._showThumbnailsSlider();
		});

		mmLayoutManager = new MMLayout.MultiMonitorsLayoutManager(this._settings);

		this._showPanelId = this._settings.connect('changed::' + MMLayout.SHOW_PANEL_ID, mmLayoutManager.showPanel.bind(mmLayoutManager));
		mmLayoutManager.showPanel();

		this._thumbnailsSliderPositionId = this._settings.connect('changed::' + THUMBNAILS_SLIDER_POSITION_ID, this._showThumbnailsSlider.bind(this));
		this._relayoutId = Main.layoutManager.connect('monitors-changed', this._relayout.bind(this));
		this._relayout();

		// Proactively tear down extra panels before suspend so the lock
		// screen on wake gets correct single-monitor geometry.
		try {
			const loginMgr = LoginManager.getLoginManager();
			this._prepareForSleepId = loginMgr.connect('prepare-for-sleep',
				(mgr, aboutToSuspend) => {
					if (aboutToSuspend)
						this._onPrepareForSleep();
				});
		} catch (e) {
			log('[MultiMonitors] Could not connect prepare-for-sleep: ' + e);
		}

		mmPanel.length = 0;
		MMLayout.setMMPanelArrayRef(mmPanel);
		MMPanel.setMMPanelArrayRef(mmPanel);
		MMOverview.setMMPanelArrayRef(mmPanel);

		Main.panel._ensureIndicator = function (role) {
			let indicator = this.statusArea[role];
			if (indicator) {
				indicator.container.show();
				return null;
			}
			else {
				let constructor = PanelModule.PANEL_ITEM_IMPLEMENTATIONS[role];
				if (!constructor) {
					return null;
				}
				indicator = new constructor(this);
				this.statusArea[role] = indicator;
			}
			return indicator;
		};

		// Patch screenshot UI to open on cursor's monitor (or all monitors based on setting)
		ScreenshotPatch.patchScreenshotUI(this._settings);
	}

	/**
	 * Called just before the system suspends.  Tear down all extra-monitor
	 * chrome so GNOME Shell's layout regions are clean when the lock
	 * screen dialog is positioned on wake.
	 */
	_onPrepareForSleep() {
		log('[MultiMonitors] _onPrepareForSleep: cleaning up before suspend');
		if (mmLayoutManager) {
			mmLayoutManager.hidePanel();
			mmLayoutManager = null;
		}
		this._hideThumbnailsSlider();
		this._mmMonitors = 0;
		this._primaryIndex = -1;
		mmPanel.length = 0;
	}

	disable() {
		// Unpatch screenshot UI
		ScreenshotPatch.unpatchScreenshotUI();

		if (this._prepareForSleepId) {
			try {
				const loginMgr = LoginManager.getLoginManager();
				loginMgr.disconnect(this._prepareForSleepId);
			} catch (e) {
				// Ignore
			}
			this._prepareForSleepId = null;
		}

		if (this._relayoutId) {
			Main.layoutManager.disconnect(this._relayoutId);
			this._relayoutId = null;
		}

		if (this._switchOffThumbnailsMuId) {
			this._mu_settings.disconnect(this._switchOffThumbnailsMuId);
			this._switchOffThumbnailsMuId = null;
		}

		if (this._forceWorkspacesId) {
			this._settings.disconnect(this._forceWorkspacesId);
			this._forceWorkspacesId = null;
		}

		if (this._showOverviewId) {
			this._settings.disconnect(this._showOverviewId);
			this._showOverviewId = null;
		}

		if (this._showPanelId) {
			this._settings.disconnect(this._showPanelId);
			this._showPanelId = null;
		}

		if (this._thumbnailsSliderPositionId) {
			this._settings.disconnect(this._thumbnailsSliderPositionId);
			this._thumbnailsSliderPositionId = null;
		}

		if (mmLayoutManager) {
			mmLayoutManager.hidePanel();
			mmLayoutManager = null;
		}

		this._hideThumbnailsSlider();
		this._mmMonitors = 0;
		this._primaryIndex = -1;

		mmPanel.length = 0;

		this._settings = null;
		this._mu_settings = null;
	}
}
