// Link rewriting for the repo's `docs/*.md`, which this site renders in place.
//
// The Markdown files are the source of truth and stay GitHub-renderable: their
// links are relative and correct when read at
// github.com/calandria-dev/calandria/tree/main/docs. This site is the rendered
// mirror, so every one of those links has to be re-pointed at build time:
//
//   SELF_HOSTING.md#metrics  ->  /docs/self-hosting/#metrics   (sibling doc)
//   ../.env.example          ->  <repo>/blob/main/.env.example (leaves docs/)
//   design/WEBSITE.md        ->  <repo>/blob/main/docs/design/WEBSITE.md
//                                (docs/design/ and docs/superpowers/ are
//                                internal and are not published here)
//
// The slug map is exported too, because `content.config.ts` has to generate the
// same slugs the rewriter targets — if the two ever disagreed the links would
// 404 and only the link validator would notice.

import { fileURLToPath } from "node:url";

import { visit } from "unist-util-visit";

export const REPO_URL = "https://github.com/calandria-dev/calandria";
export const REPO_BRANCH = "main";

/** Absolute path of the repo's `docs/` directory (this file is `website/src/plugins/`). */
export const DOCS_DIR = fileURLToPath(new URL("../../../docs/", import.meta.url));

/** Where the docs are mounted on the site. */
export const DOCS_BASE = "/docs";

/**
 * `SELF_HOSTING.md` -> `self-hosting`. The files are SCREAMING_SNAKE because
 * that is the GitHub convention for top-level docs; URLs are not, so the
 * underscores become hyphens rather than surviving into the address bar.
 *
 * @param {string} filename a path relative to `docs/`, e.g. `SELF_HOSTING.md`
 */
export function docSlug(filename) {
  return filename
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/_/g, "-");
}

/** The content-collection id (and therefore the route) for a `docs/*.md` file. */
export function docEntryId(filename) {
  return `docs/${docSlug(filename)}`;
}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Rewrite one Markdown link target. Returns the input unchanged when the link
 * is already absolute, is a bare fragment, or is a site-absolute path.
 *
 * @param {string} url
 * @returns {string}
 */
export function rewriteDocsLink(url) {
  if (!url || ABSOLUTE.test(url) || url.startsWith("#") || url.startsWith("/")) {
    return url;
  }

  const hashAt = url.indexOf("#");
  const path = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);

  if (path === "") return url; // `#anchor` handled above; `?query` is left alone

  // Leaves docs/ entirely — anything above it only exists in the repo.
  if (path.startsWith("../")) {
    return githubUrl(path.replace(/^(?:\.\.\/)+/, ""), hash);
  }

  const clean = path.replace(/^\.\//, "");

  // A sibling top-level doc: the one case that resolves inside this site.
  if (/^[^/]+\.md$/i.test(clean)) {
    return `${DOCS_BASE}/${docSlug(clean)}/${hash}`;
  }

  // Anything else under docs/ — a subdirectory (design/, superpowers/) or an
  // asset linked rather than embedded. Not published; send it to the repo.
  return githubUrl(`docs/${clean}`, hash);
}

/**
 * `blob` for files, `tree` for directories. GitHub redirects between the two,
 * but only after a round trip, and a directory link that says `blob` reads as a
 * mistake in the address bar.
 */
function githubUrl(path, hash) {
  const normalized = path.replace(/\/+$/, "");
  const last = normalized.slice(normalized.lastIndexOf("/") + 1);
  const isDirectory = path.endsWith("/") || !last.slice(1).includes(".");
  const kind = isDirectory ? "tree" : "blob";
  return `${REPO_URL}/${kind}/${REPO_BRANCH}/${normalized}${hash}`;
}

/**
 * The remark plugin. Scoped to files under the repo's `docs/` so that nothing
 * else on the site (the landing page, anything phase 3 adds) is touched.
 *
 * It also drops the leading H1: Starlight renders `title` from front-matter as
 * the page heading, so leaving the file's own `# …` in would print the title
 * twice. The heading stays in the file — GitHub needs it — and is only removed
 * from the render, and only when it matches the front-matter title.
 */
export function remarkDocsLinks() {
  return (tree, file) => {
    const path = file.history?.[0] ?? file.path;
    if (!path || !path.startsWith(DOCS_DIR)) return;

    visit(tree, ["link", "definition"], (node) => {
      node.url = rewriteDocsLink(node.url);
    });

    const title = file.data?.astro?.frontmatter?.title;
    const first = tree.children?.[0];
    if (typeof title === "string" && first?.type === "heading" && first.depth === 1) {
      if (headingText(first) === title) tree.children.shift();
    }
  };
}

function headingText(node) {
  let out = "";
  visit(node, ["text", "inlineCode"], (child) => {
    out += child.value;
  });
  return out;
}
