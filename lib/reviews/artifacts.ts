// Immutable artifact capture and reads for Work Center reviews (contract
// work-center/1, "Immutable capture and applicability").
//
// A code artifact is three review-owned refs in the task's repository
// (refs/calandria/reviews/<artifactId>/{base,head,target}) created in one
// create-only `git update-ref --stdin` transaction, so the reviewed commits
// stay reachable after the task branch moves, is force-pushed or is garbage
// collected. A document artifact is the exact file bytes, stored in SQLite by
// the caller. Callers hold the task lock and then the repo lock around a
// capture (lib/reviews/submit.ts); nothing here takes either.
//
// External processes ignore those locks. Double reads detect an observed
// change and fail `unstable_capture`; they cannot exclude an ABA write after the
// final read, which the contract records as the supported boundary.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { nanoid } from "nanoid";

import { getDb } from "../db";
import { branchForTask, legacyBranchForTask } from "../git";
import { locateWorktreeFile, resolveWorktreeFile } from "../worktreeFile";
import {
  REVIEW_LIMITS,
  ReviewError,
  sha256Hex,
  type ArtifactManifest,
  type CodeManifest,
  type DocumentManifest,
  type ReviewApplicabilityState,
} from "./types";

const MARKER_FILE = "calandria-review-repository-id";
const REF_SIDES = ["base", "head", "target"] as const;
type RefSide = (typeof REF_SIDES)[number];

export const reviewRef = (artifactId: string, side: RefSide) => `refs/calandria/reviews/${artifactId}/${side}`;

// ---------- git plumbing

interface GitResult { code: number; stdout: string; stderr: string; overflow: boolean }

/** Run git with no shell. `maxBytes` caps stdout and kills the process when passed. */
function runGit(cwd: string, args: string[], opts: { input?: string; maxBytes?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-optional-locks", ...args], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let overflow = false;
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (opts.maxBytes !== undefined && size > opts.maxBytes) {
        if (!overflow) {
          overflow = true;
          child.kill("SIGKILL");
        }
        return;
      }
      out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), overflow }));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout.trim();
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The canonical `.git` directory shared by a repository and all its worktrees. */
export async function commonDirOf(cwd: string): Promise<string> {
  const r = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.code !== 0 || !r.stdout.trim()) throw new ReviewError("artifact_unavailable", "the checkout is not a git repository");
  try {
    return fs.realpathSync(r.stdout.trim());
  } catch {
    throw new ReviewError("artifact_unavailable", "the repository is not readable");
  }
}

// ---------- repository identity

/**
 * The repository UUID for a common directory, creating the marker file on first
 * registration. The DB map and the marker must agree on every use; a marker the
 * DB does not know (a clone, a restore) is never adopted silently.
 */
export function registerRepository(commonDir: string, now = Date.now()): string {
  const db = getDb();
  const markerPath = path.join(commonDir, MARKER_FILE);
  const row = db.prepare("SELECT id FROM review_repositories WHERE common_dir = ?").get(commonDir) as { id: string } | undefined;
  if (row) {
    assertMarker(markerPath, row.id);
    return row.id;
  }
  if (fs.existsSync(markerPath)) {
    throw new ReviewError("artifact_unavailable", "the repository carries a review marker that is not registered here; restore it explicitly");
  }
  const id = nanoid();
  try {
    fs.writeFileSync(markerPath, id, { flag: "wx" });
  } catch {
    throw new ReviewError("artifact_unavailable", "the repository marker could not be created");
  }
  db.prepare("INSERT INTO review_repositories (id, common_dir, created_at) VALUES (?, ?, ?)").run(id, commonDir, now);
  return id;
}

/**
 * Explicit restoration for a repository that was moved or restored with its
 * marker: repoint the existing UUID at the new common directory. Refuses a
 * marker that does not name a known UUID, so it cannot launder a foreign clone.
 */
export function restoreRepositoryPath(commonDir: string): string {
  const markerPath = path.join(commonDir, MARKER_FILE);
  let id: string;
  try {
    id = fs.readFileSync(markerPath, "utf8").trim();
  } catch {
    throw new ReviewError("artifact_unavailable", "no review marker in that repository");
  }
  const db = getDb();
  const known = db.prepare("SELECT id FROM review_repositories WHERE id = ?").get(id);
  if (!known) throw new ReviewError("artifact_unavailable", "the marker names no registered repository");
  db.prepare("UPDATE review_repositories SET common_dir = ? WHERE id = ?").run(commonDir, id);
  return id;
}

