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

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ANIMATION_TIME} from 'resource:///org/gnome/shell/ui/overview.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ExtensionUtils from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as PanelModule from 'resource:///org/gnome/shell/ui/panel.js';
import * as DateMenu from 'resource:///org/gnome/shell/ui/dateMenu.js';

import * as MMLayout from './mmlayout.js';
import * as MMOverview from './mmoverview.js';
import * as MMIndicator from './indicator.js';
import * as Convenience from './convenience.js';
import * as MMPanel from './mmpanel.js';

const GNOME_SHELL_VERSION = Config.PACKAGE_VERSION.split('.');

const OVERRIDE_SCHEMA = 'org.gnome.shell.overrides';
const MUTTER_SCHEMA = 'org.gnome.mutter';
const WORKSPACES_ONLY_ON_PRIMARY_ID = 'workspaces-only-on-primary';

const SHOW_INDICATOR_ID = 'show-indicator';
const THUMBNAILS_SLIDER_POSITION_ID = 'thumbnails-slider-position';

// GNOME 46 compatibility: Patch add_actor method to use add_child
export function patchAddActorMethod(prototype) {
    if (!prototype.add_actor) {
        // Check if add_child exists (modern API)
        if (prototype.add_child) {
            prototype.add_actor = function(actor) {
                return this.add_child(actor);
            };
        } else {
            // Check parent prototype chain
            let parent = Object.getPrototypeOf(prototype);
            if (parent && parent.add_child) {
                prototype.add_actor = function(actor) {
                    return this.add_child(actor);
                };
            }
        }
    }
}

export function copyClass (s, d) {
//    console.log(s.name +" > "+ d.name);
	if (!s) {
		try {
			const dName = d?.name || '<unknown>';
			console.log(`Multi Monitors Add-On: source class undefined in copyClass; skipping copy for ${dName}`);
		} catch (e) {
			// ignore logging errors
		}
		return;
	}
    let propertyNames = Reflect.ownKeys(s.prototype);
    for (let pName of propertyNames.values()) {

//        console.log(" ) "+pName.toString());
        if (typeof pName === "symbol") continue;
        if (Object.prototype.hasOwnProperty.call(d.prototype, pName)) continue;
        if (pName === "prototype") continue;
        if (pName === "constructor") continue;
//        console.log(pName);
        let pDesc = Reflect.getOwnPropertyDescriptor(s.prototype, pName);
//        console.log(typeof pDesc);
        if (typeof pDesc !== 'object') continue;
        Reflect.defineProperty(d.prototype, pName, pDesc);
    }

    // Apply GNOME 46 compatibility patch
    patchAddActorMethod(d.prototype);
};

export function gnomeShellVersion() {
    return GNOME_SHELL_VERSION;
}

class MultiMonitorsAddOn {

