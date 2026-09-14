// Pins the fix for the duplicate-class hazard described in the "tag-row" incident: a
// Tags-field row was given `className="dep-row tag-row"`, and `.tag-row` already
// existed as ProjectLanding's tag card (display:flex, flex-direction:column, a
// bordered/shadowed box). Every row in the Tags field silently inherited that card
// layout. Scoping the new rules under `.tag-field .tag-row` did not help, since the
// unscoped `.tag-row` rule still matched and its declarations still applied; the fix
// was renaming to a `tagf-` prefix. `app/globals.css` is one flat class namespace by
// design (no CSS modules), so this class of collision has no compiler to catch it.
//
// This guard parses `app/globals.css` and flags a class whose *bare* form (no pseudo,
// no chained modifier, just `.name`) is targeted by rules under two or more different
// ancestor scopes (including "no ancestor") where at least one of those rules sets a
// layout property (display, flex-direction, position, padding, border). That is the
// exact shape of the incident: `.tag-row` (no ancestor) and `.tag-field .tag-row`
// (scoped) both matching one element.
//
// A blanket "no class defined twice" rule is far too noisy: this file legitimately
// restates a class under a different ancestor dozens of times as an intentional,
// shared-widget contextual override (a `.icon-btn` styled slightly differently inside
// `.svc-row`, a `.bcard` variant inside `.bcard.mini`, and so on), and no static
// analysis can tell that apart from an accidental name collision by syntax alone. So
// ALLOWED_CROSS_SCOPE_CLASSES grandfathers every such pattern already in the file
// (verified by hand when this guard was added): the guard only fires on a NEW class
// entering that shape, exactly the case the tag-row incident was.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const CSS_FILE = "app/globals.css";

interface Occurrence {
  line: number;
  prefix: string;
  selector: string;
  layoutProps: string[];
}

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const chunk = end === -1 ? text.slice(i) : text.slice(i, end + 2);
      out += chunk.replace(/[^\n]/g, " ");
      i = end === -1 ? text.length : end + 2;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

const BLOCK_AT_RULES = /^@(media|supports|keyframes|font-face|page|layer|container)\b/i;

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

/** Top-level (non-nested) rules only: content inside @media/@supports/etc is skipped,
 * since a media-query restatement of a class is an explicitly allowed pattern. */
function parseTopLevelRules(cssText: string): { selector: string; body: string; line: number }[] {
  const clean = stripComments(cssText);
  const rules: { selector: string; body: string; line: number }[] = [];
  let i = 0;
  const n = clean.length;
  while (i < n) {
    const braceIdx = clean.indexOf("{", i);
    if (braceIdx === -1) break;
    const selector = clean.slice(i, braceIdx).trim();
    let depth = 1;
    let j = braceIdx + 1;
    while (j < n && depth > 0) {
      if (clean[j] === "{") depth++;
      else if (clean[j] === "}") depth--;
      j++;
    }
    const body = clean.slice(braceIdx + 1, j - 1);
    if (selector && !selector.startsWith("@") && !BLOCK_AT_RULES.test(selector)) {
      rules.push({ selector, body, line: lineAt(clean, braceIdx) });
    }
    i = j;
  }
  return rules;
}

function isLayoutProperty(prop: string): boolean {
  if (prop === "display" || prop === "flex-direction" || prop === "position") return true;
  if (prop === "padding" || prop.startsWith("padding-")) return true;
  if (prop === "border" || /^border(-top|-right|-bottom|-left)?-width$/.test(prop)) return true;
  if (/^border(-top|-right|-bottom|-left)$/.test(prop)) return true;
  return false;
}

function declaredLayoutProperties(body: string): string[] {
  const props: string[] = [];
  for (const decl of body.split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    if (prop && isLayoutProperty(prop)) props.push(prop);
  }
  return props;
}

/** Splits on a separator char at paren-depth 0, so `:not(.a, .b)` is not mistaken for
 * two selectors and `:is([type=x],[type=y])` is not mistaken for two combinator tokens. */
