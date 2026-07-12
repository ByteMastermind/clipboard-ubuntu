import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Apps like KeePassXC tag secrets with this mimetype; never store those.
const PASSWORD_HINT_MIME = 'x-kde-passwordManagerHint';
const SAVE_DELAY_MS = 400;
const COALESCE_MS = 60;
// Minimum time between selection moves, so the highlight visibly walks
// down the list during key auto-repeat instead of teleporting.
const NAV_REPEAT_MS = 90;

const TEXT_MIMES = new Set([
    'text/plain', 'text/plain;charset=utf-8', 'UTF8_STRING', 'STRING', 'TEXT',
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function formatTime(ts) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    if (d.toDateString() === new Date().toDateString())
        return time;
    return `${d.toLocaleDateString([], {month: 'short', day: 'numeric'})} ${time}`;
}

function entryMatches(entry, query) {
    if (!query)
        return true;
    if (entry.kind === 'image') {
        return 'image'.includes(query) ||
            (entry.ocr ?? '').toLowerCase().includes(query);
    }
    return entry.text.toLowerCase().includes(query);
}

const ClipItem = GObject.registerClass(
class ClipItem extends PopupMenu.PopupBaseMenuItem {
    _init(entry, flags, callbacks) {
        super._init({style_class: 'clipman-item'});
        this.entry = entry;

        const metaParts = [];
        if (entry.kind === 'text' && flags.showLines) {
            const lines = entry.text.split('\n').length;
            if (lines > 1)
                metaParts.push(`${lines} lines`);
        }
        if (flags.showTime)
            metaParts.push(formatTime(entry.ts));

        // Single-line rows keep every clip the same height, which the popup
        // relies on for its constant overall size.
        if (entry.kind === 'image' && flags.showThumb) {
            const gicon = Gio.FileIcon.new(Gio.File.new_for_path(entry.path));
            this.add_child(new St.Icon({
                gicon,
                icon_size: 26,
                style_class: 'clipman-thumb',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        let text;
        if (entry.kind === 'image') {
            const ocr = (entry.ocr ?? '').replace(/\s+/g, ' ').trim();
            text = ocr === '' ? 'Image' : ocr.slice(0, 120);
            if (ocr !== '')
                metaParts.unshift('Image');
        } else {
            text = entry.text.replace(/\s+/g, ' ').trim().slice(0, 120);
        }
        const label = new St.Label({
            text,
            style_class: 'clipman-item-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(label);
        if (metaParts.length > 0) {
            this.add_child(new St.Label({
                text: metaParts.join(' · '),
                style_class: 'clipman-item-meta',
                y_align: Clutter.ActorAlign.CENTER,
                opacity: 160, // dim relative to the theme's foreground
            }));
        }

        const delBtn = new St.Button({
            label: '✕',
            style_class: 'clipman-del-btn',
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        delBtn.connect('clicked', () => {
            callbacks.onDelete(this);
            return Clutter.EVENT_STOP;
        });
        this.add_child(delBtn);
    }
});

const ClipboardIndicator = GObject.registerClass(
class ClipboardIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Clipboard Manager');
        this._ext = ext;
        this._settings = ext.settings;
        this._clipboard = St.Clipboard.get_default();
        this._entries = [];
        this._page = 0;
        this._pages = 1;
        this._filler = null;
        this._rowHeight = 0;
        this._lastNav = 0;
        this._coalesceId = 0;
        this._saveId = 0;
        this._focusIdleId = 0;
        this._pendingImageHashes = new Set();
        this._ocrQueue = [];
        this._ocrBusy = false;
        this._ocrCancellable = new Gio.Cancellable();
        this._destroyed = false;

        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'clipboard-manager']);
        this._imgDir = GLib.build_filenamev([this._dir, 'images']);
        GLib.mkdir_with_parents(this._imgDir, 0o700);
        this._stateFile = Gio.File.new_for_path(GLib.build_filenamev([this._dir, 'history.json']));

        this.add_style_class_name('clipman-indicator');
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${ext.path}/icons/clipboard-symbolic.svg`),
            style_class: 'system-status-icon clipman-panel-icon',
        });
        this.add_child(this._icon);
        this._applyPanelIconVisibility();

        this._buildMenu();

        // Invisible 1×1 anchor the popup attaches to in centered mode.
        this._anchor = new St.Widget({width: 1, height: 1, opacity: 0, reactive: false});
        Main.uiGroup.add_child(this._anchor);
        this._applyPopupPosition();

        this._loadHistory();

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed', (sel, type, _source) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._onClipboardChanged();
        });

        this._settingsChangedId = this._settings.connect('changed', (s, key) => {
            if (key === 'history-length') {
                this._prune();
                this._updateCount();
                this._scheduleSave();
            }
            if (key === 'ocr-images') {
                this._tesseract = undefined; // re-detect the binary
                if (this._settings.get_boolean('ocr-images'))
                    this._queueMissingOcr();
            }
            if (key === 'center-popup')
                this._applyPopupPosition();
            if (key === 'hide-panel-icon')
                this._applyPanelIconVisibility();
            if (this.menu.isOpen)
                this._refreshList();
        });

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._onMenuOpened();
            } else if (this._focusIdleId) {
                GLib.source_remove(this._focusIdleId);
                this._focusIdleId = 0;
            }
        });
        // open-state-changed(false) fires at the *start* of the ~150ms close
        // animation; tearing the items down there makes the menu visibly
        // shrink while it fades out. 'menu-closed' fires after the animation.
        this.menu.connect('menu-closed', () => {
            if (this.menu.isOpen)
                return;
            this._listSection.removeAll();
            this._filler?.destroy();
            this._filler = null;
            this._searchEntry.set_text('');
            this._page = 0;
        });
    }

    /* ---------- UI ---------- */

    _buildMenu() {
        // Hard width (not min-width) so long clips can never widen the popup.
        this.menu.box.set_style('width: 380px;');

        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header.add_child(new St.Label({
            text: 'CLIPBOARD',
            style_class: 'clipman-header-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(new St.Widget({x_expand: true}));
        this._countLabel = new St.Label({
            style_class: 'clipman-item-meta',
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 160,
        });
        header.add_child(this._countLabel);
        header.add_child(this._headerButton('user-trash-symbolic', 'Clear history', () => this._clearAll()));
        header.add_child(this._headerButton('emblem-system-symbolic', 'Settings', () => {
            this.menu.close();
            this._ext.openPreferences();
        }));
        this.menu.addMenuItem(header);

        const searchItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._searchEntry = new St.Entry({
            style_class: 'clipman-search',
            hint_text: 'Search clips…   ( / )',
            x_expand: true,
            can_focus: true,
        });
        this._searchEntry.set_primary_icon(new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 14}));
        searchItem.add_child(this._searchEntry);
        this.menu.addMenuItem(searchItem);

        this._searchEntry.clutter_text.connect('text-changed', () => {
            this._page = 0;
            this._refreshList();
        });
        this._searchEntry.clutter_text.connect('key-press-event', (actor, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Down || sym === Clutter.KEY_Tab) {
                this._focusItem(0);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                const first = this._clipItems()[0];
                if (first)
                    first.activate(Clutter.get_current_event());
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Escape) {
                if (this._searchEntry.get_text() !== '') {
                    this._searchEntry.set_text('');
                    return Clutter.EVENT_STOP;
                }
                this.menu.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._listSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._listSection);

        this._pagerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const prevBtn = new St.Button({label: '‹', style_class: 'clipman-page-btn', can_focus: true});
        prevBtn.connect('clicked', () => this._flipPage(-1, false));
        this._pageLabel = new St.Label({
            style_class: 'clipman-page-label',
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 160,
        });
        const nextBtn = new St.Button({label: '›', style_class: 'clipman-page-btn', can_focus: true});
        nextBtn.connect('clicked', () => this._flipPage(1, false));
        this._pagerItem.add_child(prevBtn);
        this._pagerItem.add_child(new St.Widget({x_expand: true}));
        this._pagerItem.add_child(this._pageLabel);
        this._pagerItem.add_child(new St.Widget({x_expand: true}));
        this._pagerItem.add_child(nextBtn);
        this.menu.addMenuItem(this._pagerItem);

        // Key events inside a popup are consumed by St.FocusManager's
        // captured-event handler on menu.actor before they reach anything
        // inside the box — including Ctrl+arrows, which it navigates right
        // out of the menu. Opt out of the focus manager and do all popup
        // keyboard handling in our own captured handler, which then runs
        // ahead of every shell handler (incl. PanelMenu's ←/→ switcher).
        global.focus_manager.remove_group(this.menu.actor);
        this.menu.actor.connect('captured-event', (a, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS || !this.menu.isOpen)
                return Clutter.EVENT_PROPAGATE;
            return this._onKeyCaptured(event);
        });
    }

    _headerButton(iconName, accessibleName, onClick) {
        const btn = new St.Button({
            style_class: 'clipman-header-btn',
            can_focus: true,
            child: new St.Icon({icon_name: iconName, icon_size: 14}),
            accessible_name: accessibleName,
        });
        btn.connect('clicked', onClick);
        return btn;
    }

    _applyPanelIconVisibility() {
        // The button must stay mapped (the popup anchors to it and the
        // keybinding toggles its menu), so collapse it instead of hiding it.
        const hide = this._settings.get_boolean('hide-panel-icon');
        this._icon.visible = !hide;
        this.style = hide ? '-natural-hpadding: 0px; -minimum-hpadding: 0px;' : null;
        this.reactive = !hide;
        this.can_focus = !hide;
        this.track_hover = !hide;
    }

    _applyPopupPosition() {
        const centered = this._settings.get_boolean('center-popup');
        this.menu.sourceActor = centered ? this._anchor : this;
        // A zero arrow keeps the centered popup a plain rounded box.
        this.menu.actor.style = centered ? '-arrow-rise: 0px;' : null;
    }

    _onMenuOpened() {
        this._searchEntry.set_text('');
        this._page = 0;
        this._refreshList();
        if (this._settings.get_boolean('center-popup')) {
            // Runs before the first paint of the open animation, so the popup
            // never flashes at the panel position.
            const monitor = Main.layoutManager.findMonitorForActor(this);
            const [, natHeight] = this.menu.actor.get_preferred_height(-1);
            // Clamp so a popup taller than the monitor stays reachable.
            const top = Math.max(8, Math.round((monitor.height - natHeight) / 2));
            this._anchor.set_position(
                monitor.x + Math.round(monitor.width / 2),
                monitor.y + top);
            this.menu._boxPointer.setPosition(this._anchor, 0.5);
        }
        // The newest clip must hold focus whenever the popup opens.
        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusIdleId = 0;
            if (!this._focusItem(0))
                this._searchEntry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refreshList() {
        if (!this.menu.isOpen)
            return;
        const query = this._searchEntry.get_text().trim().toLowerCase();
        const filtered = this._entries.filter(e => entryMatches(e, query));
        const pageSize = this._settings.get_int('page-size');
        this._pages = Math.max(1, Math.ceil(filtered.length / pageSize));
        this._page = Math.min(this._page, this._pages - 1);

        const flags = {
            showTime: this._settings.get_boolean('show-datetime'),
            showLines: this._settings.get_boolean('show-line-count'),
            showThumb: this._settings.get_boolean('show-image-preview'),
        };
        const callbacks = {
            onDelete: item => this._deleteItem(item),
        };

        this._listSection.removeAll();
        const start = this._page * pageSize;
        for (const entry of filtered.slice(start, start + pageSize)) {
            const item = new ClipItem(entry, flags, callbacks);
            item.connect('activate', () => this._copyEntry(entry));
            this._listSection.addMenuItem(item);
        }

        // Pad the page with an invisible filler so the popup keeps the same
        // height no matter how many clips the page or a search yields.
        this._filler?.destroy();
        this._filler = null;
        const items = this._clipItems();
        if (items.length > 0)
            this._rowHeight = items[0].get_preferred_height(-1)[1];
        const missing = pageSize - items.length;
        if (missing > 0) {
            this._filler = new St.Widget({height: missing * (this._rowHeight || 40)});
            this._listSection.actor.add_child(this._filler);
        }

        this._pageLabel.text = `${this._page + 1} / ${this._pages}`;
        this._updateCount();
    }

    _clipItems() {
        return this._listSection._getMenuItems().filter(i => i instanceof ClipItem);
    }

    _focusItem(index) {
        const items = this._clipItems();
        if (items.length === 0)
            return false;
        const item = items[Math.max(0, Math.min(index, items.length - 1))];
        item.grab_key_focus();
        return true;
    }

    _flipPage(delta, focusFirst) {
        if (this._pages <= 1)
            return false;
        this._page = (this._page + delta + this._pages) % this._pages;
        this._refreshList();
        if (focusFirst)
            this._focusItem(0);
        return true;
    }

    _onKeyCaptured(event) {
        const sym = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const focus = global.stage.get_key_focus();
        const inSearch = focus !== null && this._searchEntry.contains(focus);

        if (sym === Clutter.KEY_Page_Down || (ctrl && sym === Clutter.KEY_Right)) {
            this._flipPage(1, true);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Page_Up || (ctrl && sym === Clutter.KEY_Left)) {
            this._flipPage(-1, true);
            return Clutter.EVENT_STOP;
        }

        if (inSearch) {
            if (sym === Clutter.KEY_Down) {
                this._focusItem(0);
                return Clutter.EVENT_STOP;
            }
            // Everything else (typing, Enter, Escape) belongs to the entry.
            return Clutter.EVENT_PROPAGATE;
        }

        if (sym === Clutter.KEY_slash || (ctrl && (sym === Clutter.KEY_f || sym === Clutter.KEY_F)) ||
            sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
            this._searchEntry.grab_key_focus();
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Left || sym === Clutter.KEY_Right) {
            // Swallowed: PanelMenu would close us and open the neighbour menu.
            return Clutter.EVENT_STOP;
        }

        const items = this._clipItems();
        const idx = items.findIndex(i => i === focus || i.contains(focus));

        if (sym === Clutter.KEY_Down || sym === Clutter.KEY_Up) {
            const now = GLib.get_monotonic_time() / 1000;
            if (now - this._lastNav < NAV_REPEAT_MS)
                return Clutter.EVENT_STOP;
            this._lastNav = now;
            if (sym === Clutter.KEY_Down) {
                if (idx < 0)
                    this._focusItem(0);
                else if (idx === items.length - 1)
                    this._flipPage(1, true) || this._focusItem(0);
                else
                    this._focusItem(idx + 1);
            } else {
                if (idx < 0) {
                    this._focusItem(Infinity);
                } else if (idx === 0) {
                    this._flipPage(-1, false);
                    this._focusItem(Infinity);
                } else {
                    this._focusItem(idx - 1);
                }
            }
            return Clutter.EVENT_STOP;
        }

        if (idx >= 0) {
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter || sym === Clutter.KEY_space) {
                items[idx].activate(event);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Delete) {
                this._deleteItem(items[idx]);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _updateCount() {
        this._countLabel.text = `${this._entries.length}`;
    }

    /* ---------- clipboard capture ---------- */

    _onClipboardChanged() {
        // A single copy can fire owner-changed several times; coalesce.
        if (this._coalesceId)
            GLib.source_remove(this._coalesceId);
        this._coalesceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COALESCE_MS, () => {
            this._coalesceId = 0;
            this._capture();
            return GLib.SOURCE_REMOVE;
        });
    }

    _capture() {
        const mimes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
        if (!mimes || mimes.length === 0 || mimes.includes(PASSWORD_HINT_MIME))
            return;

        const maxBytes = this._settings.get_int('max-clip-size-kb') * 1024;
        const hasText = mimes.some(m => TEXT_MIMES.has(m));
        const imageMime = mimes.includes('image/png')
            ? 'image/png'
            : mimes.find(m => m.startsWith('image/'));

        if (hasText) {
            this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (cb, text) => {
                if (text && text.trim() !== '') {
                    const size = encoder.encode(text).length;
                    if (size <= maxBytes)
                        this._addText(text, size);
                } else if (imageMime) {
                    this._captureImage(imageMime, maxBytes);
                }
            });
        } else if (imageMime) {
            this._captureImage(imageMime, maxBytes);
        }
    }

    _captureImage(mime, maxBytes) {
        if (!this._settings.get_boolean('store-images'))
            return;
        this._clipboard.get_content(St.ClipboardType.CLIPBOARD, mime, (cb, bytes) => {
            if (!bytes)
                return;
            const size = bytes.get_size();
            if (size === 0 || size > maxBytes)
                return;
            const byteHash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, bytes);
            const pixelHash = this._imagePixelHash(bytes, mime);
            const existing = this._entries.find(e =>
                e.kind === 'image' &&
                (e.hash === byteHash || e.byteHash === byteHash ||
                    (pixelHash !== null && e.pixelHash === pixelHash)));
            if (existing) {
                this._moveToTop(existing);
                return;
            }
            // Different clipboard owners can encode the same screenshot
            // differently. Guard both the raw and decoded-pixel identities
            // while the image write is still in flight.
            const pendingKeys = [`bytes:${byteHash}`];
            if (pixelHash !== null)
                pendingKeys.push(`pixels:${pixelHash}`);
            if (pendingKeys.some(key => this._pendingImageHashes.has(key)))
                return;
            for (const key of pendingKeys)
                this._pendingImageHashes.add(key);
            const id = GLib.uuid_string_random();
            const ext = mime.split('/')[1]?.split('+')[0] ?? 'png';
            const file = Gio.File.new_for_path(GLib.build_filenamev([this._imgDir, `${id}.${ext}`]));
            file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
                    for (const key of pendingKeys)
                        this._pendingImageHashes.delete(key);
                    try {
                        f.replace_contents_finish(res);
                    } catch (e) {
                        console.error(`clipman: failed to store image: ${e.message}`);
                        return;
                    }
                    const entry = {
                        id, kind: 'image', mime, path: f.get_path(),
                        hash: byteHash, byteHash, pixelHash, size, ts: Date.now(),
                    };
                    this._addEntry(entry);
                    this._queueOcr(entry);
                });
        });
    }

    _imagePixelHash(bytes, mime) {
        let loader = null;
        let closed = false;
        try {
            loader = GdkPixbuf.PixbufLoader.new_with_mime_type(mime);
            loader.write_bytes(bytes);
            if (!loader.close())
                return null;
            closed = true;

            const pixbuf = loader.get_pixbuf();
            if (!pixbuf)
                return null;
            const width = pixbuf.get_width();
            const height = pixbuf.get_height();
            const channels = pixbuf.get_n_channels();
            const rowstride = pixbuf.get_rowstride();
            const pixels = pixbuf.get_pixels();
            if (width <= 0 || height <= 0 || (channels !== 3 && channels !== 4) ||
                rowstride < width * channels)
                return null;

            // Normalize RGB/RGBA images to RGBA so encoding details and alpha
            // channel presence do not affect the identity of the screenshot.
            const checksum = new GLib.Checksum(GLib.ChecksumType.MD5);
            checksum.update(encoder.encode(`rgba:${width}x${height}\0`));
            const row = new Uint8Array(width * 4);
            for (let y = 0; y < height; y++) {
                const source = y * rowstride;
                let target = 0;
                for (let x = 0; x < width; x++) {
                    const pixel = source + x * channels;
                    row[target++] = pixels[pixel];
                    row[target++] = pixels[pixel + 1];
                    row[target++] = pixels[pixel + 2];
                    row[target++] = channels === 4 ? pixels[pixel + 3] : 255;
                }
                checksum.update(row);
            }
            return checksum.get_string();
        } catch (e) {
            // Byte hashing remains a safe fallback for unsupported or corrupt
            // image formats.
            return null;
        } finally {
            if (loader && !closed) {
                try {
                    loader.close();
                } catch (e) {
                    // Ignore malformed clipboard image cleanup failures.
                }
            }
        }
    }

    _addText(text, size) {
        const existing = this._entries.find(e => e.kind === 'text' && e.text === text);
        if (existing) {
            this._moveToTop(existing);
            return;
        }
        this._addEntry({
            id: GLib.uuid_string_random(),
            kind: 'text', text, size, ts: Date.now(),
        });
    }

    _addEntry(entry) {
        this._entries.unshift(entry);
        this._prune();
        this._refreshList();
        this._updateCount();
        this._scheduleSave();
    }

    _moveToTop(entry) {
        const idx = this._entries.indexOf(entry);
        if (idx <= 0)
            return;
        entry.ts = Date.now();
        this._entries.splice(idx, 1);
        this._entries.unshift(entry);
        this._refreshList();
        this._scheduleSave();
    }

    _prune() {
        const max = this._settings.get_int('history-length');
        while (this._entries.length > max)
            this._deleteEntryFile(this._entries.pop());
    }

    /* ---------- actions ---------- */

    _copyEntry(entry) {
        if (entry.kind === 'text') {
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
            return;
        }
        const file = Gio.File.new_for_path(entry.path);
        file.load_bytes_async(null, (f, res) => {
            try {
                const [bytes] = f.load_bytes_finish(res);
                this._clipboard.set_content(St.ClipboardType.CLIPBOARD, entry.mime, bytes);
            } catch (e) {
                Main.notify('Clipboard Manager', 'Image is no longer available.');
                this._removeEntry(entry);
            }
        });
    }

    _deleteItem(item) {
        // Keep keyboard flow: refocus the same slot on the refreshed page.
        const idx = this._clipItems().indexOf(item);
        this._removeEntry(item.entry);
        if (!this._focusItem(idx))
            this._searchEntry.grab_key_focus();
    }

    _removeEntry(entry) {
        const idx = this._entries.indexOf(entry);
        if (idx >= 0)
            this._entries.splice(idx, 1);
        this._deleteEntryFile(entry);
        this._refreshList();
        this._updateCount();
        this._scheduleSave();
    }

    _deleteEntryFile(entry) {
        if (entry.kind !== 'image' || !entry.path)
            return;
        Gio.File.new_for_path(entry.path).delete_async(GLib.PRIORITY_LOW, null, (f, res) => {
            try {
                f.delete_finish(res);
            } catch (e) {
                // already gone — fine
            }
        });
    }

    _clearAll() {
        for (const entry of this._entries)
            this._deleteEntryFile(entry);
        this._entries = [];
        this._page = 0;
        this._refreshList();
        this._updateCount();
        this._scheduleSave();
    }

    /* ---------- persistence ---------- */

    _serialize() {
        const entries = this._entries.map(e => e.kind === 'image'
            ? {
                id: e.id, kind: e.kind, mime: e.mime, path: e.path,
                hash: e.hash, byteHash: e.byteHash, pixelHash: e.pixelHash,
                size: e.size, ts: e.ts, ocr: e.ocr,
            }
            : {id: e.id, kind: e.kind, text: e.text, size: e.size, ts: e.ts});
        return JSON.stringify({version: 1, entries});
    }

    _scheduleSave() {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            const bytes = new GLib.Bytes(encoder.encode(this._serialize()));
            this._stateFile.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                    } catch (e) {
                        console.error(`clipman: failed to save history: ${e.message}`);
                    }
                });
            return GLib.SOURCE_REMOVE;
        });
    }

    flushSave() {
        if (!this._saveId)
            return;
        GLib.source_remove(this._saveId);
        this._saveId = 0;
        try {
            this._stateFile.replace_contents(encoder.encode(this._serialize()), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error(`clipman: failed to save history: ${e.message}`);
        }
    }

    _loadHistory() {
        this._stateFile.load_contents_async(null, (f, res) => {
            try {
                const [, contents] = f.load_contents_finish(res);
                const data = JSON.parse(decoder.decode(contents));
                if (data?.version === 1 && Array.isArray(data.entries)) {
                    this._entries = data.entries.filter(e =>
                        e && (e.kind === 'text' ? typeof e.text === 'string' : typeof e.path === 'string'));
                    this._prune();
                }
            } catch (e) {
                // first run or corrupt file — start fresh
                this._entries = [];
            }
            this._updateCount();
            this._queueMissingOcr();
        });
    }

    /* ---------- OCR ---------- */

    _tesseractPath() {
        if (this._tesseract === undefined)
            this._tesseract = GLib.find_program_in_path('tesseract');
        return this._tesseract;
    }

    _queueOcr(entry) {
        if (!this._settings.get_boolean('ocr-images') || !this._tesseractPath())
            return;
        if (entry.kind !== 'image' || entry.ocr !== undefined)
            return;
        if (this._ocrQueue.includes(entry))
            return;
        this._ocrQueue.push(entry);
        this._runOcrQueue();
    }

    _queueMissingOcr() {
        for (const entry of this._entries) {
            if (entry.kind === 'image' && entry.ocr === undefined)
                this._queueOcr(entry);
        }
    }

    _runOcrQueue() {
        // One recognition at a time, at the lowest CPU priority, so bursts of
        // copied images can never affect shell responsiveness.
        if (this._ocrBusy || this._destroyed)
            return;
        const entry = this._ocrQueue.shift();
        if (!entry)
            return;
        if (!this._entries.includes(entry)) { // deleted while queued
            this._runOcrQueue();
            return;
        }
        const langs = (this._settings.get_string('ocr-languages') || 'eng')
            .replace(/[^a-zA-Z_+]/g, '') || 'eng';
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['nice', '-n', '19', this._tesseractPath(), entry.path, 'stdout', '-l', langs],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error(`clipman: OCR failed to start: ${e.message}`);
            return;
        }
        this._ocrBusy = true;
        let timedOut = false;
        const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            timedOut = true;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        proc.communicate_utf8_async(null, this._ocrCancellable, (p, res) => {
            if (!timedOut)
                GLib.source_remove(timeoutId);
            if (this._destroyed)
                return;
            this._ocrBusy = false;
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                entry.ocr = p.get_successful() ? (stdout ?? '').trim() : '';
            } catch (e) {
                entry.ocr = ''; // don't retry forever on a broken image
            }
            this._scheduleSave();
            // A search might be waiting on this very result.
            if (this.menu.isOpen && this._searchEntry.get_text().trim() !== '')
                this._refreshList();
            this._runOcrQueue();
        });
    }

    /* ---------- teardown ---------- */

    destroy() {
        this._destroyed = true;
        this._ocrQueue = [];
        this._ocrCancellable.cancel();
        this._anchor?.destroy();
        this._anchor = null;
        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = 0;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._coalesceId) {
            GLib.source_remove(this._coalesceId);
            this._coalesceId = 0;
        }
        if (this._focusIdleId) {
            GLib.source_remove(this._focusIdleId);
            this._focusIdleId = 0;
        }
        this.flushSave();
        super.destroy();
    }
});

export default class ClipboardManagerExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this._indicator = new ClipboardIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        Main.wm.addKeybinding('toggle-menu', this.settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._indicator?.menu.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-menu');
        this._indicator?.destroy();
        this._indicator = null;
        this.settings = null;
    }
}
