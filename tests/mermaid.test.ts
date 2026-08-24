import { describe, expect, it } from "vitest";
import type { Element } from "hast";
import { mermaidSourceOf } from "@/lib/mermaid";

// The hast a fenced block reaches react-markdown's `pre` component as. The
// shapes here are what remark-rehype emits (a text child, the language as a
// `language-*` class, a trailing newline) plus the one rehype-highlight would
// produce if it ever learned mermaid (nested spans).
const code = (className: string[] | undefined, children: Element["children"]): Element => ({
  type: "element",
  tagName: "code",
  properties: className ? { className } : {},
  children,
});
const pre = (children: Element["children"]): Element => ({ type: "element", tagName: "pre", properties: {}, children });

describe("mermaidSourceOf", () => {
  it("reads the source out of a ```mermaid fence, without the trailing newline", () => {
    const node = pre([code(["language-mermaid"], [{ type: "text", value: "graph LR\n  A --> B\n" }])]);
    expect(mermaidSourceOf(node)).toBe("graph LR\n  A --> B");
  });

  it("ignores every other fence and bare code blocks", () => {
    expect(mermaidSourceOf(pre([code(["language-ts"], [{ type: "text", value: "let x = 1\n" }])]))).toBeNull();
    expect(mermaidSourceOf(pre([code(undefined, [{ type: "text", value: "graph LR\n" }])]))).toBeNull();
    expect(mermaidSourceOf(undefined)).toBeNull();
  });

  it("reads through highlighter spans and whitespace between the tags", () => {
    const node = pre([
      { type: "text", value: "\n" },
      code(["hljs", "language-mermaid"], [
        { type: "element", tagName: "span", properties: { className: ["hljs-keyword"] }, children: [{ type: "text", value: "graph" }] },
        { type: "text", value: " LR\n  A --> B\n" },
      ]),
      { type: "text", value: "\n" },
    ]);
    expect(mermaidSourceOf(node)).toBe("graph LR\n  A --> B");
  });

  it("refuses a pre with more than one real child — that's not a fence", () => {
    const node = pre([
      code(["language-mermaid"], [{ type: "text", value: "graph LR\n" }]),
      code(["language-mermaid"], [{ type: "text", value: "graph TD\n" }]),
    ]);
    expect(mermaidSourceOf(node)).toBeNull();
  });
});
