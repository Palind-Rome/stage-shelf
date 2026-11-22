import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export default class StageShelf extends Extension {
    enable() {
        this._signals = [];
        this._watched = new Map();
        this._parked = new Set();
        this._pictures = new Map();
        this._groups = new Map();
        this._front = null;
        this._pending = 0;
        this._offset = 0;
        this._enabled = true;
        this._tracker = Shell.WindowTracker.get_default();
        this._shelf = new St.BoxLayout({vertical: true, reactive: true, track_hover: true, style: 'spacing: 12px;'});
        Main.layoutManager.addChrome(this._shelf, {trackFullscreen: true});
        this._edge = new St.Widget({reactive: true});
        Main.layoutManager.addChrome(this._edge, {trackFullscreen: true});
        this._edge.hide();
        this._edge.connect('enter-event', () => {
            this._edge.hide();
            this._shelf.show();
            return Clutter.EVENT_PROPAGATE;
        });
        this._shelf.connect('leave-event', () => {
            if (this._covered && !this._shelf.hover)
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
        const toggle = new PopupMenu.PopupSwitchMenuItem('Stage Shelf', true);
        this._button.menu.addMenuItem(toggle);
        toggle.connect('toggled', (_item, state) => {
            this._enabled = state;
            if (!state)
                this._reset();
            this._queue();
        });
        this._button.menu.addAction('Separate focused application', () => this._separate());
        Main.panel.addToStatusArea(this.uuid, this._button);

        for (const [object, event] of [
            [global.display, 'notify::focus-window'], [global.display, 'window-created'],
            [global.display, 'grab-op-end'], [global.display, 'workareas-changed'], [global.display, 'in-fullscreen-changed'],
            [global.display, 'window-entered-monitor'], [global.display, 'window-left-monitor'],
            [global.workspace_manager, 'active-workspace-changed'],
            [global.window_manager, 'map'], [Main.overview, 'hidden'],
            [Main.layoutManager, 'monitors-changed'],
        ])
            this._signals.push([object, object.connect(event, () => this._queue())]);
        this._signals.push([Main.overview, Main.overview.connect('showing', () => this._hideShelf())]);
        this._queue();
    }

    _queue() {
        if (this._pending)
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
        return this._groups.get(id) ?? id;
    }

    _focus() {
        let w = global.display.focus_window;
        while (w?.get_transient_for())
            w = w.get_transient_for();
        return w;
    }

    _restore(w) {
        this._pictures.delete(w);
        if (this._parked.delete(w) && w.minimized)
            w.unminimize();
    }

    _hideShelf() {
        this._shelf.hide();
        this._edge.hide();
        this._covered = false;
    }

    _reset() {
        for (const w of this._parked)
            this._restore(w);
        this._front = null;
        this._groups.clear();
        this._offset = 0;
        this._hideShelf();
    }

    _park(w) {
        const actor = w.get_compositor_private();
        if (!actor?.mapped || !w.can_minimize())
            return;
        try {
            if (actor.width > 0 && actor.height > 0)
                this._pictures.set(w, {content: actor.paint_to_content(null), ratio: actor.width / actor.height});
        } catch (error) {
            console.debug('Stage Shelf preview unavailable', error.message);
        }
        this._parked.add(w);
        w.minimize();
    }

    _sync() {
        const monitor = Main.layoutManager.primaryMonitor;
        const workspace = global.workspace_manager.get_active_workspace();
        if (!this._enabled || !monitor || Main.overview.visible) {
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
                this._restore(w);
                ids.forEach(id => w.disconnect(id));
                this._watched.delete(w);
            }
        }
        for (const w of windows) {
            if (!this._watched.has(w)) {
                const ids = ['notify::minimized', 'notify::maximized-horizontally', 'workspace-changed'].map(signal =>
                    w.connect(signal, () => this._queue()));
                ids.push(w.connect('unmanaged', () => {
                    this._parked.delete(w);
                    this._pictures.delete(w);
                    this._watched.delete(w);
                    this._queue();
                }));
                this._watched.set(w, ids);
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
        this._draw([...stages.values()], monitor);
    }

    _groupOrNull(w) {
        return w ? this._group(w) : null;
    }

    _select(windows, join) {
        const target = windows[0];
        if (join && this._front !== null) {
            for (const w of windows)
                this._groups.set(this._id(w), this._front);
        }
        this._front = this._group(target);
        for (const w of windows)
            this._restore(w);
        Main.activateWindow(target);
        this._offset = 0;
        this._queue();
    }

    _separate() {
        const w = this._focus();
        if (!this._watched.has(w))
            return;
        const id = this._id(w);
        // A fresh group also lets the original owner leave a merged stage.
        this._groups.set(id, Symbol());
        this._front = this._group(w);
        this._queue();
    }

    _draw(stages, monitor) {
        this._shelf.destroy_all_children();
        if (!stages.length || monitor.inFullscreen) {
            this._hideShelf();
            return;
        }
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const height = 102 * scale;
        const capacity = Math.max(1, Math.floor(area.height / (height + 12 * scale)));
        this._offset = Math.max(0, Math.min(this._offset, stages.length - capacity));
        const page = stages.slice(this._offset, this._offset + capacity);
        for (const windows of page)
            this._shelf.add_child(this._card(windows, scale));
        const total = page.length * height + (page.length - 1) * 12 * scale;
        const x = area.x + 4 * scale;
        const y = Math.round(area.y + (area.height - total) / 2);
        this._shelf.set_position(x, y);
        this._edge.set_position(area.x, y);
        this._edge.set_size(6 * scale, total);
        this._covered = [...this._watched.keys()].some(w => {
            if (w.minimized)
                return false;
            const rect = w.get_frame_rect();
            return rect.x < x + 132 * scale && rect.x + rect.width > x &&
                rect.y < y + total && rect.y + rect.height > y;
        });
        const [px, py] = global.get_pointer();
        const inside = px >= area.x && px <= x + 132 * scale && py >= y && py <= y + total;
        this._shelf.visible = !this._covered || inside;
        this._edge.visible = !this._shelf.visible;
    }

    _card(windows, scale) {
        const w = windows[0];
        const app = this._tracker.get_window_app(w);
        const name = app?.get_name() ?? w.get_title();
        const button = new St.Button({style_class: 'stage-card', can_focus: true,
            accessible_name: name, track_hover: true});
        const layout = new Clutter.Actor({width: 132 * scale, height: 102 * scale});
        button.set_child(layout);
        const shot = this._pictures.get(w);
        const ratio = shot?.ratio ?? 1.6;
        const width = Math.min(120, 76 * ratio) * scale;
        const height = width / ratio;
        const frame = new St.Widget({style_class: 'stage-preview', width, height});
        frame.set_position(5 * scale, (78 * scale - height) / 2 + 2 * scale);
        frame.set_pivot_point(0.5, 0.5);
        frame.rotation_angle_y = -12;
        if (shot?.content) {
            const picture = new Clutter.Actor({content: shot.content, width: Math.max(1, width - 4 * scale),
                height: Math.max(1, height - 4 * scale)});
            picture.set_position(2 * scale, 2 * scale);
            frame.add_child(picture);
        }
        layout.add_child(frame);
        const icon = app?.create_icon_texture(28) ?? new St.Icon({icon_name: 'application-x-executable', icon_size: 28});
        icon.set_position(0, 61 * scale);
        layout.add_child(icon);
        if (windows.length > 1) {
            const count = new St.Label({text: String(windows.length), style_class: 'stage-count'});
            count.set_position(96 * scale, 60 * scale);
            layout.add_child(count);
        }
        const caption = new St.Label({text: name, style_class: 'stage-caption', width: 124 * scale, opacity: 0});
        caption.set_position(2 * scale, 81 * scale);
        layout.add_child(caption);
        button.connect('notify::hover', () => {
            caption.ease({opacity: button.hover ? 255 : 0, duration: 140});
            frame.ease({rotation_angle_y: button.hover ? 0 : -12, duration: 160});
        });
        button.connect('clicked', () =>
            this._select(windows, Boolean(global.get_pointer()[2] & Clutter.ModifierType.SHIFT_MASK)));
        return button;
    }

    disable() {
        for (const [object, id] of this._signals)
            object.disconnect(id);
        for (const [w, ids] of this._watched)
            ids.forEach(id => w.disconnect(id));
        this._watched.clear();
        if (this._pending)
            GLib.Source.remove(this._pending);
        this._pending = 0;
        this._reset();
        this._button.destroy();
        Main.layoutManager.removeChrome(this._shelf);
        this._edge.destroy();
        this._shelf.destroy();
        this._workspace = null;
    }
}
