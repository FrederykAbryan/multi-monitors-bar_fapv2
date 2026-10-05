import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension.js', import.meta.url), 'utf8');
const start = source.indexOf('\t_applyMainPanelLayout(');
const end = source.indexOf('\n\t_moveMainDateMenu(', start);
assert.ok(start >= 0 && end > start, 'find main panel layout methods');
const methods = source.slice(start, end).replace(
    /\n\t(?=_(?:allocate|restore)MainPanel(?:Layout)?\()/g, ',\n\t');

class ActorBox {
    get_width() { return this.x2 - this.x1; }
}

class Actor {
    constructor(min, natural) {
        this.min = min;
        this.natural = natural;
    }

    get_preferred_width() { return [this.min, this.natural]; }
    get_allocation_box() { return this.allocation; }
    allocate(box) { this.allocation = Object.assign(new ActorBox(), box); }
}

// Reproduce Shell's half-panel limit to exercise the overflow correction.
class Panel {
    constructor(leftWidth, centerWidth, rightWidth, rtl = false) {
        this._leftBox = new Actor(leftWidth, leftWidth);
        this._centerBox = new Actor(centerWidth, centerWidth);
        this._rightBox = new Actor(rightWidth, rightWidth);
        this.rtl = rtl;
        this.relayouts = 0;
    }

    get_text_direction() { return this.rtl ? 1 : 0; }
    queue_relayout() { this.relayouts++; }
    vfunc_allocate(box) {
        const width = box.x2 - box.x1;
        const sideWidth = (width - this._centerBox.natural) / 2;
        const allocate = (actor, start, end) => actor.allocate({
            x1: this.rtl ? width - end : start,
            x2: this.rtl ? width - start : end,
            y1: 0,
            y2: box.y2 - box.y1,
        });
        allocate(this._leftBox, 0, Math.min(sideWidth, this._leftBox.natural));
        allocate(this._centerBox, sideWidth, sideWidth + this._centerBox.natural);
        allocate(this._rightBox, width - Math.min(sideWidth, this._rightBox.natural), width);
    }
}

class InjectionManager {
    overrideMethod(prototype, method, factory) {
        this.prototype = prototype;
        this.method = method;
        this.original = prototype[method];
        prototype[method] = factory(this.original);
    }

    clear() { this.prototype[this.method] = this.original; }
}

const Main = { panel: new Panel(180, 0, 280) };
const context = vm.createContext({
    Main,
    PanelModule: { Panel },
    InjectionManager,
    Clutter: { ActorBox, TextDirection: { RTL: 1 } },
});
const manager = vm.runInContext(`({${methods}})`, context);
const originalAllocate = Panel.prototype.vfunc_allocate;
const box = { x1: 40, x2: 680, y1: 20, y2: 52 };
manager._applyMainPanelLayout();

const assertFits = panel => {
    const allocations = [panel._leftBox, panel._centerBox, panel._rightBox]
        .map(actor => actor.allocation).sort((a, b) => a.x1 - b.x1);
    for (const allocation of allocations) {
        assert.ok(allocation.x1 >= 0 && allocation.x2 <= 640, 'inside monitor');
        assert.ok(allocation.x2 >= allocation.x1, 'nonnegative width');
        assert.equal(allocation.y2, 32, 'use panel height in local coordinates');
    }
    for (let i = 1; i < allocations.length; i++)
        assert.ok(allocations[i - 1].x2 <= allocations[i].x1, 'sections do not overlap');
};

Main.panel.vfunc_allocate(box);
assert.equal(Main.panel._rightBox.allocation.get_width(), 280);

// Adding the clock or another extension crosses Shell's 320px side limit.
Main.panel._rightBox.natural = 430;
Main.panel.vfunc_allocate(box);
assert.equal(Main.panel._rightBox.allocation.get_width(), 430, 'new icons get their full width');
assert.equal(Main.panel._rightBox.allocation.x2, 640, 'status area stays at the edge');
assertFits(Main.panel);

Main.panel._centerBox.min = 90;
Main.panel._centerBox.natural = 140;
Main.panel.vfunc_allocate(box);
assertFits(Main.panel);
assert.equal(Main.panel._centerBox.allocation.get_width(), 90, 'center retains its minimum');

Main.panel._rightBox.natural = 610;
Main.panel.vfunc_allocate(box);
assertFits(Main.panel);
assert.equal(Main.panel._rightBox.allocation.get_width(), 610);
assert.equal(Main.panel._leftBox.allocation.get_width(), 0);

Main.panel._rightBox.natural = 800;
Main.panel.vfunc_allocate(box);
assertFits(Main.panel);
assert.equal(Main.panel._rightBox.allocation.get_width(), 640, 'overflow stays within the monitor');

Main.panel = new Panel(180, 90, 430, true);
Main.panel.vfunc_allocate(box);
assertFits(Main.panel);
assert.equal(Main.panel._rightBox.allocation.x1, 0, 'RTL status area stays at the opposite edge');
assert.equal(Main.panel._rightBox.allocation.get_width(), 430);

Main.panel = new Panel(120, 100, 150);
Main.panel.vfunc_allocate(box);
assert.equal(Main.panel._centerBox.allocation.x1, 270, 'roomy layout keeps Shell centering');
assertFits(Main.panel);

const otherPanel = new Panel(180, 0, 430);
otherPanel.vfunc_allocate(box);
assert.equal(otherPanel._rightBox.allocation.get_width(), 320, 'only correct the main panel');

manager._restoreMainPanelLayout();
assert.equal(Panel.prototype.vfunc_allocate, originalAllocate, 'disable restores Shell allocation');
assert.equal(manager._mainPanelInjectionManager, null);
manager._applyMainPanelLayout();
manager._restoreMainPanelLayout();
assert.equal(Panel.prototype.vfunc_allocate, originalAllocate, 'enable and disable can repeat');

console.log('Main panel layout checks passed');
