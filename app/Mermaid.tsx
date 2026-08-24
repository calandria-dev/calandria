"use client";

import { useEffect, useRef, useState } from "react";

// A ```mermaid fence rendered as a diagram. Used by <Markdown diagrams> —
// today that's the collaboration modal, where an agent's design doc gets a
// real flowchart instead of a code block.
//
// mermaid is ~2MB and DOM-only, so it's loaded on first use with a dynamic
// import (Turbopack splits it into its own chunk) rather than bundled with
// the transcript; the promise is module-level so every diagram on the page
// shares one load.
//
// The Edit tab re-renders the document on every keystroke, and a diagram
// being typed is invalid far more often than not. So: source changes after
// the first render are debounced, and a failed parse keeps the LAST GOOD
// diagram on screen with the parser's message under it — the picture doesn't
// blink out mid-edit, and the message says what's still missing.

type MermaidApi = typeof import("mermaid").default;
let api: Promise<MermaidApi> | null = null;
const loadMermaid = () => (api ??= import("mermaid").then((m) => m.default));

// Every render gets a fresh id: mermaid.render() REMOVES any element already
// carrying its id from the document before drawing, and the previous SVG we
// injected carries the previous id. Re-using one would have the redraw delete
// the diagram it's replacing out from under React.
let seq = 0;

const DEBOUNCE_MS = 300;

export function Mermaid({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const first = useRef(true);
  const gen = useRef(0);

  useEffect(() => {
    const mine = ++gen.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draw = async () => {
      try {
        const mermaid = await loadMermaid();
        if (mine !== gen.current) return;
        // Follows the app theme the way CodeMirror in the editor pane does;
        // `strict` is mermaid's default and keeps the SVG through DOMPurify,
        // since the source is whatever the agent (or the user) wrote.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: document.documentElement.dataset.mode === "light" ? "default" : "dark",
        });
        // parse() first: a failed render() can leave its error element in the
        // document body, a failed parse() leaves nothing.
        await mermaid.parse(source);
        const { svg: out } = await mermaid.render(`mmd-${++seq}`, source);
        if (mine !== gen.current) return;
        setSvg(out);
        setErr(null);
      } catch (e) {
        if (mine !== gen.current) return;
        setErr((e instanceof Error ? e.message : String(e)).trim() || "Invalid diagram");
      }
    };
    if (first.current) {
      first.current = false;
      void draw();
    } else {
      timer = setTimeout(() => void draw(), DEBOUNCE_MS);
    }
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [source]);

  return (
    <div className={`md-mermaid${err ? " md-mermaid-bad" : ""}`} data-testid="mermaid">
      {svg !== null ? (
        <div className="md-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        // Nothing drawn yet (loading, or never valid): the source still reads
        // as the code block it would have been.
        <pre><code className="language-mermaid">{source}</code></pre>
      )}
      {err && <div className="md-mermaid-err">Diagram didn’t render: {err}</div>}
    </div>
  );
}
