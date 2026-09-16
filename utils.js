import Clutter from 'gi://Clutter';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

const [major] = Config.PACKAGE_VERSION.split('.');
export const SHELL_VERSION = Number.parseInt(major);

/**
 * Constructor props for a vertical or horizontal St.BoxLayout.
 *
 * GNOME 51 removed St.BoxLayout:vertical in favour of :orientation
 * (gnome-shell !3614). Keep `vertical` on 45–50 so those shells still
 * construct. Same split as dash-to-dock #2673.
 *
 * @param {boolean} [vertical=true]
 * @returns {object}
 */
export function boxLayoutOrientation(vertical = true) {
    if (SHELL_VERSION >= 51) {
        return {
            orientation: vertical
                ? Clutter.Orientation.VERTICAL
                : Clutter.Orientation.HORIZONTAL,
        };
    }
    return { vertical };
}
