"use client";

import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { isMarkdownPath } from "@/lib/collab";

// The edit half of collaboration mode: a SOURCE editor, deliberately not a
// WYSIWYG one. Every rich markdown editor surveyed (MDXEditor, Milkdown,
// TipTap, Lexical, Plate, BlockNote) parses to an AST and re-serializes on
// save, reformatting list markers, table padding and heading styles the user
// never touched — and what leaves this modal is a DIFF sent to the agent, so
// untouched lines must come back byte-identical. CodeMirror edits the literal
// text, which makes that true by construction. The rendered view sits beside
// it (CollabDoc), so the user still reads the document as a document.
//
// `filename` picks the syntax: markdown for a document, otherwise whatever
// @codemirror/language-data matches the extension (loaded on demand, since
// each grammar is its own chunk), and plain text when nothing matches.
//
// Loaded through next/dynamic from CollabDoc so CodeMirror stays out of the
// main bundle until someone actually opens a document.
export default function MarkdownEditor({ value, onChange, dark, filename = "document.md" }: {
  value: string;
  onChange: (v: string) => void;
  dark: boolean;
  filename?: string;
}) {
  const [lang, setLang] = useState<{ file: string; ext: Extension } | null>(null);
  useEffect(() => {
    if (isMarkdownPath(filename)) {
      setLang({ file: filename, ext: markdown({ base: markdownLanguage, codeLanguages: languages }) });
      return;
    }
    const desc = LanguageDescription.matchFilename(languages, filename);
    if (!desc) { setLang({ file: filename, ext: [] }); return; }
    let dead = false;
    desc.load().then(
      (support) => { if (!dead) setLang({ file: filename, ext: support }); },
      () => { if (!dead) setLang({ file: filename, ext: [] }); }
    );
    return () => { dead = true; };
  }, [filename]);
  const extensions = useMemo(
    () => [lang?.file === filename ? lang.ext : [], EditorView.lineWrapping],
    [lang, filename]
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
