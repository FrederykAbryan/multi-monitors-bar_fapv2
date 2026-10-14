import assert from 'node:assert/strict';

import {
    PANEL_COLOR_KEY, PANEL_LAYOUT_KEY, distributePanelSections, fitScale, hasMonitorColor,
    isVerticalPosition, panelColor, panelGeometry, panelPosition, setPanelLayoutValue,
    verticalClockText,
} from '../monitorPanelPolicy.js';

class Settings {
    constructor(values = {}) {
        this.values = {[PANEL_LAYOUT_KEY]: '{}', [PANEL_COLOR_KEY]: '', ...values};
    }

    get_string(key) { return this.values[key]; }
    set_string(key, value) { this.values[key] = value; }
}

const monitor = {x: 1920, y: 0, width: 1280, height: 1024};
assert.deepEqual(panelGeometry(monitor, 'top', 32), {x: 1920, y: 0, width: 1280, height: 32});
assert.deepEqual(panelGeometry(monitor, 'bottom', 32), {x: 1920, y: 992, width: 1280, height: 32});
assert.deepEqual(panelGeometry(monitor, 'left', 64), {x: 1920, y: 0, width: 64, height: 1024});
assert.deepEqual(panelGeometry(monitor, 'right', 64), {x: 3136, y: 0, width: 64, height: 1024});
assert.ok(isVerticalPosition('left') && isVerticalPosition('right'));
assert.ok(!isVerticalPosition('top') && !isVerticalPosition('bottom'));

const settings = new Settings();
const key = 'connector:HDMI-1';
assert.equal(panelPosition(settings, key), 'top', 'default to the top edge');
assert.equal(panelColor(settings, key), '', 'default to the theme color');

settings.set_string(PANEL_COLOR_KEY, 'rgba(10,10,10,0.8)');
assert.equal(panelColor(settings, key), 'rgba(10,10,10,0.8)', 'fall back to the shared color');
assert.ok(!hasMonitorColor(settings, key));

setPanelLayoutValue(settings, key, 'position', 'right');
setPanelLayoutValue(settings, key, 'color', 'rgb(200,0,0)');
setPanelLayoutValue(settings, 'connector:DP-2', 'position', 'bottom');
assert.equal(panelPosition(settings, key), 'right');
assert.equal(panelColor(settings, key), 'rgb(200,0,0)', 'monitor color wins');
assert.equal(panelPosition(settings, 'connector:DP-2'), 'bottom', 'monitors are independent');
assert.equal(panelColor(settings, 'connector:DP-2'), 'rgba(10,10,10,0.8)');

setPanelLayoutValue(settings, key, 'color', null);
assert.equal(panelColor(settings, key), 'rgba(10,10,10,0.8)', 'reset returns to the shared color');
assert.equal(panelPosition(settings, key), 'right', 'reset keeps the position');

setPanelLayoutValue(settings, key, 'position', null);
assert.equal(JSON.parse(settings.get_string(PANEL_LAYOUT_KEY))[key], undefined, 'drop empty entries');

settings.set_string(PANEL_LAYOUT_KEY, '{"connector:HDMI-1":{"position":"diagonal"}}');
assert.equal(panelPosition(settings, key), 'top', 'ignore unknown positions');
settings.set_string(PANEL_LAYOUT_KEY, 'not json');
assert.equal(panelPosition(settings, key), 'top', 'ignore corrupt settings');

assert.deepEqual(distributePanelSections(1000, 100, 50, 200, 150), [150, 700, 150], 'balanced while roomy');
const [start, center, end] = distributePanelSections(400, 180, 90, 140, 200);
assert.equal(end, 200, 'end section keeps its natural size');
assert.equal(start + center + end, 400, 'sections fill the bar');
assert.ok(center >= 90, 'center keeps its minimum');
assert.deepEqual(distributePanelSections(100, 50, 0, 0, 300), [0, 0, 100], 'overflow stays within the bar');

assert.equal(fitScale(40, 60), 1, 'narrow items keep their size');
assert.equal(fitScale(120, 60), 0.5, 'wide items shrink to the bar');
assert.equal(fitScale(120, -1), 1, 'unconstrained width never scales');
assert.equal(verticalClockText('Tue Oct 14 14∶30'), 'Tue\nOct\n14\n14∶30');
assert.equal(verticalClockText('14∶30'), '14∶30');

console.log('Monitor panel layout checks passed');
