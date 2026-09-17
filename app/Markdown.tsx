"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { Mermaid } from "./Mermaid";
import { mermaidSourceOf } from "@/lib/mermaid";
import { codeBlockTextOf } from "@/lib/codeBlock";
import { isFileLink, localLinkTarget, rawFileUrl } from "@/lib/localLink";
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
//
// `links` makes a link that names a file in the task's checkout open in the
// app: text in the collaboration modal through `onOpen`, an image or other
// binary from the raw file route in a new tab. Without it every link is a
// plain new-tab anchor, and a relative `docs/x.md` would navigate to
// `<origin>/docs/x.md` and 404. See lib/localLink.ts for what counts.
export type MarkdownLinks = {
  taskId: string;
  /** Absolute directories an absolute path is re-rooted against, in order:
   *  the task's worktree, then the project's repo. */
  roots: string[];
  /** Worktree-relative directory a relative href resolves against: "" for a
   *  transcript message, the document's own directory inside the modal. */
  baseDir?: string;
  onOpen: (rel: string) => void;
};

const link = ({ node: _node, ...props }: ComponentProps<"a"> & ExtraProps) => <a {...props} target="_blank" rel="noreferrer" />;

function fileAwareLink(links: MarkdownLinks) {
  return function FileLink({ node: _node, href, children, ...props }: ComponentProps<"a"> & ExtraProps) {
    const hit = href ? localLinkTarget(href, links.roots, links.baseDir) : null;
    if (!hit) return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
    if (hit.open === "raw") {
      return <a {...props} href={rawFileUrl(links.taskId, hit.rel)} className="md-file" title={hit.rel} target="_blank" rel="noreferrer">{children}</a>;
    }
    const open = (e: React.MouseEvent) => {
      e.preventDefault();
      links.onOpen(hit.rel);
    };
    return <a {...props} href={href} className="md-file" title={`Open ${hit.rel} in collaboration mode`} onClick={open}>{children}</a>;
  };
}

// react-markdown blanks any href whose scheme it doesn't know, which takes
// `file:///…`, `C:\…` and `lib/a.ts:42` with it. Those are the links this
// component wants to see; everything else keeps the default filter.
const urlTransform = (url: string) => (isFileLink(url) ? url : defaultUrlTransform(url));

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

export const Markdown = memo(function Markdown({ children, diagrams = false, links }: { children: string; diagrams?: boolean; links?: MarkdownLinks }) {
  // The components map is identity-compared by react-markdown, so it is
  // built once per `links` value; callers keep that object stable (useMemo).
  const components = useMemo(() => {
    if (!links) return diagrams ? WITH_DIAGRAMS : PLAIN;
    return { a: fileAwareLink(links), pre: diagrams ? diagramPre : codePre };
  }, [links, diagrams]);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
        urlTransform={urlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
