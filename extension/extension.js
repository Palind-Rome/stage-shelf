import Gio from 'gi://Gio';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Mtk from 'gi://Mtk';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Fade the last pixels inside the projected silhouette. Texture filtering
// alone smooths window contents but leaves the polygon edge aliased.
const PreviewEdge = GObject.registerClass(class StageShelfPreviewEdge extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(Shell.SnippetHook.FRAGMENT, 'uniform vec2 faceSize;', `
            vec2 p = abs(cogl_tex_coord_in[0].st - vec2(0.5)) * faceSize;
            float radius = min(4.0, min(faceSize.x, faceSize.y) * 0.15);
            vec2 q = p - faceSize * 0.5 + vec2(radius + 1.35);
            float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
            cogl_color_out *= 1.0 - smoothstep(-1.3, 1.3, d);
        `, false);
    }

    sizeFor(width, height) {
        this.set_uniform_float(this.get_uniform_location('faceSize'), 2, [width, height]);
    }
});

export default class StageShelf extends Extension {
    enable() {
        this._running = true;
        this._signals = [];
        this._watched = new Map();
        this._parked = new Set();
        this._manual = new Set();
        this._single = false;
        this._updates = new Set();
        this._updateTimer = 0;
        this._pictures = new Map();
        this._captures = new WeakMap();
        this._groups = new Map();
        this._front = null;
        this._pending = 0;
        this._hintTimer = 0;
        this._offset = 0;
        this._placed = new Map();
        this._slots = new Map();
        this._pageKey = '';
        this._recentVisible = true;
        this._previewActors = new Map();
        this._tracker = Shell.WindowTracker.get_default();
        this._shelf = new St.BoxLayout({vertical: true, reactive: true, track_hover: true, style: 'spacing: 8px;'});
        this._opening = new St.Adjustment({actor: this._shelf, lower: 0, upper: 1, value: 0});
        Main.layoutManager.addChrome(this._shelf, {trackFullscreen: true});
        this._edge = new St.Widget({reactive: true});
        Main.layoutManager.addChrome(this._edge, {trackFullscreen: true});
        this._edge.hide();
        this._edge.connect('enter-event', () => {
            if (this._fullscreen()) {
                this._hideShelf();
                return Clutter.EVENT_PROPAGATE;
            }
            this._edge.hide();
            this._shelf.show();
            this._turnShelf(true);
            this._shelf.translation_x = -this._shelf.width * 0.65;
            this._shelf.opacity = 100;
            this._shelf.ease({translation_x: 0, opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            return Clutter.EVENT_PROPAGATE;
        });
        this._shelf.connect('notify::hover', () => {
            this._turnShelf();
            if (this._covered && !this._shelf.hover && !this._hint)
                this._queue();
            return Clutter.EVENT_PROPAGATE;
        });
        this._shelf.connect('scroll-event', (_actor, event) => {
            const direction = event.get_scroll_direction();
            const dy = direction === Clutter.ScrollDirection.SMOOTH
                ? event.get_scroll_delta()[1] : direction === Clutter.ScrollDirection.UP ? -1 : 1;
            this._offset += Math.sign(dy);
            this._queue();
            return Clutter.EVENT_STOP;
        });
        this._button = new PanelMenu.Button(0, 'Stage Shelf');
        this._button.add_child(new St.Icon({icon_name: 'view-dual-symbolic', style_class: 'system-status-icon'}));
        const toggle = new PopupMenu.PopupSwitchMenuItem('显示最近窗口', true);
        this._button.menu.addMenuItem(toggle);
        toggle.connect('toggled', (_item, state) => {
            this._recentVisible = state;
            this._queue();
        });
        const single = new PopupMenu.PopupSwitchMenuItem('同一应用一次显示一个窗口', false);
        this._button.menu.addMenuItem(single);
        single.connect('toggled', (_item, state) => {
            this._single = state;
            this._queue();
        });
        this._button.menu.addAction('显示桌面', () => this._desktop());
        this._joinMenu = new PopupMenu.PopupSubMenuMenuItem('添加窗口到当前组合');
        this._button.menu.addMenuItem(this._joinMenu);
        this._tile = this._button.menu.addAction('并排显示两个窗口', () => this._tilePair());
        this._split = this._button.menu.addAction('将当前窗口移出组合', () => this._separate());
        this._button.menu.addAction('退出台前调度', () => Main.extensionManager.disableExtension(this.uuid),
            'system-log-out-symbolic');
        this._button.menu.connect('open-state-changed', (_menu, open) => {
            if (!open)
                return;
            const focus = this._focus();
            const others = this._companions(focus);
            this._tile.visible = others.length === 1;
            this._split.visible = others.length > 0;
            this._joinMenu.menu.removeAll();
            this._joinMenu.visible = this._watched.has(focus) && this._parked.size > 0;
            for (const w of this._parked) {
                const app = this._tracker.get_window_app(w);
                this._joinMenu.menu.addAction(w.get_title() || app?.get_name() || '窗口', () => {
                    if (this._parked.has(w))
                        this._select([w], true);
                });
            }
        });
        Main.panel.addToStatusArea(this.uuid, this._button);

        for (const [object, event] of [
            [global.display, 'notify::focus-window'], [global.display, 'window-created'],
            [global.display, 'grab-op-end'], [global.display, 'workareas-changed'], [global.display, 'in-fullscreen-changed'],
            [global.display, 'window-entered-monitor'], [global.display, 'window-left-monitor'],
            [global.workspace_manager, 'active-workspace-changed'],
            [global.window_manager, 'map'], [global.window_manager, 'destroy'], [Main.overview, 'hidden'],
            [Main.layoutManager, 'monitors-changed'],
        ])
            this._signals.push([object, object.connect(event, () => this._queue())]);
        this._signals.push([global.stage, global.stage.connect('captured-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1) {
                const [x, y] = event.get_coords();
                const hit = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
                if (hit && Main.layoutManager._backgroundGroup?.contains(hit))
                    this._desktop();
            }
            return Clutter.EVENT_PROPAGATE;
        })]);
        this._signals.push([global.display, global.display.connect('notify::focus-window', () => {
            if (global.display.focus_window?.get_window_type() === Meta.WindowType.DESKTOP)
                this._desktop();
        })]);
        this._signals.push([global.display, global.display.connect('grab-op-begin', (_display, w, op) => {
            if (![Meta.GrabOp.MOVING, Meta.GrabOp.MOVING_UNCONSTRAINED].includes(op) ||
                !this._companions(w).length || this._fullscreen())
                return;
            const area = Main.layoutManager.getWorkAreaForMonitor(w.get_monitor());
            const width = this._railWidth(area);
            this._removeTarget = new St.Label({text: '移出组合', style_class: 'stage-remove-target',
                width, y_align: Clutter.ActorAlign.CENTER});
            Main.layoutManager.addChrome(this._removeTarget);
            this._removeTarget.set_position(area.x, area.y + Math.floor(area.height / 2));
        })]);
        this._signals.push([global.display, global.display.connect('grab-op-end', (_display, w) => {
            const target = this._removeTarget;
            if (!target)
                return;
            const [x, y] = global.get_pointer();
            const [tx, ty] = target.get_transformed_position();
            const inside = x >= tx && x < tx + target.width && y >= ty && y < ty + target.height;
            target.destroy();
            this._removeTarget = null;
            if (inside)
                this._separate(w);
        })]);
        this._signals.push([Main.overview, Main.overview.connect('showing', () => this._hideShelf())]);
        this._queue();
    }

