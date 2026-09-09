import type { Element, ElementContent } from "hast";

// The hast shape react-markdown hands a `pre` component for a fenced block:
//   <pre><code class="language-<lang>">…text…</code></pre>
// Splits that into the code element's classes and its text, or null for a `pre`
// that is not one fence. Pure so both callers (the copy button in
// `app/Markdown.tsx`, the mermaid detection in `lib/mermaid.ts`) are
// unit-testable without a DOM.
//
// Reads the text recursively, since the highlighter turns the fence into a tree
// of <span>s instead of one text node. The trailing newline a fence always
// carries is dropped: it is the closing delimiter, not part of the code.

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

export function fencedCode(pre: Element | undefined): { classes: string[]; text: string } | null {
  if (!pre || pre.tagName !== "pre") return null;
  // Whitespace-only text between the tags does not count as another child.
  const kids = pre.children.filter((c) => !(c.type === "text" && c.value.trim() === ""));
  if (kids.length !== 1) return null;
  const code = kids[0];
  if (code.type !== "element" || code.tagName !== "code") return null;
  const cls = code.properties?.className;
  const classes = Array.isArray(cls) ? cls.map(String) : typeof cls === "string" ? cls.split(/\s+/) : [];
  return { classes, text: textOf(code).replace(/\n$/, "") };
}

// What a copy button puts on the clipboard for a fenced block. Null when there
// is nothing to copy, so the caller renders no button: an empty fence, or a
// `pre` the markdown pipeline produced some other way.
export function codeBlockTextOf(pre: Element | undefined): string | null {
  const fence = fencedCode(pre);
  return fence && fence.text.length > 0 ? fence.text : null;
}
