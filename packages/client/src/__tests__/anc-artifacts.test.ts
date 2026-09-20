import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localArtifactRetainer, localArtifactVerifier, readVerifiedAncArtifact } from "../anc/artifacts.js";
import { AncEffectRunner } from "../anc/effect-runner.js";
import { AncProjectLoop } from "../anc/project-loop.js";
import { type AncArtifact, type AncCaller, AncSnapshotSchema } from "../anc/schemas.js";
import { AncFileStore } from "../anc/store.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anc-artifacts-"));
  folders.push(root);
  const source = join(root, "draft.md");
  const text = "Test poster revision one";
  await writeFile(source, text);
  const artifact: AncArtifact = {
    title: "Test poster",
    uri: pathToFileURL(source).href,
    revision: "v1",
    sha256: createHash("sha256").update(text).digest("hex"),
    evidence: ["Checked test bytes"],
  };
  const archive = join(root, "review-copies");
  const retain = localArtifactRetainer(root, archive);
  const store = new AncFileStore(join(root, "state"));
  const loop = new AncProjectLoop(store, { verifyArtifact: localArtifactVerifier(root), retainArtifact: retain });
  await store.transact("camp", async () => ({
    snapshot: AncSnapshotSchema.parse({
      schemaVersion: 1,
      events: [],
      effects: {},
      project: {
        id: "camp",
        title: "Test camp",
        brief: "Testing only",
        dri: "reviewer",
        participants: ["reviewer"],
        roles: { owner: "reviewer" },
        status: "active",
        revision: 1,
        groupId: "group",
        sessionId: "owner",
        tasks: {
          poster: {
            id: "poster",
            goal: "Poster",
            acceptance: ["A verified file"],
            dependencies: [],
            reviewerRole: "owner",
            status: "running",
            revision: 1,
            sessionId: "poster-session",
          },
        },
        requests: {},
      },
    }),
    result: undefined,
  }));
  const agent: AncCaller = { kind: "agent", id: "poster-session", projectIds: ["camp"] };
  const human: AncCaller = { kind: "human", id: "reviewer", projectIds: ["camp"] };
  let sequence = 0;
  const command = (body: Record<string, unknown>, caller = agent) =>
    loop.execute(caller, { projectId: "camp", eventId: `event_${++sequence}`, ...body });
  const state = async () => {
    const result = await store.read("camp");
    if (!result) throw new Error("Missing state");
    return result;
  };
  const report = (a = artifact, revision = 1) =>
    command({
      operation: "task.report_result",
      taskId: "poster",
      expectedRevision: revision,
      artifact: a,
      dueAt: 1000,
    });
  const respond = async (decision = "approve") => {
    const request = Object.values((await state()).project.requests).find((r) => r.status === "pending");
    if (!request) throw new Error("Missing request");
    return command(
      {
        operation: "human.respond",
        requestId: request.id,
        subjectRevision: request.subjectRevision,
        artifactRevision: request.artifactRevision,
        decision,
        text: decision === "approve" ? "Approved for test" : "Change the title",
      },
      human,
    );
  };
  const perform = vi.fn(async () => "provider-receipt");
  const runner = new AncEffectRunner(loop, { perform, lookup: async () => undefined }, () => 100);
  return { root, source, text, artifact, archive, retain, loop, store, state, report, respond, perform, runner };
}