    _queue() {
        if (!this._running || this._pending)
            return;
        this._pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pending = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _id(w) {
        return this._tracker.get_window_app(w)?.get_id() ?? w.get_wm_class() ?? w.get_stable_sequence();
    }

    _group(w) {
        const id = this._id(w);
        return this._groups.get(w) ?? (this._single ? w : id);
    }

    _focus() {
        let w = global.display.focus_window;
        while (w?.get_transient_for())
            w = w.get_transient_for();
        return w;
    }

    _restore(w) {
        this._manual.delete(w);
        if (this._parked.delete(w) && w.minimized)
            this._animateWindow(w, false);
    }

    _animateWindow(w, park) {
        if (w.get_monitor() < 0) {
            if (!park)
                w.unminimize();
            return;
        }
        const area = Main.layoutManager.getWorkAreaForMonitor(w.get_monitor());
        const width = this._railWidth(area);
        const slot = this._slots.get(w) ?? new Mtk.Rectangle({x: area.x + 4,
            y: Math.round(area.y + (area.height - width) / 2), width, height: Math.round(width * 0.85)});
        const [had, old] = w.get_icon_geometry();
        w.set_icon_geometry(slot);
        try {
            if (park)
                w.minimize();
            else
                w.unminimize();
        } finally {
            w.set_icon_geometry(had ? old : null);
        }
    }

    _turnShelf(open = this._covered && (this._shelf.hover || Boolean(this._hint?.hover))) {
        if (this._openingTarget === Boolean(open))
            return;
        this._openingTarget = Boolean(open);
        this._opening.ease(open ? 1 : 0, {
            duration: open ? 210 : 185,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _hideShelf() {
        this._closeHint();
        this._shelf.hide();
        this._edge.hide();
        this._covered = false;
        this._turnShelf(false);
    }

    _reset() {
        for (const w of this._manual) {
            this._parked.delete(w);
            this._pictures.delete(w);
        }
        this._manual.clear();
        for (const w of this._parked)
            this._restore(w);
        for (const [w, pos] of this._placed) {
            const frame = w.get_frame_rect();
            if (pos && frame.x === pos.x && frame.y === pos.y && !w.get_maximized() && !w.fullscreen)
                w.move_frame(false, pos.oldX, pos.oldY);
        }
        this._pictures.clear();
        this._placed.clear();
        this._slots.clear();
        this._pageKey = '';
        this._front = null;
        this._groups.clear();
        this._offset = 0;
        this._hideShelf();
    }

    _park(w) {
        const actor = w.get_compositor_private();
        if (!actor?.mapped || !w.can_minimize())
            return;
        this._capture(w, actor);
        this._parked.add(w);
        this._animateWindow(w, true);
    }

    async _capture(w, actor) {
        const ticket = {};
        try {
            const buffer = actor.get_texture()?.get_texture();
            if (!buffer)
                return;
            // X11 supplies a single client texture before Shell applies its fade.
            const texture = !Meta.is_wayland_compositor() && buffer.is_simple()
                ? buffer.get_plane(0) : actor.paint_to_content(null)?.get_texture();
            if (!texture)
                return;
            this._captures.set(w, ticket);
            const stream = Gio.MemoryOutputStream.new_resizable();
            let raw;
            try {
                raw = await Shell.Screenshot.composite_to_stream(texture, 0, 0,
                    texture.get_width(), texture.get_height(), 1, null, 0, 0, 1, stream);
            } finally {
                stream.close(null);
            }
            if (!raw || !this._running || !this._watched.has(w) || this._captures.get(w) !== ticket)
                return;
            const scale = Math.min(1, 480 / Math.max(raw.width, raw.height));
            const width = Math.max(1, Math.round(raw.width * scale));
            const height = Math.max(1, Math.round(raw.height * scale));
            const pixels = raw.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR);
            const bytes = pixels.read_pixel_bytes();
            // A successful readback may still be entirely transparent during unmap.
            const data = bytes.get_data();
            let visible = !pixels.has_alpha;
            for (let y = 0; y < height && !visible; y++) {
                for (let x = 0; x < width; x++) {
                    if (data[y * pixels.rowstride + x * 4 + 3] > 16) {
                        visible = true;
                        break;
                    }
                }
            }
            if (!visible)
                return;
            const content = new Clutter.Image();
            content.set_bytes(bytes, pixels.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888, width, height, pixels.rowstride);
            this._pictures.set(w, {content});
            const picture = this._previewActors.get(w);
            if (picture) {
                picture.content = content;
            } else if (this._parked.has(w)) {
                this._pageKey = '';
                this._queue();
            }
        } catch (error) {
            console.debug('Stage Shelf preview unavailable', error.message);
        }
    }

    _desktop() {
        if (Main.overview.visible || this._fullscreen())
            return;
        for (const w of this._watched.keys()) {
            if (!w.minimized)
                this._park(w);
        }
        this._front = null;
        this._queue();
    }

    _damage(w) {
        if (this._pictures.has(w) && (!this._parked.has(w) || !this._shelf.visible))
            return;
        this._updates.add(w);
        if (this._updateTimer)
            return;
        this._updateTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._updateTimer = 0;
            for (const window of this._updates) {
                const actor = window.get_compositor_private();
                if (actor?.mapped && this._watched.has(window))
                    this._capture(window, actor);
            }
            this._updates.clear();
            this._queue();
            return GLib.SOURCE_REMOVE;
        });
    }

    _fullscreen() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        const ws = global.workspace_manager.get_active_workspace();
        // IME candidate windows may temporarily defeat Mutter's monitor-level
        // fullscreen heuristic. The underlying client's fullscreen flag persists.
        return monitor.inFullscreen || ws.list_windows().some(w =>
            w.fullscreen && !w.minimized && w.get_monitor() === monitor.index);
    }

