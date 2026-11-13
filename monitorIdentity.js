// Shell-side lookup of the settings key for a monitor. Preferences run in a
// separate process and get these keys from the published monitor catalog.
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { VISIBILITY_KEY, migrateMonitorKeys, monitorKey } from './monitorIndicatorPolicy.js';
import { PANEL_LAYOUT_KEY } from './monitorPanelPolicy.js';

const DISPLAY_CONFIG_NAME = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_CONFIG_PATH = '/org/gnome/Mutter/DisplayConfig';

// Mutter resolves a connector name to a monitor index, but the names
// themselves come from DisplayConfig, asynchronously. They are cached here
// until clearMonitorConnectors().
let connectorNames = [];
let cancellable = null;

/**
 * @param {number} index - layout index of the monitor
 * @returns {string|null} its connector name (e.g. "DP-1"), or null when it
 *   is not known (yet) or the index is gone
 */
export function monitorConnector(index) {
    const manager = global.backend.get_monitor_manager();
    return connectorNames.find(name =>
        manager.get_monitor_for_connector(name) === index) ?? null;
}

/**
 * Refresh the cached connector names. Until the reply arrives, unknown
 * monitors keep their index key.
 *
 * @param {Function} onChanged - called when the names differ from the cached ones
 */
export function refreshMonitorConnectors(onChanged) {
    cancellable?.cancel();
    const pending = cancellable = new Gio.Cancellable();
    Gio.DBus.session.call(DISPLAY_CONFIG_NAME, DISPLAY_CONFIG_PATH, DISPLAY_CONFIG_NAME,
        'GetCurrentState', null, null, Gio.DBusCallFlags.NONE, -1, pending,
        (connection, result) => {
            if (cancellable === pending)
                cancellable = null;
            let reply;
            try {
                reply = connection.call_finish(result);
            } catch (e) {
                // Cancelled by a newer request or by disable(); any other
                // failure keeps the names we already have.
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`[MultiMonitors] Could not read monitor connectors: ${e.message}`);
                return;
            }
            const [, monitors] = reply.deep_unpack();
            const names = monitors.map(([[connector]]) => connector).sort();
            if (names.join('\n') === connectorNames.join('\n'))
                return;
            connectorNames = names;
            onChanged();
        });
}

/** Cancel a pending refresh and forget the cached names; for disable(). */
export function clearMonitorConnectors() {
    cancellable?.cancel();
    cancellable = null;
    connectorNames = [];
}

/**
 * @param {number} index - layout index of the monitor
 * @returns {string} the key its per-monitor settings are stored under
 */
export function currentMonitorKey(index) {
    const primary = Main.layoutManager.primaryIndex;
    return monitorKey(index, primary, index === primary ? null : monitorConnector(index));
}

/**
 * Re-key settings saved by index (older versions) for the connected monitors.
 *
 * @param {Gio.Settings} settings - the extension settings
 */
export function migrateMonitorSettings(settings) {
    const primary = Main.layoutManager.primaryIndex;
    const monitors = Main.layoutManager.monitors
        .map((_, index) => ({index, connector: index === primary ? null : monitorConnector(index)}))
        .filter(monitor => monitor.connector);
    for (const key of [VISIBILITY_KEY, PANEL_LAYOUT_KEY])
        migrateMonitorKeys(settings, key, monitors);
}
