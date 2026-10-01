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
import GLib from 'gi://GLib';
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
import * as MMDock from './mmdock.js';
import * as MMOverview from './mmoverview.js';
import * as MMPanel from './mmpanel.js';
import * as ScreenshotPatch from './screenshotPatch.js';

const MUTTER_SCHEMA = 'org.gnome.mutter';
const WORKSPACES_ONLY_ON_PRIMARY_ID = 'workspaces-only-on-primary';

const THUMBNAILS_SLIDER_POSITION_ID = 'thumbnails-slider-position';

export let mmPanel = [];
export let mmOverview = null;
export let mmLayoutManager = null;

const DASH_TO_DOCK_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock';
const DASH_TO_DOCK_MULTI_MONITOR_ID = 'multi-monitor';

export default class MultiMonitorsExtension extends Extension {
	constructor(metadata) {
		super(metadata);
		this._settings = null;
		this._mu_settings = null;
		this._mmMonitors = 0;
		this._primaryIndex = -1;
		this._primaryDock = null;
		this.syncWorkspacesActualGeometry = null;

		this._switchOffThumbnailsMuId = null;
		this._showPanelId = null;
		this._thumbnailsSliderPositionId = null;
		this._relayoutId = null;
		this._prepareForSleepId = null;
		this._resumeFromSleepId = null;
		this._resumeSessionModeUpdatedId = null;
		this._mainPanelClipState = null;
		this._showDockId = null;
		this._dtdSettings = null;
		this._savedDockMultiMonitor = null;
		this._mainPanelEnsureIndicator = null;
		this._loginManager = null;
	}

	_getDashToDockSettings() {
		const schemaSource = Gio.SettingsSchemaSource.get_default();
		if (!schemaSource)
			return null;
		const schema = schemaSource.lookup(DASH_TO_DOCK_SCHEMA, true);
		if (!schema || !schema.has_key(DASH_TO_DOCK_MULTI_MONITOR_ID))
			return null;
		return new Gio.Settings({ settings_schema: schema });
	}

	_applyDashToDockMultiMonitor() {
		const enabled = this._settings.get_boolean('show-dock-on-extended-monitors');
		if (!this._dtdSettings)
			this._dtdSettings = this._getDashToDockSettings();

		if (!this._dtdSettings)
			return;

		if (enabled) {
			// Save original value only on first apply
			if (this._savedDockMultiMonitor === null)
				this._savedDockMultiMonitor = this._dtdSettings.get_boolean(DASH_TO_DOCK_MULTI_MONITOR_ID);
			this._dtdSettings.set_boolean(DASH_TO_DOCK_MULTI_MONITOR_ID, true);
		} else {
			// Restore original value if we previously saved one
			if (this._savedDockMultiMonitor !== null) {
				this._dtdSettings.set_boolean(DASH_TO_DOCK_MULTI_MONITOR_ID, this._savedDockMultiMonitor);
				this._savedDockMultiMonitor = null;
			}
		}
	}

	_restoreDashToDockMultiMonitor() {
		if (!this._dtdSettings || this._savedDockMultiMonitor === null)
			return;
		this._dtdSettings.set_boolean(DASH_TO_DOCK_MULTI_MONITOR_ID, this._savedDockMultiMonitor);
		this._savedDockMultiMonitor = null;
	}

	_applyMainPanelClipping() {
		if (this._mainPanelClipState)
			return;

		const actors = [
			Main.layoutManager?.panelBox,
			Main.panel,
			Main.panel?._leftBox,
			Main.panel?._centerBox,
			Main.panel?._rightBox,
		].filter(actor => actor);

		this._mainPanelClipState = actors.map(actor => ({
			actor,
			clipToAllocation: actor.clip_to_allocation,
		}));

		for (const actor of actors)
			actor.clip_to_allocation = true;
	}

	_restoreMainPanelClipping() {
		if (!this._mainPanelClipState)
			return;

		for (const state of this._mainPanelClipState) {
			state.actor.clip_to_allocation = state.clipToAllocation;
		}
		this._mainPanelClipState = null;
	}

