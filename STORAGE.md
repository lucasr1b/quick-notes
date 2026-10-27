# Where notes live

Notes used to sit as one array inside electron-store's `config.json`, in
`~/Library/Application Support/quick-notes/`. Every save rewrote the whole
blob, in a folder nothing backs up on purpose, so a single bad write or a wiped
Application Support folder took all of them.

They are now files in a vault, defaulting to `~/Documents/quick-notes`. Point
it elsewhere (iCloud, Dropbox) with `QUICK_NOTES_VAULT`:

```bash
QUICK_NOTES_VAULT=~/Drive/quick-notes npm run electron:dev
```

```
~/Documents/quick-notes/
├── notes/<id>.json      one file per note, the source of truth
├── order.json           note ids in list order
├── images/              pasted images, served over qn-image://
├── trash/<stamp>-<id>.json
├── versions/            previous copy of a note when a save would wipe most of its text
└── backup/config-<stamp>.json   snapshot of the old config at migration
```

## Properties

- **One note per file.** A corrupt or unreadable note costs that note. The rest
  load normally (the loader logs and skips it).
- **Atomic writes.** Every write goes to a temp file and is renamed into place,
  so a crash mid-save cannot truncate a note.
- **Only what changed is written.** Editing one note writes one file. Adding or
  reordering notes touches `order.json` alone, so backups and folder sync don't
  churn through every note.
- **Order survives separately.** If `order.json` is lost, every note still
  loads, sorted newest first, and the file is rebuilt on the next save.
- **Deletes are recoverable.** Removing a note moves it to `trash/`.
- **Migration is one-way and safe.** On first launch the old `config.json` is
  copied into `backup/`, then its notes are written out as files. The
  `notes` key inside electron-store is never written or removed again, so the
  pre-vault copy of everything stays where it was.

electron-store still holds app settings and window state, which are cheap to
lose and meaningless outside the app.

## Export and import

Export All Notes… (⌘K or the menu bar) zips `notes/`, `images/`, `order.json`
and a `manifest.json` into one folder, `Quick Notes/`, using macOS's own
`ditto`. Trash, versions and backups stay behind.

Import Notes… unzips to a temp folder and merges with `vault.importFrom()`:

- a note this vault doesn't have is added after the current notes, in the
  exporting Mac's order;
- an identical note is skipped;
- when both have the same note with different contents, the newer
  `updatedAt` wins and the local copy is written to `versions/` first;
- images are copied only if the name is free (names are unique per paste).

Nothing is ever trashed by an import, and importing the same zip twice is a
no-op.

## Code

| Path | Purpose |
|---|---|
| `electron/vault.js` | The vault: list, save, trash, migrate, atomic writes, export, import |
| `electron/main.js` | Calls `vault.list()` / `vault.saveAll()` behind the same IPC |
