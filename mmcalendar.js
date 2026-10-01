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
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import GnomeDesktop from 'gi://GnomeDesktop';
import Pango from 'gi://Pango';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import * as DateMenu from 'resource:///org/gnome/shell/ui/dateMenu.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as ExtensionUtils from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as MultiMonitors from './extension.js';
import * as Common from './common.js';
import { shellVersion } from './common.js';

export let MainRef = null;
export function setMainRef(m) { MainRef = m; }

// TodayButton is not exported in GNOME Shell 46, so we need to implement our own
// Based on the upstream DateMenu.TodayButton implementation
const MultiMonitorsTodayButton = GObject.registerClass(
    class MultiMonitorsTodayButton extends St.Button {
        _init(calendar) {
            super._init({
                style_class: 'datemenu-today-button',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                can_focus: true,
            });

            let hbox = new St.BoxLayout({ vertical: true });
            this.add_child(hbox);

            this._dayLabel = new St.Label({
                style_class: 'day-label',
                x_align: Clutter.ActorAlign.START,
            });
            hbox.add_child(this._dayLabel);

            this._dateLabel = new St.Label({ style_class: 'date-label' });
            hbox.add_child(this._dateLabel);

            this._calendar = calendar;
            this._selectedDateChangedId = this._calendar.connect('selected-date-changed', (_calendar, datetime) => {
                // Make the button reactive only if the selected date is not the
                // current date.
                this.reactive = !DateMenu._isToday(DateMenu._gDateTimeToDate(datetime));
            });
        }

        vfunc_clicked() {
            this._calendar.setDate(new Date(), false);
        }

        setDate(date) {
            // Use Intl.DateTimeFormat (available in GJS 1.68+/GNOME 40+)
            const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
            const longDateFmt = new Intl.DateTimeFormat(undefined, {
                year: 'numeric', month: 'long', day: 'numeric'
            });
            const dayText = weekdayFmt.format(date);
            const dateText = longDateFmt.format(date);
            this._dayLabel.set_text(dayText);
            this._dateLabel.set_text(dateText);
            this.accessible_name = `${dayText} ${dateText}`;
        }

        destroy() {
            if (this._calendar && this._selectedDateChangedId) {
                this._calendar.disconnect(this._selectedDateChangedId);
                this._selectedDateChangedId = 0;
            }

            super.destroy();
        }
    });

// Calendar.DoNotDisturbSwitch is const, so not exported. Either
// <https://gjs.guide/guides/gobject/subclassing.html#gtypename> is untrue, or
// GObject.type_from_name() is broken, so we can't get its constructor via GI
// either. Luckily it's a short class, so we can copy & paste.
const MultiMonitorsDoNotDisturbSwitch = GObject.registerClass(
    class MultiMonitorsDoNotDisturbSwitch extends PopupMenu.Switch {
        _init() {
            this._settings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.notifications',
            });

            super._init(this._settings.get_boolean('show-banners'));

            this._settings.bind('show-banners',
                this, 'state',
                Gio.SettingsBindFlags.INVERT_BOOLEAN);

            this.connect('destroy', () => {
                this._settings = null;
            });
        }
    });

// Calendar.Placeholder is not exported in GNOME Shell 46+, so we need to implement our own
// Based on the upstream Calendar.Placeholder implementation
const MultiMonitorsPlaceholder = GObject.registerClass(
    class MultiMonitorsPlaceholder extends St.BoxLayout {
        _init() {
            super._init({
                style_class: 'message-list-placeholder',
                vertical: true,
            });
            this._date = new Date();

            this._icon = new St.Icon({ icon_name: 'no-notifications-symbolic' });
            this.add_child(this._icon);

            this._label = new St.Label({ text: _('No Notifications') });
            this.add_child(this._label);
        }
    });

const MultiMonitorsCalendar = Calendar.Calendar;

