import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODIFIER_KEYVALS = new Set([
    Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
    Gdk.KEY_Super_L, Gdk.KEY_Super_R,
    Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
    Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
]);

function formatSize(bytes) {
    if (bytes >= 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

export default class ClipboardManagerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(480, 700);

        const page = new Adw.PreferencesPage({
            title: 'Clipboard Manager',
            icon_name: 'edit-paste-symbolic',
        });
        window.add(page);

        const historyGroup = new Adw.PreferencesGroup({
            title: 'History',
            description: 'What gets remembered, and for how long',
        });
        page.add(historyGroup);

        const lengthRow = new Adw.SpinRow({
            title: 'History length',
            subtitle: 'Maximum number of clips kept',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 500, step_increment: 1, page_increment: 10,
            }),
        });
        settings.bind('history-length', lengthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(lengthRow);

        const sizeRow = new Adw.SpinRow({
            title: 'Maximum clip size',
            subtitle: 'Clips larger than this (in KB) are not stored',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 20480, step_increment: 16, page_increment: 256,
            }),
        });
        settings.bind('max-clip-size-kb', sizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(sizeRow);

        const imagesRow = new Adw.SwitchRow({
            title: 'Store images',
            subtitle: 'Keep copied images (screenshots, pictures) in the history',
        });
        settings.bind('store-images', imagesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(imagesRow);

        const hasTesseract = GLib.find_program_in_path('tesseract') !== null;
        const ocrRow = new Adw.SwitchRow({
            title: 'Search text in images',
            subtitle: hasTesseract
                ? 'Recognize text in copied images (OCR) so search can find them'
                : 'Requires the tesseract-ocr package (sudo apt install tesseract-ocr)',
            sensitive: hasTesseract,
        });
        settings.bind('ocr-images', ocrRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(ocrRow);

        const ocrLangRow = new Adw.EntryRow({
            title: 'OCR languages',
            tooltip_text: 'Tesseract language codes joined with +, e.g. eng+ces. Each needs its package (tesseract-ocr-ces, …).',
        });
        settings.bind('ocr-languages', ocrLangRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        if (hasTesseract)
            settings.bind('ocr-images', ocrLangRow, 'sensitive', Gio.SettingsBindFlags.GET);
        else
            ocrLangRow.sensitive = false;
        historyGroup.add(ocrLangRow);

        const usageRow = new Adw.ActionRow({
            title: 'History size on disk',
            subtitle: 'Text index and stored images',
        });
        this._usageLabel = new Gtk.Label({valign: Gtk.Align.CENTER, css_classes: ['dim-label']});
        usageRow.add_suffix(this._usageLabel);
        const refreshBtn = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Recalculate',
        });
        refreshBtn.connect('clicked', () => this._updateUsage());
        usageRow.add_suffix(refreshBtn);
        historyGroup.add(usageRow);
        this._updateUsage();

        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Popup',
            description: 'How clips are presented',
        });
        page.add(appearanceGroup);

        const pageSizeRow = new Adw.SpinRow({
            title: 'Clips per page',
            subtitle: 'The popup shows clips in pages — flip them with Ctrl+← and Ctrl+→',
            adjustment: new Gtk.Adjustment({
                lower: 3, upper: 30, step_increment: 1, page_increment: 5,
            }),
        });
        settings.bind('page-size', pageSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(pageSizeRow);

        const previewRow = new Adw.SwitchRow({
            title: 'Show image previews',
            subtitle: 'Display thumbnails of stored images in the list',
        });
        settings.bind('show-image-preview', previewRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(previewRow);

        const timeRow = new Adw.SwitchRow({
            title: 'Show copy time',
            subtitle: 'Display when each clip was copied',
        });
        settings.bind('show-datetime', timeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(timeRow);

        const linesRow = new Adw.SwitchRow({
            title: 'Show line count',
            subtitle: 'Display the number of lines of multi-line clips',
        });
        settings.bind('show-line-count', linesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(linesRow);

        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Keyboard',
        });
        page.add(shortcutGroup);

        const shortcutRow = new Adw.ActionRow({
            title: 'Toggle popup',
            subtitle: 'Click to record a new shortcut',
            activatable: true,
        });
        const shortcutLabel = new Gtk.ShortcutLabel({
            accelerator: settings.get_strv('toggle-menu')[0] ?? '',
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });
        settings.connect('changed::toggle-menu', () => {
            shortcutLabel.accelerator = settings.get_strv('toggle-menu')[0] ?? '';
        });
        shortcutRow.add_suffix(shortcutLabel);
        shortcutRow.connect('activated', () => this._recordShortcut(window, settings));
        shortcutGroup.add(shortcutRow);

        const tipsGroup = new Adw.PreferencesGroup();
        page.add(tipsGroup);
        tipsGroup.add(new Adw.ActionRow({
            title: 'In the popup',
            subtitle: '↑ ↓ move between clips  ·  PgUp PgDn or Ctrl+← Ctrl+→ switch pages  ·  Enter copies  ·  Del removes  ·  /  or Ctrl+F jumps to search',
            activatable: false,
        }));
    }

    _updateUsage() {
        const base = GLib.build_filenamev([GLib.get_user_cache_dir(), 'clipboard-manager']);
        let total = 0;
        try {
            total += Gio.File.new_for_path(GLib.build_filenamev([base, 'history.json']))
                .query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null)
                .get_size();
        } catch {
            // no history yet
        }
        try {
            const dir = Gio.File.new_for_path(GLib.build_filenamev([base, 'images']));
            const children = dir.enumerate_children('standard::size',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = children.next_file(null)) !== null)
                total += info.get_size();
            children.close(null);
        } catch {
            // no images yet
        }
        this._usageLabel.label = formatSize(total);
    }

    _recordShortcut(parent, settings) {
        const dialog = new Adw.Window({
            modal: true,
            transient_for: parent,
            resizable: false,
            default_width: 400,
            default_height: 220,
            title: 'Set Shortcut',
        });
        dialog.set_content(new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-symbolic',
            title: 'Press a key combination',
            description: 'Esc cancels · Backspace disables the shortcut',
        }));

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (ctrl, keyval, keycode, state) => {
            if (MODIFIER_KEYVALS.has(keyval))
                return Gdk.EVENT_STOP;
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_Escape && mods === 0) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace && mods === 0) {
                settings.set_strv('toggle-menu', []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            const isFnKey = keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F12;
            if (mods === 0 && !isFnKey)
                return Gdk.EVENT_STOP; // require a modifier for ordinary keys
            if (Gtk.accelerator_valid(keyval, mods)) {
                settings.set_strv('toggle-menu', [Gtk.accelerator_name(keyval, mods)]);
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present();
    }
}
