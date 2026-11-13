export const CATALOG_KEY = 'monitor-indicator-catalog';
export const VISIBILITY_KEY = 'monitor-indicator-visibility';
export const CONTROL_ROLE = 'multiMonitorBarVisibility';
export const EXCLUDED_MIRROR_ROLES = [
    'a11y', 'dwellClick', 'screencast', 'screenRecording', 'remoteAccess',
    'screenSharing', 'keyboard', 'power', 'unsafeModeIndicator', 'backgroundApps',
];

// Keep the source's own visibility separate from our primary-panel override.
// Mirrors must still see an icon that the user only hid on the main monitor.
export const primaryVisibility = new WeakMap();

export function sourceIsVisible(actor) {
    return primaryVisibility.get(actor)?.visible ?? actor?.visible ?? false;
}

/**
 * Extended monitors are keyed by connector (e.g. "connector:DP-1") so their
 * settings follow the screen when Mutter renumbers the monitors. The index
 * key is the fallback when the connector is unknown, and the legacy format.
 *
 * @param {number} index - layout index of the monitor
 * @param {number} primaryIndex - layout index of the primary monitor
 * @param {string|null} connector - connector name, when known
 * @returns {string} the key the monitor's settings are stored under
 */
export function monitorKey(index, primaryIndex, connector = null) {
    if (index === primaryIndex)
        return 'main';
    return connector ? `connector:${connector}` : `monitor:${index}`;
}

function readObject(settings, settingsKey) {
    try {
        const value = JSON.parse(settings.get_string(settingsKey));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

/**
 * Move the settings stored under a legacy index key to the connector of the
 * monitor now at that index. An existing connector entry wins; the index
 * entry is dropped either way so it cannot attach to another monitor later.
 *
 * @param {Gio.Settings} settings - the extension settings
 * @param {string} settingsKey - a key holding a JSON object of per-monitor entries
 * @param {{index: number, connector: string}[]} monitors - the extended monitors
 */
export function migrateMonitorKeys(settings, settingsKey, monitors) {
    const stored = readObject(settings, settingsKey);
    let changed = false;
    for (const {index, connector} of monitors) {
        const legacy = `monitor:${index}`;
        if (!connector || !Object.hasOwn(stored, legacy))
            continue;
        const key = `connector:${connector}`;
        if (!Object.hasOwn(stored, key))
            stored[key] = stored[legacy];
        delete stored[legacy];
        changed = true;
    }
    if (changed)
        settings.set_string(settingsKey, JSON.stringify(stored));
}

export function readVisibility(settings) {
    return readObject(settings, VISIBILITY_KEY);
}

export function indicatorIsEnabled(settings, key, role, fallback = true) {
    if (role === CONTROL_ROLE)
        return true;
    const value = readVisibility(settings)[key]?.[role];
    return typeof value === 'boolean' ? value : fallback;
}

export function setIndicatorEnabled(settings, key, role, enabled) {
    const preferences = readVisibility(settings);
    const previous = preferences[key];
    preferences[key] = {
        ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
        [role]: enabled,
    };
    settings.set_string(VISIBILITY_KEY, JSON.stringify(preferences));
}
