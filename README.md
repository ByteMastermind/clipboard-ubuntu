# Clipboard Manager

Clipboard Manager is a clipboard history extension for GNOME Shell (45–48).
It keeps a history of copied text and images, searchable from a paginated
popup in the top panel.

Clipboard changes are captured through Mutter's selection signal (no
polling), clips flagged by password managers are never stored, and history
is kept in `~/.cache/clipboard-manager/`.

## Installation

    ./install.sh

On Wayland, log out and back in. On X11, restart GNOME Shell (Alt+F2, `r`).

## Usage

Click the panel icon or press `Ctrl+Alt+H`, then:

    ↑ / ↓              move between clips
    PgUp / PgDn        switch pages (also Ctrl+← / Ctrl+→)
    Enter              copy the selected clip
    Del                remove the selected clip
    / or Ctrl+F        search
    Esc                clear search, then close

History length, maximum clip size, image support, clips per page and the
shortcut can be configured:

    gnome-extensions prefs clipboard-manager@bytemastermind

## Uninstallation

    gnome-extensions disable clipboard-manager@bytemastermind
    rm -rf ~/.local/share/gnome-shell/extensions/clipboard-manager@bytemastermind
    rm -rf ~/.cache/clipboard-manager

## Development

Run a nested shell for testing:

    dbus-run-session -- gnome-shell --nested --wayland

Logs:

    journalctl -f -o cat /usr/bin/gnome-shell
