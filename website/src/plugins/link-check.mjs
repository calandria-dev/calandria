// Internal-link validation over the BUILT site, as an Astro integration.
//
// This is the PR gate for `docs/CLAUDE.md`'s second rule: the repo's Markdown
// keeps GitHub-correct relative links, `remarkDocsLinks` re-points them at build
// time, and if a rename or a moved heading leaves one dangling the site build
// fails in the same PR that broke it.
//
// Why not `starlight-links-validator`, which does exactly this job: it derives a
// page's identity from `path.relative(<srcDir>/content/docs, <file>)`, so it
// only works for Markdown that lives inside the Astro project. Ours lives in the
// repo's `docs/`, which is the whole point of this site — every doc came back
// with an id like `../../../docs/self_hosting/`, nothing matched, and all 35
// internal links were reported invalid. Checking `dist/` instead sidesteps the
// assumption and is strictly more coverage: it sees the rendered anchors, the
// hand-written `/docs/` index, and anything else the build emits.
//
// External links are deliberately NOT checked. A build that reaches the network
// is a build that fails for reasons that have nothing to do with the commit.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** `<a href="…">`, and only anchors — not `<link>`, `<script>` or `<img>`. */
const ANCHOR = /<a\b[^>]*?\shref="([^"]*)"/gi;
/** Any `id="…"`, which is what a fragment has to land on. */
const ID = /\sid="([^"]+)"/gi;
/** Anything with a scheme, or protocol-relative. */
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function linkCheck() {
  return {
    name: "calandria:link-check",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const files = await htmlFiles(root);

        /** route (always trailing-slashed) -> Set of anchor ids */
        const anchors = new Map();
        /** route -> [{ href, sourceFile }] */
        const links = new Map();
        /** every emitted file, as a site-absolute path, for asset links */
        const assets = new Set(await allFiles(root));

        for (const file of files) {
          const html = await readFile(path.join(root, file), "utf8");
          const route = routeOf(file);
          anchors.set(route, new Set([...html.matchAll(ID)].map((m) => m[1])));
          links.set(
            route,
            [...html.matchAll(ANCHOR)].map((m) => decodeHref(m[1])),
          );
        }

        const problems = [];

        for (const [route, hrefs] of links) {
          for (const href of hrefs) {
            const problem = check(href, route, anchors, assets);
            if (problem) problems.push({ route, href, problem });
          }
        }

        if (problems.length === 0) {
          logger.info(`checked internal links on ${files.length} pages — all resolve`);
          return;
        }

        for (const { route, href, problem } of problems) {
          logger.error(`${route} -> ${href}: ${problem}`);
        }
        throw new Error(
          `${problems.length} broken internal link${problems.length === 1 ? "" : "s"}. ` +
            "In a doc, that is usually a relative link to a renamed file or a moved heading — " +
            "see docs/CLAUDE.md.",
        );
      },
    },
  };
}

function check(href, from, anchors, assets) {
  if (!href || ABSOLUTE.test(href)) return null;

  const [beforeHash, ...rest] = href.split("#");
  const hash = rest.join("#");
  const target = beforeHash.split("?")[0];

  // A bare fragment resolves against the page it is on.
  const route = target === "" ? from : resolve(from, target);

  if (!anchors.has(route)) {
    // Not a page — an asset (an image, a font, the OG card) is fine.
    if (assets.has(stripTrailingSlash(route)) || assets.has(route)) return null;
    return "no such page or file in the build";
  }

  if (hash === "" || hash === "top" || hash === "_top") return null;
  if (anchors.get(route).has(decodeURIComponent(hash))) return null;

  return `page exists but has no #${hash}`;
}

/** Resolve `target` (relative or site-absolute) against the page at `from`. */
function resolve(from, target) {
  const base = target.startsWith("/") ? "/" : from;
  const resolved = path.posix.resolve(base, target);
  return resolved.endsWith("/") ? resolved : `${resolved}/`;
}

/** `docs/self-hosting/index.html` -> `/docs/self-hosting/`; `404.html` -> `/404.html/`. */
function routeOf(file) {
  const url = `/${file.split(path.sep).join("/")}`;
  return url.endsWith("/index.html") ? url.slice(0, -"index.html".length) : `${url}/`;
}

function stripTrailingSlash(p) {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** Astro emits `&#38;` and friends in attributes. */
function decodeHref(href) {
  return href
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"');
}

async function htmlFiles(root) {
  return (await allFiles(root))
    .filter((p) => p.endsWith(".html"))
    .map((p) => p.slice(1).split("/").join(path.sep));
}

/** Every emitted file, as a site-absolute path with `/` separators. */
async function allFiles(root, prefix = "") {
  const out = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const next = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await allFiles(root, next)));
    else out.push(`/${next}`);
  }
  return out;
}
