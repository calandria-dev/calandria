// Covers the agent-tool half of task attachments: resolveAgentAttachments'
// worktree confinement, createSuggestedTask and updateTaskForAgent staging
// files into a task's own uploads dir, buildProjectContext's nudge, and the
// stdio bridge endpoint that forwards attachments for non-Claude agents.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createProject, createTask, getTask, listAgentEdits, updateTask } from "@/lib/store";
import { createSuggestedTask, resolveAgentAttachments, updateTaskForAgent } from "@/lib/agentTools";
import { UPLOADS_DIR, taskUploadsDir } from "@/lib/uploads";
import { fileAttachmentMarker, splitAttachmentText, ATTACHMENT_NUDGE } from "@/lib/uploadTypes";
import { buildProjectContext } from "@/lib/agents/shared";
import { POST as updateTaskEp } from "@/app/api/internal/agent-tools/update-task/route";

/** A caller task with a real worktree directory on disk, the fixture every case here needs. */
function callerWithWorktree(projectName = "Attach") {
  const project = createProject({ name: `${projectName}-${Math.random().toString(36).slice(2)}` });
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-agent-wt-"));
  const created = createTask({ project_id: project.id, title: "Caller", description: "" });
  updateTask(created.id, { worktree_path: worktree });
  return { project, caller: getTask(created.id)!, worktree };
}

/** The names currently staged under UPLOADS_DIR, for before/after "nothing was staged" checks. */
function uploadDirs(): string[] {
  try {
    return fs.readdirSync(UPLOADS_DIR);
  } catch {
    return [];
  }
}

