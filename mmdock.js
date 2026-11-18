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
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DashModule from 'resource:///org/gnome/shell/ui/dash.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

import * as DashIsolation from './dashIsolation.js';

/**
 * A native bottom dock revealed from the desktop's bottom edge when enabled.
 * Extended monitors also show it in overview; the primary uses GNOME's dash.
 * Neither the dock nor its edge trigger reserves desktop space.
 */
export class MultiMonitorsDock {
    constructor(monitor, settings, {showInOverview = true, nativeDash = null} = {}) {
        this._settings = settings;
        this._showInOverview = showInOverview;
        this._hideTimeoutId = 0;
        this._positionIdleId = 0;
        this._rearmTimeoutId = 0;
        this._rearmMotionId = 0;
        this._hiding = false;
        this._inOverview = false;
        this._magnifiedIcons = new Map();
        this._magnificationTracked = new WeakSet();
        this._monitor = {
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        };

        this._heightChangedId = null;
        this._showAppsButtonId = null;
        this._stateAdjustment = null;
        this._stateAdjustmentId = null;
        this._overviewShowingId = null;
        this._overviewHidingId = null;
        this._ignoreShowAppsButtonToggle = false;

        this._borrowedDash = !!nativeDash;
        this._dash = nativeDash ?? new DashModule.Dash();
        this._dockStyle = null;
        if (!this._borrowedDash) {
            this._isolation = new DashIsolation.DashMonitorIsolation(this._dash,
                settings, () => this._getMonitorIndex());
        }

        this._connectShowAppsButton();

        // Match the dock width so empty space beside it remains clickable.
        this._bin = new St.Bin({
            name: 'multiMonitorsDockBin',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            reactive: true,
            clip_to_allocation: true,
        });
        // Keep the input region stationary and clip the moving content at
        // the monitor edge, including when another display is below this one.
        this._slide = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        if (!this._borrowedDash)
            this._slide.set_child(this._dash);
        this._bin.set_child(this._slide);
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interfaceSettings.connectObject('changed::color-scheme',
            () => this._syncDockTheme(), this._bin);
        if (!this._borrowedDash)
            this._applyDockStyle();
        this._dash._box.connectObject('child-added', (_box, item) =>
            this._connectAppItem(item), this._bin);
        for (const item of this._dash._box.get_children())
            this._connectAppItem(item);

        // Fullscreen visibility is managed below. Shell tracking would
        // forcibly show hidden chrome again whenever windows are restacked.
        this._bin.hide();
        Main.layoutManager.addChrome(this._bin, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        this._edge = new St.Widget({
            name: 'multiMonitorsDockEdge',
            reactive: true,
            height: 2,
        });
        Main.layoutManager.addChrome(this._edge, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        this._edge.connect('enter-event', () => {
            this._revealDock();
            return Clutter.EVENT_PROPAGATE;
        });
        // During a hide animation the bin still covers the edge trigger.
        // Re-entering either actor must interrupt that animation.
        this._bin.connect('enter-event', () => {
            this._revealDock();
            return Clutter.EVENT_PROPAGATE;
        });
        this._bin.connect('motion-event', (_actor, event) => {
            this._updateMagnification(...event.get_coords());
            return Clutter.EVENT_PROPAGATE;
        });
        this._bin.connect('leave-event', () => {
            // Crossing between descendants also bubbles through this actor.
            if (!this._containsPointer(...global.get_pointer()))
                this._resetMagnification(true);
            return Clutter.EVENT_PROPAGATE;
        });
        if (this._borrowedDash) {
            // In Overview the native dash is outside our desktop bin. Listen
            // on the dash itself without reparenting or reallocating it.
            for (const signal of ['enter-event', 'motion-event']) {
                this._dash.connectObject(signal, () => {
                    if (this._inOverview)
                        this._updateMagnification(...global.get_pointer());
                    return Clutter.EVENT_PROPAGATE;
                }, this._bin);
            }
            // Decide by the actor being entered, not by pointer geometry: an
            // enlarged icon paints above the dash, so a pointer leaving over
            // its top is still "near" the dash, and once it is outside no
            // further event would arrive to shrink the icon again.
            this._dash.connectObject('leave-event', (_actor, event) => {
                const entered = event.get_related();
                if (this._inOverview && !(entered && this._dash.contains(entered)))
                    this._resetMagnification(true);
                return Clutter.EVENT_PROPAGATE;
            }, this._bin);
            // Like the extended docks, magnify only on real pointer events.
            // Sampling on Overview 'shown' could enlarge Show Apps under a
            // still pointer that Clutter never saw enter, so no leave-event
            // arrived when it moved straight to another monitor.
        }

        this._updatePosition();
        this._heightChangedId = this._dash.connect('notify::height',
            () => this._queuePositionUpdate());
        this._widthChangedId = this._dash.connect('notify::width',
            () => this._queuePositionUpdate());
        // The dash is allocated the bin's fixed width, so adding or removing
        // icons never changes its width by itself. Re-measure whenever its
        // content asks for a new layout (also tracks icon scale animations).
        this._dash.connectObject('queue-relayout',
            () => this._queuePositionUpdate(), this._bin);
        this._overviewShowingId = Main.overview.connect('showing', () => {
            this._setOverviewMode(true);
            this._connectOverviewStateAdjustment();
        });
        this._overviewHidingId = Main.overview.connect('hiding', () => {
            this._stopLaunchBounce();
            this._resetMagnification();
            this._setShowAppsChecked(false);
        });
        this._overviewHiddenId = Main.overview.connect('hidden',
            () => this._setOverviewMode(false));
        this._hoverSettingId = settings.connect('changed::reveal-dock-on-hover',
            () => this._syncEdge());
        this._magnificationSettingId = settings.connect('changed::dock-magnification', () => {
            this._resetMagnification();
            this._updatePosition();
            this._updateMagnification(...global.get_pointer());
        });
        this._sessionUpdatedId = Main.sessionMode.connect('updated',
            () => this._syncEdge());
        this._fullscreenChangedId = global.display.connect('in-fullscreen-changed',
            () => this._syncEdge());
        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            if (global.display.focus_window)
                this._dismissDock();
        });
        Main.layoutManager.connectObject('startup-complete',
            () => {
                if (!this._borrowedDash)
                    this._dash._redisplay();
                this._updatePosition();
                this._syncEdge();
            }, this._bin);
        // Hidden dashes defer their initial icon population until mapped or
        // the deferred-work timeout. Populate now so the edge already spans
        // the full dock on the first approach after login.
        if (!this._borrowedDash)
            this._dash._redisplay();
        this._updatePosition();
        this._setOverviewMode(Main.overview.visible);
        this._connectOverviewStateAdjustment();
    }

