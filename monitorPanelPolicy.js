export const PANEL_LAYOUT_KEY = 'monitor-panel-layout';
export const PANEL_COLOR_KEY = 'panel-color';
export const PANEL_POSITIONS = ['top', 'bottom', 'left', 'right'];

// Side bars hold the clock, so they need more room than the bar is tall.
export const VERTICAL_THICKNESS_SCALE = 2;

export function readPanelLayout(settings) {
    try {
        const value = JSON.parse(settings.get_string(PANEL_LAYOUT_KEY));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

export function panelPosition(settings, key) {
    const position = readPanelLayout(settings)[key]?.position;
    return PANEL_POSITIONS.includes(position) ? position : 'top';
}

// Monitor color overrides the shared color, which overrides the theme.
// The shared color is for additional monitors, so the main bar skips it.
export function panelColor(settings, key) {
    const color = readPanelLayout(settings)[key]?.color;
    if (typeof color === 'string' && color)
        return color;
    return key === 'main' ? '' : settings.get_string(PANEL_COLOR_KEY);
}

export function hasMonitorColor(settings, key) {
    const color = readPanelLayout(settings)[key]?.color;
    return typeof color === 'string' && color !== '';
}

export function setPanelLayoutValue(settings, key, field, value) {
    const layout = readPanelLayout(settings);
    const previous = layout[key];
    const entry = {...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {})};
    if (value === null || value === undefined || value === '')
        delete entry[field];
    else
        entry[field] = value;
    if (Object.keys(entry).length)
        layout[key] = entry;
    else
        delete layout[key];
    settings.set_string(PANEL_LAYOUT_KEY, JSON.stringify(layout));
}

export function isVerticalPosition(position) {
    return position === 'left' || position === 'right';
}

export function panelGeometry(monitor, position, thickness) {
    switch (position) {
    case 'bottom':
        return {x: monitor.x, y: monitor.y + monitor.height - thickness, width: monitor.width, height: thickness};
    case 'left':
        return {x: monitor.x, y: monitor.y, width: thickness, height: monitor.height};
    case 'right':
        return {x: monitor.x + monitor.width - thickness, y: monitor.y, width: thickness, height: monitor.height};
    default:
        return {x: monitor.x, y: monitor.y, width: monitor.width, height: thickness};
    }
}

// Panel items are mirrors of horizontal widgets, so on a side bar the ones
// wider than the bar are scaled down to fit instead of being clipped.
export function fitScale(natWidth, available) {
    return available >= 0 && natWidth > available ? available / natWidth : 1;
}

// Put each word of the clock on its own line (e.g. "Tue\nOct\n14\n14∶30").
export function verticalClockText(text) {
    return text.trim().split(/[   ]+/).join('\n');
}

// Split the bar between its start, center and end sections. Keep the
// balanced GNOME layout while there is room; otherwise reserve the end
// section first so Quick Settings stays anchored to the monitor edge.
export function distributePanelSections(total, startNat, centerMin, centerNat, endNat) {
    const side = Math.max(startNat, endNat);
    if (side * 2 + centerNat <= total)
        return [side, total - side * 2, side];

    const end = Math.min(endNat, total);
    const remaining = total - end;
    const centerFloor = Math.min(centerMin, remaining);
    const start = Math.min(startNat, Math.max(0, remaining - centerFloor));
    return [start, Math.max(0, total - start - end), end];
}