describe("ANC immutable review artifacts", () => {
  it("retains verified bytes and never follows later producer edits", async () => {
    const f = await fixture();
    const retained = await f.retain(f.artifact);
    await writeFile(f.source, "A different unapproved version");
    expect(await readVerifiedAncArtifact(f.root, retained)).toEqual(Buffer.from(f.text));
    await expect(localArtifactVerifier(f.root)(f.artifact)).rejects.toThrow("digest mismatch");
    expect((await readdir(f.archive)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
  it("deduplicates concurrent retention without overwriting review files", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.retain(f.artifact), f.retain(f.artifact)]);
    expect(a.uri).toBe(b.uri);
    expect(await readdir(f.archive)).toHaveLength(1);
  });
  it("blocks a corrupt archive copy instead of silently replacing it", async () => {
    const f = await fixture();
    const retained = await f.retain(f.artifact);
    await writeFile(fileURLToPath(retained.uri), "corrupt");
    await expect(f.retain(f.artifact)).rejects.toThrow("digest mismatch");
    expect(await readFile(fileURLToPath(retained.uri), "utf8")).toBe("corrupt");
    expect(await readdir(f.archive)).toHaveLength(1);
  });
  it("rejects missing, remote, outside-root and symlink-escaped files", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(readVerifiedAncArtifact(f.root, { ...f.artifact, uri: "https://example.com/a" })).rejects.toThrow(
      "local",
    );
    await expect(
      readVerifiedAncArtifact(f.root, { ...f.artifact, uri: pathToFileURL(join(f.root, "missing")).href }),
    ).rejects.toThrow();
    await expect(readVerifiedAncArtifact(f.root, other.artifact)).rejects.toThrow("escaped");
    const linked = join(f.root, "linked");
    await symlink(other.source, linked);
    await expect(
      readVerifiedAncArtifact(f.root, { ...other.artifact, uri: pathToFileURL(linked).href }),
    ).rejects.toThrow("escaped");
  });
  it("rejects empty and oversized artifacts before reading bytes", async () => {
    const f = await fixture();
    await writeFile(f.source, "");
    await expect(readVerifiedAncArtifact(f.root, f.artifact)).rejects.toThrow("Invalid artifact");
    await truncate(f.source, 128 * 1024 * 1024 + 1);
    await expect(readVerifiedAncArtifact(f.root, f.artifact)).rejects.toThrow("Invalid artifact");
  });
  it("binds an approval to the retained artifact, not a later draft at the same source path", async () => {
    const f = await fixture();
    await f.report();
    await writeFile(f.source, "Later unapproved draft");
    const state = await f.respond();
    expect(state.project.tasks.poster?.status).toBe("approved");
    const retained = state.project.tasks.poster?.artifact;
    if (!retained) throw new Error("Missing retained artifact");
    expect(retained.uri).not.toBe(f.artifact.uri);
    expect(await readVerifiedAncArtifact(f.root, retained)).toEqual(Buffer.from(f.text));
    expect(state.project.tasks.poster?.artifactHistory).toEqual([retained]);
  });
  it("preserves prior versions and rejects reusing a revision label", async () => {
    const f = await fixture();
    await f.report();
    await f.respond("changes");
    await expect(f.report(f.artifact, 2)).rejects.toThrow("already used");
    const revision2 = { ...f.artifact, revision: "v2" };
    const state = await f.report(revision2, 2);
    expect(state.project.tasks.poster?.artifactHistory.map((a) => a.revision)).toEqual(["v1", "v2"]);
  });
  it("does not accept approval after corruption of the actual review copy", async () => {
    const f = await fixture();
    const state = await f.report();
    const artifact = state.project.tasks.poster?.artifact;
    if (!artifact) throw new Error("Missing artifact");
    await writeFile(fileURLToPath(artifact.uri), "tampered after review");
    await expect(f.respond()).rejects.toThrow("digest mismatch");
    expect((await f.state()).project.tasks.poster?.status).toBe("waiting_human");
  });
  it("fails before external publication if approved bytes are lost or modified", async () => {
    const f = await fixture();
    await f.report();
    const state = await f.respond();
    const artifact = state.project.tasks.poster?.artifact;
    if (!artifact) throw new Error("Missing artifact");
    await writeFile(fileURLToPath(artifact.uri), "tampered after approval");
    await f.runner.tick();
    const effects = Object.values((await f.state()).effects);
    expect(f.perform).not.toHaveBeenCalled();
    expect(effects.find((e) => e.kind === "artifact.publish")).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "artifact_verification_failed",
    });
    expect((await f.state()).project.tasks.poster?.status).toBe("approved");
  });
});
