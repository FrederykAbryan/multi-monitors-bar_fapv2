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

import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SHOW_PANEL_ID = 'show-panel';
const SHOW_ACTIVITIES_ID = 'show-activities';
const SHOW_APP_MENU_ID = 'show-app-menu';
const SHOW_DATE_TIME_ID = 'show-date-time';
const THUMBNAILS_SLIDER_POSITION_ID = 'thumbnails-slider-position';
const ENABLE_HOT_CORNERS = 'enable-hot-corners';
const SCREENSHOT_ON_ALL_MONITORS_ID = 'screenshot-on-all-monitors';
const FORCE_WORKSPACES_ON_ALL_DISPLAYS_ID = 'force-workspaces-on-all-displays';
const SHOW_OVERVIEW_ON_EXTENDED_MONITORS_ID = 'show-overview-on-extended-monitors';
const PANEL_COLOR_ID = 'panel-color';


class MultiMonitorsPrefsWidget extends Gtk.Grid {
    _init(settings, desktopSettings) {
        super._init({
            margin_top: 6, margin_end: 6, margin_bottom: 6, margin_start: 6
        });

        this._numRows = 0;

        this.set_orientation(Gtk.Orientation.VERTICAL);

        this._settings = settings;
        this._desktopSettings = desktopSettings;

        this._display = Gdk.Display.get_default();
        this._monitors = this._display.get_monitors()

        this._addBooleanSwitch(_('Show Panel on additional monitors.'), SHOW_PANEL_ID);
        this._addBooleanSwitch(_('Show Activities-Button on additional monitors.'), SHOW_ACTIVITIES_ID);
        this._addBooleanSwitch(_('Show AppMenu-Button on additional monitors.'), SHOW_APP_MENU_ID);
        this._addBooleanSwitch(_('Show DateTime-Button on additional monitors.'), SHOW_DATE_TIME_ID);
        this._addComboBoxSwitch(_('Show Thumbnails-Slider on additional monitors.'), THUMBNAILS_SLIDER_POSITION_ID, {
            none: _('No'),
            right: _('On the right'),
            left: _('On the left'),
            auto: _('Auto')
        });
        this._addSettingsBooleanSwitch(_('Enable hot corners.'), this._desktopSettings, ENABLE_HOT_CORNERS);
        this._addBooleanSwitch(_('Show screenshot tools on all monitors.'), SCREENSHOT_ON_ALL_MONITORS_ID);
        this._addBooleanSwitch(_('Force workspaces on all displays.'), FORCE_WORKSPACES_ON_ALL_DISPLAYS_ID);
        this._addBooleanSwitch(_('Show App Grid and Search on extended monitors.'), SHOW_OVERVIEW_ON_EXTENDED_MONITORS_ID);

        this._addColorPicker(_('Panel color on additional monitors.'), PANEL_COLOR_ID);
    }

    add(child) {
        this.attach(child, 0, this._numRows++, 1, 1);
    }

    _addComboBoxSwitch(label, schema_id, options) {
        this._addSettingsComboBoxSwitch(label, this._settings, schema_id, options)
    }

    _addSettingsComboBoxSwitch(label, settings, schema_id, options) {
        let gHBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            margin_top: 10, margin_end: 10, margin_bottom: 10, margin_start: 10,
            spacing: 20, hexpand: true
        });
        let gLabel = new Gtk.Label({ label: _(label), halign: Gtk.Align.START });
        gHBox.append(gLabel);

        let gCBox = new Gtk.ComboBoxText({ halign: Gtk.Align.END });
        Object.entries(options).forEach(function (entry) {
            const [key, val] = entry;
            gCBox.append(key, val);
        });
        gHBox.append(gCBox);

        this.add(gHBox);

        settings.bind(schema_id, gCBox, 'active-id', Gio.SettingsBindFlags.DEFAULT);
    }

    _addBooleanSwitch(label, schema_id) {
        this._addSettingsBooleanSwitch(label, this._settings, schema_id);
    }

    _addSettingsBooleanSwitch(label, settings, schema_id) {
        let gHBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            margin_top: 10, margin_end: 10, margin_bottom: 10, margin_start: 10,
            spacing: 20, hexpand: true
        });
        let gLabel = new Gtk.Label({ label: _(label), halign: Gtk.Align.START });
        gHBox.append(gLabel);
        let gSwitch = new Gtk.Switch({ halign: Gtk.Align.END });
        gHBox.append(gSwitch);
        this.add(gHBox);

        settings.bind(schema_id, gSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
    }

    _addColorPicker(label, schema_id) {
        let gHBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            margin_top: 10, margin_end: 10, margin_bottom: 10, margin_start: 10,
            spacing: 20, hexpand: true
        });
        let gLabel = new Gtk.Label({ label: _(label), halign: Gtk.Align.START, hexpand: true });
        gHBox.append(gLabel);

        let colorBtn = new Gtk.ColorButton({
            halign: Gtk.Align.END,
            use_alpha: true,
            title: _(label)
        });

        // Load saved color
        let savedColor = this._settings.get_string(schema_id);
        if (savedColor && savedColor !== '') {
            let rgba = new Gdk.RGBA();
            rgba.parse(savedColor);
            colorBtn.set_rgba(rgba);
        } else {
            // Default: transparent (use system theme)
            let rgba = new Gdk.RGBA();
            rgba.parse('rgba(0,0,0,0)');
            colorBtn.set_rgba(rgba);
        }

        colorBtn.connect('color-set', () => {
            let rgba = colorBtn.get_rgba();
            this._settings.set_string(schema_id, rgba.to_string());
        });

        gHBox.append(colorBtn);

        // Reset button to clear custom color
        let resetBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: _('Reset to default theme color'),
            halign: Gtk.Align.END
        });
        resetBtn.connect('clicked', () => {
            this._settings.set_string(schema_id, '');
            let rgba = new Gdk.RGBA();
            rgba.parse('rgba(0,0,0,0)');
            colorBtn.set_rgba(rgba);
        });
        gHBox.append(resetBtn);

        this.add(gHBox);
    }
}

const MultiMonitorsPrefsWidgetGObject = GObject.registerClass(MultiMonitorsPrefsWidget);

export default class MultiMonitorsExtensionPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const desktopSettings = new Gio.Settings({ schema: "org.gnome.desktop.interface" });

        const widget = new MultiMonitorsPrefsWidgetGObject(settings, desktopSettings);

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        group.add(widget);
        page.add(group);
        window.add(page);
    }
}
