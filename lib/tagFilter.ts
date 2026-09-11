/** How several selected tags combine. "any" is a union; "all" is an intersection. */
export type TagMatch = "any" | "all";

/** A tag filter shared by the client board and agent task listings. */
export interface TagFilter {
  ids: string[];
  match: TagMatch;
}

/** Keep rows that carry any or all selected tags. An empty selection keeps every row. */
export function inTags<T extends { tag_ids: string[] }>(rows: T[], filter: TagFilter): T[] {
  if (!filter.ids.length) return rows;
  return rows.filter((row) =>
    filter.match === "all"
      ? filter.ids.every((id) => row.tag_ids.includes(id))
      : filter.ids.some((id) => row.tag_ids.includes(id))
  );
}
