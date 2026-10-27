/**
 * Notes Toolbar
 *
 * Bottom formatting bar for the sticky notes editor.
 * Provides rich text formatting controls via Tiptap editor commands.
 */
"use client";

import { useState, useCallback } from "react";
import type { Editor } from "@tiptap/react";
import {
  Bold, Italic, Strikethrough, Underline, Code,
  Link, AlignLeft, AlignCenter, AlignRight,
  List, ListOrdered, Heading, XCircle,
} from "lucide-react";

export function NotesToolbar({
  editor,
  onClose,
}: {
  editor: Editor | null;
  onClose: () => void;
}) {
  const [showHeadings, setShowHeadings] = useState(false);

  const toggleLink = useCallback(() => {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const url = window.prompt("URL:");
    if (url) {
      editor.chain().focus().setLink({ href: url }).run();
    }
  }, [editor]);

  if (!editor) return null;

  return (
    <div className="app-no-drag flex items-center gap-px px-1.5 h-[34px] border-t border-[var(--separator)] bg-[var(--material-chrome)] shrink-0 relative">
      {/* Heading dropdown */}
      <div className="relative">
        <ToolbarButton
          icon={Heading}
          active={editor.isActive("heading")}
          onClick={() => setShowHeadings(!showHeadings)}
          title="Heading"
          hasDropdown
        />
        {showHeadings && (
          <div className="surface-elevated materialize absolute bottom-full left-0 mb-1.5 rounded-[9px] py-1 min-w-[118px] z-50 origin-bottom">
            {([1, 2, 3] as const).map((level) => (
              <button
                key={level}
                onClick={() => {
                  editor.chain().focus().toggleHeading({ level }).run();
                  setShowHeadings(false);
                }}
                className={`type-body w-full px-2.5 py-1 text-left transition-colors ${
                  editor.isActive("heading", { level })
                    ? "text-foreground bg-[var(--material-control-active)]"
                    : "text-foreground/70 hover:text-foreground hover:bg-[var(--material-control)]"
                }`}
              >
                Heading {level}
              </button>
            ))}
            <button
              onClick={() => {
                editor.chain().focus().setParagraph().run();
                setShowHeadings(false);
              }}
              className="type-body w-full px-2.5 py-1 text-left text-foreground/70 hover:text-foreground hover:bg-[var(--material-control)] transition-colors"
            >
              Paragraph
            </button>
          </div>
        )}
      </div>

      <ToolbarButton icon={Bold} active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold" />
      <ToolbarButton icon={Italic} active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic" />
      <ToolbarButton icon={Strikethrough} active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough" />
      <ToolbarButton icon={Underline} active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline" />
      <ToolbarButton icon={Code} active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()} title="Code" />
      <ToolbarButton icon={Link} active={editor.isActive("link")} onClick={toggleLink} title="Link" />

      <div className="w-px h-3.5 bg-[var(--separator)] mx-1" />

      <ToolbarButton icon={AlignLeft} active={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()} title="Align left" />
      <ToolbarButton icon={AlignCenter} active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()} title="Align center" />
      <ToolbarButton icon={AlignRight} active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()} title="Align right" />

      <div className="w-px h-3.5 bg-[var(--separator)] mx-1" />

      <ToolbarButton icon={List} active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list" />
      <ToolbarButton icon={ListOrdered} active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Ordered list" />

      <div className="flex-1" />

      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="app-no-drag h-[24px] w-[24px] flex items-center justify-center rounded-[6px] text-white/35 hover:text-white/80 hover:bg-[var(--material-control)] transition-colors duration-150"
        title="Hide formatting bar"
      >
        <XCircle className="h-[14px] w-[14px]" strokeWidth={1.9} />
      </button>
    </div>
  );
}

function ToolbarButton({
  icon: Icon,
  active,
  onClick,
  title,
  hasDropdown,
}: {
  icon: typeof Bold;
  active: boolean;
  onClick: () => void;
  title: string;
  hasDropdown?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`h-[26px] w-[26px] flex items-center justify-center rounded-[6px] transition-colors duration-100 ${
        active
          ? "text-foreground bg-[var(--material-control-active)] shadow-[inset_0_1px_0_var(--edge-highlight)]"
          : "text-white/45 hover:text-white/85 hover:bg-[var(--material-control)]"
      }`}
    >
      <Icon className="h-[13px] w-[13px]" strokeWidth={1.9} />
      {hasDropdown && <span className="text-[8px] ml-[-2px] mt-1">▾</span>}
    </button>
  );
}