    constructor() {
        this._settings = Convenience.getSettings();
//        this._ov_settings = new Gio.Settings({ schema: OVERRIDE_SCHEMA });
        this._mu_settings = new Gio.Settings({ schema: MUTTER_SCHEMA });

        this.mmIndicator = null;
        // Try to also set mmPanel on Main object for backwards compatibility
        // but use the exported mmPanel from this module as the primary reference
        try {
            if (!('mmPanel' in Main) && Object.isExtensible(Main)) {
                Object.defineProperty(Main, 'mmPanel', {
                    get() { return mmPanel; },
                    set(value) {
                        mmPanel.length = 0;
                        if (Array.isArray(value)) {
                            mmPanel.push(...value);
                        }
                    },
                    configurable: true
                });
                console.log('[Multi Monitors Add-On] Successfully set Main.mmPanel property');
            } else if (!Object.isExtensible(Main)) {
                console.log('[Multi Monitors Add-On] Main object is not extensible, using module export instead');
            }
        } catch (e) {
            console.log('[Multi Monitors Add-On] Could not set Main.mmPanel, using module export instead:', e);
        }

        // Try to set mmOverview on Main object for backwards compatibility
        try {
            if (!('mmOverview' in Main) && Object.isExtensible(Main)) {
                Object.defineProperty(Main, 'mmOverview', {
                    get() { return mmOverview; },
                    set(value) { mmOverview = value; },
                    configurable: true
                });
                console.log('[Multi Monitors Add-On] Successfully set Main.mmOverview property');
            } else if (!Object.isExtensible(Main)) {
                console.log('[Multi Monitors Add-On] Main object is not extensible, using module export instead');
            }
        } catch (e) {
            console.log('[Multi Monitors Add-On] Could not set Main.mmOverview, using module export instead:', e);
        }

        // Try to set mmLayoutManager on Main object for backwards compatibility
        try {
            if (!('mmLayoutManager' in Main) && Object.isExtensible(Main)) {
                Object.defineProperty(Main, 'mmLayoutManager', {
                    get() { return mmLayoutManager; },
                    set(value) { mmLayoutManager = value; },
                    configurable: true
                });
                console.log('[Multi Monitors Add-On] Successfully set Main.mmLayoutManager property');
            } else if (!Object.isExtensible(Main)) {
                console.log('[Multi Monitors Add-On] Main object is not extensible, using module export instead');
            }
        } catch (e) {
            console.log('[Multi Monitors Add-On] Could not set Main.mmLayoutManager, using module export instead:', e);
        }

        this._mmMonitors = 0;
        this.syncWorkspacesActualGeometry = null;
    }

    _showIndicator() {
		if(this._settings.get_boolean(SHOW_INDICATOR_ID)) {
			if(!this.mmIndicator) {
				this.mmIndicator = Main.panel.addToStatusArea('MultiMonitorsAddOn', new MMIndicator.MultiMonitorsIndicator());
			}
		}
		else {
			this._hideIndicator();
		}
    }

    _hideIndicator() {
		if(this.mmIndicator) {
			this.mmIndicator.destroy();
			this.mmIndicator = null;
		}
    }