var MultiMonitorsEventsSection = (() => {
    let MultiMonitorsEventsSection = class MultiMonitorsEventsSection extends St.Button {
        _init() {
            super._init({
                style_class: 'events-button',
                can_focus: true,
                x_expand: true,
                child: new St.BoxLayout({
                    style_class: 'events-box',
                    vertical: true,
                    x_expand: true,
                }),
            });

            this._startDate = null;
            this._endDate = null;

            this._eventSource = null;
            this._calendarApp = null;

            this._title = new St.Label({
                style_class: 'events-title',
            });
            this.child.add_child(this._title);

            this._eventsList = new St.BoxLayout({
                style_class: 'events-list',
                vertical: true,
                x_expand: true,
            });
            this.child.add_child(this._eventsList);

            this._appSys = Shell.AppSystem.get_default();
            this._appInstalledChangedId = this._appSys.connect('installed-changed',
                this._appInstalledChanged.bind(this));
            this._appInstalledChanged();

            this._appInstalledChanged();
        }

        destroy() {
            this._appSys.disconnect(this._appInstalledChangedId);
            super.destroy();
        }

        _appInstalledChanged() {
            // Fallback implementation when base class doesn't provide it
            // This method checks for calendar app availability
            this._calendarApp = this._appSys.lookup_app('org.gnome.Calendar.desktop') ||
                this._appSys.lookup_app('evolution.desktop') ||
                this._appSys.lookup_app('gnome-calendar.desktop');

            // If we have a calendar app, we could set up event source here
            // For now, just update visibility based on app availability
            if (this._calendarApp) {
                this.visible = true;
            }
        }

        setEventSource(eventSource) {
            // Fallback implementation of setEventSource
            // This method is called by upstream DateMenuButton code
            this._eventSource = eventSource;
        }

        setDate(date) {
            // Fallback implementation of setDate
            // This method is called when the calendar date changes
            this._startDate = date;
        }
    };

    const EventsBase = DateMenu.EventsSection ?? null;
    if (EventsBase) {
        Common.copyClass(EventsBase, MultiMonitorsEventsSection);
    }
    // If EventsBase is null, we already have fallback implementations of
    // setEventSource and setDate in the class definition above

    return GObject.registerClass(MultiMonitorsEventsSection);
})();

var MultiMonitorsNotificationSection = (() => {
    // Check if MessageListSection is available, otherwise use St.Widget as base
    // MessageListSection is available in GNOME 40+, use version check
    const BaseClass = (shellVersion >= 40 && MessageList.MessageListSection)
        ? MessageList.MessageListSection
        : St.Widget;

    let MultiMonitorsNotificationSection = class MultiMonitorsNotificationSection extends BaseClass {
        _init() {
            super._init();

            this._sources = new Map();
            this._nUrgent = 0;

            this._sourceAddedId = MainRef.messageTray.connect('source-added', this._sourceAdded.bind(this));
            MainRef.messageTray.getSources().forEach(source => {
                this._sourceAdded(MainRef.messageTray, source);
            });
        }

        destroy() {
            MainRef.messageTray.disconnect(this._sourceAddedId);
            let source, obj;
            for ([source, obj] of this._sources.entries()) {
                this._onSourceDestroy(source, obj);
            }
            super.destroy();
        }

        _sourceAdded(tray, source) {
            // Fallback stub if not copied from upstream
            // This is a minimal no-op to prevent crashes
        }

        _onSourceDestroy(source, obj) {
            // Fallback stub if not copied from upstream
            // This is a minimal no-op to prevent crashes
            this._sources.delete(source);
        }
    };

    if (Calendar.NotificationSection)
        Common.copyClass(Calendar.NotificationSection, MultiMonitorsNotificationSection);
    return GObject.registerClass(MultiMonitorsNotificationSection);
})();

