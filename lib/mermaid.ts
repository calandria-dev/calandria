import type { Element } from "hast";
import { fencedCode } from "./codeBlock";

// Picks out the source of a ```mermaid fence, or null for any other block.
// Pure so detection is unit-testable without a DOM; rendering happens in
// `app/Mermaid.tsx`.

export function mermaidSourceOf(pre: Element | undefined): string | null {
  const fence = fencedCode(pre);
  if (!fence || !fence.classes.includes("language-mermaid")) return null;
  return fence.text;
}
