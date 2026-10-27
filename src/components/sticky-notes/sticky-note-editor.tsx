/**
 * Sticky Note Editor
 *
 * Single-note-per-window editor. Multiple windows sync through the shared
 * notes store in the main process. Tiptap rich text with markdown paste,
 * CMD+K command palette, CMD+P browse-notes panel, inline title rename
 * via double-click, and manual window drag from the titlebar.
 */
"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import {
  Plus, Search, Pin, Trash2, Layers, Command,
  Copy, FileText, Download, ArrowUp, ArrowDown,
  Clipboard, FileCode, X, AppWindow, Archive, ArchiveRestore,
} from "lucide-react";
import { NotesToolbar } from "./notes-toolbar";
import { useWindowState } from "@/hooks/use-window-state";

/* ─── Types ─── */

interface StickyNote {
  id: string;
  title: string;
  customTitle: boolean;
  content: object | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PaletteCommand {
  id: string;
  icon: React.ElementType;
  label: string;
  keys?: string[];
  dividerBefore?: boolean;
  action: () => void;
}

interface ElectronNotesAPI {
  loadNotes: () => Promise<StickyNote[]>;
  saveNotes: (notes: StickyNote[]) => Promise<void>;
  exportAllNotes?: () => Promise<{ notes: number } | null>;
  importNotes?: () => Promise<{ added: number; updated: number; firstId: string | null } | null>;
  onNoteCreated?: (callback: (noteId: string) => void) => () => void;
  onJumpToNote?: (callback: (noteId: string) => void) => () => void;
  onNotesUpdated?: (callback: () => void) => () => void;
  notifyNotesChanged?: () => void;
  getWindowBounds?: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
  setWindowPosition?: (pos: { x: number; y: number }) => Promise<void>;
  moveWindowBy?: (delta: { dx: number; dy: number }) => void;
  saveImage?: (dataUrl: string) => Promise<string>;
  openImage?: (src: string) => Promise<void>;
}

function getAPI(): ElectronNotesAPI | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { electronAPI?: ElectronNotesAPI };
  return w.electronAPI ?? null;
}

