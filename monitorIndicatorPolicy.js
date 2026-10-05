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

export function monitorKey(display, index, primaryIndex) {
    if (index === primaryIndex)
        return 'main';
    const connector = display.get_monitor_plug_name?.(index);
    return connector ? `connector:${connector}` : `monitor:${index}`;
}

export function readVisibility(settings) {
    try {
        const value = JSON.parse(settings.get_string(VISIBILITY_KEY));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
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