    _showThumbnailsSlider() {
		if (this._settings.get_string(THUMBNAILS_SLIDER_POSITION_ID) === 'none') {
			this._hideThumbnailsSlider();
			return;
		}

//		if(this._ov_settings.get_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID))
//			this._ov_settings.set_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID, false);
		if(this._mu_settings.get_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID))
			this._mu_settings.set_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID, false);

		if (mmOverview)
			return;

		mmOverview = [];
		// Also update Main.mmOverview if the property was successfully set
		if ('mmOverview' in Main) {
			Main.mmOverview = mmOverview;
		}

	for (let idx = 0; idx < Main.layoutManager.monitors.length; idx++) {
		if (idx != Main.layoutManager.primaryIndex) {
			mmOverview[idx] = new MMOverview.MultiMonitorsOverview(idx);
		}
	}

	// Guard against missing searchController._workspacesDisplay in GNOME 46
	if (Main.overview.searchController && 
		Main.overview.searchController._workspacesDisplay &&
		Main.overview.searchController._workspacesDisplay._syncWorkspacesActualGeometry) {
		this.syncWorkspacesActualGeometry = Main.overview.searchController._workspacesDisplay._syncWorkspacesActualGeometry;
		Main.overview.searchController._workspacesDisplay._syncWorkspacesActualGeometry = function() {
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

			const mmOverviewRef = ('mmOverview' in Main) ? Main.mmOverview : mmOverview;
			if (mmOverviewRef) {
				for (let idx = 0; idx < mmOverviewRef.length; idx++) {
					if (!mmOverviewRef[idx])
						continue;
					if (!mmOverviewRef[idx]._overview)
						continue;
					const mmView = mmOverviewRef[idx]._overview._controls._workspacesViews;
					if (!mmView)
						continue;

					const mmGeometry = mmOverviewRef[idx].getWorkspacesActualGeometry();
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
        // Also update Main.mmOverview if the property was successfully set
        if ('mmOverview' in Main) {
            Main.mmOverview = null;
        }
        // Guard against missing searchController._workspacesDisplay in GNOME 46
        if (this.syncWorkspacesActualGeometry &&
            Main.overview.searchController &&
            Main.overview.searchController._workspacesDisplay) {
            Main.overview.searchController._workspacesDisplay._syncWorkspacesActualGeometry = this.syncWorkspacesActualGeometry;
        }
    }

    _relayout() {
		if(this._mmMonitors!=Main.layoutManager.monitors.length){
			this._mmMonitors = Main.layoutManager.monitors.length;
			console.log("pi:"+Main.layoutManager.primaryIndex);
			for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
				let monitor = Main.layoutManager.monitors[i];
					console.log("i:"+i+" x:"+monitor.x+" y:"+monitor.y+" w:"+monitor.width+" h:"+monitor.height);
			}
			this._hideThumbnailsSlider();
			this._showThumbnailsSlider();
		}
    }

    _switchOffThumbnails() {
		if (
//            this._ov_settings.get_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID) ||
            this._mu_settings.get_boolean(WORKSPACES_ONLY_ON_PRIMARY_ID))
        {
			this._settings.set_string(THUMBNAILS_SLIDER_POSITION_ID, 'none');
		}
    }

    enable(version) {
		console.log("Enable Multi Monitors Add-On ("+version+")...")
		
		if(Main.panel.statusArea.MultiMonitorsAddOn)
			disable();
		
		this._mmMonitors = 0;

//		this._switchOffThumbnailsOvId = this._ov_settings.connect('changed::'+WORKSPACES_ONLY_ON_PRIMARY_ID,
//																	this._switchOffThumbnails.bind(this));
		this._switchOffThumbnailsMuId = this._mu_settings.connect('changed::'+WORKSPACES_ONLY_ON_PRIMARY_ID,
																	this._switchOffThumbnails.bind(this));

		this._showIndicatorId = this._settings.connect('changed::'+SHOW_INDICATOR_ID, this._showIndicator.bind(this));
		this._showIndicator();

		mmLayoutManager = new MMLayout.MultiMonitorsLayoutManager();
		// Also update Main.mmLayoutManager if the property was successfully set
		if ('mmLayoutManager' in Main) {
			Main.mmLayoutManager = mmLayoutManager;
		}
		this._showPanelId = this._settings.connect('changed::'+MMLayout.SHOW_PANEL_ID, mmLayoutManager.showPanel.bind(mmLayoutManager));
		mmLayoutManager.showPanel();
		
		this._thumbnailsSliderPositionId = this._settings.connect('changed::'+THUMBNAILS_SLIDER_POSITION_ID, this._showThumbnailsSlider.bind(this));
		this._relayoutId = Main.layoutManager.connect('monitors-changed', this._relayout.bind(this));
		this._relayout();
    }

    disable() {
		Main.layoutManager.disconnect(this._relayoutId);
//		this._ov_settings.disconnect(this._switchOffThumbnailsOvId);
		this._mu_settings.disconnect(this._switchOffThumbnailsMuId);
		
		this._settings.disconnect(this._showPanelId);
		this._settings.disconnect(this._thumbnailsSliderPositionId);
		this._settings.disconnect(this._showIndicatorId);


		this._hideIndicator();

		if (mmLayoutManager) {
			mmLayoutManager.hidePanel();
		}
		mmLayoutManager = null;
		// Also update Main.mmLayoutManager if the property was successfully set
		if ('mmLayoutManager' in Main) {
			Main.mmLayoutManager = null;
		}

		this._hideThumbnailsSlider();
		this._mmMonitors = 0;

		console.log("Disable Multi Monitors Add-On ...")
    }
}

let multiMonitorsAddOn = null;
let version = null;

// Export mmPanel array so other modules can import and use it
// instead of trying to attach it to Main object
export let mmPanel = [];
export let mmOverview = null;
export let mmLayoutManager = null;

export function init() {
    Convenience.initTranslations();
	// Diagnostics: log shapes of key modules to help troubleshoot loader issues
	try {
		const hasLegacyExtUtils = !!(globalThis.imports && globalThis.imports.misc && globalThis.imports.misc.extensionUtils);
		const legacyHasGetCurrent = hasLegacyExtUtils && typeof globalThis.imports.misc.extensionUtils.getCurrentExtension === 'function';

		const extuKeys = Object.keys(ExtensionUtils ?? {});
		const panelKeys = Object.keys(PanelModule ?? {});
		const dateMenuKeys = Object.keys(DateMenu ?? {});

		const diag = {
			gnomeShellVersion: Config.PACKAGE_VERSION,
			ExtensionUtils: {
				typeof_getCurrentExtension: typeof (ExtensionUtils && ExtensionUtils.getCurrentExtension),
				keys: extuKeys.slice(0, 20),
			},
			LegacyExtensionUtils: {
				present: hasLegacyExtUtils,
				typeof_getCurrentExtension: legacyHasGetCurrent ? 'function' : typeof (globalThis.imports?.misc?.extensionUtils?.getCurrentExtension),
			},
			PanelModule: {
				has_PANEL_ITEM_IMPLEMENTATIONS: !!(PanelModule && PanelModule.PANEL_ITEM_IMPLEMENTATIONS),
				typeof_AppMenuButton: typeof (PanelModule && PanelModule.AppMenuButton),
				keys: panelKeys.slice(0, 20),
			},
			DateMenu: {
				typeof_DateMenuButton: typeof (DateMenu && DateMenu.DateMenuButton),
				has_EventsSection: !!(DateMenu && DateMenu.EventsSection),
				keys: dateMenuKeys.slice(0, 20),
			},
		};
		console.log(`[Multi Monitors Add-On] Diagnostics: ${JSON.stringify(diag)}`);
	} catch (e) {
		console.log(`[Multi Monitors Add-On] Diagnostics failed: ${e}`);
	}
}

export function enable() {
    if (multiMonitorsAddOn !== null)
        return;

    // Reset mmPanel array
    mmPanel.length = 0;

    // Set the mmPanel reference in other modules to avoid circular dependency issues
    MMLayout.setMMPanelArrayRef(mmPanel);
    MMPanel.setMMPanelArrayRef(mmPanel);
    MMOverview.setMMPanelArrayRef(mmPanel);

    // fix bug in panel: Destroy function many time added to this same indicator.
    Main.panel._ensureIndicator = function(role) {
        let indicator = this.statusArea[role];
        if (indicator) {
            indicator.container.show();
            return null;
        }
        else {
			let constructor = PanelModule.PANEL_ITEM_IMPLEMENTATIONS[role];
            if (!constructor) {
                // This icon is not implemented (this is a bug)
                return null;
            }
            indicator = new constructor(this);
            this.statusArea[role] = indicator;
        }
        return indicator;
    };

	const extension = Convenience.getCurrentExtension();
    const metaVersion = extension.metadata['version'];
    if (Number.isFinite(metaVersion)) {
        version = 'v'+Math.trunc(metaVersion);
        switch(Math.round((metaVersion%1)*10)) {
           case 0:
               break;
            case 1:
               version += '+bugfix';
               break;
            case 2:
               version += '+develop';
               break;
           default:
               version += '+modified';
                break;
        }
    }
    else
        version = metaVersion;

    multiMonitorsAddOn = new MultiMonitorsAddOn();
    multiMonitorsAddOn.enable(version);
}

export function disable() {
    if (multiMonitorsAddOn == null)
        return;

    multiMonitorsAddOn.disable();
    multiMonitorsAddOn = null;

    // Clear mmPanel array
    mmPanel.length = 0;
}

// Provide a default class export so GNOME's extension loader can instantiate
// the extension when it prefers a default-class style module. The class
// simply forwards lifecycle calls to the existing functions above.
export default class ExtensionEntryPoint extends Extension {
	constructor(metadata) {
		// Pass metadata to parent Extension so it can initialize correctly.
		super(metadata);
		// Store the extension object for use by convenience functions
		Convenience.setCurrentExtension(this);
	}

	init() {
		// reuse existing init function
		init();
	}

	enable() {
		// call enable if present
		enable();
	}

	disable() {
		disable();
	}
}
	// No default export: rely on exported `init`, `enable`, `disable` functions
	// so the extension loader uses the functional lifecycle instead of a
	// default-class constructor. This avoids loader-specific constructor
	// metadata handling differences.
