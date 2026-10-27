/**
 * Markdown Source Editor
 *
 * Plain textarea shown when the window is in "markdown" view mode.
 * Reads the current note's markdown via tiptap-markdown's storage helper
 * and writes back through editor.commands.setContent — so the rich editor
 * stays in sync and auto-save continues working unchanged.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";

interface MarkdownSourceEditorProps {
  editor: Editor | null;
  noteId: string | null;
}

function readMarkdown(editor: Editor | null): string {
  if (!editor) return "";
  const storage = (editor.storage as unknown as {
    markdown?: { getMarkdown?: () => string };
  }).markdown;
  return storage?.getMarkdown?.() ?? editor.getText();
}

export function MarkdownSourceEditor({ editor, noteId }: MarkdownSourceEditorProps) {
  const [value, setValue] = useState<string>(() => readMarkdown(editor));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const writeTimer = useRef<NodeJS.Timeout>(undefined);

  // When the active note changes, re-read source from the editor
  useEffect(() => {
    setValue(readMarkdown(editor));
  }, [noteId, editor]);

  // Focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      spellCheck={false}
      onChange={(e) => {
        const next = e.target.value;
        setValue(next);
        clearTimeout(writeTimer.current);
        writeTimer.current = setTimeout(() => {
          if (editor) {
            // tiptap-markdown parses markdown strings when passed to setContent
            editor.commands.setContent(next);
          }
        }, 150);
      }}
      className="markdown-source-editor w-full min-h-[200px] bg-transparent outline-none resize-none text-foreground/90"
      placeholder="Start typing markdown..."
    />
  );
}