    _sync() {
        const monitor = Main.layoutManager.primaryMonitor;
        const workspace = global.workspace_manager.get_active_workspace();
        if (this._drop)
            return;
        if (!monitor || Main.overview.visible || this._fullscreen()) {
            this._hideShelf();
            return;
        }
        if (this._workspace !== workspace) {
            this._workspace = workspace;
            this._reset();
        }
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace)
            .filter(w => w.get_window_type() === Meta.WindowType.NORMAL && !w.skip_taskbar &&
                !w.is_on_all_workspaces() && w.get_monitor() === monitor.index);
        const live = new Set(windows);
        for (const [w, ids] of this._watched) {
            if (!live.has(w)) {
                if (this._manual.delete(w))
                    this._parked.delete(w);
                this._restore(w);
                this._updates.delete(w);
                this._pictures.delete(w);
                w.get_compositor_private()?.disconnectObject(this);
                ids.forEach(id => w.disconnect(id));
                this._watched.delete(w);
                this._placed.delete(w);
                this._groups.delete(w);
                this._slots.delete(w);
            }
        }
        for (const w of windows) {
            if (!this._watched.has(w)) {
                const ids = ['notify::fullscreen', 'notify::maximized-horizontally', 'position-changed', 'size-changed', 'workspace-changed'].map(signal =>
                    w.connect(signal, () => this._queue()));
                const actor = w.get_compositor_private();
                actor?.connectObject('damaged', () => this._damage(w), this);
                ids.push(w.connect('notify::minimized', () => {
                    if (w.minimized && !this._parked.has(w)) {
                        if (actor?.mapped)
                            this._capture(w, actor);
                        this._groups.set(w, Symbol());
                        this._parked.add(w);
                        this._manual.add(w);
                    } else if (!w.minimized) {
                        this._manual.delete(w);
                    }
                    this._queue();
                }));
                ids.push(w.connect('unmanaged', () => {
                    actor?.disconnectObject(this);
                    this._updates.delete(w);
                    this._manual.delete(w);
                    this._parked.delete(w);
                    this._pictures.delete(w);
                    this._watched.delete(w);
                    this._placed.delete(w);
                    this._groups.delete(w);
                    this._slots.delete(w);
                    this._queue();
                }));
                this._watched.set(w, ids);
                if (actor?.mapped)
                    this._damage(w);
            }
        }

