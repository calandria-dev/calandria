/**
 * Version comparison for the update check.
 *
 * Releases are cut by release-please, so every tag is a plain `X.Y.Z` of three
 * integers. Anything else parses to null and compares as older than every
 * parsed version, which is the safe direction: a malformed feed can never
 * produce an update pill.
 */

export type Version = { major: number; minor: number; patch: number };

const RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Three integers, with an optional leading `v`. Null for anything else. */
export function parseVersion(s: string | null | undefined): Version | null {
  if (!s) return null;
  const m = RE.exec(s.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * -1, 0 or 1, ordering unparseable strings below everything. Two unparseable
 * strings are equal, so neither is ever "newer" than the other.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewer(candidate: string | null | undefined, current: string | null | undefined): boolean {
  return compareVersions(candidate, current) > 0;
}
