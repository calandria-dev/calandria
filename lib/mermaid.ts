import type { Element, ElementContent } from "hast";

// The hast shape react-markdown hands a `pre` component for a fenced block:
//   <pre><code class="language-<lang>">…text…</code></pre>
// Picks out the source of a ```mermaid fence, or null for any other block.
// Pure so detection is unit-testable without a DOM; rendering happens in
// `app/Mermaid.tsx`.
//
// Reads the text recursively, since the fence can arrive as a tree of
// <span>s instead of one text node.

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

export function mermaidSourceOf(pre: Element | undefined): string | null {
  if (!pre || pre.tagName !== "pre") return null;
  // Whitespace-only text between the tags does not count as another child.
  const kids = pre.children.filter((c) => !(c.type === "text" && c.value.trim() === ""));
  if (kids.length !== 1) return null;
  const code = kids[0];
  if (code.type !== "element" || code.tagName !== "code") return null;
  const cls = code.properties?.className;
  const classes = Array.isArray(cls) ? cls.map(String) : typeof cls === "string" ? cls.split(/\s+/) : [];
  if (!classes.includes("language-mermaid")) return null;
  return textOf(code).replace(/\n$/, "");
}