        const focus = this._focus();
        if (live.has(focus) && !focus.minimized)
            this._front = this._group(focus);
        else if (!windows.some(w => this._group(w) === this._front && !w.minimized))
            this._front = this._groupOrNull(windows.find(w => !w.minimized));

        const stages = new Map();
        for (const w of windows) {
            const group = this._group(w);
            if (group === this._front) {
                this._restore(w);
            } else if (this._front !== null && !w.minimized) {
                this._park(w);
            }
            if (this._parked.has(w)) {
                if (!stages.has(group))
                    stages.set(group, []);
                stages.get(group).push(w);
            }
        }
        if (stages.size && live.has(focus) && !this._placed.has(focus) && !focus.minimized) {
            this._placed.set(focus, null);
            const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
            const r = focus.get_frame_rect();
            const gutter = this._railWidth(area);
            if (!focus.get_maximized() && !focus.fullscreen && !focus.get_tile_match() &&
                !this._companions(focus).length && r.width <= area.width - 2 * gutter && r.height < area.height) {
                const x = Math.round(area.x + (area.width + gutter - r.width) / 2);
                const y = Math.round(area.y + (area.height - r.height) / 2);
                this._placed.set(focus, {x, y, oldX: r.x, oldY: r.y});
                focus.move_frame(false, x, y);
            }
        }
        this._draw([...stages.values()], monitor);
    }

    _groupOrNull(w) {
        return w ? this._group(w) : null;
    }

    _select(windows, join) {
        const target = windows[0];
        if (join && this._front !== null) {
            // Preserve explicitly joined members across display-mode changes.
            for (const w of this._watched.keys()) {
                if (!w.minimized && this._group(w) === this._front)
                    this._groups.set(w, this._front);
            }
            for (const w of windows)
                this._groups.set(w, this._front);
        }
        this._front = this._group(target);
        for (const w of windows)
            this._restore(w);
        Main.activateWindow(target);
        this._offset = 0;
        this._queue();
    }

    _companions(w) {
        if (!this._watched.has(w))
            return [];
        return [...this._watched.keys()].filter(other =>
            other !== w && !other.minimized && this._group(other) === this._group(w));
    }

    _tilePair() {
        const focus = this._focus();
        const others = this._companions(focus);
        if (others.length !== 1)
            return;
        const area = Main.layoutManager.getWorkAreaForMonitor(focus.get_monitor());
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const gap = 10 * scale;
        const inset = this._recentVisible && this._parked.size ? this._railWidth(area) + gap : gap;
        const width = Math.floor((area.width - inset - 2 * gap) / 2);
        [others[0], focus].forEach((w, i) => {
            if (w.fullscreen)
                w.unmake_fullscreen();
            w.unmaximize(Meta.MaximizeFlags.BOTH);
            this._placed.set(w, null);
            w.move_resize_frame(true, area.x + inset + i * (width + gap), area.y + gap,
                width, Math.max(1, area.height - 2 * gap));
        });
    }

    _separate(w = this._focus()) {
        const [next] = this._companions(w);
        if (!next)
            return;
        this._groups.set(w, Symbol());
        this._front = this._group(next);
        this._park(w);
        Main.activateWindow(next);
        this._queue();
    }

    _railWidth(area) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return Math.round(Math.min(150 * scale, Math.max(94 * scale, area.width * 0.095)));
    }

    _draw(stages, monitor) {
        if (!stages.length || this._fullscreen()) {
            this._pageKey = '';
            this._shelf.destroy_all_children();
            this._hideShelf();
            return;
        }
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const width = this._railWidth(area);
        const height = Math.round(width * 0.91);
        const gap = 8 * scale;
        const capacity = Math.max(1, Math.min(6, Math.floor((area.height - 16 * scale) / (height + gap))));
        this._offset = Math.max(0, Math.min(this._offset, stages.length - capacity));
        const page = stages.slice(this._offset, this._offset + capacity);
        const total = page.length * height + (page.length - 1) * gap;
        const x = area.x + 5 * scale;
        const y = Math.round(area.y + (area.height - total) / 2);
        const key = JSON.stringify([width, scale, ...page.map(set => set.map(w => w.get_stable_sequence()))]);
        if (key !== this._pageKey) {
            this._closeHint();
            this._shelf.destroy_all_children();
            page.forEach((windows, i) => {
                const tilt = Math.max(-1, Math.min(1, (total / 2 - i * (height + gap) - height / 2) / (2 * height)));
                this._shelf.add_child(this._card(windows, width, height, scale, tilt));
            });
            this._pageKey = key;
        }
        this._shelf.set_position(x, y);
        page.forEach((windows, i) => {
            const slot = new Mtk.Rectangle({x, y: y + i * (height + gap), width, height});
            for (const w of windows)
                this._slots.set(w, slot);
        });
        this._edge.set_position(area.x, y);
        this._edge.set_size(6 * scale, total);
        this._covered = !this._recentVisible || [...this._watched.keys()].some(w => {
            if (w.minimized)
                return false;
            const r = w.get_frame_rect();
            return r.x < x + width && r.x + r.width > x && r.y < y + total && r.y + r.height > y;
        });
        const [px, py] = global.get_pointer();
        const inside = px >= area.x && px <= x + width && py >= y && py <= y + total;
        this._shelf.visible = !this._covered || inside || Boolean(this._hint?.hover);
        this._edge.visible = !this._shelf.visible;
        this._turnShelf(this._covered && this._shelf.visible);
    }

    _closeHint() {
        if (this._hintTimer)
            GLib.Source.remove(this._hintTimer);
        this._hintTimer = 0;
        const hint = this._hint;
        this._hint = null;
        hint?.destroy();
    }

    _delayHint(delay, callback) {
        if (!this._running)
            return;
        if (this._hintTimer)
            GLib.Source.remove(this._hintTimer);
        this._hintTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hintTimer = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    _members(button, windows) {
        this._closeHint();
        if (this._drop || !button.mapped || !windows.every(w => this._parked.has(w)))
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const panel = new St.BoxLayout({vertical: true, reactive: true, track_hover: true,
            style_class: 'stage-members', width: Math.round(Math.min(312 * scale, area.width * 0.55))});
        this._hint = panel;
        Main.layoutManager.addChrome(panel);
        const heading = new St.Label({text: `组合中的窗口 · ${windows.length}`, style_class: 'stage-members-heading'});
        panel.add_child(heading);
        const scroll = new St.ScrollView({hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true});
        panel.add_child(scroll);
        const list = new St.BoxLayout({vertical: true});
        scroll.set_child(list);
        for (const w of windows) {
            const app = this._tracker.get_window_app(w);
            const title = w.get_title() || '';
            const name = app?.get_name() || w.get_wm_class() || '窗口';
            const row = new St.Button({style_class: 'stage-member', can_focus: true,
                x_expand: true, accessible_name: [name, title].join(' ')});
            const line = new St.BoxLayout({style_class: 'stage-member-line',
                width: Math.max(1, panel.width - 36 * scale)});
            const icon = app?.create_icon_texture(24);
            if (icon) {
                icon.y_align = Clutter.ActorAlign.CENTER;
                line.add_child(icon);
            }
            const labels = new St.BoxLayout({vertical: true, x_expand: true});
            labels.add_child(new St.Label({text: name, style_class: 'stage-member-app'}));
            if (title && title !== name)
                labels.add_child(new St.Label({text: title, style_class: 'stage-member-title'}));
            line.add_child(labels);
            row.set_child(line);
            row.connect('clicked', () => {
                this._closeHint();
                if (this._parked.has(w))
                    this._select([w, ...windows.filter(other => other !== w && this._parked.has(other))], false);
            });
            list.add_child(row);
        }
        const maxHeight = Math.round(area.height * 0.63);
        scroll.height = Math.min(maxHeight, list.get_preferred_height(panel.width - 28 * scale)[1]);
        const h = panel.get_preferred_height(panel.width)[1];
        const [x, y] = button.get_transformed_position();
        panel.set_position(Math.round(x + button.width + 2 * scale),
            Math.max(area.y, Math.min(area.y + area.height - h, Math.round(y + (button.height - h) / 2))));
        panel.connect('notify::hover', () => {
            this._turnShelf();
            if (!panel.hover)
                this._delayHint(220, () => { if (!button.hover) { this._closeHint(); this._queue(); } });
        });
        panel.opacity = 0;
        panel.ease({opacity: 255, duration: 120});
    }

    _card(windows, width, height, scale, tilt) {
        const apps = windows.map(w => this._tracker.get_window_app(w));
        const names = [...new Set(windows.map((w, i) => apps[i]?.get_name() ?? w.get_title()))];
        const button = new St.Button({style_class: 'stage-card', can_focus: true,
            accessible_name: names.join(' · '), track_hover: true});
        const layout = new Clutter.Actor({width, height});
        button.set_child(layout);
        const rects = windows.map(w => w.get_frame_rect());
        const left = Math.min(...rects.map(r => r.x));
        const top = Math.min(...rects.map(r => r.y));
        const spanX = Math.max(...rects.map(r => r.x + r.width)) - left;
        const spanY = Math.max(...rects.map(r => r.y + r.height)) - top;
        const shrink = Math.min(height * 0.78 / Math.max(1, spanY), width * 1.40 / Math.max(1, spanX));
        const shades = [];
        const composite = new Clutter.Actor({width: spanX * shrink, height: spanY * shrink});
        const updatePerspective = () => {
            const progress = this._opening.value;
            const rest = 1 - progress;
            const taper = 0.12 * rest;
            const fit = Math.min(1, (width - 8 * scale) / composite.width);
            const sy = rest + fit * progress;
            const sx = 0.72 * rest + fit * progress;
            const matrix = new Graphene.Matrix();
            matrix.init_from_float([sx, tilt * 0.15 * rest + taper * composite.height / (2 * composite.width),
                0, taper / composite.width, 0, sy, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
            composite.set_transform(matrix);
            composite.set_position(5 * scale, (height - composite.height * sy) / 2);
        };
        updatePerspective();
        this._opening.connectObject('notify::value', updatePerspective, composite);
        layout.add_child(composite);

        for (let i = rects.length - 1; i >= 0; i--) {
            const r = rects[i];
            const shot = this._pictures.get(windows[i]);
            const w = Math.max(1, r.width * shrink);
            const h = Math.max(1, r.height * shrink);
            const face = new St.Widget({style_class: 'stage-face', width: w, height: h});
            if (shot?.content) {
                const picture = new Clutter.Actor({content: shot.content, width: w, height: h});
                picture.set_content_scaling_filters(Clutter.ScalingFilter.TRILINEAR, Clutter.ScalingFilter.LINEAR);
                const edge = new PreviewEdge();
                picture.add_effect(edge);
                edge.sizeFor(w, h);
                face.add_child(picture);
                const window = windows[i];
                this._previewActors.set(window, picture);
                picture.connect('destroy', () => {
                    if (this._previewActors.get(window) === picture)
                        this._previewActors.delete(window);
                });
            } else {
                face.add_style_class_name('stage-unavailable');
                const label = new St.Label({text: apps[i]?.get_name() || windows[i].get_title() || '窗口',
                    style_class: 'stage-missing', width: w});
                face.add_child(label);
                label.y = Math.round(h * 0.35);
            }
            const shade = new St.Widget({style_class: 'stage-idle-shade', width: w, height: h, opacity: 32});
            face.add_child(shade);
            shades.push(shade);
            // Expose a sliver when multiple windows occupy the same rectangle.
            const coincident = i > 0 && Math.abs(r.x - rects[0].x) * shrink < 4 * scale &&
                Math.abs(r.y - rects[0].y) * shrink < 4 * scale;
            face.set_position((r.x - left) * shrink + (coincident ? 7 * scale * Math.min(3, i) : 0),
                (r.y - top) * shrink - (coincident ? 3 * scale * Math.min(3, i) : 0));
            composite.add_child(face);
        }
        const uniqueApps = [...new Set(apps.filter(Boolean))];
        uniqueApps.slice(0, 3).forEach((app, i) => {
            const icon = app.create_icon_texture(24);
            const positionIcon = () => {
                const anchor = height - composite.y;
                icon.set_position(i * 21 * scale, Math.min(height - 24 * scale, anchor - 15 * scale));
            };
            positionIcon();
            composite.connectObject('notify::y', positionIcon, icon);
            layout.add_child(icon);
        });
        composite.set_pivot_point(0, 0.5);
        button.connect('notify::hover', () => {
            const magnification = button.hover && !this._covered ? 1.08 : 1;
            composite.ease({scale_x: magnification, scale_y: magnification, duration: 145,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            for (const shade of shades)
                shade.ease({opacity: button.hover ? 0 : 32, duration: 145});
            if (windows.length > 1) {
                if (button.hover)
                    this._delayHint(320, () => this._members(button, windows));
                else
                    this._delayHint(220, () => { if (!this._hint?.hover) { this._closeHint(); this._queue(); } });
            }
        });
        button.connect('clicked', () =>
            this._select(windows, Boolean(global.get_pointer()[2] & Clutter.ModifierType.SHIFT_MASK)));
        button._delegate = {getDragActor: () => new Clutter.Clone({source: layout, width, height}),
            getDragActorSource: () => layout};
        const drag = DND.makeDraggable(button);
        drag.connect('drag-begin', () => {
            this._closeHint();
            const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            this._drop = new St.Widget({reactive: true});
            this._drop.set_position(area.x + width + 6 * scale, area.y);
            this._drop.set_size(Math.max(1, area.width - width - 6 * scale), area.height);
            this._drop._delegate = {
                handleDragOver: () => DND.DragMotionResult.MOVE_DROP,
                acceptDrop: () => {
                    this._select([windows[0]], true);
                    return true;
                },
            };
            Main.layoutManager.addChrome(this._drop);
        });
        drag.connect('drag-end', () => {
            this._drop?.destroy();
            this._drop = null;
            this._queue();
        });
        return button;
    }

    disable() {
        this._running = false;
        this._removeTarget?.destroy();
        this._removeTarget = null;
        for (const [object, id] of this._signals)
            object.disconnect(id);
        for (const [w, ids] of this._watched) {
            w.get_compositor_private()?.disconnectObject(this);
            ids.forEach(id => w.disconnect(id));
        }
        if (this._updateTimer)
            GLib.Source.remove(this._updateTimer);
        this._updates.clear();
        this._watched.clear();
        if (this._pending)
            GLib.Source.remove(this._pending);
        this._pending = 0;
        this._reset();
        this._drop?.destroy();
        this._drop = null;
        this._button.destroy();
        Main.layoutManager.removeChrome(this._shelf);
        this._edge.destroy();
        this._shelf.destroy();
        this._opening.remove_transition('value');
        this._previewActors.clear();
        this._workspace = null;
    }
}