var MultiMonitorsCalendarMessageList = (() => {
    let MultiMonitorsCalendarMessageList = class MultiMonitorsCalendarMessageList extends St.Widget {
        // _init will be defined after copyClass
        _initCustom() {
            super._init({
                style_class: 'message-list',
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                y_expand: true,
            });

            this._sessionModeUpdatedId = 0;

            this._placeholder = new MultiMonitorsPlaceholder();
            this.add_child(this._placeholder);

            let box = new St.BoxLayout({
                vertical: true,
                x_expand: true, y_expand: true
            });
            this.add_child(box);

            this._scrollView = new St.ScrollView({
                style_class: 'vfade',
                overlay_scrollbars: true,
                x_expand: true, y_expand: true,
            });
            this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
            box.add_child(this._scrollView);

            let hbox = new St.BoxLayout({ style_class: 'message-list-controls' });
            box.add_child(hbox);

            const dndLabel = new St.Label({
                text: _('Do Not Disturb'),
                y_align: Clutter.ActorAlign.CENTER,
            });
            hbox.add_child(dndLabel);

            this._dndSwitch = new MultiMonitorsDoNotDisturbSwitch();
            this._dndButton = new St.Button({
                can_focus: true,
                toggle_mode: true,
                child: this._dndSwitch,
                label_actor: dndLabel,
            });

            this._dndSwitch.bind_property('state',
                this._dndButton, 'checked',
                GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE);

            hbox.add_child(this._dndButton);

            this._clearButton = new St.Button({
                style_class: 'message-list-clear-button button',
                label: _('Clear'),
                can_focus: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
            });
            this._clearButton.connect('clicked', () => {
                this._sectionList.get_children().forEach(s => s.clear());
            });
            hbox.add_child(this._clearButton);

            this._placeholder.bind_property('visible',
                this._clearButton, 'visible',
                GObject.BindingFlags.INVERT_BOOLEAN);

            this._sectionList = new St.BoxLayout({
                style_class: 'message-list-sections',
                vertical: true,
                x_expand: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.START
            });
            // Note: St.BoxLayout doesn't have child-added/child-removed signals
            // _sync is called via session mode updates instead
            this._scrollView.add_child(this._sectionList);

            this._notificationSection = new MultiMonitorsNotificationSection();
            this._addSection(this._notificationSection);

            this._sessionModeUpdatedId = MainRef.sessionMode.connect('updated', this._sync.bind(this));
        }

        destroy() {
            MainRef.sessionMode.disconnect(this._sessionModeUpdatedId);
            this._sessionModeUpdatedId = 0;
            super.destroy();
        }

        _sync() {
            if (this._sessionModeUpdatedId === 0) return;
            // Skip calling parent _sync to avoid add_actor issues
            // Calendar.CalendarMessageList.prototype._sync.call(this);
            let sections = this._sectionList.get_children();
            let empty = sections.every(s => s.empty || !s.visible);
            this._placeholder.visible = empty;
        }
    };

    if (Calendar.CalendarMessageList)
        Common.copyClass(Calendar.CalendarMessageList, MultiMonitorsCalendarMessageList);

    // Override _init AFTER copyClass to avoid signal connection issues with St.BoxLayout
    MultiMonitorsCalendarMessageList.prototype._init = MultiMonitorsCalendarMessageList.prototype._initCustom;

    // Override _addSection AFTER copyClass to ensure our implementation is used
    // This avoids Calendar.Placeholder constructor issues
    MultiMonitorsCalendarMessageList.prototype._addSection = function (section) {
        this._sectionList.add_child(section);
        section.connect('notify::empty', this._sync.bind(this));
        section.connect('notify::visible', this._sync.bind(this));
        section.connect('destroy', () => {
            this._sectionList.remove_child(section);
            this._sync();
        });
    };

    let RegisteredClass = GObject.registerClass(MultiMonitorsCalendarMessageList);
    // Apply GNOME 46 compatibility after registration
    Common.patchAddActorMethod(RegisteredClass.prototype);

    // Wrap _sectionList to prevent 'actor-added' signal connections
    // This is a workaround for inherited methods that try to connect to signals
    // that don't exist on St.BoxLayout
    const originalInit = RegisteredClass.prototype._init;
    RegisteredClass.prototype._init = function () {
        originalInit.call(this);
        // Wrap the _sectionList's connect method to ignore 'actor-added' and 'actor-removed'
        if (this._sectionList) {
            const originalConnect = this._sectionList.connect.bind(this._sectionList);
            this._sectionList.connect = function (signal, callback) {
                if (signal === 'actor-added' || signal === 'actor-removed' ||
                    signal === 'child-added' || signal === 'child-removed') {
                    // Silently ignore these signals as St.BoxLayout doesn't have them
                    return 0;
                }
                return originalConnect(signal, callback);
            };
        }
    };

    return RegisteredClass;
})();

