// Shell-side lookup of the settings key for a monitor. Preferences run in a
// separate process and get these keys from the published monitor catalog.
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { VISIBILITY_KEY, migrateMonitorKeys, monitorKey } from './monitorIndicatorPolicy.js';
import { PANEL_LAYOUT_KEY } from './monitorPanelPolicy.js';

const DISPLAY_CONFIG_NAME = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_CONFIG_PATH = '/org/gnome/Mutter/DisplayConfig';

// Mutter 49+ lists its monitors directly. Older releases only resolve a
// connector name to an index, so the names are fetched from DisplayConfig
// (asynchronously) and cached here until clearMonitorConnectors().
let connectorNames = [];
let cancellable = null;

function listsMonitors(manager) {
    return typeof manager.get_logical_monitors === 'function';
}

// Connector name (e.g. "DP-1") of the monitor at a layout index, or null
// when it is not known (yet) or the index is gone.
export function monitorConnector(index) {
    const manager = global.backend.get_monitor_manager();
    if (listsMonitors(manager)) {
        const logical = manager.get_logical_monitors()
            .find(monitor => monitor.get_number() === index);
        return logical?.get_monitors()[0]?.get_connector() ?? null;
    }
    return connectorNames.find(name =>
        manager.get_monitor_for_connector(name) === index) ?? null;
}

// Refresh the cached connector names where Mutter cannot list its monitors.
// `onChanged` runs once the names differ from the cached ones; until then
// unknown monitors keep their index key.
export function refreshMonitorConnectors(onChanged) {
    if (listsMonitors(global.backend.get_monitor_manager()))
        return;
    cancellable?.cancel();
    const pending = cancellable = new Gio.Cancellable();
    Gio.DBus.session.call(DISPLAY_CONFIG_NAME, DISPLAY_CONFIG_PATH, DISPLAY_CONFIG_NAME,
        'GetCurrentState', null, null, Gio.DBusCallFlags.NONE, -1, pending,
        (connection, result) => {
            let names;
            try {
                const [, monitors] = connection.call_finish(result).deep_unpack();
                names = monitors.map(([[connector]]) => connector).sort();
            } catch {
                // Cancelled, or DisplayConfig is unavailable: keep what we have.
                return;
            } finally {
                if (cancellable === pending)
                    cancellable = null;
            }
            if (names.join('\n') === connectorNames.join('\n'))
                return;
            connectorNames = names;
            onChanged();
        });
}

export function clearMonitorConnectors() {
    cancellable?.cancel();
    cancellable = null;
    connectorNames = [];
}

export function currentMonitorKey(index) {
    const primary = Main.layoutManager.primaryIndex;
    return monitorKey(index, primary, index === primary ? null : monitorConnector(index));
}

// Re-key settings saved by index (older versions) for the connected monitors.
export function migrateMonitorSettings(settings) {
    const primary = Main.layoutManager.primaryIndex;
    const monitors = Main.layoutManager.monitors
        .map((_, index) => ({index, connector: index === primary ? null : monitorConnector(index)}))
        .filter(monitor => monitor.connector);
    for (const key of [VISIBILITY_KEY, PANEL_LAYOUT_KEY])
        migrateMonitorKeys(settings, key, monitors);
}
