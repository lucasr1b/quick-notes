#!/usr/bin/env node
// Launch the built app on a throwaway vault and profile full of sample notes,
// for screenshots and screen recordings. Your real notes and windows are never
// touched. Quit your normal Quick Notes first, or the two fight over the
// shortcut and the menu bar.
//
//   npm run app && npm run demo

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(os.tmpdir(), "quick-notes-demo");
const vault = path.join(root, "vault");
const profile = path.join(root, "profile");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
fs.mkdirSync(profile, { recursive: true });

const text = (t, marks) => ({ type: "text", text: t, ...(marks ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...parts) => ({ type: "paragraph", content: parts.map((x) => (typeof x === "string" ? text(x) : x)) });
const h = (level, t) => ({ type: "heading", attrs: { level }, content: [text(t)] });
const ul = (...items) => ({ type: "bulletList", content: items.map((i) => ({ type: "listItem", content: [p(i)] })) });
const ol = (...items) => ({ type: "orderedList", attrs: { start: 1 }, content: items.map((i) => ({ type: "listItem", content: [p(i)] })) });
const doc = (...content) => ({ type: "doc", content });

const hour = 3600 * 1000;
const now = Date.now();
const notes = [
  {
    title: "Thursday",
    content: doc(
      h(2, "Thursday"),
      p("Call with Maya moved to ", text("3:30", ["bold"]), ". Bring the numbers from last week."),
      ul("Reply to the Figma comments", "Book the dentist", "Pick up the film from the lab"),
      p("Wifi at the studio: ", text("north-window-42", ["code"])),
    ),
  },
  {
    title: "Launch",
    pinned: true,
    content: doc(
      h(2, "Launch"),
      ol("Record the demo", "Write the post", "Ship the release", "Reply to everyone"),
      p(text("Keep it short.", ["italic"]), " Nobody reads the second paragraph."),
    ),
  },
  {
    title: "Ideas",
    content: doc(
      h(2, "Ideas"),
      ul("A lamp that dims with the sunset", "Postcards from every city in the book", "Rename the band"),
    ),
  },
  { title: "Reading", content: doc(h(2, "Reading"), ul("The Timeless Way of Building", "Shop Class as Soulcraft", "A Pattern Language")) },
  { title: "Groceries", content: doc(h(2, "Groceries"), ul("Lemons", "Good bread", "Coffee beans", "Basil")) },
  { title: "Gift ideas", content: doc(h(2, "Gift ideas"), p("Mum: the blue scarf from the market. Sam: that fountain pen.")) },
];

const ids = [];
notes.forEach((n, i) => {
  const id = `note-demo-${i + 1}`;
  ids.push(id);
  const stamp = new Date(now - i * 5 * hour).toISOString();
  const note = { id, title: n.title, customTitle: false, content: n.content, pinned: Boolean(n.pinned), createdAt: stamp, updatedAt: stamp };
  fs.writeFileSync(path.join(vault, "notes", `${id}.json`), JSON.stringify(note, null, 2));
});
fs.writeFileSync(path.join(vault, "order.json"), JSON.stringify(ids));

fs.writeFileSync(
  path.join(profile, "config.json"),
  JSON.stringify({
    legacyMigrated: true,
    alwaysOnTop: true,
    windows: [{ id: "win-demo", noteId: ids[0], viewMode: "rich", bounds: { x: 760, y: 220, width: 400, height: 500 } }],
  }),
);

const candidates = [
  path.join(__dirname, "..", "dist-electron", "mac-arm64", "Quick Notes.app", "Contents", "MacOS", "Quick Notes"),
  path.join(__dirname, "..", "dist-electron", "mac", "Quick Notes.app", "Contents", "MacOS", "Quick Notes"),
];
const bin = candidates.find((c) => fs.existsSync(c));
if (!bin) {
  console.error("No built app found. Run `npm run app` first.");
  process.exit(1);
}

console.log(`demo vault: ${vault}`);
spawn(bin, process.argv.slice(2), {
  env: { ...process.env, QUICK_NOTES_VAULT: vault, QUICK_NOTES_USER_DATA: profile },
  stdio: "inherit",
});