function createNote(): StickyNote {
  return {
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: "Untitled",
    customTitle: false,
    content: null,
    pinned: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function migrateNote(n: StickyNote): StickyNote {
  return { ...n, customTitle: n.customTitle ?? (n.title !== "Untitled") };
}

function getFirstLine(content: object | null): string {
  if (!content) return "";
  const doc = content as Record<string, unknown>;
  if (!Array.isArray(doc.content) || doc.content.length === 0) return "";
  const firstBlock = doc.content[0] as Record<string, unknown>;
  if (!Array.isArray(firstBlock.content)) return "";
  return firstBlock.content
    .map((node: Record<string, unknown>) => (typeof node.text === "string" ? node.text : ""))
    .join("")
    .trim();
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

function getPlainText(content: object | null): string {
  if (!content) return "";
  // Blocks (paragraphs, headings, list items) go on their own lines; only
  // inline runs join directly, or "Title" + "Body" copies as "TitleBody".
  const extract = (node: Record<string, unknown>): string => {
    if (typeof node.text === "string") return node.text;
    if (node.type === "hardBreak") return "\n";
    if (!Array.isArray(node.content)) return "";
    const kids = node.content as Record<string, unknown>[];
    const inline = kids.every((k) => typeof k.text === "string" || k.type === "hardBreak" || k.type === "image");
    return kids.map(extract).join(inline ? "" : "\n");
  };
  return extract(content as Record<string, unknown>);
}

/** Browser row preview: the text after the title, on one line. */
function getSnippet(note: { title: string; content: object | null }): string {
  const lines = getPlainText(note.content).split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines[0] === note.title.trim()) lines.shift();
  return lines.join(" ").slice(0, 80);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ═══════════════════════════════════════════════════════════ */
/*  STICKY NOTE EDITOR                                        */
/* ═══════════════════════════════════════════════════════════ */

export function StickyNoteEditor() {
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [loaded, setLoaded] = useState(false);

  const {
    state: windowState,
    loaded: winLoaded,
    setNoteId,
    spawnWindow,
    closeWindow: closeWin,
  } = useWindowState();

  const activeNoteId = windowState?.noteId ?? null;
  const activeNote = notes.find((n) => n.id === activeNoteId) ?? null;

  // Panels
  const [showBrowser, setShowBrowser] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [inlineRenaming, setInlineRenaming] = useState(false);
  const [showToolbar, setShowToolbar] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [editorScrolled, setEditorScrolled] = useState(false);
  const [metaHeld, setMetaHeld] = useState(false);
  const [dragY, setDragY] = useState(0);
  const dragCountRef = useRef(0);
  const editorAreaRef = useRef<HTMLDivElement>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [browserIdx, setBrowserIdx] = useState(0);

  const saveTimeoutRef = useRef<NodeJS.Timeout>(undefined);
  // id of the note the editor currently holds. Until this matches the active
  // note, the editor's doc is not that note and must never be written back.
  const hydratedNoteIdRef = useRef<string | null>(null);
  // when this window last changed the doc itself, so that adopting another
  // window's copy never yanks the text out from under someone mid-sentence
  const lastLocalEditRef = useRef(0);
  const filteredNotesRef = useRef<StickyNote[]>([]);
  const browserIdxRef = useRef(0);
  const browserListRef = useRef<HTMLDivElement>(null);
  const paletteListRef = useRef<HTMLDivElement>(null);
  const browserRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const inlineRenameInputRef = useRef<HTMLInputElement>(null);

  // Title drag state — enables "drag titlebar to move window, dblclick to rename"
  interface TitleDrag {
    totalDx: number;
    totalDy: number;
    pendingDx: number;
    pendingDy: number;
    active: boolean;
    rafId: number | null;
  }
  const titleDragRef = useRef<TitleDrag | null>(null);

  /* ─── Tiptap editor ─── */

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Link.configure({ openOnClick: true }),
      Image.configure({ inline: false, allowBase64: true }),
      Placeholder.configure({ placeholder: "Start typing..." }),
      Markdown.configure({
        html: true,
        tightLists: true,
        transformPastedText: true,
        transformCopiedText: false,
      }),
    ],
    content: "",
    onUpdate: ({ editor }) => {
      if (!activeNoteId) return;
      // The editor is still holding another note (or an empty doc while the
      // notes load). Writing now would save that doc over the active note.
      if (hydratedNoteIdRef.current !== activeNoteId) return;
      lastLocalEditRef.current = Date.now();
      const json = editor.getJSON();
      setNotes((prev) =>
        prev.map((n) => {
          if (n.id !== activeNoteId) return n;
          const updated: StickyNote = { ...n, content: json, updatedAt: new Date().toISOString() };
          if (!n.customTitle) {
            const firstLine = getFirstLine(json);
            updated.title = firstLine
              ? firstLine.length > 50 ? firstLine.slice(0, 50) + "…" : firstLine
              : "Untitled";
          }
          return updated;
        })
      );
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => saveAll(), 500);
    },
    editorProps: {
      attributes: { class: "outline-none min-h-[200px]" },
      handlePaste: (view, event) => {
        const files = event.clipboardData?.files;
        if (!files || files.length === 0) return false;
        const image = Array.from(files).find((f) => f.type.startsWith("image/"));
        if (!image) return false;
        event.preventDefault();
        const api = getAPI();
        fileToDataUrl(image).then(async (dataUrl) => {
          const src = api?.saveImage ? await api.saveImage(dataUrl) : dataUrl;
          view.dispatch(
            view.state.tr.replaceSelectionWith(
              view.state.schema.nodes.image.create({ src })
            )
          );
        });
        return true;
      },
      handleDrop: (view, event) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        const image = Array.from(files).find((f) => f.type.startsWith("image/"));
        if (!image) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
        const api = getAPI();
        fileToDataUrl(image).then(async (dataUrl) => {
          const src = api?.saveImage ? await api.saveImage(dataUrl) : dataUrl;
          const node = view.state.schema.nodes.image.create({ src });
          const tr = view.state.tr.insert(pos?.pos ?? view.state.selection.from, node);
          view.dispatch(tr);
        });
        return true;
      },
    },
  });

  /* ─── Load notes ─── */

  useEffect(() => {
    async function load() {
      const api = getAPI();
      if (api) {
        const saved = await api.loadNotes();
        if (saved && saved.length > 0) {
          setNotes(saved.map(migrateNote));
        }
      }
      setLoaded(true);
    }
    load();
  }, []);

  /* ─── Cross-window sync ─── */

  useEffect(() => {
    const api = getAPI();
    if (!api?.onNotesUpdated) return;
    const cleanup = api.onNotesUpdated(async () => {
      const saved = await api.loadNotes();
      const incoming = saved.map(migrateNote);
      setNotes(incoming);

      // Another window saved. If it was this window's active note, the editor
      // is now holding a stale doc, and the next keystroke here would write it
      // back over their edit. Adopt their copy instead.
      if (!editor || !activeNoteId) return;
      if (hydratedNoteIdRef.current !== activeNoteId) return; // not loaded yet
      if (Date.now() - lastLocalEditRef.current < 1500) return; // being typed in
      const note = incoming.find((n) => n.id === activeNoteId);
      if (!note) return;
      if (JSON.stringify(note.content) === JSON.stringify(editor.getJSON())) return;

      const caret = editor.state.selection.from;
      // emitUpdate defaults to true in Tiptap v3: leaving it on would save and
      // re-broadcast, bouncing the update between the windows
      editor.commands.setContent(note.content || "", { emitUpdate: false });
      editor.commands.setTextSelection(Math.min(caret, editor.state.doc.content.size));
    });
    return cleanup;
  }, [editor, activeNoteId]);

  /* ─── Tray-initiated events ─── */

  useEffect(() => {
    const api = getAPI();
    if (!api) return;

    let cleanupCreated: (() => void) | undefined;
    let cleanupJump: (() => void) | undefined;

    if (api.onNoteCreated) {
      cleanupCreated = api.onNoteCreated(async (noteId: string) => {
        const saved = await api.loadNotes();
        setNotes(saved.map(migrateNote));
        setNoteId(noteId);
      });
    }

    if (api.onJumpToNote) {
      cleanupJump = api.onJumpToNote((noteId: string) => {
        setNoteId(noteId);
        setShowBrowser(false);
        setShowPalette(false);
        setInlineRenaming(false);
      });
    }

    return () => {
      cleanupCreated?.();
      cleanupJump?.();
    };
  }, [setNoteId]);

  /* ─── Focus editor when window becomes visible ─── */

  useEffect(() => {
    const handler = () => {
      if (!document.hidden && editor && !showBrowser && !showPalette && !inlineRenaming) {
        setTimeout(() => editor.commands.focus(), 50);
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [editor, showBrowser, showPalette, inlineRenaming]);

  /* ─── Sync editor content when note changes ─── */

  useEffect(() => {
    if (!editor) return;
    if (!activeNoteId) {
      hydratedNoteIdRef.current = null;
      return;
    }
    if (hydratedNoteIdRef.current === activeNoteId) return;
    // On launch the editor mounts before loadNotes() resolves, so the active
    // note is not in state yet. Wait for it: hydrating from a missing note
    // would leave the editor empty and the first keystroke would save that
    // empty doc over the real one.
    if (!loaded || !activeNote) return;
    editor.commands.setContent(activeNote.content || "", { emitUpdate: false });
    hydratedNoteIdRef.current = activeNoteId;
  }, [editor, activeNoteId, activeNote, loaded]);

  /* ─── Save helper ─── */

  const saveAll = useCallback(() => {
    const api = getAPI();
    if (api) {
      setNotes((current) => {
        api.saveNotes(current);
        api.notifyNotesChanged?.();
        return current;
      });
    }
  }, []);

  /* ─── Note actions ─── */

  const addNote = useCallback(() => {
    const n = createNote();
    setNotes((prev) => [n, ...prev]);
    setNoteId(n.id);
    setShowBrowser(false);
    setShowPalette(false);
    setInlineRenaming(false);
    setSearchQuery("");
    setPaletteQuery("");
    setTimeout(saveAll, 100);
  }, [setNoteId, saveAll]);

  const openNewWindow = useCallback(() => {
    spawnWindow({});
    setShowPalette(false);
    setPaletteQuery("");
  }, [spawnWindow]);

  const duplicateNote = useCallback(() => {
    if (!activeNote) return;
    const dup: StickyNote = {
      ...createNote(),
      title: activeNote.customTitle ? `${activeNote.title} (copy)` : activeNote.title,
      customTitle: activeNote.customTitle,
      content: activeNote.content ? JSON.parse(JSON.stringify(activeNote.content)) : null,
    };
    setNotes((prev) => [dup, ...prev]);
    setNoteId(dup.id);
    setShowPalette(false);
    setPaletteQuery("");
    setTimeout(saveAll, 100);
  }, [activeNote, setNoteId, saveAll]);

  const deleteNote = useCallback(
    (id: string) => {
      setNotes((prev) => {
        const remaining = prev.filter((n) => n.id !== id);
        // If we deleted the note this window is showing, switch to another
        // or close the window entirely.
        if (id === activeNoteId) {
          if (remaining.length > 0) {
            setNoteId(remaining[0].id);
          } else {
            closeWin();
          }
        }
        return remaining;
      });
      setTimeout(saveAll, 100);
    },
    [activeNoteId, setNoteId, closeWin, saveAll]
  );

  const togglePin = useCallback(
    (id: string) => {
      setNotes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n))
      );
      setTimeout(saveAll, 100);
    },
    [saveAll]
  );

  const switchNote = useCallback(
    (id: string) => {
      setNoteId(id);
      setShowBrowser(false);
      setSearchQuery("");
    },
    [setNoteId]
  );

  const updateTitle = useCallback(
    (title: string) => {
      if (!activeNoteId) return;
      setNotes((prev) =>
        prev.map((n) =>
          n.id === activeNoteId
            ? { ...n, title: title || "Untitled", customTitle: true }
            : n
        )
      );
      setInlineRenaming(false);
      setTimeout(saveAll, 100);
    },
    [activeNoteId, saveAll]
  );

  const copyNoteAsText = useCallback(() => {
    if (!activeNote) return;
    navigator.clipboard.writeText(getPlainText(activeNote.content));
    setShowPalette(false);
    setPaletteQuery("");
  }, [activeNote]);

  const exportAllNotes = useCallback(() => {
    setShowPalette(false);
    setPaletteQuery("");
    getAPI()?.exportAllNotes?.();
  }, []);

  const importNotes = useCallback(async () => {
    setShowPalette(false);
    setPaletteQuery("");
    const stats = await getAPI()?.importNotes?.();
    // A fresh install opens on an empty note; show what just came in instead.
    // The main process broadcasts the reload, so the note arrives in state
    // on its own and the editor hydrates once it does.
    if (stats?.firstId && !getPlainText(activeNote?.content ?? null).trim()) {
      setNoteId(stats.firstId);
    }
  }, [activeNote, setNoteId]);

  const exportNote = useCallback(() => {
    if (!activeNote) return;
    const text = getPlainText(activeNote.content);
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeNote.title}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setShowPalette(false);
    setPaletteQuery("");
  }, [activeNote]);

  const moveNoteUp = useCallback(() => {
    if (!activeNoteId) return;
    setNotes((prev) => {
      const idx = prev.findIndex((n) => n.id === activeNoteId);
      if (idx <= 0) return prev;
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
    setTimeout(saveAll, 100);
  }, [activeNoteId, saveAll]);

  const moveNoteDown = useCallback(() => {
    if (!activeNoteId) return;
    setNotes((prev) => {
      const idx = prev.findIndex((n) => n.id === activeNoteId);
      if (idx < 0 || idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
    setTimeout(saveAll, 100);
  }, [activeNoteId, saveAll]);

  const toggleToolbar = useCallback(() => {
    setShowToolbar((prev) => !prev);
    setShowPalette(false);
    setPaletteQuery("");
  }, []);

  const closeCurrentWindow = useCallback(() => {
    saveAll();
    closeWin();
  }, [saveAll, closeWin]);

  /* ─── Title drag handlers (manual, so we can keep onDoubleClick) ─── */

  const handleTitlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      if (e.button !== 0) return;
      if (inlineRenaming) return;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
      titleDragRef.current = {
        totalDx: 0, totalDy: 0,
        pendingDx: 0, pendingDy: 0,
        active: false, rafId: null,
      };
    },
    [inlineRenaming]
  );

  const flushDrag = useCallback(() => {
    const d = titleDragRef.current;
    if (!d || (d.pendingDx === 0 && d.pendingDy === 0)) {
      if (d) d.rafId = null;
      return;
    }
    const api = getAPI();
    api?.moveWindowBy?.({ dx: d.pendingDx, dy: d.pendingDy });
    d.pendingDx = 0;
    d.pendingDy = 0;
    d.rafId = null;
  }, []);

  const handleTitlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      const d = titleDragRef.current;
      if (!d) return;
      const dx = e.movementX;
      const dy = e.movementY;
      if (!d.active) {
        d.totalDx += dx;
        d.totalDy += dy;
        if (Math.hypot(d.totalDx, d.totalDy) < 4) return;
        d.active = true;
        d.pendingDx = d.totalDx;
        d.pendingDy = d.totalDy;
      } else {
        d.pendingDx += dx;
        d.pendingDy += dy;
      }
      // Batch IPC calls to once per animation frame for smoother movement
      if (d.rafId === null) {
        d.rafId = requestAnimationFrame(flushDrag);
      }
    },
    [flushDrag]
  );

  const handleTitlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      const d = titleDragRef.current;
      if (d) {
        // Flush any remaining pending movement
        if (d.rafId !== null) cancelAnimationFrame(d.rafId);
        if (d.pendingDx !== 0 || d.pendingDy !== 0) {
          getAPI()?.moveWindowBy?.({ dx: d.pendingDx, dy: d.pendingDy });
        }
      }
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      titleDragRef.current = null;
    },
    []
  );

  /* ─── Command palette ─── */

  const commands: PaletteCommand[] = useMemo(
    () => [
      { id: "new", icon: Plus, label: "New Note", keys: ["⌘", "N"], action: addNote },
      { id: "new-window", icon: AppWindow, label: "New Window", action: openNewWindow },
      { id: "dup", icon: Copy, label: "Duplicate Note", action: duplicateNote },
      { id: "browse", icon: Layers, label: "Browse Notes", keys: ["⌘", "P"], action: () => { setShowPalette(false); setPaletteQuery(""); setShowBrowser(true); } },
      { id: "rename", icon: FileText, label: "Rename Note", keys: ["⌘", "R"], dividerBefore: true, action: () => { setShowPalette(false); setPaletteQuery(""); setInlineRenaming(true); } },
      { id: "pin", icon: Pin, label: activeNote?.pinned ? "Unpin Note" : "Pin Note", action: () => { if (activeNoteId) togglePin(activeNoteId); setShowPalette(false); setPaletteQuery(""); } },
      { id: "copy", icon: Clipboard, label: "Copy as Plain Text", dividerBefore: true, action: copyNoteAsText },
      { id: "export", icon: Download, label: "Export as Text...", action: exportNote },
      { id: "export-all", icon: Archive, label: "Export All Notes...", action: exportAllNotes },
      { id: "import", icon: ArchiveRestore, label: "Import Notes...", action: importNotes },
      { id: "toggle-toolbar", icon: FileCode, label: "Toggle Editor Tools", action: toggleToolbar },
      { id: "up", icon: ArrowUp, label: "Move Note Up", dividerBefore: true, action: () => { moveNoteUp(); setShowPalette(false); setPaletteQuery(""); } },
      { id: "down", icon: ArrowDown, label: "Move Note Down", action: () => { moveNoteDown(); setShowPalette(false); setPaletteQuery(""); } },
      { id: "close-window", icon: X, label: "Close Window", dividerBefore: true, action: closeCurrentWindow },
      { id: "delete", icon: Trash2, label: "Delete Note", action: () => { if (activeNoteId) deleteNote(activeNoteId); setShowPalette(false); setPaletteQuery(""); } },
    ],
    [showToolbar, toggleToolbar, addNote, openNewWindow, duplicateNote, activeNote, activeNoteId, togglePin, copyNoteAsText, exportNote, exportAllNotes, importNotes, moveNoteUp, moveNoteDown, closeCurrentWindow, deleteNote]
  );

  const filteredCommands = useMemo(() => {
    if (!paletteQuery.trim()) return commands;
    const q = paletteQuery.toLowerCase();
    return commands.filter((a) => a.label.toLowerCase().includes(q));
  }, [commands, paletteQuery]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [filteredCommands.length]);

  useEffect(() => {
    if (searchQuery) setBrowserIdx(0);
  }, [searchQuery]);

  /* ─── Close overlays on click outside ─── */

  useEffect(() => {
    if (!showBrowser && !showPalette) return;
    const handler = (e: MouseEvent) => {
      if (showBrowser && browserRef.current && !browserRef.current.contains(e.target as Node)) {
        setShowBrowser(false);
        setSearchQuery("");
      }
      if (showPalette && paletteRef.current && !paletteRef.current.contains(e.target as Node)) {
        setShowPalette(false);
        setPaletteQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showBrowser, showPalette]);

  /* ─── Focus inputs when panels open ─── */

  useEffect(() => {
    if (showBrowser) {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      const idx = filteredNotes.findIndex((n) => n.id === activeNoteId);
      setBrowserIdx(idx >= 0 ? idx : 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBrowser]);

  useEffect(() => {
    if (showPalette) setTimeout(() => paletteInputRef.current?.focus(), 50);
  }, [showPalette]);

  useEffect(() => {
    if (inlineRenaming) {
      setTimeout(() => {
        inlineRenameInputRef.current?.focus();
        inlineRenameInputRef.current?.select();
      }, 30);
    }
  }, [inlineRenaming]);

  /* ─── Auto-scroll selected row into view (both panels) ─── */

  useEffect(() => {
    if (!showBrowser) return;
    const el = browserListRef.current?.querySelector<HTMLElement>(
      `[data-browser-idx="${browserIdx}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [browserIdx, showBrowser]);

  useEffect(() => {
    if (!showPalette) return;
    const el = paletteListRef.current?.querySelector<HTMLElement>(
      `[data-command-idx="${highlightIdx}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIdx, showPalette]);

  /* ─── Command key held: reveals the shortcut hints on a blank note ─── */

  useEffect(() => {
    const sync = (e: KeyboardEvent) => setMetaHeld(e.metaKey || e.ctrlKey);
    // blur/visibility clear it, or the hints stick when the window loses focus
    // mid-chord (⌘Tab) and the keyup never arrives
    const clear = () => setMetaHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);

  /* ─── Keyboard handler ─── */

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      if (e.key === "Escape") {
        if (inlineRenaming) { setInlineRenaming(false); return; }
        if (showPalette) { setShowPalette(false); setPaletteQuery(""); return; }
        if (showBrowser) { setShowBrowser(false); setSearchQuery(""); return; }
      }

      if (showPalette) {
        if (e.key === "ArrowDown") { e.preventDefault(); setHighlightIdx((i) => Math.min(i + 1, filteredCommands.length - 1)); }
        if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx((i) => Math.max(i - 1, 0)); }
        if (e.key === "Enter" && filteredCommands[highlightIdx]) { e.preventDefault(); filteredCommands[highlightIdx].action(); }
      }

      if (showBrowser && !meta) {
        const fn = filteredNotesRef.current;
        if (e.key === "ArrowDown") { e.preventDefault(); setBrowserIdx((i) => Math.min(i + 1, fn.length - 1)); }
        if (e.key === "ArrowUp") { e.preventDefault(); setBrowserIdx((i) => Math.max(i - 1, 0)); }
        if (e.key === "Enter") {
          const note = fn[browserIdxRef.current];
          if (note) { e.preventDefault(); switchNote(note.id); }
        }
        if (e.key.length === 1 && !e.altKey) {
          searchInputRef.current?.focus();
        }
      }

      if (meta && !e.shiftKey && !inlineRenaming) {
        if (e.key === "k") {
          e.preventDefault();
          setShowBrowser(false);
          setSearchQuery("");
          setShowPalette((prev) => !prev);
          if (!showPalette) setPaletteQuery("");
        }
        if (e.key === "n") {
          e.preventDefault();
          addNote();
        }
        if (e.key === "p") {
          e.preventDefault();
          setShowPalette(false);
          setPaletteQuery("");
          setShowBrowser((prev) => !prev);
          if (!showBrowser) setSearchQuery("");
        }
        if (e.key === "r") {
          e.preventDefault();
          setShowBrowser(false);
          setSearchQuery("");
          setShowPalette(false);
          setPaletteQuery("");
          setInlineRenaming(true);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [showBrowser, showPalette, inlineRenaming, filteredCommands, highlightIdx, addNote, switchNote]);

  /* ─── Filtered notes for browser ─── */

  const filteredNotes = notes.filter((n) => {
    if (!searchQuery.trim()) return true;
    return n.title.toLowerCase().includes(searchQuery.toLowerCase());
  });
  filteredNotesRef.current = filteredNotes;
  browserIdxRef.current = browserIdx;

  if (!loaded || !winLoaded) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#191919]">
        <div className="h-5 w-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  const anyOverlay = showBrowser || showPalette;
  const isBlank = !getPlainText(activeNote?.content ?? null).trim();

  return (
    <div className="app-shell flex flex-col h-screen text-foreground overflow-hidden select-none">
      {/* ─── Title Bar ─── */}
      <div
        className="app-drag scroll-edge flex items-center gap-1.5 px-3 h-[38px] shrink-0 bg-[var(--material-chrome)]"
        data-scrolled={editorScrolled}
      >
        <div className="w-[52px] shrink-0" />

        <div className="flex-1 flex items-center justify-center min-w-0 px-2">
          <div className="app-no-drag min-w-0 max-w-full">
            {inlineRenaming ? (
              <input
                ref={inlineRenameInputRef}
                defaultValue={activeNote?.title ?? ""}
                onKeyDown={(e) => {
                  if (e.key === "Enter") updateTitle((e.target as HTMLInputElement).value);
                  if (e.key === "Escape") setInlineRenaming(false);
                }}
                onBlur={(e) => updateTitle(e.target.value)}
                className="type-title w-full max-w-[240px] text-center bg-[var(--material-control)] rounded-md px-2 py-0.5 border border-white/[0.08] text-foreground outline-none focus:border-primary/45 focus:bg-[var(--material-control-hover)] transition-colors"
                spellCheck={false}
              />
            ) : (
              <span
                onPointerDown={handleTitlePointerDown}
                onPointerMove={handleTitlePointerMove}
                onPointerUp={handleTitlePointerUp}
                onPointerCancel={handleTitlePointerUp}
                onDoubleClick={() => setInlineRenaming(true)}
                className="type-title text-foreground/85 truncate block select-none"
                title="Double-click to rename"
              >
                {activeNote?.title ?? "Untitled"}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => { setShowPalette(!showPalette); setShowBrowser(false); setInlineRenaming(false); }}
            className={`app-no-drag h-[22px] w-[22px] flex items-center justify-center rounded-[6px] transition-colors duration-150 ${
              showPalette
                ? "text-foreground/95 bg-[var(--material-control-active)] shadow-[inset_0_1px_0_var(--edge-highlight)]"
                : "text-white/45 hover:text-white/80 hover:bg-[var(--material-control)]"
            }`}
            title="Command palette (⌘K)"
          >
            <Command className="h-[13px] w-[13px]" strokeWidth={1.9} />
          </button>

          <button
            onClick={() => { setShowBrowser(!showBrowser); setShowPalette(false); setInlineRenaming(false); }}
            className={`app-no-drag h-[22px] w-[22px] flex items-center justify-center rounded-[6px] transition-colors duration-150 ${
              showBrowser
                ? "text-foreground/95 bg-[var(--material-control-active)] shadow-[inset_0_1px_0_var(--edge-highlight)]"
                : "text-white/45 hover:text-white/80 hover:bg-[var(--material-control)]"
            }`}
            title="Browse notes (⌘P)"
          >
            <FileText className="h-[13px] w-[13px]" strokeWidth={1.9} />
          </button>

          <button
            onClick={addNote}
            className="app-no-drag h-[22px] w-[22px] flex items-center justify-center rounded-[6px] text-white/45 hover:text-white/80 hover:bg-[var(--material-control)] transition-colors duration-150"
            title="New note (⌘N)"
          >
            <Plus className="h-[14px] w-[14px]" strokeWidth={1.9} />
          </button>
        </div>
      </div>

      {/* ─── Editor ─── */}
      <div
        ref={editorAreaRef}
        className="flex-1 overflow-auto px-4 py-3.5 select-text relative"
        onScroll={(e) => setEditorScrolled(e.currentTarget.scrollTop > 2)}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.tagName === "IMG" && (target as HTMLImageElement).src) {
            getAPI()?.openImage?.((target as HTMLImageElement).src);
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          dragCountRef.current++;
          if (e.dataTransfer?.types.includes("Files")) setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!editorAreaRef.current) return;
          const rect = editorAreaRef.current.getBoundingClientRect();
          setDragY(e.clientY - rect.top + editorAreaRef.current.scrollTop);
        }}
        onDragLeave={() => {
          dragCountRef.current--;
          if (dragCountRef.current <= 0) { dragCountRef.current = 0; setDragOver(false); }
        }}
        onDrop={() => { dragCountRef.current = 0; setDragOver(false); }}
      >
        {dragOver && (
          <div
            className="absolute inset-x-4 h-[3px] rounded-full bg-primary/60 pointer-events-none z-10 transition-[top] duration-75"
            style={{ top: Math.max(0, dragY) }}
          />
        )}
        <div className="prose-notes">
          <EditorContent editor={editor} />
        </div>

        {isBlank && metaHeld && (
          <div className="animate-in fade-in duration-100 pointer-events-none absolute left-4 top-[38px] flex flex-wrap gap-x-3.5 gap-y-1.5 opacity-40">
            {[
              { keys: ["⌘", "N"], label: "New note" },
              { keys: ["⌘", "P"], label: "Browse" },
              { keys: ["⌘", "K"], label: "Commands" },
            ].map((hint) => (
              <span key={hint.label} className="flex items-center gap-1">
                {hint.keys.map((k) => (
                  <kbd key={k} className="kbd">{k}</kbd>
                ))}
                <span className="type-meta text-white/45 ml-0.5">{hint.label}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ─── Toolbar ─── */}
      {showToolbar && (
        <NotesToolbar editor={editor} onClose={() => setShowToolbar(false)} />
      )}

      {/* ─── Overlays ─── */}
      {anyOverlay && (
        <div className="absolute inset-0 z-40 flex items-start justify-center pt-[56px]">
          <div
            className="scrim absolute inset-0 bg-black/30 backdrop-blur-[1.5px]"
            onClick={() => {
              setShowBrowser(false); setSearchQuery("");
              setShowPalette(false); setPaletteQuery("");
            }}
          />

          {/* Command Palette */}
          {showPalette && (
            <div
              ref={paletteRef}
              className="surface-elevated materialize relative w-[calc(100%-20px)] max-w-[420px] rounded-[12px] overflow-hidden"
            >
              <div className="px-2.5 pt-2.5 pb-1.5">
                <div className="flex items-center gap-2 bg-[var(--material-control)] rounded-[8px] px-2.5 h-[30px] border border-white/[0.05] focus-within:border-white/[0.14] focus-within:bg-[var(--material-control-hover)] transition-colors">
                  <Search className="h-[13px] w-[13px] text-white/30 shrink-0" strokeWidth={2} />
                  <input
                    ref={paletteInputRef}
                    value={paletteQuery}
                    onChange={(e) => setPaletteQuery(e.target.value)}
                    placeholder="Type a command..."
                    className="type-body flex-1 bg-transparent text-foreground placeholder:text-white/25 outline-none"
                    spellCheck={false}
                  />
                </div>
              </div>

              <div
                ref={paletteListRef}
                className="list-fade max-h-[300px] overflow-y-auto px-1.5 pb-1.5"
              >
                {filteredCommands.map((action, idx) => {
                  const Icon = action.icon;
                  const isHighlighted = idx === highlightIdx;
                  return (
                    <div key={action.id} data-command-idx={idx}>
                      {action.dividerBefore && idx > 0 && (
                        <div className="mx-2.5 my-1 h-px bg-[var(--separator)]" />
                      )}
                      <button
                        onClick={action.action}
                        onMouseEnter={() => setHighlightIdx(idx)}
                        className={`w-full flex items-center gap-2.5 px-2.5 h-[30px] rounded-[7px] text-left transition-colors duration-75 ${
                          isHighlighted
                            ? "bg-[var(--material-control-active)] text-foreground"
                            : "text-foreground/75 hover:bg-[var(--material-control)]"
                        }`}
                      >
                        <Icon
                          className={`h-[14px] w-[14px] shrink-0 transition-colors ${isHighlighted ? "text-primary/80" : "text-white/40"}`}
                          strokeWidth={1.9}
                        />
                        <span className="type-body flex-1 truncate">{action.label}</span>
                        {action.keys && (
                          <div className="flex items-center gap-0.5 shrink-0">
                            {action.keys.map((key, i) => (
                              <kbd key={i} className="kbd">
                                {key}
                              </kbd>
                            ))}
                          </div>
                        )}
                      </button>
                    </div>
                  );
                })}
                {filteredCommands.length === 0 && (
                  <div className="type-body px-3 py-6 text-center text-white/25">
                    No commands found
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Browse Notes Panel */}
          {showBrowser && (
            <div
              ref={browserRef}
              className="surface-elevated materialize relative w-[calc(100%-20px)] max-w-[420px] rounded-[12px] overflow-hidden"
            >
              <div className="px-2.5 pt-2.5 pb-1.5">
                <div className="flex items-center gap-2 bg-[var(--material-control)] rounded-[8px] px-2.5 h-[30px] border border-white/[0.05] focus-within:border-white/[0.14] focus-within:bg-[var(--material-control-hover)] transition-colors">
                  <Search className="h-[13px] w-[13px] text-white/30 shrink-0" strokeWidth={2} />
                  <input
                    ref={searchInputRef}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search for notes..."
                    className="type-body flex-1 bg-transparent text-foreground placeholder:text-white/25 outline-none"
                    spellCheck={false}
                  />
                </div>
              </div>

              <div className="px-3 pt-1 pb-1">
                <span className="type-section text-white/35">Notes</span>
              </div>

              <div
                ref={browserListRef}
                className="list-fade max-h-[290px] overflow-y-auto px-1.5 pb-1"
              >
                {filteredNotes.map((note, idx) => {
                  const isCurrent = note.id === activeNoteId;
                  const isHighlighted = idx === browserIdx;
                  return (
                    <button
                      key={note.id}
                      data-browser-idx={idx}
                      onClick={() => switchNote(note.id)}
                      onMouseEnter={() => setBrowserIdx(idx)}
                      className={`group relative w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[7px] text-left transition-colors duration-100 ${
                        isHighlighted
                          ? "bg-[var(--material-control-active)]"
                          : isCurrent
                            ? "bg-[var(--material-control)]"
                            : "hover:bg-[var(--material-control)]"
                      }`}
                    >

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`type-title truncate ${isCurrent ? "text-foreground" : "text-foreground/85"}`}>
                            {note.title}
                          </span>
                          {note.pinned && (
                            <Pin className="h-[9px] w-[9px] text-primary/70 shrink-0 fill-primary/70" />
                          )}
                        </div>
                        <div className="type-meta text-white/35 truncate">
                          {getSnippet(note) || (getPlainText(note.content).trim() ? "No additional text" : "Empty note")}
                        </div>
                      </div>

                      <span className="type-meta text-white/30 shrink-0 tabular-nums group-hover:opacity-0 transition-opacity">
                        {timeAgo(note.updatedAt)}
                      </span>

                      <div className="absolute right-2.5 flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        <span
                          onClick={(e) => { e.stopPropagation(); togglePin(note.id); }}
                          className={`h-[22px] w-[22px] flex items-center justify-center rounded-[6px] transition-colors cursor-pointer ${
                            note.pinned
                              ? "text-primary/80 hover:text-primary hover:bg-[var(--material-control)]"
                              : "text-white/35 hover:text-white/70 hover:bg-[var(--material-control)]"
                          }`}
                          title={note.pinned ? "Unpin" : "Pin"}
                        >
                          <Pin className={`h-3 w-3 ${note.pinned ? "fill-current" : ""}`} />
                        </span>
                        <span
                          onClick={(e) => { e.stopPropagation(); deleteNote(note.id); }}
                          className="h-[22px] w-[22px] flex items-center justify-center rounded-[6px] text-white/35 hover:text-destructive hover:bg-destructive/12 transition-colors cursor-pointer"
                          title="Delete"
                        >
                          <Trash2 className="h-3 w-3" />
                        </span>
                      </div>
                    </button>
                  );
                })}

                {filteredNotes.length === 0 && (
                  <div className="type-body px-3 py-6 text-center text-white/25">
                    No notes found
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--separator)] px-1.5 py-1.5">
                <button
                  onClick={addNote}
                  className="w-full flex items-center gap-2 px-2.5 h-[28px] rounded-[7px] text-white/45 hover:text-white/85 hover:bg-[var(--material-control)] transition-colors"
                >
                  <Plus className="h-[13px] w-[13px]" strokeWidth={1.9} />
                  <span className="type-body flex-1 text-left">New note</span>
                  <kbd className="kbd">⌘N</kbd>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
