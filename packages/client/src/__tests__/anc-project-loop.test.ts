import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertHostedTools } from "../agent-runtime/validation.js";
import { localArtifactVerifier } from "../anc/artifacts.js";
import { AncDeferred, AncEffectRunner, AncSafeRetry } from "../anc/effect-runner.js";
import { ancAgentView, createAncHostedTools } from "../anc/hosted-tools.js";
import { AncProjectLoop } from "../anc/project-loop.js";
import { routeAncHumanReply } from "../anc/routing.js";
import type { AncArtifact, AncCaller, AncCommand, AncEffect } from "../anc/schemas.js";
import { AncFileStore } from "../anc/store.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anc-v4-"));
  folders.push(root);
  const store = new AncFileStore(join(root, "state"));
  let clock = 100;
  const loop = new AncProjectLoop(store, { now: () => clock, verifyArtifact: localArtifactVerifier(root) });
  const agent: AncCaller = { kind: "agent", id: "project-agent", projectIds: ["camp"] };
  const human: AncCaller = { kind: "human", id: "reviewer", projectIds: ["camp"] };
  const receipts = new Map<string, string>();
  const calls: AncEffect[] = [];
  const adapter = {
    perform: vi.fn(async (e: AncEffect) => {
      calls.push(e);
      const receipt = `${e.kind}-${e.id}`;
      receipts.set(e.id, receipt);
      return receipt;
    }),
    lookup: vi.fn(async (e: AncEffect) => receipts.get(e.id)),
  };
  const runner = new AncEffectRunner(loop, adapter, () => clock);
  let sequence = 0;
  const command = (body: Record<string, unknown>, caller = agent) =>
    loop.execute(caller, { projectId: "camp", eventId: `e${++sequence}`, ...body });
  const state = async () => {
    const value = await store.read("camp");
    if (!value) throw new Error("Missing fixture project");
    return value;
  };
  const pending = async (purpose: string, taskId?: string) => {
    const r = Object.values((await state()).project.requests).find(
      (r) => r.purpose === purpose && r.taskId === taskId && (r.status === "pending" || r.status === "blocked"),
    );
    if (!r) throw new Error(`Missing pending request: ${purpose}`);
    return r;
  };
  const respond = async (purpose: string, decision = "approve", taskId?: string) => {
    const r = await pending(purpose, taskId);
    return command(
      {
        operation: "human.respond",
        requestId: r.id,
        subjectRevision: r.subjectRevision,
        artifactRevision: r.artifactRevision,
        decision,
        text: decision === "changes" ? "Please simplify the title." : "Approved for this test.",
      },
      human,
    );
  };
  const drain = async () => {
    for (let n = 0; n < 40; n++) {
      if ((await runner.tick()) === 0) return;
    }
    throw new Error("Fixture failed to reach quiescence");
  };
  const propose = () =>
    command({
      operation: "project.propose",
      title: "Camp test",
      brief: "Prepare a poster and courseware.",
      dri: "reviewer",
      participants: ["reviewer"],
      dueAt: 1000,
    });
  const activate = async () => {
    await propose();
    await drain();
    await respond("start");
    await drain();
  };
  const dispatch = (taskId: string, dependencies: string[] = []) =>
    command({
      operation: "task.dispatch",
      taskId,
      goal: `Produce ${taskId}`,
      acceptance: ["A complete readable file"],
      dependencies,
    });
  const artifact = async (revision = "v1"): Promise<AncArtifact> => {
    const path = join(root, `${revision}.md`);
    const body = `Verified draft ${revision}`;
    await writeFile(path, body);
    return {
      title: "Draft",
      uri: pathToFileURL(path).href,
      revision,
      sha256: createHash("sha256").update(body).digest("hex"),
      evidence: ["Local content checked"],
    };
  };
  const report = async (taskId: string, expectedRevision = 1, revision = "v1") =>
    command({
      operation: "task.report_result",
      taskId,
      expectedRevision,
      artifact: await artifact(revision),
      dueAt: 1000,
    });
  return {
    root,
    store,
    loop,
    runner,
    adapter,
    calls,
    receipts,
    agent,
    human,
    command,
    state,
    pending,
    respond,
    drain,
    propose,
    activate,
    dispatch,
    artifact,
    report,
    setTime: (n: number) => {
      clock = n;
    },
  };
}

