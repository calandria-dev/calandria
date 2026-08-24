"use client";

import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";

// The edit half of collaboration mode: a SOURCE editor, deliberately not a
// WYSIWYG one. Every rich markdown editor surveyed (MDXEditor, Milkdown,
// TipTap, Lexical, Plate, BlockNote) parses to an AST and re-serializes on
// save, reformatting list markers, table padding and heading styles the user
// never touched — and what leaves this modal is a DIFF sent to the agent, so
// untouched lines must come back byte-identical. CodeMirror edits the literal
// text, which makes that true by construction. The rendered view sits beside
// it (CollabDoc), so the user still reads the document as a document.
//
// Loaded through next/dynamic from CollabDoc so CodeMirror stays out of the
// main bundle until someone actually opens a document.
export default function MarkdownEditor({ value, onChange, dark }: { value: string; onChange: (v: string) => void; dark: boolean }) {
  const extensions = useMemo(
    () => [markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping],
    []
  );
  return (
    <CodeMirror
      className="collab-cm"
      value={value}
      height="100%"
      theme={dark ? "dark" : "light"}
      extensions={extensions}
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false }}
      onChange={onChange}
    />
  );
}
