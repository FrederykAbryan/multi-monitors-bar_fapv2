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
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as ExtensionUtils from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Convenience from './convenience.js';

function getExtensionPath() {
	try {
		let ext = null;
		if (ExtensionUtils && typeof ExtensionUtils.getCurrentExtension === 'function')
			ext = ExtensionUtils.getCurrentExtension();
		else if (globalThis.imports?.misc?.extensionUtils?.getCurrentExtension)
			ext = globalThis.imports.misc.extensionUtils.getCurrentExtension();
		return ext?.path ?? '';
	} catch (e) {
		return '';
	}
}

export const MultiMonitorsIndicator = GObject.registerClass(
class MultiMonitorsIndicator extends PanelMenu.Button {
	_init() {
		super._init(0.0, "MultiMonitorsAddOn", false);

		Convenience.initTranslations();

		this.text = null;
		this._mmStatusIcon = new St.BoxLayout({ style_class: 'multimonitor-status-indicators-box' });
		this._mmStatusIcon.hide();
		this.add_child(this._mmStatusIcon);
		this._leftRightIcon = true;
		this._viewMonitorsId = Main.layoutManager.connect('monitors-changed', this._viewMonitors.bind(this));
		this._viewMonitors();
	}

	_onDestroy() {
		Main.layoutManager.disconnect(this._viewMonitorsId);
		super._onDestroy();
	}

    _syncIndicatorsVisible() {
        this._mmStatusIcon.visible = this._mmStatusIcon.get_children().some(a => a.visible);
    }

	_icon_name (icon, iconName) {
		const path = getExtensionPath();
		icon.set_gicon(Gio.icon_new_for_string(`${path}/icons/${iconName}.svg`));
	}

	_viewMonitors() {
		let monitors = this._mmStatusIcon.get_children();

		let monitorChange = Main.layoutManager.monitors.length - monitors.length;
		if(monitorChange>0){
			console.log("Add Monitors ...");
			for(let idx = 0; idx<monitorChange; idx++){
				let icon;
				icon = new St.Icon({style_class: 'system-status-icon multimonitor-status-icon'});
				this._mmStatusIcon.add_child(icon);
				icon.connect('notify::visible', this._syncIndicatorsVisible.bind(this));

				if (this._leftRightIcon)
					this._icon_name(icon, 'multi-monitors-l-symbolic');
				else
					this._icon_name(icon, 'multi-monitors-r-symbolic');
				this._leftRightIcon = !this._leftRightIcon;
			}
			this._syncIndicatorsVisible();
		}
		else if(monitorChange<0){
			console.log("Remove Monitors ...");
			monitorChange = -monitorChange;

			for(let idx = 0; idx<monitorChange; idx++){
				let icon = this._mmStatusIcon.get_last_child();
				this._mmStatusIcon.remove_child(icon);
				icon.destroy();
				this._leftRightIcon = !this._leftRightIcon;
			}
		}
	}

	_onPreferences() {
		const uuid = "multi-monitors-bar@frederykabryan";
		Gio.DBus.session.call(
			'org.gnome.Shell.Extensions',
			'/org/gnome/Shell/Extensions',
			'org.gnome.Shell.Extensions',
			'OpenExtensionPrefs',
			new GLib.Variant('(ssa{sv})', [uuid, '', {}]),
			null,
			Gio.DBusCallFlags.NONE,
			-1,
			null);
	}
});