describe("ANC V4 durable human collaboration", () => {
  it("wakes the owner once after exhausted delivery retries and exposes the blocked effect", async () => {
    const f = await fixture();
    await f.activate();
    await f.dispatch("poster");
    await f.drain();
    await f.report("poster");
    await f.drain();
    await f.respond("task_review", "approve", "poster");
    f.adapter.perform.mockImplementation(async (effect) => {
      if (effect.kind === "artifact.publish") throw new AncSafeRetry("not sent");
      return effect.id;
    });
    for (const at of [100, 2100, 6100]) {
      f.setTime(at);
      await f.runner.tick();
    }
    const failed = Object.values((await f.state()).effects).find((effect) => effect.status === "failed");
    expect(failed?.kind).toBe("artifact.publish");
    const notices = Object.values((await f.state()).effects).filter((effect) => effect.recoveryOf === failed?.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe("session.wake");
    const view = ancAgentView(await f.state(), { projectId: "camp", sessionId: "owner" });
    expect(view).toMatchObject({ deliveryIssues: [expect.objectContaining({ id: failed?.id, status: "failed" })] });
    await f.drain();
    expect(Object.values((await f.state()).effects).filter((effect) => effect.recoveryOf === failed?.id)).toHaveLength(
      1,
    );
    expect((await f.state()).project.tasks.poster?.status).toBe("approved");
  });

  it("bounds unknown-outcome lookups without replaying a delivery or hiding its uncertainty", async () => {
    const f = await fixture();
    await f.activate();
    await f.dispatch("poster");
    await f.drain();
    await f.report("poster");
    await f.drain();
    await f.respond("task_review", "approve", "poster");
    f.adapter.perform.mockImplementation(async (effect) => {
      if (effect.kind === "artifact.publish") throw new Error("response lost after send");
      return effect.id;
    });
    await f.runner.tick();
    const lost = Object.values((await f.state()).effects).find((effect) => effect.kind === "artifact.publish");
    expect(lost?.status).toBe("unknown");
    f.adapter.lookup.mockImplementation(async () => undefined);
    for (const at of [61000, 122000, 183000, 244000]) {
      f.setTime(at);
      await f.runner.tick();
    }
    const unresolved = lost ? (await f.state()).effects[lost.id] : undefined;
    expect(unresolved).toMatchObject({
      status: "unknown",
      reconciliationAttempts: 3,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    });
    expect(f.adapter.perform.mock.calls.filter(([effect]) => effect.kind === "artifact.publish")).toHaveLength(1);
    expect(f.adapter.lookup).toHaveBeenCalledTimes(3);
    expect(Object.values((await f.state()).effects).filter((effect) => effect.recoveryOf === lost?.id)).toHaveLength(1);
  });

  it("does not create an infinite chain when the recovery wake itself fails", async () => {
    const f = await fixture();
    await f.activate();
    await f.dispatch("poster");
    f.adapter.perform.mockImplementation(async (effect) => {
      if (effect.kind === "session.create" || effect.kind === "session.wake") throw new AncSafeRetry("not started");
      return effect.id;
    });
    for (const at of [100, 2100, 6100, 6200, 8200, 12200, 13000]) {
      f.setTime(at);
      await f.runner.tick();
    }
    const state = await f.state();
    const recovery = Object.values(state.effects).filter((effect) => effect.recoveryOf);
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.status).toBe("failed");
    expect(state.project.tasks.poster?.status).toBe("blocked");
  });

  it("does not exhaust retries while waiting for an execution slot", async () => {
    const f = await fixture();
    await f.propose();
    f.adapter.perform.mockImplementation(async () => {
      throw new AncDeferred("occupied");
    });
    for (let n = 0; n < 6; n++) {
      f.setTime(100 + n * 2000);
      await f.runner.tick();
    }
    const effect = Object.values((await f.state()).effects)[0];
    expect(effect?.status).toBe("pending");
    expect(effect?.attempts).toBe(0);
    expect(f.adapter.perform).toHaveBeenCalledTimes(6);
  });

  it("sends a durable human request while two model runs are still active", async () => {
    const f = await fixture();
    await f.activate();
    await f.dispatch("poster");
    await f.dispatch("courseware");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Set<string>();
    const sent = new Set<string>();
    f.adapter.perform.mockImplementation(async (e) => {
      if (e.kind === "session.wake") {
        started.add(e.taskId ?? "owner");
        await hold;
      }
      if (e.kind === "human.send") sent.add(e.requestId ?? "");
      return e.id;
    });
    const controller = new AbortController();
    const service = f.runner.serve(controller.signal);
    try {
      await vi.waitFor(() => expect(started.size).toBe(2), { timeout: 60000 });
      await f.report("poster");
      const request = await f.pending("task_review", "poster");
      await vi.waitFor(() => expect(sent.has(request.id)).toBe(true), { timeout: 60000 });
      const running = Object.values((await f.state()).effects).filter(
        (e) => e.kind === "session.wake" && e.status === "running",
      );
      expect(running).toHaveLength(2);
    } finally {
      controller.abort();
      release();
      await service;
    }
  });

  it("hosts scoped Codex tools without exposing human approvals or other projects", async () => {
    const f = await fixture();
    await f.activate();
    await f.dispatch("poster");
    await f.drain();
    const tools = createAncHostedTools(f.loop, { projectId: "camp", sessionId: "poster-session", taskId: "poster" });
    expect(() =>
      assertHostedTools(
        { fileSystem: "read-only", network: "disabled", approvals: "never", tools: { mode: "provider-default" } },
        tools,
      ),
    ).not.toThrow();
    const ownerTools = createAncHostedTools(f.loop, { projectId: "camp", sessionId: "owner" });
    expect(() =>
      assertHostedTools(
        { fileSystem: "read-only", network: "disabled", approvals: "never", tools: { mode: "provider-default" } },
        ownerTools,
      ),
    ).not.toThrow();
    expect(tools.definitions.map((t) => t.name)).not.toContain("anc_human_respond");
    expect(tools.definitions.map((t) => t.name)).not.toContain("anc_task_dispatch");
    const signal = new AbortController().signal;
    const denied = await tools.handler({
      name: "anc_task_report_result",
      input: { taskId: "courseware" },
      runId: "run",
      toolCallId: "call",
      signal,
    });
    expect(denied.success).toBe(false);
    const view = await tools.handler({ name: "anc_state", input: {}, runId: "run", toolCallId: "state", signal });
    expect(view.success).toBe(true);
    expect(JSON.parse(view.content[0]?.text ?? "{}").task.id).toBe("poster");
  });
  it("revises a rejected start proposal without creating another project", async () => {
    const f = await fixture();
    await f.propose();
    await f.respond("start", "changes");
    await f.command({ operation: "project.revise_proposal", expectedRevision: 1, brief: "Revised scope", dueAt: 1000 });
    await f.respond("start");
    await f.drain();
    expect((await f.state()).project.revision).toBe(2);
    expect(f.calls.filter((e) => e.kind === "group.create")).toHaveLength(1);
  });

  it("never publishes obsolete approved artifacts after an approved amendment", async () => {
    const f = await fixture();
    await f.activate();
    await f.dispatch("poster");
    await f.drain();
    await f.report("poster");
    await f.respond("task_review", "approve", "poster");
    await f.command({ operation: "project.amend", expectedRevision: 1, brief: "Different title", dueAt: 1000 });
    await f.drain();
    expect(f.calls.filter((e) => e.kind === "artifact.publish")).toHaveLength(0);
    await f.respond("amend");
    await f.drain();
    expect(f.calls.filter((e) => e.kind === "artifact.publish")).toHaveLength(0);
    await f.command({
      operation: "task.revise",
      taskId: "poster",
      expectedRevision: 2,
      goal: "Updated poster",
      acceptance: ["Matches approved scope"],
    });
    await f.drain();
    await f.report("poster", 3, "v3");
    await f.respond("task_review", "approve", "poster");
    await f.drain();
    expect((await f.state()).project.tasks.poster?.status).toBe("delivered");
    expect(f.calls.filter((e) => e.kind === "session.create" && e.taskId === "poster")).toHaveLength(1);
  });

  it("accepts concurrent independent task results through a single writer", async () => {
    const f = await fixture();
    await f.activate();
    await f.dispatch("poster");
    await f.dispatch("courseware");
    await f.drain();
    await Promise.all([f.report("poster", 1, "poster-v1"), f.report("courseware", 1, "courseware-v1")]);
    expect(Object.values((await f.state()).project.tasks).every((t) => t.status === "waiting_human")).toBe(true);
  });

  it("uncertain delivery does not starve independent work in the same project", async () => {
    const f = await fixture();
    await f.activate();
    await f.dispatch("poster");
    await f.dispatch("courseware");
    await f.drain();
    await f.report("poster");
    await f.report("courseware");
    f.adapter.perform.mockImplementation(async (e) => {
      if (e.taskId === "poster") throw new Error("Lost receipt");
      return `receipt-${e.id}`;
    });
    await f.runner.tick();
    const sends = Object.values((await f.state()).effects).filter((e) => e.kind === "human.send" && e.taskId);
    expect(sends.find((e) => e.taskId === "poster")?.status).toBe("unknown");
    expect(sends.find((e) => e.taskId === "courseware")?.status).toBe("succeeded");
  });
  it("runs propose -> group -> parallel work -> revise -> deliver -> explicit close", async () => {
    const f = await fixture();
    await f.activate();
    await f.dispatch("poster");
    await f.dispatch("courseware");
    await f.drain();
    await f.report("poster");
    expect((await f.state()).project.tasks.courseware?.status).toBe("running");
    await f.report("courseware");
    await f.drain();
    await f.respond("task_review", "changes", "poster");
    await f.drain();
    await f.report("poster", 2, "v2");
    await f.drain();
    await f.respond("task_review", "approve", "poster");
    await f.respond("task_review", "approve", "courseware");
    await f.drain();
    expect(Object.values((await f.state()).project.tasks).map((t) => t.status)).toEqual(["delivered", "delivered"]);
    await f.command({ operation: "project.close", dueAt: 2000 });
    expect((await f.state()).project.status).toBe("closing");
    await f.drain();
    await f.respond("close");
    await f.drain();
    expect((await f.state()).project.status).toBe("closed");
    expect(f.calls.filter((e) => e.kind === "group.create")).toHaveLength(1);
    expect(f.calls.filter((e) => e.kind === "artifact.publish")).toHaveLength(2);
    expect((await stat(join(f.root, "state", "camp.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects forged human identity, acknowledgements and stale artifact approval", async () => {
    const f = await fixture();
    await f.activate();
    await f.dispatch("poster");
    await f.drain();
    await f.report("poster");
    const r = await f.pending("task_review", "poster");
    const body = {
      operation: "human.respond",
      requestId: r.id,
      subjectRevision: 1,
      artifactRevision: "v1",
      decision: "approve",
      text: "Approved",
    };
    await expect(f.command(body)).rejects.toThrow("authenticated human");
    await expect(f.command(body, { ...f.human, id: "intruder" })).rejects.toThrow("recipient mismatch");
    await expect(f.command({ ...body, decision: "answer", text: "Received" }, f.human)).rejects.toThrow("not approval");
    await expect(f.command({ ...body, artifactRevision: "v0" }, f.human)).rejects.toThrow("Stale artifact");
    await f.respond("task_review", "changes", "poster");
    await expect(f.command(body, f.human)).rejects.toThrow("no longer pending");
  });

  it("deduplicates accepted operations and rejects conflicting reuse", async () => {
    const f = await fixture();
    await f.propose();
    const c = { projectId: "camp", eventId: "stable", operation: "deadline.check" } as AncCommand;
    const system = { ...f.agent, kind: "system" as const };
    await f.loop.execute(system, c);
    await f.loop.execute(system, c);
    expect((await f.state()).events.filter((e) => e.id === "stable")).toHaveLength(1);
    await expect(f.loop.execute(f.agent, { ...c, operation: "project.close", dueAt: 3000 })).rejects.toThrow(
      "Idempotency",
    );
  });

  it("requires delivered dependencies and real artifact bytes", async () => {
    const f = await fixture();
    await f.activate();
    await f.dispatch("poster");
    await f.dispatch("publish", ["poster"]);
    await f.drain();
    expect((await f.state()).project.tasks.publish?.status).toBe("ready");
    const bad = { ...(await f.artifact()), sha256: "0".repeat(64) };
    await expect(
      f.command({ operation: "task.report_result", taskId: "poster", expectedRevision: 1, artifact: bad, dueAt: 1000 }),
    ).rejects.toThrow("digest mismatch");
    await f.report("poster");
    await f.respond("task_review", "approve", "poster");
    await f.drain();
    expect((await f.state()).project.tasks.publish?.status).toBe("running");
    await expect(f.command({ operation: "project.close", dueAt: 1000 })).rejects.toThrow("Deliver all");
  });

  it("restores pending human requests and reminds only once", async () => {
    const f = await fixture();
    await f.propose();
    await f.drain();
    const restarted = new AncFileStore(join(f.root, "state"));
    expect(Object.values((await restarted.read("camp"))?.project.requests ?? {})).toHaveLength(1);
    f.setTime(1100);
    await f.command({ operation: "deadline.check" }, { ...f.agent, kind: "system" });
    await f.command({ operation: "deadline.check" }, { ...f.agent, kind: "system" });
    await f.drain();
    expect(f.calls.filter((e) => e.kind === "human.remind")).toHaveLength(1);
    f.setTime(1000 + 24 * 60 * 60 * 1000);
    await f.command({ operation: "deadline.check" }, { ...f.agent, kind: "system" });
    expect((await f.pending("start")).status).toBe("blocked");
    expect((await f.state()).project.status).toBe("proposed");
    await f.respond("start");
    await f.drain();
    expect((await f.state()).project.status).toBe("active");
  });

  it("reconciles crash after send without repeating the side effect", async () => {
    const f = await fixture();
    await f.propose();
    const s = await f.state();
    const e = Object.values(s.effects)[0];
    if (!e) throw new Error("Missing effect");
    await f.store.transact("camp", async (next) => {
      if (!next?.effects[e.id]) throw new Error("Missing state");
      const pendingEffect = next.effects[e.id];
      if (!pendingEffect) throw new Error("Missing effect");
      pendingEffect.status = "running";
      return { snapshot: next, result: undefined };
    });
    f.receipts.set(e.id, "provider-receipt");
    await f.runner.recover();
    await f.runner.tick();
    expect(f.adapter.perform).not.toHaveBeenCalled();
    expect((await f.state()).effects[e.id]?.receipt).toBe("provider-receipt");
  });

  it("keeps unknown outcomes blocked and caps safe retries", async () => {
    const f = await fixture();
    await f.propose();
    f.adapter.perform.mockRejectedValue(new Error("timeout after write"));
    await f.runner.tick();
    await f.runner.tick();
    expect(f.adapter.perform).toHaveBeenCalledTimes(1);
    expect(Object.values((await f.state()).effects)[0]?.status).toBe("unknown");
    const retry = await fixture();
    await retry.propose();
    retry.adapter.perform.mockRejectedValue(new AncSafeRetry("Not sent"));
    for (let n = 0; n < 4; n++) {
      retry.setTime(n * 100000);
      await retry.runner.tick();
    }
    expect(retry.adapter.perform).toHaveBeenCalledTimes(3);
    expect(Object.values((await retry.state()).effects)[0]?.status).toBe("failed");
  });

  it("fails closed on corrupt files and concurrent writers", async () => {
    const f = await fixture();
    await f.propose();
    await f.store.lock("exclusive", async () => {
      await expect(f.store.lock("exclusive", async () => undefined)).rejects.toMatchObject({ code: "EEXIST" });
    });
    const original = await readFile(join(f.root, "state", "camp.json"), "utf8");
    await writeFile(join(f.root, "state", "camp.json"), "{");
    await expect(f.store.read("camp")).rejects.toThrow("invalid JSON");
    await writeFile(join(f.root, "state", "camp.json"), original);
    expect(await f.store.recoverDeadLocks()).toBe(0);
    await expect(f.store.read("../../escape")).rejects.toThrow();
  });

  it("routes replies across channels by identity and anchor, not last active project", async () => {
    const f = await fixture();
    await f.activate();
    await f.dispatch("poster");
    await f.dispatch("courseware");
    await f.drain();
    await f.report("poster");
    await f.report("courseware");
    await f.drain();
    const s = await f.state();
    const r = await f.pending("task_review", "poster");
    expect(routeAncHumanReply({ actorId: "reviewer" }, [s]).status).toBe("ambiguous");
    expect(routeAncHumanReply({ actorId: "reviewer", replyToMessageId: r.receipt }, [s])).toMatchObject({
      status: "matched",
      request: { id: r.id },
    });
    expect(routeAncHumanReply({ actorId: "intruder", requestId: r.id }, [s]).status).toBe("unmatched");
    expect(routeAncHumanReply({ actorId: "reviewer", requestId: "unknown" }, [s]).status).toBe("unmatched");
  });
});
