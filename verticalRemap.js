import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { verticalBoxProps } from './common.js';

// Mirrors are mostly live Clutter.Clones of main-panel widgets, which paint
// their source as one horizontal row however the bar is oriented. On a side
// bar, remap such a clone: hide it and show a vertical stack holding one
// clone per icon/label of the source instead.

function isVisualLeaf(actor) {
    if (actor instanceof St.Icon || actor instanceof St.Label || actor instanceof Clutter.Text)
        return true;
    return actor.get_n_children() === 0;
}

// Walk a horizontal row down to the pieces that can be stacked. Children of a
// row wider than tall are split further; anything else is kept whole.
function collectLeaves(actor, leaves, watched) {
    watched.push(actor);
    if (!actor.visible)
        return;
    const allChildren = actor.get_children();
    const children = allChildren.filter(child => child.visible);
    // Hidden icons (VPN, recording, sharing, etc.) must still trigger a
    // rebuild when enabled, even though they have no clone yet.
    watched.push(...allChildren.filter(child => !child.visible));
    if (allChildren.length > 0 && children.length === 0)
        return;
    if (isVisualLeaf(actor) || children.length === 0) {
        leaves.push(actor);
        return;
    }
    const [width, height] = actor.get_size();
    if (children.length === 1 || width <= height) {
        if (children.length === 1 && !(children[0] instanceof Clutter.Text))
            collectLeaves(children[0], leaves, watched);
        else
            leaves.push(actor);
        return;
    }
    for (const child of children)
        collectLeaves(child, leaves, watched);
}

function leafClone(leaf, owner, compactIcons) {
    const clone = new Clutter.Clone({
        source: leaf,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    clone._mmRemapClone = true;
    // Clones paint at the source's allocation, not its preferred size.
    const syncSize = () => {
        const box = leaf.get_allocation_box();
        const width = Math.round(box.get_width());
        const height = Math.round(box.get_height());
        // A hidden main panel can temporarily allocate its graphs at zero.
        // Keep the last painted size until the source is allocated again.
        if (width > 0 && height > 0) {
            const limit = compactIcons && leaf instanceof St.Icon
                ? 18 * St.ThemeContext.get_for_stage(global.stage).scale_factor
                : Infinity;
            const scale = Math.min(1, limit / Math.max(width, height));
            clone.set_size(Math.round(width * scale), Math.round(height * scale));
        }
    };
    leaf.connectObject('notify::allocation', syncSize, owner);
    syncSize();
    return clone;
}

// The actor that stands for the clone in its parent: the clone itself, or a
// single-child wrapper sized to the source around it.
function remapTarget(clone) {
    let target = clone;
    for (;;) {
        const parent = target.get_parent();
        if (!parent || parent instanceof PanelMenu.Button || parent instanceof St.Button ||
            parent.get_n_children() !== 1 ||
            !(parent.layout_manager instanceof Clutter.BinLayout))
            return target;
        target = parent;
    }
}

export function remapClone(clone, vertical) {
    if (clone._mmRemapClone)
        return;

    if (!vertical) {
        clone._mmRemapStack?.destroy();
        return;
    }
    if (clone._mmRemapStack || !clone.source)
        return;

    const target = remapTarget(clone);
    const parent = target.get_parent();
    if (!parent)
        return;

    let compactIcons = false;
    for (let actor = parent; actor; actor = actor.get_parent()) {
        if (actor.has_style_class_name?.('mm-astra-monitor')) {
            compactIcons = true;
            break;
        }
    }

    const stack = new St.BoxLayout({
        style_class: 'mm-vertical-remap',
        ...verticalBoxProps(),
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: false,
    });
    stack._mmRemapClone = true;
    let inner = null;
    let idleId = 0;

    const rebuild = () => {
        inner?.destroy();
        inner = new St.BoxLayout({
            style_class: 'mm-vertical-remap-items',
            ...verticalBoxProps(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
        });
        inner._mmRemapClone = true;

        // Before the source's first allocation, rows can't be told apart
        // from single items; look again once it has a size.
        const [sourceWidth, sourceHeight] = clone.source.get_size();
        if (sourceWidth <= 0 || sourceHeight <= 0)
            clone.source.connectObject('notify::allocation', queueRebuild, inner);

        const leaves = [];
        const watched = [];
        collectLeaves(clone.source, leaves, watched);
        for (const actor of watched) {
            let horizontal = actor.width > actor.height;
            let allocated = actor.width > 0 && actor.height > 0;
            actor.connectObject(
                'child-added', queueRebuild,
                'child-removed', queueRebuild,
                'notify::visible', queueRebuild,
                'notify::allocation', () => {
                    const nextHorizontal = actor.width > actor.height;
                    const nextAllocated = actor.width > 0 && actor.height > 0;
                    if (nextAllocated && (!allocated || nextHorizontal !== horizontal))
                        queueRebuild();
                    horizontal = nextHorizontal;
                    allocated = nextAllocated;
                },
                inner);
        }
        for (const leaf of leaves)
            inner.add_child(leafClone(leaf, inner, compactIcons));
        stack.add_child(inner);

        // Even one icon needs a content-sized, centered clone. Its original
        // wrapper may retain the horizontal panel's padding and dimensions.
        stack.visible = leaves.length > 0;
        target.visible = false;
    };

    function queueRebuild() {
        if (idleId)
            return;
        idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            idleId = 0;
            rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    stack.connect('destroy', () => {
        if (idleId) {
            GLib.source_remove(idleId);
            idleId = 0;
        }
        inner = null;
        if (clone._mmRemapStack === stack) {
            clone._mmRemapStack = null;
            target.visible = true;
        }
    });
    clone.connectObject('destroy', () => stack.destroy(), stack);
    clone.source.connectObject('destroy', () => stack.destroy(), stack);

    clone._mmRemapStack = stack;
    // Insert before the target: PanelMenu.ButtonBox only lays out its first child.
    parent.insert_child_below(stack, target);
    rebuild();
}