function splitTopLevel(text: string, separators: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (separators.includes(ch) && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function rightmostCompoundAndPrefix(selectorPart: string): { compound: string; prefix: string } {
  const tokens = splitTopLevel(selectorPart, " >+~").map((t) => t.trim()).filter(Boolean);
  const compound = tokens[tokens.length - 1] ?? "";
  const prefix = tokens.slice(0, -1).join(" ");
  return { compound, prefix };
}

const BARE_CLASS = /^\.[a-zA-Z_][\w-]*$/;

/**
 * Groups every rule whose rightmost compound selector is a bare class (no pseudo, no
 * chained modifier, no element) by that class name, and returns the classes defined
 * under two or more distinct ancestor scopes (an empty prefix counts as its own scope)
 * where at least one definition sets a layout property.
 */
function findCrossScopeClassDefinitions(cssText: string): Map<string, Occurrence[]> {
  const byClass = new Map<string, Occurrence[]>();
  for (const rule of parseTopLevelRules(cssText)) {
    const layoutProps = declaredLayoutProperties(rule.body);
    for (const part of splitTopLevel(rule.selector, ",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const { compound, prefix } = rightmostCompoundAndPrefix(trimmed);
      if (!BARE_CLASS.test(compound)) continue;
      const list = byClass.get(compound) ?? [];
      list.push({ line: rule.line, prefix, selector: trimmed, layoutProps });
      byClass.set(compound, list);
    }
  }

  const flagged = new Map<string, Occurrence[]>();
  for (const [cls, occurrences] of byClass) {
    const distinctPrefixes = new Set(occurrences.map((o) => o.prefix));
    if (distinctPrefixes.size < 2) continue;
    if (!occurrences.some((o) => o.layoutProps.length > 0)) continue;
    flagged.set(cls, occurrences);
  }
  return flagged;
}

/**
 * Every class here is a reviewed, pre-existing "shared widget styled differently under
 * an ancestor" pattern (e.g. `.icon-btn` under `.svc-row`), not a name collision between
 * unrelated components. Verified by hand when this guard was added; a class earns a spot
 * here only with the same review, never by widening the detector's thresholds.
 */
const ALLOWED_CROSS_SCOPE_CLASSES = new Set<string>([
  ".agent-badge", ".ask-head", ".ask-other", ".attach-row", ".av",
  ".bc-act", ".bc-meta", ".bc-top", ".bcol", ".bcol-body", ".bseg", ".btn",
  ".cmt", ".cn", ".collab-c", ".ct", ".ctxw-dot",
  ".dl", ".dl-no",
  ".e-ic",
  ".gbadge", ".gchips", ".gstrip",
  ".icon-btn", ".in-provhead", ".in-provrow",
  ".lab",
  ".md-copy", ".md-mermaid-svg", ".msg-attachments", ".msg-body", ".mtabbar",
  ".mpick", ".mpick-lbl", ".mpick-pane", ".mpick-panes", ".mpick-price", ".mpick-row", ".mpick-scroll",
  ".perm-head", ".perm-pre", ".perm-what", ".pic", ".pick-slot", ".pickbox",
  ".pr-chip", ".pr-ic", ".pr-refresh", ".pri",
  ".rail-tab",
  ".sdot", ".search-bar", ".session-body", ".sg-name", ".sg-why", ".skel",
  ".snz-set", ".snz-wake", ".spinner", ".sug-chev", ".sugcard-head", ".sugcard-note",
  ".task", ".tc-btn", ".term-host", ".titlebar", ".tool-h", ".tpeek-more",
  ".wiz-stepnum",
]);

describe("CSS component-scope guard (globals.css class namespace collisions)", () => {
  it("keeps mobile diff text at its declared size", () => {
    const cssText = fs.readFileSync(path.join(ROOT, CSS_FILE), "utf8");
    const diffRule = /\.tc-hunks\{([^}]*)\}/.exec(cssText)?.[1] ?? "";
    const declarations = diffRule.split(";");
    expect(declarations).toEqual(expect.arrayContaining([
      "-webkit-text-size-adjust:100%",
      "text-size-adjust:100%",
    ]));
  });

  it("no class newly collides across two components' scopes with a layout conflict", () => {
    const cssText = fs.readFileSync(path.join(ROOT, CSS_FILE), "utf8");
    const flagged = findCrossScopeClassDefinitions(cssText);
    const unexpected: string[] = [];
    for (const [cls, occurrences] of flagged) {
      if (ALLOWED_CROSS_SCOPE_CLASSES.has(cls)) continue;
      const detail = occurrences
        .map((o) => `${CSS_FILE}:${o.line} \`${o.selector}\` [${o.layoutProps.join(", ") || "no layout props"}]`)
        .join("\n    ");
      unexpected.push(`${cls}:\n    ${detail}`);
    }
    expect(
      unexpected,
      unexpected.length
        ? `Class(es) defined under two different ancestor scopes with a layout-property ` +
            `conflict:\n\n  ${unexpected.join("\n  ")}\n\n` +
            `If these are genuinely the same shared widget styled differently in context, ` +
            `add the class to ALLOWED_CROSS_SCOPE_CLASSES. If this is a new component ` +
            `reusing an existing name by coincidence (the tag-row incident), rename the new ` +
            `class with a component-specific prefix instead.`
        : undefined
    ).toEqual([]);
  });

  it("the allowlist has no dead entries", () => {
    const cssText = fs.readFileSync(path.join(ROOT, CSS_FILE), "utf8");
    const flagged = findCrossScopeClassDefinitions(cssText);
    const dead = [...ALLOWED_CROSS_SCOPE_CLASSES].filter((cls) => !flagged.has(cls));
    expect(dead, `ALLOWED_CROSS_SCOPE_CLASSES entries no longer flagged: ${dead.join(", ")}`).toEqual([]);
  });

  it("catches the tag-row/tag-field collision shape (sanity, the matcher is not vacuous)", () => {
    const css = `
      .tag-row{display:flex;flex-direction:column;padding:11px 13px;border:1px solid red;}
      .tag-field .tag-row{cursor:default;gap:6px;}
    `;
    expect(findCrossScopeClassDefinitions(css).has(".tag-row")).toBe(true);
  });

  it("does not flag ordinary hover/state/media restatement of one component (sanity)", () => {
    const css = `
      .widget{display:flex;padding:8px;}
      .widget:hover{border-color:red;}
      .widget.on{background:blue;}
      @media (max-width:700px){.widget{padding:4px;}}
    `;
    expect(findCrossScopeClassDefinitions(css).has(".widget")).toBe(false);
  });
});