var MultiMonitorsMessagesIndicator = (() => {
    let MultiMonitorsMessagesIndicator = class MultiMonitorsMessagesIndicator extends St.Icon {
        _init() {
            super._init({
                icon_size: 16,
                visible: false,
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._sources = [];
            this._count = 0;

            this._settings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.notifications',
            });

            // _sync may be provided by copying the upstream DateMenu.MessagesIndicator
            // prototype. Guard against missing _sync to avoid runtime TypeErrors on
            // systems where the upstream class isn't present or doesn't export it.
            if (this._sync) {
                this._settings.connect('changed::show-banners', this._sync.bind(this));
            }

            this._sourceAddedId = MainRef.messageTray.connect('source-added', this._onSourceAdded.bind(this));
            this._sourceRemovedId = MainRef.messageTray.connect('source-removed', this._onSourceRemoved.bind(this));
            this._queueChangedId = MainRef.messageTray.connect('queue-changed', this._updateCount.bind(this));

            let sources = MainRef.messageTray.getSources();
            sources.forEach(source => this._onSourceAdded(null, source));

            // Call _sync only if it's available (copied from upstream).
            if (this._sync) {
                this._sync();
            } else {
                // Fallback: update visibility using our local implementation
                this._updateVisibility();
            }

            this.connect('destroy', () => {
                this._settings = null;
                MainRef.messageTray.disconnect(this._sourceAddedId);
                MainRef.messageTray.disconnect(this._sourceRemovedId);
                MainRef.messageTray.disconnect(this._queueChangedId);

                // Clean up all source connections
                if (this._sourceConnections) {
                    for (const [source, { notifAddedId, notifRemovedId }] of this._sourceConnections.entries()) {
                        if (notifAddedId) source.disconnect(notifAddedId);
                        if (notifRemovedId) source.disconnect(notifRemovedId);
                    }
                    this._sourceConnections.clear();
                }
            });
        }

        _onSourceAdded(tray, source) {
            // Fallback stub if not copied from upstream
            if (!this._sources) return;

            if (this._sources.indexOf(source) >= 0)
                return;

            this._sources.push(source);
            // GNOME 46+ removed 'count-updated' signal. Instead, track notification count changes
            // by connecting to the source's notification-added and notification-removed signals
            if (source.connect) {
                // Try to connect to notification signals if available
                let notifAddedId = source.connect('notification-added', this._updateCount.bind(this));
                let notifRemovedId = source.connect('notification-removed', this._updateCount.bind(this));

                // Store connection IDs for cleanup
                if (!this._sourceConnections) {
                    this._sourceConnections = new Map();
                }
                this._sourceConnections.set(source, { notifAddedId, notifRemovedId });
            }
            this._updateCount();
        }

        _onSourceRemoved(tray, source) {
            // Fallback stub if not copied from upstream
            if (!this._sources) return;

            let index = this._sources.indexOf(source);
            if (index >= 0) {
                // Clean up connections if they exist
                if (this._sourceConnections && this._sourceConnections.has(source)) {
                    const { notifAddedId, notifRemovedId } = this._sourceConnections.get(source);
                    if (notifAddedId) source.disconnect(notifAddedId);
                    if (notifRemovedId) source.disconnect(notifRemovedId);
                    this._sourceConnections.delete(source);
                }
                this._sources.splice(index, 1);
                this._updateCount();
            }
        }

        _updateCount() {
            // Fallback stub if not copied from upstream
            if (!this._sources) {
                this._count = 0;
                this._updateVisibility();
                return;
            }

            this._count = this._sources.reduce((count, source) => {
                return count + source.unseenCount;
            }, 0);

            this._updateVisibility();
        }

        _updateVisibility() {
            // Fallback stub if not copied from upstream
            if (!this._settings) {
                this.visible = this._count > 0;
                return;
            }

            const dndEnabled = !this._settings.get_boolean('show-banners');
            this.visible = this._count > 0 || dndEnabled;

            if (this.visible) {
                this.icon_name = dndEnabled ? 'notifications-disabled-symbolic'
                    : 'message-indicator-symbolic';
            }
        }
    };

    // Copy upstream methods FIRST, then register
    if (DateMenu.MessagesIndicator)
        Common.copyClass(DateMenu.MessagesIndicator, MultiMonitorsMessagesIndicator);
    return GObject.registerClass(MultiMonitorsMessagesIndicator);
})();

