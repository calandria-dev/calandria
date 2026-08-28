import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

import { REPO_BRANCH, REPO_URL } from "./plugins/docs-links.mjs";

// "Edit page" has to be computed rather than configured. Starlight builds it by
// concatenating `editLink.baseUrl` with the entry's `filePath`, which for this
// collection is `../docs/SELF_HOSTING.md` — project-relative, and the `..` then
// eats a segment of the base URL, so `…/edit/main/` silently resolves to
// `…/edit/docs/SELF_HOSTING.md` with the branch missing. Turning the same
// `filePath` into a repo-relative one first gives the right URL for any file
// the collection picks up, without a second slug-to-filename mapping to keep.
export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const filePath = route.entry?.filePath;
  if (!filePath?.startsWith("../")) return;

  const repoPath = filePath.replace(/^(?:\.\.\/)+/, "");
  route.editUrl = new URL(`${REPO_URL}/edit/${REPO_BRANCH}/${repoPath}`);
});