	_showThumbnailsSlider() {


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

			return;
		}

		mmOverview = [];


		for (let idx = 0; idx < Main.layoutManager.monitors.length; idx++) {
			if (idx != Main.layoutManager.primaryIndex) {

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
		const primaryMonitor = Main.layoutManager.monitors[newPrimary];
		if (!primaryMonitor) {
			this._destroyPrimaryDock();
		} else if (this._primaryDock) {
			this._primaryDock.updateMonitor(primaryMonitor);
		} else {
			// The primary monitor already has GNOME's overview dash, but
			// needs its own desktop hover dock even with no external displays.
			this._primaryDock = new MMDock.MultiMonitorsDock(primaryMonitor,
				this._settings, { showInOverview: false });
		}
		if (this._mmMonitors !== newCount || this._primaryIndex !== newPrimary) {

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

	_destroyPrimaryDock() {
		this._primaryDock?.destroy();
		this._primaryDock = null;
	}

	enable() {
		this._mmMonitors = 0;
		this._primaryIndex = -1;

		this._settings = this.getSettings();
		this._mu_settings = new Gio.Settings({ schema: MUTTER_SCHEMA });
		this._applyMainPanelClipping();

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

		this._showDockId = this._settings.connect('changed::show-dock-on-extended-monitors',
			this._applyDashToDockMultiMonitor.bind(this));
		this._applyDashToDockMultiMonitor();

		mmPanel.length = 0;
		MMLayout.setMMPanelArrayRef(mmPanel);
		MMPanel.setMMPanelArrayRef(mmPanel);
		MMOverview.setMMPanelArrayRef(mmPanel);

		mmLayoutManager = new MMLayout.MultiMonitorsLayoutManager(this._settings);

		this._showPanelId = this._settings.connect('changed::' + MMLayout.SHOW_PANEL_ID, mmLayoutManager.showPanel.bind(mmLayoutManager));
		mmLayoutManager.showPanel();

		this._thumbnailsSliderPositionId = this._settings.connect('changed::' + THUMBNAILS_SLIDER_POSITION_ID, this._showThumbnailsSlider.bind(this));
		this._relayoutId = Main.layoutManager.connect('monitors-changed', this._relayout.bind(this));
		this._relayout();

		// Proactively tear down extra panels before suspend so the lock
		// screen on wake gets correct single-monitor geometry.
		this._loginManager = LoginManager.getLoginManager();
		this._prepareForSleepId = this._loginManager.connect('prepare-for-sleep',
			(mgr, aboutToSuspend) => {
				if (aboutToSuspend)
					this._onPrepareForSleep();
				else
					this._onResumeFromSleep();
			});


		if (!this._mainPanelEnsureIndicator)
			this._mainPanelEnsureIndicator = Main.panel._ensureIndicator;

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

	disable() {
		this._destroyPrimaryDock();
		// Unpatch screenshot UI
		ScreenshotPatch.unpatchScreenshotUI();

		if (this._prepareForSleepId) {
			this._loginManager.disconnect(this._prepareForSleepId);
			this._prepareForSleepId = null;
		}
		this._loginManager = null;

		if (this._resumeFromSleepId) {
			GLib.source_remove(this._resumeFromSleepId);
			this._resumeFromSleepId = null;
		}
		this._disconnectResumeSessionWatcher();

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

		if (this._showDockId) {
			this._settings.disconnect(this._showDockId);
			this._showDockId = null;
		}
		this._restoreDashToDockMultiMonitor();
		this._dtdSettings = null;

		if (this._showPanelId) {
			this._settings.disconnect(this._showPanelId);
			this._showPanelId = null;
		}

		if (this._thumbnailsSliderPositionId) {
			this._settings.disconnect(this._thumbnailsSliderPositionId);
			this._thumbnailsSliderPositionId = null;
		}

		this._restoreMainPanelClipping();

		if (mmLayoutManager) {
			mmLayoutManager.hidePanel();
			mmLayoutManager = null;
		}

		if (this._mainPanelEnsureIndicator) {
			Main.panel._ensureIndicator = this._mainPanelEnsureIndicator;
			this._mainPanelEnsureIndicator = null;
		}

		this._hideThumbnailsSlider();
		this._mmMonitors = 0;
		this._primaryIndex = -1;

		mmPanel.length = 0;

		this._settings = null;
		this._mu_settings = null;
	}


	/**
	 * Called just before the system suspends.  Tear down all extra-monitor
	 * chrome so GNOME Shell's layout regions are clean when the lock
	 * screen dialog is positioned on wake.
	 */
	_onPrepareForSleep() {
		this._destroyPrimaryDock();

		if (this._resumeFromSleepId) {
			GLib.source_remove(this._resumeFromSleepId);
			this._resumeFromSleepId = null;
		}
		this._disconnectResumeSessionWatcher();

		if (mmLayoutManager) {
			mmLayoutManager.hidePanel();
		}
		this._hideThumbnailsSlider();
		this._mmMonitors = 0;
		this._primaryIndex = -1;
		mmPanel.length = 0;
	}

	/**
	 * Called after wake.  Rebuild secondary-monitor chrome after GNOME Shell has
	 * restored monitor/workarea state, otherwise mirrored indicators can keep
	 * stale source/menu references from before suspend.
	 */
	_onResumeFromSleep() {

		this._queueResumeRebuild(1000);
	}

	_queueResumeRebuild(delayMs) {
		if (this._resumeFromSleepId)
			GLib.source_remove(this._resumeFromSleepId);

		this._resumeFromSleepId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
			this._resumeFromSleepId = null;

			if (!this._settings)
				return GLib.SOURCE_REMOVE;

			if (!this._isUserSessionActive()) {

				this._waitForUserSessionResume();
				return GLib.SOURCE_REMOVE;
			}

			if (!this._isOverviewIdle()) {

				this._queueResumeRebuild(500);
				return GLib.SOURCE_REMOVE;
			}

			this._disconnectResumeSessionWatcher();
			this._rebuildAfterResume();
			return GLib.SOURCE_REMOVE;
		});
	}

	_isUserSessionActive() {
		const sessionMode = Main.sessionMode;
		if (!sessionMode)
			return true;

		if (sessionMode.isLocked)
			return false;

		return !sessionMode.currentMode || sessionMode.currentMode === 'user';
	}

	_isOverviewIdle() {
		return !Main.overview?.visible && !Main.overview?.animationInProgress;
	}

	_waitForUserSessionResume() {
		if (this._resumeSessionModeUpdatedId)
			return;

		this._resumeSessionModeUpdatedId = Main.sessionMode.connect('updated', () => {
			if (!this._isUserSessionActive())
				return;

			this._disconnectResumeSessionWatcher();
			this._queueResumeRebuild(750);
		});
	}

	_disconnectResumeSessionWatcher() {
		if (!this._resumeSessionModeUpdatedId)
			return;

		Main.sessionMode.disconnect(this._resumeSessionModeUpdatedId);
		this._resumeSessionModeUpdatedId = null;
	}

	_rebuildAfterResume() {


		if (!mmLayoutManager) {
			mmLayoutManager = new MMLayout.MultiMonitorsLayoutManager(this._settings);

			if (this._showPanelId) {
				this._settings.disconnect(this._showPanelId);
				this._showPanelId = null;
			}
			this._showPanelId = this._settings.connect('changed::' + MMLayout.SHOW_PANEL_ID,
				mmLayoutManager.showPanel.bind(mmLayoutManager));
		} else {
			mmLayoutManager.hidePanel();
		}

		mmPanel.length = 0;
		MMLayout.setMMPanelArrayRef(mmPanel);
		MMPanel.setMMPanelArrayRef(mmPanel);
		MMOverview.setMMPanelArrayRef(mmPanel);

		mmLayoutManager.showPanel();
		this._hideThumbnailsSlider();
		this._mmMonitors = 0;
		this._primaryIndex = -1;
		this._relayout();
	}
}
