# Quick Notes

A floating scratchpad for macOS. Press ⌃⌥⌘N from anywhere and a note appears on top of whatever you are doing. Press it again and it gets out of the way.

It is free, open source, and keeps your notes as plain files on your own disk. There is no account and nothing leaves your machine.

Inspired by Raycast Notes. [lucascodes.net/quick-notes](https://lucascodes.net/quick-notes)

## Install

Download the latest `.dmg` from [Releases](https://github.com/lucasr1b/quick-notes/releases) (Apple Silicon or Intel), open it, and drag Quick Notes into Applications. It lives in the menu bar rather than the Dock, and updates itself in the background.

Requires macOS 12 or later.

## Using it

| Shortcut | Action |
|---|---|
| ⌃⌥⌘N | Show or hide Quick Notes from any app |
| ⌘N | New note |
| ⌘P | Browse and search notes |
| ⌘K | Command palette |
| ⌘R | Rename the current note |
| ⌘⇧C | Copy the selection as Markdown (the whole note if nothing is selected) |
| esc | Close a panel |

Hold ⌘ on an empty note to see the shortcuts. The global shortcut can be changed from the menu bar icon under Shortcut.

Notes are rich text with Markdown shortcuts, and you can switch any note to raw Markdown. Paste or drop images straight in. Each window shows one note, so you can open several and keep them side by side. Pin the notes you come back to and they appear in the menu bar icon along with your recent ones. Windows stay on top by default, even over full-screen apps; turn that off from the menu bar icon, along with launch at login.

## Where your notes live

Every note is its own file in `~/Documents/quick-notes`:

```
~/Documents/quick-notes/
├── notes/<id>.json   one file per note
├── order.json        list order
├── images/           pasted images
├── trash/            deleted notes, kept so you can recover them
└── versions/         the previous copy of a note whenever a save removes most of its text
```

Writes are atomic, so a crash mid-save cannot corrupt a note, and a damaged file only costs that one note. To keep them somewhere else, such as iCloud Drive or Dropbox, choose Notes Folder > Change Folder… from the menu bar icon. Your notes are copied to the new folder and the old one is left as a backup. Picking a folder that already has Quick Notes notes in it opens those instead. `QUICK_NOTES_VAULT` overrides the setting if you'd rather use an environment variable. [STORAGE.md](STORAGE.md) has the details.

## Moving to a new Mac

Open the command palette (⌘K) and choose Export All Notes… to save everything (notes, their order and images) as one `.zip`. On the other Mac, install Quick Notes and choose Import Notes… with that file. Both are also in the menu bar icon under Notes Folder.

Importing merges rather than replaces: notes you don't have are added, and when both Macs have changed the same note the newer copy wins, with the older one kept in `versions/`. Importing the same file twice does nothing.

## Building from source

```bash
npm install
npm run electron:dev   # dev app with hot reload
npm run app            # packaged app in dist-electron/, unsigned
```

It is Electron with a Next.js static export as the UI and Tiptap as the editor. `electron/main.js` owns windows, the tray and the global shortcut, `electron/vault.js` owns storage, and the editor is `src/components/sticky-notes/`. [DESIGN.md](DESIGN.md) covers the visual rules.

## License

[MIT](LICENSE)
