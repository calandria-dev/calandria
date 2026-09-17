import { describe, expect, it } from "vitest";
import type { Element } from "hast";
import { codeBlockTextOf } from "@/lib/codeBlock";

// The hast a fenced block reaches react-markdown's `pre` component as: a text
// child, the language as a `language-*` class, a trailing newline, plus the
// nested spans rehype-highlight leaves behind on a highlighted fence.
const code = (className: string[] | undefined, children: Element["children"]): Element => ({
  type: "element",
  tagName: "code",
  properties: className ? { className } : {},
  children,
});
const pre = (children: Element["children"]): Element => ({ type: "element", tagName: "pre", properties: {}, children });

describe("codeBlockTextOf", () => {
  it("reads the block's text, without the fence's trailing newline", () => {
    const node = pre([code(["language-ts"], [{ type: "text", value: "let x = 1\nlet y = 2\n" }])]);
    expect(codeBlockTextOf(node)).toBe("let x = 1\nlet y = 2");
  });

  it("reads through highlighter spans, so the copy is the source and not the markup", () => {
    const node = pre([
      code(["hljs", "language-ts"], [
        { type: "element", tagName: "span", properties: { className: ["hljs-keyword"] }, children: [{ type: "text", value: "let" }] },
        { type: "text", value: " x = 1\n" },
      ]),
    ]);
    expect(codeBlockTextOf(node)).toBe("let x = 1");
  });

  it("covers a bare fence with no language", () => {
    expect(codeBlockTextOf(pre([code(undefined, [{ type: "text", value: "npm test\n" }])]))).toBe("npm test");
  });

  it("returns null when there is nothing to copy", () => {
    expect(codeBlockTextOf(undefined)).toBeNull();
    expect(codeBlockTextOf(pre([code(["language-ts"], [{ type: "text", value: "\n" }])]))).toBeNull();
    expect(codeBlockTextOf(pre([{ type: "text", value: "loose text" }]))).toBeNull();
  });
});