function post(handler: (req: NextRequest) => Promise<Response>, url: string, body: unknown) {
  return handler(
    new NextRequest(`http://127.0.0.1:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("resolveAgentAttachments", () => {
  it("resolves a relative path inside the worktree", () => {
    const { caller, worktree } = callerWithWorktree();
    const abs = path.join(worktree, "notes.md");
    fs.writeFileSync(abs, "hi");

    const hit = resolveAgentAttachments(caller.id, ["notes.md"]);

    expect(hit).toEqual({ files: [fs.realpathSync(abs)] });
  });

  it("resolves an absolute path inside the worktree", () => {
    const { caller, worktree } = callerWithWorktree();
    const abs = path.join(worktree, "notes.md");
    fs.writeFileSync(abs, "hi");

    const hit = resolveAgentAttachments(caller.id, [abs]);

    expect(hit).toEqual({ files: [fs.realpathSync(abs)] });
  });

  it("refuses a path outside the worktree", () => {
    const { caller } = callerWithWorktree();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-outside-"));
    const outside = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outside, "shh");

    const hit = resolveAgentAttachments(caller.id, [outside]);

    expect("error" in hit).toBe(true);
    expect((hit as { error: string }).error).toContain("outside");
  });

  it("refuses a symlink inside the worktree that points outside it", () => {
    const { caller, worktree } = callerWithWorktree();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "shh");
    const link = path.join(worktree, "link.txt");
    fs.symlinkSync(outsideFile, link);

    const hit = resolveAgentAttachments(caller.id, ["link.txt"]);

    expect("error" in hit).toBe(true);
    expect((hit as { error: string }).error).toContain("outside");
  });

  it("refuses a directory", () => {
    const { caller, worktree } = callerWithWorktree();
    fs.mkdirSync(path.join(worktree, "sub"));

    const hit = resolveAgentAttachments(caller.id, ["sub"]);

    expect("error" in hit).toBe(true);
    expect((hit as { error: string }).error).toContain("isn't a file");
  });

  it("refuses a missing file", () => {
    const { caller } = callerWithWorktree();

    const hit = resolveAgentAttachments(caller.id, ["ghost.txt"]);

    expect("error" in hit).toBe(true);
    expect((hit as { error: string }).error).toContain("doesn't exist");
  });

  it("allows a file already inside the caller's own uploads dir", () => {
    const { caller } = callerWithWorktree();
    const dir = taskUploadsDir(caller.id);
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, "sent-back.txt");
    fs.writeFileSync(abs, "hi");

    const hit = resolveAgentAttachments(caller.id, [abs]);

    expect(hit).toEqual({ files: [fs.realpathSync(abs)] });
  });

  it("refuses a caller with no worktree", () => {
    const project = createProject({ name: `NoWt-${Math.random().toString(36).slice(2)}` });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });

    const hit = resolveAgentAttachments(caller.id, ["notes.md"]);

    expect("error" in hit).toBe(true);
    expect((hit as { error: string }).error).toContain("worktree");
  });

  it("refuses the whole call when one path among several good ones is bad", () => {
    const { caller, worktree } = callerWithWorktree();
    fs.writeFileSync(path.join(worktree, "good.txt"), "ok");

    const hit = resolveAgentAttachments(caller.id, ["good.txt", "ghost.txt"]);

    expect("error" in hit).toBe(true);
  });
});

describe("createSuggestedTask with attachments", () => {
  it("stages files under the new task's uploads dir, byte-identical, and reports the count", () => {
    const { project, caller, worktree } = callerWithWorktree();
    fs.writeFileSync(path.join(worktree, "notes.md"), "notes content");
    fs.writeFileSync(path.join(worktree, "shot.png"), "png bytes");

    const { task, text } = createSuggestedTask(project, {
      title: "Ship it",
      description: "See attached.",
      origin_task_id: caller.id,
      attachments: ["notes.md", "shot.png"],
    });

    expect(task).not.toBeNull();
    const { text: prose, attachments } = splitAttachmentText(task!.description);
    expect(prose).toBe("See attached.");
    expect(attachments).toHaveLength(2);
    const fileRef = attachments.find((a) => a.kind === "file")!;
    const imageRef = attachments.find((a) => a.kind === "image")!;
    expect(path.dirname(fileRef.path)).toBe(taskUploadsDir(task!.id));
    expect(path.dirname(imageRef.path)).toBe(taskUploadsDir(task!.id));
    expect(fs.readFileSync(fileRef.path, "utf8")).toBe("notes content");
    expect(fs.readFileSync(imageRef.path, "utf8")).toBe("png bytes");
    expect(text).toContain("Attached 2 files");
  });

  it("creates nothing and stages nothing on a bad path", () => {
    const { project, caller } = callerWithWorktree();
    const before = uploadDirs();

    const { task, text } = createSuggestedTask(project, {
      title: "Bad attach",
      description: "brief",
      origin_task_id: caller.id,
      attachments: ["/etc/hostname-not-in-worktree"],
    });

    expect(task).toBeNull();
    expect(text).toContain("Nothing was created");
    expect(uploadDirs()).toEqual(before);
  });
});

describe("updateTaskForAgent attachments", () => {
  it("appends a marker and the file exists on disk", () => {
    const { project, caller, worktree } = callerWithWorktree();
    fs.writeFileSync(path.join(worktree, "a.txt"), "a content");
    const target = createSuggestedTask(project, { title: "Target", description: "brief" }).task!;

    const first = updateTaskForAgent(caller, target.id, { attachments: ["a.txt"] });

    expect(first.task).not.toBeNull();
    const { text: prose1, attachments: att1 } = splitAttachmentText(first.task!.description);
    expect(prose1).toBe("brief");
    expect(att1).toHaveLength(1);
    expect(fs.readFileSync(att1[0].path, "utf8")).toBe("a content");
    expect(first.text).toContain("1 file attached");

    // A second call that only rewrites the prose keeps the existing marker.
    const second = updateTaskForAgent(caller, target.id, { description: "new prose" });
    expect(second.task).not.toBeNull();
    const { text: prose2, attachments: att2 } = splitAttachmentText(second.task!.description);
    expect(prose2).toBe("new prose");
    expect(att2).toEqual(att1);
  });

  it("does not duplicate markers when the description comes back with them in place", () => {
    const { project, caller, worktree } = callerWithWorktree();
    fs.writeFileSync(path.join(worktree, "a.txt"), "a");
    const target = createSuggestedTask(project, { title: "Target", description: "brief" }).task!;
    const withFile = updateTaskForAgent(caller, target.id, { attachments: ["a.txt"] }).task!;

    // The shape get_task hands back: prose plus the marker line. An agent
    // editing from that copy sends the marker along with its new prose.
    const res = updateTaskForAgent(caller, target.id, { description: withFile.description.replace("brief", "sharper brief") });

    expect(res.task).not.toBeNull();
    const { text, attachments } = splitAttachmentText(res.task!.description);
    expect(text).toBe("sharper brief");
    expect(attachments).toHaveLength(1);
    expect(res.text).toContain("description rewritten");
    // Sending the unchanged text back, markers included, is a no-op.
    expect(updateTaskForAgent(caller, target.id, { description: res.task!.description }).text).toMatch(/^No change/);
  });

  it("records the edit on an ACCEPTED (no longer suggested) task", () => {
    const { project, caller, worktree } = callerWithWorktree();
    fs.writeFileSync(path.join(worktree, "a.txt"), "hi");
    const target = createTask({ project_id: project.id, title: "Accepted", description: "" });
    updateTask(target.id, { suggested: 0 });

    const res = updateTaskForAgent(caller, target.id, { attachments: ["a.txt"] });

    expect(res.task).not.toBeNull();
    const edits = listAgentEdits(target.id);
    expect(edits).toHaveLength(1);
    expect(edits[0].changes.map((c) => c.field)).toContain("description");
  });

  it("refuses the whole call when a bad attachment accompanies a valid title change", () => {
    const { project, caller } = callerWithWorktree();
    const target = createSuggestedTask(project, { title: "Target", description: "" }).task!;
    const before = uploadDirs();

    const res = updateTaskForAgent(caller, target.id, { title: "Renamed", attachments: ["ghost.txt"] });

    expect(res.task).toBeNull();
    expect(getTask(target.id)!.title).toBe("Target");
    expect(uploadDirs()).toEqual(before);
  });

  it("stages nothing when a valid attachment accompanies an invalid priority", () => {
    const { project, caller, worktree } = callerWithWorktree();
    fs.writeFileSync(path.join(worktree, "a.txt"), "hi");
    const target = createSuggestedTask(project, { title: "Target", description: "" }).task!;

    const res = updateTaskForAgent(caller, target.id, { attachments: ["a.txt"], priority: "urgent" as never });

    expect(res.task).toBeNull();
    // The copy is deferred until every field passes; priority never did.
    expect(fs.existsSync(taskUploadsDir(target.id))).toBe(false);
  });
});

describe("buildProjectContext attachment nudge", () => {
  it("includes ATTACHMENT_NUDGE when the description carries a marker line", () => {
    const project = createProject({ name: `Nudge-${Math.random().toString(36).slice(2)}` });
    const task = createTask({
      project_id: project.id,
      title: "T",
      description: `Brief.\n\n${fileAttachmentMarker("/tmp/x/uploads/t1/a.txt")}`,
    });

    const ctx = buildProjectContext(project, task);

    expect(ctx).toContain(ATTACHMENT_NUDGE);
  });

  it("omits it when the description has no marker line", () => {
    const project = createProject({ name: `NoNudge-${Math.random().toString(36).slice(2)}` });
    const task = createTask({ project_id: project.id, title: "T", description: "Just prose." });

    const ctx = buildProjectContext(project, task);

    expect(ctx).not.toContain(ATTACHMENT_NUDGE);
  });
});

describe("update-task bridge endpoint forwards attachments", () => {
  it("stages a file named via the bridge's attachments field", async () => {
    const { project, caller, worktree } = callerWithWorktree();
    fs.writeFileSync(path.join(worktree, "a.txt"), "via bridge");
    const target = createSuggestedTask(project, { title: "Target", description: "" }).task!;

    const res = await post(updateTaskEp, "/api/internal/agent-tools/update-task", {
      taskId: caller.id,
      task: target.id,
      attachments: ["a.txt"],
    });

    expect(res.status).toBe(200);
    const { attachments } = splitAttachmentText(getTask(target.id)!.description);
    expect(attachments).toHaveLength(1);
    expect(fs.readFileSync(attachments[0].path, "utf8")).toBe("via bridge");
  });
});