var MultiMonitorsDateMenuButton = (() => {
    const BaseDateMenuButton = DateMenu.DateMenuButton ?? PanelMenu.Button;

    let MultiMonitorsDateMenuButton = class MultiMonitorsDateMenuButton extends BaseDateMenuButton {
        _init(panel = null) {
            // Upstream's date menu is built once and lives as long as the session,
            // so it never disconnects from the shell singletons or from its
            // calendar event source. Our copies are destroyed on every monitor
            // change, so record what super._init() wires up and drop it again in
            // _onDestroy().
            this._mmGlobalSignals = [];
            this._mmEventSourceIds = [];

            if (DateMenu.DateMenuButton) {
                this._mmTrackClockConnections(() =>
                    this._mmTrackSingletonSignals(() => super._init()));
                this._panel = panel;
                this._syncMultiMonitorPanelStyle();
                return;
            }

            let hbox;
            let vbox;

            super._init(0.5);

            this._clockDisplay = new St.Label({
                style_class: 'clock',
                y_align: Clutter.ActorAlign.CENTER
            });
            this._clockDisplay.clutter_text.y_align = Clutter.ActorAlign.CENTER;
            this._clockDisplay.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

            this._indicator = new MultiMonitorsMessagesIndicator();

            const indicatorPad = new St.Widget();
            this._indicator.bind_property('visible',
                indicatorPad, 'visible',
                GObject.BindingFlags.SYNC_CREATE);
            indicatorPad.add_constraint(new Clutter.BindConstraint({
                source: this._indicator,
                coordinate: Clutter.BindCoordinate.SIZE,
            }));

            let box = new St.BoxLayout({
                style_class: 'clock-display-box',
                visible: true
            });
            box.add_child(indicatorPad);
            box.add_child(this._clockDisplay);
            box.add_child(this._indicator);

            this.label_actor = this._clockDisplay;
            this.add_child(box);
            // Ensure our button and label use the same style classes as the main panel
            // Button should look like a normal panel button; label should have clock-display
            this.add_style_class_name('panel-button');
            if (this._clockDisplay && this._clockDisplay.add_style_class_name)
                this._clockDisplay.add_style_class_name('clock-display');
            // Copy style classes from the main dateMenu when available for visual parity
            const mainBtn = (MainRef && MainRef.panel && MainRef.panel.statusArea)
                ? MainRef.panel.statusArea.dateMenu : null;
            if (mainBtn) {
                if (mainBtn.get_style_class_name && this.set_style_class_name) {
                    const btnCls = mainBtn.get_style_class_name();
                    if (btnCls)
                        this.set_style_class_name(btnCls);
                }
                const mainMenuBox = mainBtn.menu ? mainBtn.menu.box : null;
                if (mainMenuBox && mainMenuBox.get_style_class_name && this.menu && this.menu.box && this.menu.box.set_style_class_name) {
                    const menuCls = mainMenuBox.get_style_class_name();
                    if (menuCls)
                        this.menu.box.set_style_class_name(menuCls);
                }
            }

            // Force visibility
            this.visible = true;
            this.show();
            box.show();
            this._clockDisplay.show();


            // FreezableBinLayout was added in GNOME 40
            let layout;
            if (shellVersion >= 40 && DateMenu.FreezableBinLayout) {
                layout = new DateMenu.FreezableBinLayout();
            } else {
                layout = new Clutter.BinLayout();
                Object.defineProperty(layout, 'frozen', {
                    configurable: true,
                    enumerable: false,
                    get() { return false; },
                    set(_) { /* noop */ },
                });
            }

            let bin = new St.Widget({ layout_manager: layout });
            // For some minimal compatibility with PopupMenuItem
            bin._delegate = this;
            this.menu.box.add_child(bin);

            hbox = new St.BoxLayout({ name: 'calendarArea' });
            bin.add_child(hbox);

            this._calendar = new MultiMonitorsCalendar();
            this._calendar.connect('selected-date-changed', (_calendar, datetime) => {
                let date = DateMenu._gDateTimeToDate(datetime);
                layout.frozen = !DateMenu._isToday(date);
                this._eventsItem.setDate(date);
            });
            this._date = new MultiMonitorsTodayButton(this._calendar);

            this.menu.connect('open-state-changed', (menu, isOpen) => {
                // Whenever the menu is opened, select today
                if (isOpen) {
                    let now = new Date();
                    this._calendar.setDate(now);
                    this._date.setDate(now);
                    this._eventsItem.setDate(now);
                }
            });

            // Fill up the first column
            this._messageList = new MultiMonitorsCalendarMessageList();
            hbox.add_child(this._messageList);

            // Fill up the second column
            const boxLayout = new Clutter.BoxLayout({ orientation: Clutter.Orientation.VERTICAL });
            vbox = new St.Widget({
                style_class: 'datemenu-calendar-column',
                layout_manager: boxLayout
            });
            hbox.add_child(vbox);

            vbox.add_child(this._date);
            vbox.add_child(this._calendar);

            this._displaysSection = new St.ScrollView({
                style_class: 'datemenu-displays-section vfade',
                x_expand: true,
                overlay_scrollbars: true
            });
            this._displaysSection.set_policy(St.PolicyType.NEVER, St.PolicyType.EXTERNAL);
            vbox.add_child(this._displaysSection);

            let displaysBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'datemenu-displays-box'
            });
            this._displaysSection.add_child(displaysBox);

            // World clocks section
            if (DateMenu.WorldClocksSection) {
                this._clocksItem = new DateMenu.WorldClocksSection();
                displaysBox.add_child(this._clocksItem);
            }

            // Weather section
            if (DateMenu.WeatherSection) {
                this._weatherItem = new DateMenu.WeatherSection();
                displaysBox.add_child(this._weatherItem);
            }

            this._eventsItem = new MultiMonitorsEventsSection();
            displaysBox.add_child(this._eventsItem);

            // Use the local menu (built above) so the popup opens on the external monitor.
            // We intentionally do NOT open the main panel's date menu here to avoid it
            // appearing on the primary monitor.

            this._clock = new GnomeDesktop.WallClock();
            this._clockBinding = this._clock.bind_property('clock', this._clockDisplay, 'text', GObject.BindingFlags.SYNC_CREATE);
            this._clockNotifyTimezoneId = this._clock.connect('notify::timezone', this._updateTimeZone.bind(this));

            this._sessionModeUpdatedId = MainRef.sessionMode.connect('updated', this._sessionUpdated.bind(this));
            this._sessionUpdated();
            this._panel = panel;
            this._syncMultiMonitorPanelStyle();
        }

        _syncMultiMonitorPanelStyle() {
            this.y_expand = true;
            this.y_align = Clutter.ActorAlign.FILL;

            if (this.container) {
                this.container.y_expand = true;
                this.container.y_align = Clutter.ActorAlign.FILL;
            }

            for (const item of [this._eventsItem, this._clocksItem, this._weatherItem]) {
                if (!item || item._mmCloseDateMenuId)
                    continue;

                item._mmCloseDateMenuId = item.connect('clicked', () => {
                    this.menu?.close();
                });
            }
        }

        _mmTrackSingletonSignals(callback) {
            // Shell-wide objects upstream connects to with a plain connect() and
            // never disconnects from: Main.sessionMode 'updated' (DateMenuButton),
            // Main.messageTray 'source-added'/'source-removed'/'queue-changed'
            // (MessagesIndicator) and Shell.AppSystem 'installed-changed'
            // (EventsSection, WorldClocksSection).
            const singletons = [];
            if (MainRef?.sessionMode)
                singletons.push(MainRef.sessionMode);
            if (MainRef?.messageTray)
                singletons.push(MainRef.messageTray);
            singletons.push(Shell.AppSystem.get_default());

            for (const object of singletons) {
                const connect = object.connect.bind(object);
                object.connect = (...args) => {
                    const id = connect(...args);
                    this._mmGlobalSignals.push({ object, id });
                    return id;
                };
            }

            try {
                callback();
            } finally {
                // Removes the own property again, restoring the prototype method.
                for (const object of singletons)
                    delete object.connect;
            }
        }

        _mmDisconnectSingletonSignals() {
            for (const { object, id } of this._mmGlobalSignals) {
                object.disconnect(id);
            }
            this._mmGlobalSignals = [];
        }

        _mmDisconnectEventSourceSignals() {
            const source = this._eventSource;
            const ids = this._mmEventSourceIds ?? [];
            this._mmEventSourceIds = [];

            if (!source)
                return;

            for (const id of ids) {
                source.disconnect(id);
            }
        }

        _setEventSource(eventSource) {
            // Calendar.setEventSource() and EventsSection.setEventSource() connect
            // to the source and throw the handler ids away. Once this button is
            // destroyed those handlers keep firing on a live DBusEventSource and
            // rebuild a disposed calendar, which is what floods the journal with
            // "has been already disposed" plus "can't access property 'attach',
            // layout is null" whenever the monitor layout changes.
            this._mmDisconnectEventSourceSignals();

            const ids = [];
            const connect = eventSource.connect.bind(eventSource);
            eventSource.connect = (...args) => {
                const id = connect(...args);
                ids.push(id);
                return id;
            };

            try {
                if (typeof super._setEventSource === 'function') {
                    super._setEventSource(eventSource);
                } else {
                    // Fallback path (no upstream DateMenuButton to inherit from).
                    this._eventSource?.destroy();
                    this._calendar?.setEventSource(eventSource);
                    this._eventsItem?.setEventSource(eventSource);
                    this._eventSource = eventSource;
                }
            } finally {
                delete eventSource.connect;
            }

            this._mmEventSourceIds = ids;
        }

        _mmTrackClockConnections(callback) {
            // Capture connections on this menu's clock while upstream builds it.
            // Only this instance is wrapped; the primary panel clock is untouched.
            let clock = null;
            Object.defineProperty(this, '_clock', {
                configurable: true,
                get: () => clock,
                set: value => {
                    clock = value;
                    const bindProperty = clock.bind_property.bind(clock);
                    const connect = clock.connect.bind(clock);
                    clock.bind_property = (...args) => {
                        const binding = bindProperty(...args);
                        this._clockBinding = binding;
                        return binding;
                    };
                    clock.connect = (...args) => {
                        const id = connect(...args);
                        this._mmClockSignalIds.push(id);
                        return id;
                    };
                },
            });
            this._mmClockSignalIds = [];
            try {
                callback();
            } finally {
                if (clock) {
                    delete clock.bind_property;
                    delete clock.connect;
                }
                Object.defineProperty(this, '_clock', {
                    configurable: true, enumerable: true, writable: true, value: clock,
                });
            }
        }

        _cleanupClock() {
            if (this._clockBinding) {
                this._clockBinding.unbind();
                this._clockBinding = null;
            }

            if (this._clockNotifyTimezoneId && this._clock) {
                this._clock.disconnect(this._clockNotifyTimezoneId);
                this._clockNotifyTimezoneId = 0;
            }

            for (const id of this._mmClockSignalIds ?? [])
                this._clock.disconnect(id);
            this._mmClockSignalIds = [];
            this._clock = null;
        }

        _mmCleanup() {
            if (this._mmCleanedUp)
                return;
            this._mmCleanedUp = true;

            this._mmDisconnectEventSourceSignals();
            const eventSource = this._eventSource;
            this._eventSource = null;
            if (eventSource) {
                eventSource.destroy();
            }

            this._mmDisconnectSingletonSignals();

            if (this._sessionModeUpdatedId && MainRef?.sessionMode) {
                MainRef.sessionMode.disconnect(this._sessionModeUpdatedId);
                this._sessionModeUpdatedId = null;
            }

            this._cleanupClock();

            // The fallback path builds these itself; on the upstream path they are
            // plain children and go away with the actor tree.
            if (!DateMenu.DateMenuButton) {
                if (this._clocksItem) {
                    this._clocksItem.destroy();
                    this._clocksItem = null;
                }
                if (this._weatherItem) {
                    this._weatherItem.destroy();
                    this._weatherItem = null;
                }
            }
        }

        _onDestroy() {
            // PanelMenu.ButtonBox connects this to 'destroy', so it also runs when
            // the panel is torn down from C on a monitor change — a destroy()
            // override alone would be skipped there.
            this._mmCleanup();
            super._onDestroy();
            this._clockDisplay = null;
            this._panel = null;
        }

        _onOpenStateChanged(menu, open) {
            if (open)
                this.add_style_pseudo_class('active');
            else
                this.remove_style_pseudo_class('active');

            const layoutManager = MainRef?.layoutManager;
            if (!layoutManager || !this.menu?.actor)
                return;

            let monitorIndex = this._panel?.monitorIndex;
            const actorMonitor = layoutManager.findIndexForActor(this);
            if (actorMonitor >= 0)
                monitorIndex = actorMonitor;

            if (monitorIndex === undefined || monitorIndex === null || monitorIndex < 0)
                monitorIndex = layoutManager.primaryIndex;

            const workArea = layoutManager.getWorkAreaForMonitor(monitorIndex);
            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const verticalMargins = this.menu.actor.margin_top + this.menu.actor.margin_bottom;
            const maxHeight = Math.round((workArea.height - verticalMargins) / scaleFactor);

            this.menu.actor.style = `max-height: ${maxHeight}px;`;
        }

        // Fallback methods if not copied from upstream
        _updateTimeZone() {
            if (this._mmCleanedUp)
                return;

            if (DateMenu.DateMenuButton && super._updateTimeZone)
                return super._updateTimeZone();

            // Fallback: no-op if upstream method not available
            if (!this._calendar) return;
            // The calendar will update its timezone automatically
        }

        _sessionUpdated() {
            if (this._mmCleanedUp)
                return;

            if (DateMenu.DateMenuButton && super._sessionUpdated)
                return super._sessionUpdated();

            // Fallback: minimal visibility update
            if (!this._displaysSection) return;
            // Update visibility based on session mode if needed
        }
    };

    // Don't copyClass for DateMenuButton as our custom _init would be overwritten
    // if (DateMenu.DateMenuButton)
    //     Common.copyClass(DateMenu.DateMenuButton, MultiMonitorsDateMenuButton);
    let RegisteredClass = GObject.registerClass(MultiMonitorsDateMenuButton);
    // Apply GNOME 46 compatibility after registration
    Common.patchAddActorMethod(RegisteredClass.prototype);
    return RegisteredClass;
})();

export { MultiMonitorsCalendar, MultiMonitorsEventsSection, MultiMonitorsDateMenuButton };
