import { describe, expect, it } from "vitest";
import { TRANSCRIPT_CACHE_LIMIT, evictTranscripts, touchRecent } from "../app/shell/transcriptCache";

describe("transcriptCache: the shell keeps the selected transcript plus a few recent ones", () => {
  it("touchRecent moves the selected task to the front and trims to the limit", () => {
    let order: string[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f"]) order = touchRecent(order, id);
    expect(order).toHaveLength(TRANSCRIPT_CACHE_LIMIT);
    expect(order[0]).toBe("f");
    expect(order).not.toContain("a");
    expect(order).not.toContain("b");
  });

  it("re-selecting a task already on the list moves it to the front without duplicating it", () => {
    const order = touchRecent(["c", "b", "a"], "a");
    expect(order).toEqual(["a", "c", "b"]);
  });

  it("nothing selected leaves the order alone, trimmed", () => {
    expect(touchRecent(["b", "a"], null)).toEqual(["b", "a"]);
    expect(touchRecent(["e", "d", "c", "b", "a"], null, 2)).toEqual(["e", "d"]);
  });

  it("evictTranscripts drops every task off the keep list", () => {
    const map = { a: [1], b: [2], c: [3] };
    const next = evictTranscripts(map, ["b", "c"]);
    expect(Object.keys(next).sort()).toEqual(["b", "c"]);
    expect(next.b).toBe(map.b);
  });

  it("evictTranscripts returns the same object when there is nothing to drop, so React can bail out", () => {
    const map = { a: [1], b: [2] };
    expect(evictTranscripts(map, ["a", "b", "zzz"])).toBe(map);
    expect(evictTranscripts({}, [])).toEqual({});
  });

  it("going to the background keeps only the selected task", () => {
    const map = { a: [1], b: [2], c: [3] };
    expect(Object.keys(evictTranscripts(map, ["b"]))).toEqual(["b"]);
    expect(Object.keys(evictTranscripts(map, []))).toEqual([]);
  });
});