function assertMarker(markerPath: string, expected: string) {
  let found = "";
  try {
    found = fs.readFileSync(markerPath, "utf8").trim();
  } catch {
    /* missing marker */
  }
  if (found !== expected) throw new ReviewError("artifact_unavailable", "the repository identity marker is missing or does not match");
}

/** The registered common directory for a repository UUID, verified against its marker. */
export function repositoryDir(repositoryId: string): string {
  const row = getDb().prepare("SELECT common_dir FROM review_repositories WHERE id = ?").get(repositoryId) as { common_dir: string } | undefined;
  if (!row) throw new ReviewError("artifact_unavailable", "the repository is not registered");
  assertMarker(path.join(row.common_dir, MARKER_FILE), repositoryId);
  return row.common_dir;
}

// ---------- code capture

export interface CodeObservation {
  commonDir: string;
  branch: string;
  head: string;
  headTree: string;
  baseTip: string;
  baseCommit: string;
  baseTree: string;
  status: string;
}

const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];

/**
 * Observe the checkout's reviewable state, refusing anything that is not a
 * clean task branch with one merge base. Throws ReviewError; the caller
 * decides whether that refuses a submission or marks an artifact changed.
 */
export async function observeCode(worktree: string, taskId: string, baseBranch: string): Promise<CodeObservation> {
  if (!worktree || !fs.existsSync(worktree)) throw new ReviewError("artifact_unavailable", "the task has no checkout");
  const commonDir = await commonDirOf(worktree);
  const sym = await runGit(worktree, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = sym.stdout.trim();
  if (sym.code !== 0 || !branch) throw new ReviewError("source_changed", "HEAD is detached");
  if (branch !== branchForTask(taskId) && branch !== legacyBranchForTask(taskId)) throw new ReviewError("source_changed", "HEAD is not on the task branch");
  for (const name of IN_PROGRESS) {
    const p = await runGit(worktree, ["rev-parse", "--git-path", name]);
    if (p.code === 0 && fs.existsSync(path.resolve(worktree, p.stdout.trim()))) {
      throw new ReviewError("source_changed", "a merge, rebase or similar operation is in progress");
    }
  }
  const st = await runGit(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (st.code !== 0) throw new ReviewError("artifact_unavailable", "the checkout status is not readable");
  if (st.stdout.length > 0) throw new ReviewError("dirty_worktree", "the checkout has uncommitted or untracked changes");
  const head = await git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => "");
  const headTree = await git(worktree, ["rev-parse", "--verify", "HEAD^{tree}"]).catch(() => "");
  const baseTip = await git(worktree, ["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`]).catch(() => "");
  if (!OID.test(head) || !OID.test(headTree)) throw new ReviewError("artifact_unavailable", "HEAD is not readable");
  if (!OID.test(baseTip)) throw new ReviewError("source_changed", "the base branch does not resolve");
  const mb = await runGit(worktree, ["merge-base", "--all", baseTip, head]);
  const bases = mb.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (mb.code !== 0 || bases.length !== 1 || !OID.test(bases[0])) {
    throw new ReviewError("source_changed", bases.length > 1 ? "the base and the task branch have several merge bases" : "the base and the task branch share no history");
  }
  const baseTree = await git(worktree, ["rev-parse", "--verify", `${bases[0]}^{tree}`]).catch(() => "");
  if (!OID.test(baseTree)) throw new ReviewError("artifact_unavailable", "the base tree is not readable");
  return { commonDir, branch, head, headTree, baseTip, baseCommit: bases[0], baseTree, status: st.stdout };
}

export interface Pin { ref: string; oid: string }

/** Create the three pins create-only in one transaction. Never overwrites an existing ref. */
export async function createPins(commonDir: string, artifactId: string, oids: Record<RefSide, string>): Promise<Pin[]> {
  const pins = REF_SIDES.map((side) => ({ ref: reviewRef(artifactId, side), oid: oids[side] }));
  const input = pins.map((p) => `create ${p.ref} ${p.oid}\n`).join("");
  const r = await runGit(commonDir, ["--git-dir", commonDir, "update-ref", "--stdin"], { input });
  if (r.code !== 0) throw new ReviewError("unstable_capture", "the review pins could not be created");
  return pins;
}

/** Delete exactly these pins, each only while it still holds the OID this attempt wrote. */
export async function deletePins(commonDir: string, pins: Pin[]): Promise<void> {
  if (!pins.length) return;
  const input = pins.map((p) => `delete ${p.ref} ${p.oid}\n`).join("");
  await runGit(commonDir, ["--git-dir", commonDir, "update-ref", "--stdin"], { input }).catch(() => undefined);
}

export interface CodeCapture {
  artifactId: string;
  manifest: CodeManifest;
  pins: Pin[];
}

export interface PrEvidence { number: number; url: string; headSha: string; repositoryId: string }

/**
 * Capture a code artifact: observe, pin, observe again, and re-read the pins.
 * The caller commits the submission and calls `deletePins` if that commit fails.
 */
export async function captureCode(input: {
  worktree: string;
  taskId: string;
  baseBranch: string;
  pr: PrEvidence | null;
  now?: number;
}): Promise<CodeCapture> {
  const first = await observeCode(input.worktree, input.taskId, input.baseBranch);
  const repositoryId = registerRepository(first.commonDir);
  const artifactId = nanoid();
  const pins = await createPins(first.commonDir, artifactId, { base: first.baseCommit, head: first.head, target: first.baseTip });
  try {
    const second = await observeCode(input.worktree, input.taskId, input.baseBranch);
    for (const k of ["commonDir", "branch", "head", "headTree", "baseTip", "baseCommit", "baseTree", "status"] as const) {
      if (first[k] !== second[k]) throw new ReviewError("unstable_capture", "the checkout changed during capture");
    }
    for (const p of pins) {
      const got = await git(first.commonDir, ["--git-dir", first.commonDir, "rev-parse", "--verify", `${p.ref}^{commit}`]).catch(() => "");
      if (got !== p.oid) throw new ReviewError("unstable_capture", "a review pin did not read back");
    }
  } catch (e) {
    await deletePins(first.commonDir, pins);
    throw e;
  }
  return {
    artifactId,
    pins,
    manifest: {
      repositoryId,
      taskBranch: first.branch,
      baseBranch: input.baseBranch,
      baseTipSha: first.baseTip,
      baseCommitSha: first.baseCommit,
      headCommitSha: first.head,
      baseTreeSha: first.baseTree,
      headTreeSha: first.headTree,
      pr: input.pr ? { repositoryId: input.pr.repositoryId || repositoryId, number: input.pr.number, url: input.pr.url, headSha: input.pr.headSha } : null,
      capturedAt: input.now ?? Date.now(),
    },
  };
}

// ---------- document capture

const DOC_EXT = new Set([".md", ".markdown"]);

/** Normalize a caller path: forward slashes, no leading ./, nothing absolute or traversing. */
export function normalizeDocumentPath(raw: string): string {
  if (!raw || raw.includes("\0")) throw new ReviewError("bad_request", "document path is malformed");
  const slashed = raw.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed) || path.isAbsolute(raw)) throw new ReviewError("bad_request", "document path must be relative");
  if (slashed.split("/").some((seg) => seg === "..")) throw new ReviewError("bad_request", "document path must not traverse");
  const norm = path.posix.normalize(slashed);
  if (!norm || norm === "." || norm.startsWith("../") || norm === "..") throw new ReviewError("bad_request", "document path is malformed");
  if (!DOC_EXT.has(path.posix.extname(norm).toLowerCase())) throw new ReviewError("unsupported_artifact", "only .md and .markdown documents can be reviewed");
  return norm;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function assertStrictUtf8(bytes: Buffer): void {
  try {
    STRICT_UTF8.decode(bytes);
  } catch {
    throw new ReviewError("invalid_utf8", "the document is not valid UTF-8");
  }
}

export interface DocumentCapture {
  artifactId: string;
  manifest: DocumentManifest;
  bytes: Buffer;
}

function readBounded(fd: number, max: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buf = Buffer.allocUnsafe(Math.min(64 * 1024, max + 1 - total));
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    total += n;
    chunks.push(buf.subarray(0, n));
    if (total > max) throw new ReviewError("document_too_large", "the document is larger than 1 MiB");
  }
  return Buffer.concat(chunks);
}

/**
 * Read a Markdown file from the task's checkout as an exact byte artifact.
 * `beforeVerify` is a test seam that runs between the first read and the
 * identity checks, where a concurrent writer would land.
 */
export async function captureDocument(input: {
  worktree: string;
  path: string;
  now?: number;
  beforeVerify?: () => void;
}): Promise<DocumentCapture> {
  const rel = normalizeDocumentPath(input.path);
  if (!input.worktree || !fs.existsSync(input.worktree)) throw new ReviewError("artifact_unavailable", "the task has no checkout");
  const real = resolveWorktreeFile(input.worktree, rel);
  if (!real) throw new ReviewError("artifact_not_found", "the document was not found in the task checkout");
  const root = fs.realpathSync(input.worktree);
  const realRel = path.relative(root, real).split(path.sep).join("/");
  if (!DOC_EXT.has(path.posix.extname(realRel).toLowerCase())) throw new ReviewError("unsupported_artifact", "the document resolves to a file that is not Markdown");

  const fd = fs.openSync(real, fs.constants.O_RDONLY);
  let bytes: Buffer;
  try {
    const st1 = fs.fstatSync(fd);
    if (!st1.isFile()) throw new ReviewError("unsupported_artifact", "the document is not a regular file");
    if (st1.size > REVIEW_LIMITS.documentBytes) throw new ReviewError("document_too_large", "the document is larger than 1 MiB");
    bytes = readBounded(fd, REVIEW_LIMITS.documentBytes);
    input.beforeVerify?.();
    const st2 = fs.fstatSync(fd);
    let pathStat: fs.Stats;
    let again: string | null;
    try {
      pathStat = fs.statSync(real);
      again = resolveWorktreeFile(input.worktree, rel);
    } catch {
      throw new ReviewError("unstable_capture", "the document was replaced during capture");
    }
    if (
      bytes.length !== st1.size || st2.size !== st1.size || st2.mtimeMs !== st1.mtimeMs || st2.ino !== st1.ino ||
      pathStat.ino !== st1.ino || pathStat.dev !== st1.dev || again !== real
    ) {
      throw new ReviewError("unstable_capture", "the document changed during capture");
    }
  } finally {
    fs.closeSync(fd);
  }
  const sha = sha256Hex(bytes);
  let second: Buffer;
  try {
    second = fs.readFileSync(real);
  } catch {
    throw new ReviewError("unstable_capture", "the document disappeared during capture");
  }
  if (sha256Hex(second) !== sha) throw new ReviewError("unstable_capture", "the document changed during capture");
  assertStrictUtf8(bytes);

  const commonDir = await commonDirOf(input.worktree);
  const repositoryId = registerRepository(commonDir);
  const headSha = await git(input.worktree, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => "");
  return {
    artifactId: nanoid(),
    bytes,
    manifest: {
      repositoryId,
      path: rel,
      realRelativePath: realRel,
      sha256: sha,
      byteLength: bytes.length,
      sourceHeadSha: OID.test(headSha) ? headSha : null,
      capturedAt: input.now ?? Date.now(),
      encoding: "utf-8",
    },
  };
}

// ---------- exact reads

export interface CodePreview {
  text: string | null;
  byteLength: number;
  pathCount: number | null;
  truncated: boolean;
  reason: string | null;
}

/**
 * The bounded diff of a code artifact, read from its own pinned objects rather
 * than the task branch. Verifies the registered repository, then that each pin
 * still resolves to the manifest's commit. An over-limit diff is returned
 * truncated and labelled, never as complete.
 */
export async function readCodePreview(artifactId: string, manifest: CodeManifest): Promise<CodePreview> {
  const dir = repositoryDir(manifest.repositoryId);
  const expected: Record<RefSide, string> = { base: manifest.baseCommitSha, head: manifest.headCommitSha, target: manifest.baseTipSha };
  for (const side of REF_SIDES) {
    const got = await runGit(dir, ["--git-dir", dir, "rev-parse", "--verify", `${reviewRef(artifactId, side)}^{commit}`]);
    if (got.code !== 0 || got.stdout.trim() !== expected[side]) throw new ReviewError("artifact_unavailable", "the pinned review objects are not available");
  }
  const base = reviewRef(artifactId, "base");
  const head = reviewRef(artifactId, "head");
  const names = await runGit(dir, ["--git-dir", dir, "diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", base, head]);
  if (names.code !== 0) throw new ReviewError("artifact_unavailable", "the pinned diff is not readable");
  const pathCount = names.stdout.split("\0").filter(Boolean).length;
  if (pathCount > REVIEW_LIMITS.diffPreviewPaths) {
    return { text: null, byteLength: 0, pathCount, truncated: true, reason: "path_limit" };
  }
  const diff = await runGit(dir, ["--git-dir", dir, "diff", "--no-ext-diff", "--no-textconv", "--no-color", base, head], { maxBytes: REVIEW_LIMITS.diffPreviewBytes });
  if (diff.code !== 0 && !diff.overflow) throw new ReviewError("artifact_unavailable", "the pinned diff is not readable");
  let text = diff.stdout;
  if (diff.overflow) {
    const cut = text.lastIndexOf("\n");
    text = cut > 0 ? text.slice(0, cut + 1) : text;
  }
  return { text, byteLength: Buffer.byteLength(text, "utf8"), pathCount, truncated: diff.overflow, reason: diff.overflow ? "size_limit" : null };
}

// ---------- applicability

export interface ApplicabilityVerdict { state: ReviewApplicabilityState; reason: string | null }

/**
 * Whether the task's current source still matches a captured manifest. Pure
 * observation: it never writes. Epoch and receipt policy sit above this in
 * lib/reviews/read.ts; this answers only "does the checkout match".
 */
export async function checkManifestCurrent(input: {
  taskId: string;
  worktree: string;
  manifest: ArtifactManifest;
  kind: "code" | "document";
}): Promise<ApplicabilityVerdict> {
  const { manifest } = input;
  try {
    const dir = repositoryDir(manifest.repositoryId);
    if (!input.worktree || !fs.existsSync(input.worktree)) return { state: "unavailable", reason: "the task has no checkout" };
    if ((await commonDirOf(input.worktree)) !== dir) return { state: "unavailable", reason: "the checkout belongs to a different repository" };
    if (input.kind === "code") {
      const m = manifest as CodeManifest;
      const now = await observeCode(input.worktree, input.taskId, m.baseBranch);
      if (now.branch !== m.taskBranch || now.head !== m.headCommitSha) return { state: "changed", reason: "the task branch moved since submission" };
      if (now.baseTip !== m.baseTipSha) return { state: "changed", reason: "the base branch moved since submission" };
      return { state: "current", reason: null };
    }
    const m = manifest as DocumentManifest;
    const hit = locateWorktreeFile(input.worktree, m.path, REVIEW_LIMITS.documentBytes);
    if (!hit.ok) return { state: "changed", reason: "the document is missing or too large" };
    const root = fs.realpathSync(input.worktree);
    if (path.relative(root, hit.abs).split(path.sep).join("/") !== m.realRelativePath) return { state: "changed", reason: "the document path now resolves elsewhere" };
    if (sha256Hex(fs.readFileSync(hit.abs)) !== m.sha256) return { state: "changed", reason: "the document bytes changed since submission" };
    return { state: "current", reason: null };
  } catch (e) {
    if (e instanceof ReviewError) {
      if (e.code === "dirty_worktree") return { state: "changed", reason: "the checkout has uncommitted changes" };
      if (e.code === "source_changed") return { state: "changed", reason: e.message };
      return { state: "unavailable", reason: e.message };
    }
    return { state: "unavailable", reason: "the source could not be read" };
  }
}

/**
 * Whether the task branch still ends at the submitted head. A landed artifact
 * has moved the base by definition, so only the task branch is compared: a
 * commit past the accepted head is work the landing never covered. Null when
 * the checkout cannot answer (gone, detached, unreadable), which a landed
 * receipt tolerates, since the checkout may legitimately have been retired.
 */
export async function headMovedSince(worktree: string, taskId: string, manifest: CodeManifest): Promise<boolean | null> {
  if (!worktree || !fs.existsSync(worktree)) return null;
  const sym = await runGit(worktree, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const head = await runGit(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (sym.code !== 0 || head.code !== 0) return null;
  const branch = sym.stdout.trim();
  if (branch !== branchForTask(taskId) && branch !== legacyBranchForTask(taskId)) return true;
  return head.stdout.trim() !== manifest.headCommitSha;
}