    _canReveal() {
        return !this._inOverview &&
            !Main.layoutManager._startingUp &&
            !Main.overview.visible && !Main.overview.animationInProgress &&
            !Main.sessionMode.isLocked && Main.sessionMode.currentMode === 'user' &&
            !Main.layoutManager.monitors.some(monitor =>
                monitor.x === this._monitor.x && monitor.y === this._monitor.y &&
                monitor.inFullscreen) &&
            this._settings.get_boolean('reveal-dock-on-hover');
    }

    _syncEdge() {
        this._edge.visible = this._canReveal();
        if (!this._edge.visible && !this._inOverview)
            this._hideDesktopDock();
    }

    _setOverviewMode(inOverview) {
        if (this._borrowedDash) {
            // The native dash belongs to Overview. Keep our empty desktop
            // container out of its actor tree and stop measuring its animated
            // allocations until Shell has finished leaving Overview.
            this._inOverview = inOverview;
            if (this._positionIdleId) {
                global.compositor.get_laters().remove(this._positionIdleId);
                this._positionIdleId = 0;
            }
            this._hideDesktopDock();
            if (!inOverview)
                this._updatePosition();
            this._syncEdge();
            return;
        }
        this._hideDesktopDock();
        // Match the primary dash in each mode: Shell's native theme in
        // Overview, and the shared glass treatment for desktop hover.
        if (inOverview)
            this._restoreDockStyle();
        else
            this._applyDockStyle();
        if (this._inOverview !== inOverview) {
            if (this._inOverview)
                Main.layoutManager.overviewGroup.remove_child(this._bin);
            else
                Main.layoutManager.removeChrome(this._bin);

            this._inOverview = inOverview;
            if (inOverview)
                Main.layoutManager.overviewGroup.add_child(this._bin);
            else
                Main.layoutManager.addChrome(this._bin, {
                    affectsStruts: false,
                    trackFullscreen: false,
                });
        }
        this._bin.visible = inOverview && this._showInOverview;
        this._syncEdge();
        this._queuePositionUpdate();
    }

