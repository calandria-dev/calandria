/**
 * The part of a GitHub release body worth showing in the update popover.
 *
 * A release body is the release-please changelog section, followed by a
 * `<!-- desktop-artifacts -->` marker and a table of desktop installers and
 * their signing status. The table is build provenance, so it is cut. The
 * version heading above it duplicates the popover's own header, so that goes
 * too.
 */

const MARKER = "<!-- desktop-artifacts -->";

/** A release-please section heading: `## [0.12.0](compare link) (2026-09-15)`. */
const HEADING = /^#{1,3}\s*\[?v?\d+\.\d+\.\d+\]?.*$/;

export function trimReleaseNotes(body: string | null | undefined): string {
  if (!body) return "";
  const cut = body.indexOf(MARKER);
  let text = cut >= 0 ? body.slice(0, cut) : body;
  text = text.replace(/\r\n/g, "\n").trim();
  const lines = text.split("\n");
  if (lines.length && HEADING.test(lines[0].trim())) lines.shift();
  return lines.join("\n").trim();
}
