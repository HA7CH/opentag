import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { localArtifactVerifier } from "../anc/artifacts.js";
import { AncEffectRunner } from "../anc/effect-runner.js";
import { ancAgentView, createAncHostedTools } from "../anc/hosted-tools.js";
import { AncProjectLoop, ancEffectIsCurrent } from "../anc/project-loop.js";
import type { AncCaller, AncEffect, AncProjectPolicy } from "../anc/schemas.js";
import { AncFileStore } from "../anc/store.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const flexible: AncProjectPolicy = { existingGroupId: "existing-chat", allowInternalTasks: true };

async function fixture(policy?: AncProjectPolicy) {
  const root = await mkdtemp(join(tmpdir(), "anc-policy-"));
  folders.push(root);
  const directory = join(root, "state");
  const store = new AncFileStore(directory);
  const options = { now: () => 100, verifyArtifact: localArtifactVerifier(root) };
  const loop = new AncProjectLoop(store, { ...options, projectPolicy: () => policy });
  const agent: AncCaller = { kind: "agent", id: "owner", ownerSessionId: "owner", projectIds: ["project"] };
  const human: AncCaller = { kind: "human", id: "reviewer", projectIds: ["project"] };
  const calls: AncEffect[] = [];
  const runner = new AncEffectRunner(loop, {
    perform: async (effect) => {
      calls.push(effect);
      return `receipt_${effect.id}`;
    },
    lookup: async () => undefined,
  });
  let sequence = 0;
  const command = (body: Record<string, unknown>, caller = agent) =>
    loop.execute(caller, { projectId: "project", eventId: `e${++sequence}`, ...body });
  const state = async () => {
    const snapshot = await store.read("project");
    if (!snapshot) throw new Error("Missing project");
    return snapshot;
  };
  const drain = async () => {
    for (let n = 0; n < 40; n++) if ((await runner.tick()) === 0) return;
    throw new Error("Effects did not settle");
  };
  const propose = (extra: Record<string, unknown> = {}) =>
    command({
      operation: "project.propose",
      title: "Quotation",
      brief: "Research products and prepare a reviewed quotation.",
      dri: "reviewer",
      participants: ["reviewer"],
      dueAt: 1000,
      ...extra,
    });
  const respond = async (purpose: string, decision = "approve", taskId?: string) => {
    const request = Object.values((await state()).project.requests).find(
      (r) => r.purpose === purpose && r.taskId === taskId && r.status === "pending",
    );
    if (!request) throw new Error("Missing human request");
    return command(
      {
        operation: "human.respond",
        requestId: request.id,
        subjectRevision: request.subjectRevision,
        artifactRevision: request.artifactRevision,
        decision,
        text: "Verified fixture feedback",
      },
      human,
    );
  };
  const activate = async () => {
    await propose();
    await drain();
    await respond("start");
    await drain();
  };
  const dispatch = (taskId: string, mode?: "internal" | "deliverable", dependencies: string[] = []) =>
    command({ operation: "task.dispatch", taskId, mode, dependencies, goal: taskId, acceptance: ["Check the result"] });
  const complete = (taskId: string, expectedRevision = 1, extra: Record<string, unknown> = {}) =>
    command({ operation: "task.complete_internal", taskId, expectedRevision, summary: "Working result", ...extra });
  const report = async (taskId: string, expectedRevision = 1) => {
    const body = `Quotation revision ${expectedRevision}`;
    const path = join(root, `${taskId}-${expectedRevision}.txt`);
    await writeFile(path, body);
    return command({
      operation: "task.report_result",
      taskId,
      expectedRevision,
      artifact: {
        title: "Quotation",
        uri: pathToFileURL(path).href,
        revision: `v${expectedRevision}`,
        sha256: createHash("sha256").update(body).digest("hex"),
        evidence: ["Fixture content checked"],
      },
      dueAt: 1000,
    });
  };
  return {
    root,
    directory,
    store,
    options,
    loop,
    agent,
    calls,
    command,
    state,
    drain,
    propose,
    respond,
    activate,
    dispatch,
    complete,
    report,
  };
}

