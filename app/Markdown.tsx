"use client";

import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { Mermaid } from "./Mermaid";
import { mermaidSourceOf } from "@/lib/mermaid";
import { codeBlockTextOf } from "@/lib/codeBlock";
import { Icon } from "./icons";

// Renders an agent's markdown output: headings, lists, tables, fenced code blocks
// (syntax-highlighted), inline code, links. Used for assistant + user messages.
//
// `detect: false`: only fenced blocks with an explicit language get
// highlighted; hljs auto-detection over every bare code block is expensive
// during streaming turns. Memoized so messages whose text hasn't changed skip
// the whole markdown parse and highlight on transcript re-renders.
//
// `diagrams` swaps a ```mermaid fence for the rendered diagram. Opt-in
// because the transcript renders a message on every streamed token: a
// half-written diagram would fail to parse on each one, and the mermaid
// chunk would load for every session that mentions a flowchart. The
// collaboration modal turns it on, since a document there is read whole.
const link = (props: ComponentProps<"a">) => <a {...props} target="_blank" rel="noreferrer" />;

const COPIED_MS = 1400;

// The copy affordance sits in a wrapper beside the <pre>. The <pre> scrolls
// horizontally, so a button inside it would slide off screen on a wide block.
// It stays hidden until the block is hovered or the button takes focus (see
// `.md-copy` in globals.css), which keeps it out of a screenshotted transcript
// while leaving it reachable from the keyboard.
function CopyCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch { /* clipboard blocked */ }
  };
  const label = copied ? "Copied" : "Copy code";
  return (
    <button type="button" className={`md-copy${copied ? " on" : ""}`} title={label} aria-label={label} onClick={copy}>
      {copied ? Icon.check() : Icon.copy()}
    </button>
  );
}

// Wraps every fenced block so it can carry a copy button. A `pre` with no text
// to copy (an empty fence, an indented block the pipeline shaped differently)
// gets neither the wrapper nor the button.
const codePre = ({ node, children, ...props }: ComponentProps<"pre"> & ExtraProps) => {
  const text = codeBlockTextOf(node);
  if (text === null) return <pre {...props}>{children}</pre>;
  return (
    <div className="md-pre">
      <pre {...props}>{children}</pre>
      <CopyCode text={text} />
    </div>
  );
};

const diagramPre = (props: ComponentProps<"pre"> & ExtraProps) => {
  const source = mermaidSourceOf(props.node);
  return source === null ? codePre(props) : <Mermaid source={source} />;
};

const PLAIN = { a: link, pre: codePre };
const WITH_DIAGRAMS = { a: link, pre: diagramPre };

export const Markdown = memo(function Markdown({ children, diagrams = false }: { children: string; diagrams?: boolean }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={diagrams ? WITH_DIAGRAMS : PLAIN}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