    _revealDock() {
        if (!this._canReveal() || this._hideTimeoutId || this._rearmTimeoutId)
            return;

        this._borrowNativeDash();
        this._updatePosition();
        this._slide.remove_all_transitions();
        this._hiding = false;
        this._slide.opacity = 255;
        this._slide.translation_y = 0;
        this._bin.show();
        // The primary dash has just been reparented out of Overview. Sample
        // the pointer after layout, when its desktop allocations are valid,
        // instead of waiting for another motion event to start magnification.
        this._queuePositionUpdate();
        // Poll only while revealed. This also works while an icon's popup
        // menu owns the pointer grab and normal leave events are unavailable.
        let outsideSince = null;
        this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            const [x, y] = global.get_pointer();
            const inside = this._containsPointer(x, y);
            // AppIcon keeps its popup in `_menu`; checking only `menu` let
            // the dock hide (and close the menu) as the pointer moved onto it.
            const menuOpen = this._dash._box.get_children().some(
                item => (item.child?._menu ?? item.child?.menu)?.isOpen);
            const focus = global.stage.get_key_focus();
            // Mouse clicks can leave stale Shell key focus on an icon even
            // after a normal application owns the keyboard.
            const focused = !global.display.focus_window && focus && this._bin.contains(focus);
            const now = GLib.get_monotonic_time();
            if (inside || menuOpen || focused)
                outsideSince = null;
            else
                outsideSince ??= now;

            if (!this._canReveal() ||
                (!this._launchBounce && outsideSince !== null && now - outsideSince >= 300000)) {
                this._hideTimeoutId = 0;
                this._hideDesktopDock(this._canReveal());
                return GLib.SOURCE_REMOVE;
            }
            if (this._magnificationNeedsRetry)
                this._updateMagnification(x, y);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _connectAppItem(item) {
        if (!item.child?._delegate?.app)
            return;
        item.child.connectObject('clicked', () => this._bounceApp(item.child), this._bin);
        item.child.connectObject('destroy', () => {
            if (this._launchBounce?.button === item.child)
                this._stopLaunchBounce();
        }, this._bin);
    }

    _bounceApp(button) {
        this._stopLaunchBounce();
        // Activating from Overview closes it at once (Shell's own click
        // handler runs first, so it may already be hiding). The dash then
        // zooms out and is reparented mid-bounce, and the window appearing
        // is the feedback, so only bounce from the desktop dock.
        if (!this._interfaceSettings.get_boolean('enable-animations') ||
            this._inOverview || Main.overview.visible || !this._bin.visible) {
            this._dismissDock();
            return;
        }
        // Only translate vertically, leaving hover scale and spacing intact.
        // Launching remains Shell's job and is never delayed by the animation.
        const timeline = new Clutter.Timeline({actor: button, duration: 720});
        const state = {button, timeline, translationY: button.translation_y, elapsed: 0};
        this._launchBounce = state;
        if (this._magnificationRowClip === undefined) {
            this._magnificationRowClip = this._dash._box.clip_to_allocation;
            this._dash._box.clip_to_allocation = false;
        }
        timeline.connect('new-frame', () => {
            state.elapsed += timeline.get_delta();
            const first = state.elapsed < 440;
            const progress = Math.min(1, first ? state.elapsed / 440 : (state.elapsed - 440) / 280);
            const height = button.height * (first ? 0.32 : 0.14);
            button.translation_y = state.translationY - height * Math.sin(Math.PI * progress);
            if (state.elapsed >= 720) {
                this._stopLaunchBounce();
                this._dismissDock();
            }
        });
        timeline.connect('completed', () => {
            if (this._launchBounce !== state)
                return;
            this._stopLaunchBounce();
            this._dismissDock();
        });
        timeline.start();
    }

    _stopLaunchBounce() {
        const state = this._launchBounce;
        if (!state)
            return;
        this._launchBounce = null;
        state.timeline.stop();
        state.button.translation_y = state.translationY;
        if (!this._magnifiedIcons.size && this._magnificationRowClip !== undefined) {
            this._dash._box.clip_to_allocation = this._magnificationRowClip;
            this._magnificationRowClip = undefined;
        }
    }

    _updateMagnification(x, y) {
        const nativeOverview = this._borrowedDash && this._inOverview;
        if (!this._settings.get_boolean('dock-magnification') ||
            this._hiding || (nativeOverview
                ? !this._dash.visible
                : !this._bin.visible || this._nativeOverviewOwnsLayout()))
            return;
        let inside = this._containsPointer(x, y);
        if (nativeOverview) {
            const [dx, dy] = this._dash.get_transformed_position();
            const [dw, dh] = this._dash.get_transformed_size();
            // Use the native allocation, not the hidden desktop wrapper.
            // Include the enlarged paint area so child crossings don't reset.
            const margin = dh * 0.5;
            inside = x >= dx - margin && x < dx + dw + margin &&
                y >= dy - margin && y < dy + dh;
        }
        if (!inside) {
            this._resetMagnification(true);
            return;
        }
        // Icons move during Overview transitions, so don't measure new
        // targets then. The leave check above must still run: clicking Show
        // Apps starts a transition, and a pointer leaving during it would
        // otherwise keep the button enlarged with no later event to undo it.
        if (nativeOverview && Main.overview.animationInProgress)
            return;
        // Shell clips the app row for its normal overflow behavior. Enlarged
        // buttons need to paint above and beside that row; the outer bin still
        // clips everything at the monitor edge. Restore Shell's value on reset.
        if (this._magnificationRowClip === undefined) {
            this._magnificationRowClip = this._dash._box.clip_to_allocation;
            this._dash._box.clip_to_allocation = false;
        }
        // High-rate mice deliver several motion events per frame. Keep only
        // the latest sample and measure the row once, on the next frame.
        this._magnificationPointer = [x, y];
        this._startMagnificationAnimation();
    }

    _computeMagnificationTargets(x, y) {
        const nativeOverview = this._borrowedDash && this._inOverview;
        this._magnificationNeedsRetry = false;
        let room = 0;
        const buttons = this._dash._box.get_children().map(item => item.child);
        const showAppsButton = this._getLocalShowAppsButton();
        buttons.push(showAppsButton);
        const entries = [];
        for (const button of new Set(buttons)) {
            // Show Apps owns its BaseIcon on the wrapper, not on the button.
            if (!button || (!button.icon && button !== showAppsButton) || !button.visible)
                continue;
            const [bx] = button.get_transformed_position();
            const [bw] = button.get_transformed_size();
            // Reparenting after Overview can leave a locally allocated icon
            // with zero stage size until its ancestors finish allocation.
            // Never divide by that size or capture a zero baseline scale.
            if (!(button.width > 0) || !Number.isFinite(bx) ||
                !Number.isFinite(bw) || bw <= 0 ||
                !(button.scale_x > 0) || !(button.scale_y > 0)) {
                this._magnificationNeedsRetry = true;
                continue;
            }
            // Transform the whole button: highlights, running indicators and
            // click targets must travel with the icon.
            let state = this._magnifiedIcons.get(button);
            if (!state) {
                const [pivotX, pivotY] = button.get_pivot_point();
                state = {scaleX: button.scale_x, scaleY: button.scale_y,
                    translationX: button.translation_x, pivotX, pivotY,
                    scale: 1, offset: 0, targetScale: 1, targetOffset: 0};
                this._magnifiedIcons.set(button, state);
                if (!this._magnificationTracked.has(button)) {
                    this._magnificationTracked.add(button);
                    button.connectObject('destroy', () => this._magnifiedIcons.delete(button), this._bin);
                }
                button.set_pivot_point(0.5, 1);
            }
            // Setting the pivot changes the transformed origin.
            const [pivotBx] = button.get_transformed_position();
            const width = bw / state.scale;
            const unit = width / button.width;
            // Remove our current transform before measuring distance. Using
            // animated bounds here creates feedback and makes icons wobble.
            const center = pivotBx + bw / 2 - state.offset * unit;
            const distance = Math.abs(x - center) / Math.max(1, width * 2);
            const wave = distance < 1 ? (1 + Math.cos(Math.PI * distance)) / 2 : 0;
            state.unit = unit;
            entries.push({button, state, center, width, unit, growth: width * wave * 0.4});
        }
        entries.sort((a, b) => a.center - b.center);
        if (entries.length) {
            // Measure actual buttons in both modes: the borrowed dash can
            // retain a full-width preferred size after leaving Overview.
            const first = entries[0];
            const last = entries[entries.length - 1];
            const left = first.center - first.width / 2;
            const right = last.center + last.width / 2;
            const clipLeft = nativeOverview ? this._monitor.x : this._bin.x;
            const clipWidth = nativeOverview ? this._monitor.width : this._bin.width;
            room = 2 * Math.max(0, Math.min(left - clipLeft,
                clipLeft + clipWidth - right));
        }
        let growth = entries.reduce((sum, entry) => sum + entry.growth, 0);
        // Reduce the effect on crowded docks rather than clipping outer icons.
        const fit = growth > 0 ? Math.min(1, room / growth) : 1;
        growth *= fit;
        let offset = -growth / 2;
        for (const entry of entries) {
            const extra = entry.growth * fit;
            entry.state.targetScale = 1 + extra / entry.width;
            entry.state.targetOffset = (offset + extra / 2) / entry.unit;
            offset += extra;
        }
        const background = this._dash._background;
        if (background.width > 0 && !this._magnificationBackground) {
            const [pivotX, pivotY] = background.get_pivot_point();
            this._magnificationBackground = {actor: background,
                scaleX: background.scale_x, pivotX, pivotY, scale: 1, targetScale: 1};
            background.set_pivot_point(0.5, 0.5);
        }
        if (this._magnificationBackground && background.width > 0)
            this._magnificationBackground.targetScale = 1 + growth / background.width;
    }

    _applyMagnifiedTransform(button, state) {
        button.scale_x = state.scaleX * state.scale;
        button.scale_y = state.scaleY * state.scale;
        button.translation_x = state.translationX + state.offset;
        // Shell places the hover label from the item's unscaled allocation.
        // Follow the enlarged top edge (bottom pivot) and the sideways shift
        // so the name never covers the magnified icon.
        const label = button.get_parent?.()?.label;
        if (label) {
            const unit = state.unit ?? 1;
            label.translation_x = state.offset * unit;
            label.translation_y = -button.height * unit * (state.scale - 1);
        }
    }

    _startMagnificationAnimation() {
        if (this._magnificationTimeline)
            return;
        // One compositor-clock animation, independent of mouse event frequency.
        // Retargeting keeps the current velocity-free exponential response;
        // it never restarts a separate easing curve for every icon/mouse event.
        const timeline = new Clutter.Timeline({actor: this._dash, duration: 1000, repeat_count: -1});
        this._magnificationTimeline = timeline;
        timeline.connect('new-frame', () => {
            const sample = this._magnificationPointer;
            if (sample) {
                this._magnificationPointer = null;
                this._computeMagnificationTargets(...sample);
            }
            const alpha = 1 - Math.exp(-Math.max(1, timeline.get_delta()) / 45);
            let moving = false;
            for (const [button, state] of this._magnifiedIcons) {
                state.scale += (state.targetScale - state.scale) * alpha;
                state.offset += (state.targetOffset - state.offset) * alpha;
                const unsettled = Math.abs(state.targetScale - state.scale) > 0.001 ||
                    Math.abs(state.targetOffset - state.offset) > 0.05;
                moving ||= unsettled;
                this._applyMagnifiedTransform(button, state);
            }
            const bg = this._magnificationBackground;
            if (bg) {
                bg.scale += (bg.targetScale - bg.scale) * alpha;
                if (Math.abs(bg.targetScale - bg.scale) < 0.001)
                    bg.scale = bg.targetScale;
                else
                    moving = true;
                bg.actor.scale_x = bg.scaleX * bg.scale;
            }
            if (!moving) {
                // Finish the row together; snapping individual icons early
                // would briefly break the spacing between adjacent buttons.
                for (const [button, state] of this._magnifiedIcons) {
                    state.scale = state.targetScale;
                    state.offset = state.targetOffset;
                    this._applyMagnifiedTransform(button, state);
                }
                timeline.stop();
                this._magnificationTimeline = null;
                // Once an animated reset has settled, hand the (possibly
                // native Shell) dash back untouched: original pivots, row
                // clipping and a fresh baseline for the next hover.
                const idle = [...this._magnifiedIcons.values()].every(state =>
                    state.targetScale === 1 && state.targetOffset === 0) &&
                    (!bg || bg.targetScale === 1);
                if (idle) {
                    // A pointer still waiting on a late allocation keeps
                    // its pending retry; only the transforms are released.
                    const retry = this._magnificationNeedsRetry;
                    this._resetMagnification();
                    this._magnificationNeedsRetry = retry;
                }
            }
        });
        timeline.start();
    }

    _resetMagnification(animate = false) {
        this._magnificationNeedsRetry = false;
        this._magnificationPointer = null;
        for (const [button, state] of this._magnifiedIcons) {
            state.targetScale = 1;
            state.targetOffset = 0;
            if (!animate) {
                button.scale_x = state.scaleX;
                button.scale_y = state.scaleY;
                button.translation_x = state.translationX;
                button.set_pivot_point(state.pivotX, state.pivotY);
                const label = button.get_parent?.()?.label;
                if (label) {
                    label.translation_x = 0;
                    label.translation_y = 0;
                }
            }
        }
        const bg = this._magnificationBackground;
        if (bg) {
            bg.targetScale = 1;
            if (!animate) {
                bg.actor.scale_x = bg.scaleX;
                bg.actor.set_pivot_point(bg.pivotX, bg.pivotY);
                this._magnificationBackground = null;
            }
        }
        if (animate && this._magnifiedIcons.size) {
            this._startMagnificationAnimation();
        } else {
            this._magnificationTimeline?.stop();
            this._magnificationTimeline = null;
            this._magnifiedIcons.clear();
            if (!this._launchBounce && this._magnificationRowClip !== undefined) {
                this._dash._box.clip_to_allocation = this._magnificationRowClip;
                this._magnificationRowClip = undefined;
            }
        }
    }

    _dismissDock() {
        if (this._launchBounce || this._inOverview || !this._bin.visible || this._hiding)
            return;
        this._hideDesktopDock(true);
        // Hiding uncovers the edge beneath the pointer. Do not interpret that
        // synthetic enter as another reveal; require a fresh approach.
        if (!this._rearmTimeoutId) {
            // Polling alone misses a quick leave-and-return between samples.
            // Observe real motion only while waiting for a fresh approach;
            // synthetic enter/leave events from unmapping do not rearm it.
            this._rearmMotionId = global.stage.connect('captured-event', (_stage, event) => {
                if (event.type() === Clutter.EventType.MOTION &&
                    !this._containsPointer(...event.get_coords()))
                    this._clearRearm();
                return Clutter.EVENT_PROPAGATE;
            });
            this._rearmTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                const [x, y] = global.get_pointer();
                if (this._containsPointer(x, y))
                    return GLib.SOURCE_CONTINUE;
                this._rearmTimeoutId = 0;
                this._clearRearm();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _containsPointer(x, y) {
        return x >= this._bin.x && x < this._bin.x + this._bin.width &&
            y >= this._bin.y && y < this._monitor.y + this._monitor.height;
    }

    _clearRearm() {
        if (this._rearmTimeoutId) {
            GLib.source_remove(this._rearmTimeoutId);
            this._rearmTimeoutId = 0;
        }
        if (this._rearmMotionId) {
            global.stage.disconnect(this._rearmMotionId);
            this._rearmMotionId = 0;
        }
    }

    _hideDesktopDock(animate = false) {
        this._stopLaunchBounce();
        this._resetMagnification();
        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
        this._slide.remove_all_transitions();
        if (animate && this._bin.visible) {
            this._hiding = true;
            this._slide.ease({
                opacity: 0,
                translation_y: this._bin.height,
                duration: 280,
                mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
                onComplete: () => {
                    this._bin.hide();
                    this._returnNativeDash();
                    this._hiding = false;
                    this._slide.opacity = 255;
                    this._slide.translation_y = 0;
                    // A crossing can be lost as the animated actor unmaps.
                    // Respect click-dismissal and session guards in reveal.
                    if (this._containsPointer(...global.get_pointer()))
                        this._revealDock();
                },
            });
        } else {
            this._hiding = false;
            this._bin.hide();
            this._returnNativeDash();
            this._slide.opacity = 255;
            this._slide.translation_y = 0;
            this._clearRearm();
        }
    }

    _applyDockStyle() {
        if (this._dockStyle)
            return;
        // Save only our classes; other extensions may update unrelated styles.
        const classes = ['multimonitor-dock', 'mm-dock-light'];
        const originalClasses = classes.filter(name => this._dash.has_style_class_name(name));
        const blur = new Shell.BlurEffect({
            mode: Shell.BlurMode.BACKGROUND,
            brightness: 0.8,
        });
        if ('radius' in blur)
            blur.radius = 60;
        else
            blur.sigma = 30;
        this._dockStyle = {classes, originalClasses, blur};
        this._dash.add_style_class_name('multimonitor-dock');
        this._dash._background.add_effect_with_name('mm-dock-blur', blur);
        this._syncDockTheme();
    }

    _syncDockTheme() {
        if (!this._dockStyle)
            return;
        const dark = this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
        if (dark)
            this._dash.remove_style_class_name('mm-dock-light');
        else
            this._dash.add_style_class_name('mm-dock-light');
        this._dockStyle.blur.brightness = dark ? 0.8 : 1.0;
    }

    _restoreDockStyle() {
        if (!this._dockStyle)
            return;
        const {classes, originalClasses, blur} = this._dockStyle;
        this._dash._background.remove_effect(blur);
        for (const name of classes) {
            if (originalClasses.includes(name))
                this._dash.add_style_class_name(name);
            else
                this._dash.remove_style_class_name(name);
        }
        this._dockStyle = null;
    }

    _borrowNativeDash() {
        if (!this._borrowedDash || this._nativePlacement)
            return;
        const parent = this._dash.get_parent();
        this._nativePlacement = {
            parent,
            index: parent.get_children().indexOf(this._dash),
            opacity: this._dash.opacity,
            visible: this._dash.visible,
            yAlign: this._dash.y_align,
            translationY: this._dash.translation_y,
        };
        parent.remove_child(this._dash);
        this._slide.set_child(this._dash);
        this._applyDockStyle();
        // Overview lays the dash out with FILL alignment (its expanding
        // container would stretch it across our headroom) and may leave an
        // animation offset. Sit it on the monitor edge like extended docks.
        this._dash.y_align = Clutter.ActorAlign.END;
        this._dash.translation_y = 0;
        this._dash.opacity = 255;
        this._dash.show();
    }

    _returnNativeDash() {
        if (!this._nativePlacement)
            return;
        const {parent, index, opacity, visible, yAlign, translationY} = this._nativePlacement;
        this._nativePlacement = null;
        this._restoreDockStyle();
        this._slide.remove_child(this._dash);
        parent.insert_child_at_index(this._dash, index);
        this._dash.y_align = yAlign;
        this._dash.translation_y = translationY;
        this._dash.opacity = opacity;
        this._dash.visible = visible;
        parent.queue_relayout();
    }

    _nativeOverviewOwnsLayout() {
        return this._borrowedDash && (this._inOverview ||
            Main.overview.visible || Main.overview.animationInProgress);
    }

    _queuePositionUpdate() {
        if (this._nativeOverviewOwnsLayout() || this._positionIdleId)
            return;
        // Size notifications can fire during allocation; defer layout changes
        // to before the next frame. An idle source would be starved by
        // overview/workspace animations, leaving the clipped bin at its old
        // width so added icons stay hidden until the animation ends.
        this._positionIdleId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._positionIdleId = 0;
                this._updatePosition();
                this._updateMagnification(...global.get_pointer());
                return GLib.SOURCE_REMOVE;
            });
    }

    _getLocalShowAppsButton() {
        if (!this._dash)
            return null;

        return this._dash.showAppsButton ?? null;
    }

    _connectShowAppsButton() {
        const button = this._getLocalShowAppsButton();
        if (!button || this._showAppsButtonId)
            return;

        this._showAppsButtonId = button.connect('notify::checked',
            () => this._onShowAppsButtonToggled());
    }

    _getOverviewControls() {
        return Main.overview?._overview?.controls ??
            Main.overview?._overview?._controls ??
            Main.overview?._controls ??
            null;
    }

    _getOverviewStateAdjustment() {
        return this._getOverviewControls()?._stateAdjustment ?? null;
    }

    _getPrimaryShowAppsButton() {
        const controls = this._getOverviewControls();
        return controls?.dash?.showAppsButton ??
            controls?._dash?.showAppsButton ??
            Main.overview?.dash?.showAppsButton ??
            null;
    }

    _connectOverviewStateAdjustment() {
        if (this._borrowedDash)
            return;
        const adjustment = this._getOverviewStateAdjustment();
        if (!adjustment || adjustment === this._stateAdjustment)
            return;

        if (this._stateAdjustment && this._stateAdjustmentId)
            this._stateAdjustment.disconnect(this._stateAdjustmentId);

        this._stateAdjustment = adjustment;
        this._stateAdjustmentId = adjustment.connect('notify::value',
            () => this._syncShowAppsButton());
        this._syncShowAppsButton();
    }

    _setShowAppsChecked(checked) {
        if (this._borrowedDash)
            return;
        const button = this._getLocalShowAppsButton();
        if (!button)
            return;

        try {
            if (button.checked === checked)
                return;

            this._ignoreShowAppsButtonToggle = true;
            button.checked = checked;
        } finally {
            this._ignoreShowAppsButtonToggle = false;
        }
    }

    _syncShowAppsButton() {
        const adjustment = this._getOverviewStateAdjustment();
        if (!adjustment)
            return;

        const appGridState = OverviewControls.ControlsState?.APP_GRID ?? 2;
        this._setShowAppsChecked(adjustment.value >= appGridState - 0.5);
    }

    _onShowAppsButtonToggled() {
        if (this._borrowedDash) {
            // Shell's own toggle handler changes the overview state, but
            // does not open it when this button is used from the desktop.
            if (this._nativePlacement && !Main.overview.visible &&
                this._dash.showAppsButton.checked) {
                this._hideDesktopDock();
                Main.overview.show(OverviewControls.ControlsState?.APP_GRID ?? 2);
            }
            return;
        }
        if (this._ignoreShowAppsButtonToggle)
            return;

        const button = this._getLocalShowAppsButton();
        if (!button)
            return;

        const controlsState = OverviewControls.ControlsState ?? {
            WINDOW_PICKER: 1,
            APP_GRID: 2,
        };
        let checked = false;
        checked = button.checked;

        const targetState = checked ? controlsState.APP_GRID : controlsState.WINDOW_PICKER;

        if (!Main.overview.visible) {
            if (targetState === controlsState.APP_GRID) {
                if (Main.overview.showApps)
                    Main.overview.showApps();
                else
                    Main.overview.show(targetState);
            } else {
                Main.overview.show(targetState);
            }
            return;
        }

        const primaryButton = this._getPrimaryShowAppsButton();
        if (primaryButton && primaryButton !== button) {
            if (primaryButton.checked === checked)
                return;
            primaryButton.checked = checked;
            return;
        }

        const adjustment = this._getOverviewStateAdjustment();
        if (!adjustment)
            return;

        adjustment.remove_transition('value');
        adjustment.ease(targetState, {
            duration: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME ?? 250,
            mode: Clutter.AnimationMode.EASE_OUT_SINE,
        });
    }

    _updatePosition() {
        if (!this._bin || !this._dash || this._nativeOverviewOwnsLayout())
            return;

        // Use the Dash's natural height; fall back to 60 px
        let [, natHeight] = this._dash.get_preferred_height(-1);
        if (!natHeight || natHeight <= 0)
            natHeight = 60;

        if (!this._borrowedDash)
            this._dash.setMaxSize(this._monitor.width, this._monitor.height);
        const [, natWidth] = this._dash.get_preferred_width(natHeight);
        // Reserve room inside the monitor clip for enlarged icons. The slide
        // remains naturally sized and bottom-aligned, keeping hit targets stable.
        const extra = this._settings.get_boolean('dock-magnification') ? Math.ceil(natHeight * 0.5) : 0;
        const headroom = extra + Math.ceil(natHeight * 0.4);
        const width = Math.min(this._monitor.width, Math.max(1, natWidth) + extra * 4);
        this._dockNaturalWidth = Math.max(1, natWidth);
        this._bin.set_size(width, natHeight + headroom);
        this._bin.set_position(
            this._monitor.x + Math.floor((this._monitor.width - width) / 2),
            this._monitor.y + this._monitor.height - natHeight - headroom
        );
        const edgeWidth = Math.min(this._monitor.width, Math.max(1, natWidth));
        this._edge.set_size(edgeWidth, 2);
        this._edge.set_position(this._monitor.x + Math.floor((this._monitor.width - edgeWidth) / 2),
            this._monitor.y + this._monitor.height - 2);
    }

    _getMonitorIndex() {
        // Match by the dock monitor's center, not exact geometry: extended
        // docks are not always handed updated geometry on monitor changes
        // (scale, resume), and an exact mismatch would hide every app.
        const cx = this._monitor.x + this._monitor.width / 2;
        const cy = this._monitor.y + this._monitor.height / 2;
        return Main.layoutManager.monitors.findIndex(monitor =>
            cx >= monitor.x && cx < monitor.x + monitor.width &&
            cy >= monitor.y && cy < monitor.y + monitor.height);
    }

    updateMonitor(monitor) {
        if (!this._inOverview)
            this._hideDesktopDock();
        this._monitor = {
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        };
        this._updatePosition();
    }

    destroy() {
        // Disconnect every handler before touching any actor, so nothing can
        // call back into a half-destroyed dock. No "destroying" flag needed.
        this._settings.disconnect(this._hoverSettingId);
        this._settings.disconnect(this._magnificationSettingId);
        Main.sessionMode.disconnect(this._sessionUpdatedId);
        global.display.disconnect(this._fullscreenChangedId);
        global.display.disconnect(this._focusWindowId);
        Main.overview.disconnect(this._overviewHiddenId);
        this._isolation?.destroy();
        this._isolation = null;
        // 'startup-complete' and the app-item 'clicked' handlers are owned by
        // this._bin via connectObject and drop when it is destroyed below.

        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }

        if (this._overviewHidingId) {
            Main.overview.disconnect(this._overviewHidingId);
            this._overviewHidingId = null;
        }

        if (this._stateAdjustment && this._stateAdjustmentId) {
            this._stateAdjustment.disconnect(this._stateAdjustmentId);
            this._stateAdjustment = null;
            this._stateAdjustmentId = null;
        }

        const showAppsButton = this._getLocalShowAppsButton();
        if (showAppsButton && this._showAppsButtonId) {
            showAppsButton.disconnect(this._showAppsButtonId);
            this._showAppsButtonId = null;
        }

        if (this._dash && this._heightChangedId) {
            this._dash.disconnect(this._heightChangedId);
            this._heightChangedId = null;
        }
        if (this._dash && this._widthChangedId) {
            this._dash.disconnect(this._widthChangedId);
            this._widthChangedId = null;
        }

        this._hideDesktopDock();
        if (this._positionIdleId) {
            global.compositor.get_laters().remove(this._positionIdleId);
            this._positionIdleId = 0;
        }

        Main.layoutManager.removeChrome(this._edge);
        this._edge.destroy();
        this._edge = null;

        if (this._inOverview && !this._borrowedDash)
            Main.layoutManager.overviewGroup.remove_child(this._bin);
        else
            Main.layoutManager.removeChrome(this._bin);

        this._restoreDockStyle();
        this._bin.destroy();
        this._bin = null;
        this._slide = null;
        this._dash = null;
    }
}
