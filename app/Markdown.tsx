"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { Mermaid } from "./Mermaid";
import { mermaidSourceOf } from "@/lib/mermaid";

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
const diagramPre = ({ node, children, ...props }: ComponentProps<"pre"> & ExtraProps) => {
  const source = mermaidSourceOf(node);
  return source === null ? <pre {...props}>{children}</pre> : <Mermaid source={source} />;
};

export const Markdown = memo(function Markdown({ children, diagrams = false }: { children: string; diagrams?: boolean }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={diagrams ? { a: link, pre: diagramPre } : { a: link }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