describe("ANC project boundaries", () => {
  it("preserves the strict pilot when admission has no policy", async () => {
    const f = await fixture();
    await f.activate();
    expect(f.calls.filter((e) => e.kind === "group.create")).toHaveLength(1);
    expect((await f.state()).project.policy).toBeUndefined();
    await expect(f.dispatch("research", "internal")).rejects.toThrow("not authorized");
    await f.dispatch("quote");
    await f.drain();
    await expect(f.complete("quote")).rejects.toThrow("Not an authorized internal task");
    await f.report("quote");
    expect((await f.state()).project.tasks.quote?.status).toBe("waiting_human");
  });

  it("uses an admitted existing chat only after explicit start approval", async () => {
    const f = await fixture(flexible);
    await f.propose();
    await f.drain();
    expect(f.calls.every((e) => e.kind === "human.send")).toBe(true);
    await expect(f.dispatch("research", "internal")).rejects.toThrow("not ready");
    await f.respond("start");
    await f.drain();
    expect((await f.state()).project).toMatchObject({ groupId: "existing-chat", sessionId: "owner", status: "active" });
    expect(f.calls.some((e) => e.kind === "group.create")).toBe(false);
    expect(f.calls.some((e) => e.kind === "session.wake")).toBe(true);
  });

  it("does not admit policy or destinations supplied in a model command", async () => {
    const f = await fixture();
    await f.propose({ policy: flexible, groupId: "attacker-chat" });
    const before = (await f.state()).project;
    expect(before.policy).toBeUndefined();
    expect(before.groupId).toBeUndefined();
    await f.respond("start");
    await f.drain();
    await expect(f.dispatch("research", "internal")).rejects.toThrow("not authorized");
  });

  it("persists admission across restart rather than silently reevaluating new configuration", async () => {
    const f = await fixture({ ...flexible });
    await f.activate();
    const restarted = new AncProjectLoop(new AncFileStore(f.directory), f.options);
    await restarted.execute(f.agent, {
      operation: "task.dispatch",
      projectId: "project",
      eventId: "restart-dispatch",
      taskId: "research",
      mode: "internal",
      goal: "Research",
      acceptance: ["Summarize findings"],
    });
    expect((await f.state()).project.tasks.research?.mode).toBe("internal");
    const old = await fixture();
    await old.activate();
    const changed = new AncProjectLoop(old.store, { ...old.options, projectPolicy: () => flexible });
    await expect(
      changed.execute(old.agent, {
        operation: "task.dispatch",
        projectId: "project",
        eventId: "changed-config",
        taskId: "research",
        mode: "internal",
        goal: "Research",
        acceptance: ["Findings"],
      }),
    ).rejects.toThrow("not authorized");
  });

  it("keeps the command digest of legacy dispatch events unchanged", async () => {
    const f = await fixture();
    await f.activate();
    const command = {
      projectId: "project",
      eventId: "legacy-dispatch",
      operation: "task.dispatch",
      taskId: "quote",
      goal: "Quote",
      acceptance: ["Readable"],
      dependencies: [],
      reviewerRole: "owner",
    };
    const expected = createHash("sha256")
      .update(JSON.stringify({ caller: { kind: "agent", id: "owner", ownerSessionId: "owner" }, command }))
      .digest("hex");
    await f.loop.execute(f.agent, command);
    await f.loop.execute(f.agent, command);
    const events = (await f.state()).events.filter((e) => e.id === command.eventId);
    expect(events).toHaveLength(1);
    expect(events[0]?.digest).toBe(expected);
  });

  it("unblocks dependencies from internal results without review or external delivery", async () => {
    const f = await fixture(flexible);
    await f.activate();
    await f.dispatch("research", "internal");
    await f.dispatch("quote", "deliverable", ["research"]);
    await f.dispatch("unrelated", "internal");
    await f.drain();
    expect((await f.state()).project.tasks.quote?.status).toBe("ready");
    await f.complete("research");
    await f.drain();
    const snapshot = await f.state();
    expect(snapshot.project.tasks.research).toMatchObject({ status: "completed", result: "Working result" });
    expect(snapshot.project.tasks.quote?.status).toBe("running");
    expect(Object.values(snapshot.project.requests).some((r) => r.taskId === "research")).toBe(false);
    expect(f.calls.some((e) => e.taskId === "research" && e.kind === "artifact.publish")).toBe(false);
    const view = ancAgentView(snapshot, { projectId: "project", sessionId: "quote-worker", taskId: "quote" });
    expect(view).toMatchObject({ dependencies: [{ id: "research", status: "completed", result: "Working result" }] });
    expect(JSON.stringify(view)).not.toContain("unrelated");
    expect(JSON.stringify(view)).not.toContain(snapshot.project.tasks.research?.sessionId);
  });

  it("rejects stale completion and deduplicates a repeated internal result", async () => {
    const f = await fixture(flexible);
    await f.activate();
    await f.dispatch("research", "internal");
    await f.drain();
    await expect(f.complete("research", 2)).rejects.toThrow("Stale");
    await f.complete("research", 1, { eventId: "stable-result" });
    await f.complete("research", 1, { eventId: "stable-result" });
    expect((await f.state()).events.filter((e) => e.id === "stable-result")).toHaveLength(1);
    await expect(f.complete("research", 1, { eventId: "stable-result", summary: "Changed" })).rejects.toThrow(
      "Idempotency",
    );
  });

  it("waits for verified human feedback before an internal task can continue", async () => {
    const f = await fixture(flexible);
    await f.activate();
    await f.dispatch("research", "internal");
    await f.drain();
    const sessionId = (await f.state()).project.tasks.research?.sessionId;
    await f.command({
      operation: "human.request",
      requestId: "missing-input",
      taskId: "research",
      recipientId: "reviewer",
      kind: "information",
      question: "Which product family?",
      dueAt: 1000,
    });
    await expect(f.complete("research")).rejects.toThrow("non-running");
    await f.respond("question", "answer", "research");
    await f.drain();
    await f.complete("research", 2);
    expect((await f.state()).project.tasks.research).toMatchObject({ status: "completed", revision: 2, sessionId });
  });

  it("keeps external review, revisions, receipts and explicit closure in the flexible path", async () => {
    const f = await fixture(flexible);
    await f.activate();
    await f.dispatch("research", "internal");
    await f.dispatch("quote", "deliverable", ["research"]);
    await f.drain();
    await f.complete("research");
    await f.drain();
    await f.report("quote");
    await f.respond("task_review", "changes", "quote");
    await f.drain();
    await f.report("quote", 2);
    await f.respond("task_review", "approve", "quote");
    expect((await f.state()).project.tasks.quote?.status).toBe("approved");
    await expect(f.command({ operation: "project.close", dueAt: 1000 })).rejects.toThrow("Deliver all");
    await f.drain();
    expect((await f.state()).project.tasks.quote?.status).toBe("delivered");
    expect(f.calls.filter((e) => e.kind === "artifact.publish")).toHaveLength(1);
    await f.command({ operation: "project.close", dueAt: 1000 });
    expect((await f.state()).project.status).toBe("closing");
    await f.respond("close");
    expect((await f.state()).project.status).toBe("closed");
  });

  it("does not let internal completion become a file-publication escape hatch", async () => {
    const f = await fixture(flexible);
    await f.activate();
    await f.dispatch("research", "internal");
    await f.drain();
    await expect(f.report("research")).rejects.toThrow("Use task.complete_internal");
    const snapshot = await f.state();
    const effect = Object.values(snapshot.effects).find((e) => e.taskId === "research");
    if (!effect) throw new Error("Missing task effect");
    const publication: AncEffect = { ...effect, kind: "artifact.publish" };
    expect(ancEffectIsCurrent(snapshot, publication)).toBe(false);
    await expect(f.loop.verifyDelivery(publication, snapshot)).rejects.toThrow("cannot be published");
  });

  it("scopes the new completion tool to the assigned worker and never exposes approval", async () => {
    const f = await fixture(flexible);
    await f.activate();
    await f.dispatch("research", "internal");
    await f.drain();
    const tools = createAncHostedTools(f.loop, { projectId: "project", sessionId: "worker", taskId: "research" });
    expect(tools.definitions.map((t) => t.name)).not.toContain("anc_human_respond");
    expect(tools.definitions.map((t) => t.name)).not.toContain("anc_task_dispatch");
    const call = {
      name: "anc_task_complete_internal",
      input: { taskId: "other", expectedRevision: 1, summary: "Result" },
      runId: "run",
      toolCallId: "call",
      signal: new AbortController().signal,
    };
    expect((await tools.handler(call)).success).toBe(false);
    expect((await tools.handler({ ...call, input: { ...call.input, taskId: "research" } })).success).toBe(true);
  });

  it("invalidates internal results on amendment and clears them when replanning", async () => {
    const f = await fixture(flexible);
    await f.activate();
    await f.dispatch("research", "internal");
    await f.drain();
    await f.complete("research");
    await f.command({ operation: "project.amend", expectedRevision: 1, brief: "Different products", dueAt: 1000 });
    await f.respond("amend");
    await f.command({
      operation: "task.revise",
      taskId: "research",
      expectedRevision: 2,
      goal: "Research the new products",
      acceptance: ["Matches revised scope"],
      mode: "deliverable",
    });
    const task = (await f.state()).project.tasks.research;
    expect(task?.result).toBeUndefined();
    expect(task?.mode).toBe("internal");
    await expect(f.complete("research", 1)).rejects.toThrow("Stale");
  });
});
