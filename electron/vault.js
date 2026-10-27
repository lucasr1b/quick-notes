const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_VAULT = path.join(os.homedir(), "Documents", "quick-notes");

const isSafeId = (id) => typeof id === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(id);

/** Keep at most this many files in <vault>/versions/. */
const MAX_VERSIONS = 60;

/** Total length of the text in a Tiptap/ProseMirror doc. */
const textLength = (node) => {
  if (Array.isArray(node)) {
    let total = 0;
    for (const child of node) total += textLength(child);
    return total;
  }
  if (!node || typeof node !== "object") return 0;
  let total = typeof node.text === "string" ? node.text.length : 0;
  if (node.content) total += textLength(node.content);
  return total;
};

/**
 * Notes as real files on disk instead of one blob in Application Support.
 *
 *   <vault>/notes/<id>.json   one note, the source of truth
 *   <vault>/order.json        note ids in list order (rebuilt if lost)
 *   <vault>/images/           pasted images, served over qn-image://
 *   <vault>/trash/            deleted notes, kept rather than unlinked
 *   <vault>/backup/           snapshot of the old config.json at migration
 *   <vault>/versions/         the previous file, kept whenever a save would
 *                             wipe out most of a note's text
 *
 * Order lives in its own file so that reordering or adding a note does not
 * rewrite every note file (and thrash backups/sync).
 */
function createVault(vaultPath) {
  const vault = path.resolve(
    vaultPath || process.env.QUICK_NOTES_VAULT || DEFAULT_VAULT,
  );
  const notesDir = path.join(vault, "notes");
  const imagesDir = path.join(vault, "images");
  const trashDir = path.join(vault, "trash");
  const backupDir = path.join(vault, "backup");
  const versionsDir = path.join(vault, "versions");

  for (const dir of [notesDir, imagesDir, trashDir, backupDir, versionsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const orderFile = path.join(vault, "order.json");
  const noteFile = (id) => path.join(notesDir, `${id}.json`);

  /** id -> exact file contents, so unchanged notes are never rewritten */
  const cache = new Map();

  const writeAtomic = (file, contents) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, contents, "utf8");
    fs.renameSync(tmp, file);
  };

  const pruneVersions = () => {
    let names;
    try {
      names = fs.readdirSync(versionsDir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    if (names.length <= MAX_VERSIONS) return;
    // every name starts with an ISO stamp, so a plain sort is oldest first
    for (const name of names.sort().slice(0, names.length - MAX_VERSIONS)) {
      try {
        fs.unlinkSync(path.join(versionsDir, name));
      } catch {
        // best effort
      }
    }
  };

  /**
   * A note is about to be overwritten. If the incoming version drops all or
   * most of its text, keep the old file first: that is the shape of a wipe,
   * and the write below is a rename, so otherwise the old bytes are gone.
   */
  const keepVersionIfTextLost = (id, nextNote) => {
    let prevRaw = cache.get(id);
    if (prevRaw === undefined) {
      try {
        prevRaw = fs.readFileSync(noteFile(id), "utf8");
      } catch {
        return; // new note, nothing to lose
      }
    }

    let prevLen = 0;
    try {
      prevLen = textLength(JSON.parse(prevRaw)?.content);
    } catch {
      return;
    }
    if (prevLen === 0) return;

    const nextLen = textLength(nextNote?.content);
    const wiped = nextLen === 0;
    const gutted = prevLen >= 40 && nextLen < prevLen / 2;
    if (!wiped && !gutted) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      fs.writeFileSync(path.join(versionsDir, `${stamp}-${id}.json`), prevRaw, "utf8");
      pruneVersions();
    } catch (err) {
      console.error("[quick-notes] could not keep previous version of", id, err);
    }
  };

  const readOrder = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(orderFile, "utf8"));
      return Array.isArray(parsed) ? parsed.filter(isSafeId) : [];
    } catch {
      return [];
    }
  };

  const readAllNotes = () => {
    const byId = new Map();
    let names = [];
    try {
      names = fs.readdirSync(notesDir);
    } catch {
      return byId;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(notesDir, name);
      try {
        const raw = fs.readFileSync(file, "utf8");
        const note = JSON.parse(raw);
        if (!isSafeId(note?.id)) continue;
        cache.set(note.id, raw);
        byId.set(note.id, note);
      } catch (err) {
        // a single unreadable note must never take the rest down
        console.error("[quick-notes] skipping unreadable note", name, err);
      }
    }
    return byId;
  };

  const list = () => {
    const byId = readAllNotes();
    const ordered = [];
    const seen = new Set();
    for (const id of readOrder()) {
      const note = byId.get(id);
      if (note) {
        ordered.push(note);
        seen.add(id);
      }
    }
    // notes the order file doesn't know about (recovered, hand-dropped, or
    // written by another window) go after, newest first
    const rest = [...byId.values()]
      .filter((note) => !seen.has(note.id))
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    return [...ordered, ...rest];
  };

  const trash = (id) => {
    if (!isSafeId(id)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      fs.renameSync(noteFile(id), path.join(trashDir, `${stamp}-${id}.json`));
    } catch {
      // already gone
    }
    cache.delete(id);
  };

  /**
   * Persists the full note list the renderer holds. Only notes whose contents
   * actually changed are written; notes no longer in the list go to trash.
   */
  const saveAll = (notes) => {
    if (!Array.isArray(notes)) return { written: 0, trashed: 0 };
    const ids = new Set();
    let written = 0;

    for (const note of notes) {
      if (!isSafeId(note?.id)) continue;
      ids.add(note.id);
      const json = JSON.stringify(note, null, 2);
      if (cache.get(note.id) === json) continue;
      keepVersionIfTextLost(note.id, note);
      writeAtomic(noteFile(note.id), json);
      cache.set(note.id, json);
      written += 1;
    }

    let trashed = 0;
    for (const id of [...readAllNotes().keys()]) {
      if (!ids.has(id)) {
        trash(id);
        trashed += 1;
      }
    }

    const nextOrder = JSON.stringify([...ids], null, 2);
    if (nextOrder !== JSON.stringify(readOrder(), null, 2)) {
      writeAtomic(orderFile, nextOrder);
    }
    return { written, trashed };
  };

  /** One-time lift of the notes that lived inside electron-store's config. */
  const migrateFrom = (legacyNotes, configFile) => {
    if (!Array.isArray(legacyNotes) || legacyNotes.length === 0) return 0;
    if (readAllNotes().size > 0) return 0;

    if (configFile && fs.existsSync(configFile)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      try {
        fs.copyFileSync(configFile, path.join(backupDir, `config-${stamp}.json`));
      } catch (err) {
        console.error("[quick-notes] could not back up config.json", err);
      }
    }

    const { written } = saveAll(legacyNotes);
    return written;
  };

  /** Bring across images from the old userData location, copy only. */
  const adoptImages = (oldImagesDir) => {
    if (!oldImagesDir || !fs.existsSync(oldImagesDir)) return 0;
    let copied = 0;
    for (const name of fs.readdirSync(oldImagesDir)) {
      const target = path.join(imagesDir, name);
      if (fs.existsSync(target)) continue;
      try {
        fs.copyFileSync(path.join(oldImagesDir, name), target);
        copied += 1;
      } catch (err) {
        console.error("[quick-notes] could not copy image", name, err);
      }
    }
    return copied;
  };

  return { vault, notesDir, imagesDir, trashDir, versionsDir, list, saveAll, trash, migrateFrom, adoptImages };
}

module.exports = { createVault };
