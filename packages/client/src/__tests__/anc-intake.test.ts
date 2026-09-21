import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentPromptRequest,
  AgentRuntime,
  AgentRuntimeFactory,
  CreateAgentRuntimeRequest,
} from "../agent-runtime/types.js";
import { AncDeferred, AncEffectRunner } from "../anc/effect-runner.js";
import { AncProjectLoop } from "../anc/project-loop.js";
import { AncSessionDriver } from "../anc/session-driver.js";
import { AncFileStore } from "../anc/store.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const intake = {
  projectId: "camp",
  eventId: "verified-message",
  actorId: "reviewer",
  humanIds: ["reviewer"],
  text: "Prepare the test camp poster and courseware.",
  source: { appId: "test-app", chatId: "test-chat", messageId: "test-message" },
};
const proposal = {
  title: "Camp test",
  brief: "Prepare a poster and courseware; date and venue remain unconfirmed.",
  dri: "reviewer",
  participants: ["reviewer"],
  dueAt: 1000,
};
async function invoke(
  request: CreateAgentRuntimeRequest,
  name: string,
  input: Record<string, string | number | string[]>,
  runId = "run",
) {
  if (!request.hostedTools) throw new Error("Missing hosted tools");
  return request.hostedTools.handler({ name, input, runId, toolCallId: name, signal: new AbortController().signal });
}
async function fixture(
  perform: (request: CreateAgentRuntimeRequest, prompt: AgentPromptRequest) => Promise<void> = async () => undefined,
) {
  const root = await mkdtemp(join(tmpdir(), "anc-intake-"));
  folders.push(root);
  const loop = new AncProjectLoop(new AncFileStore(join(root, "projects")), { verifyArtifact: async () => undefined });
  const manifest = {
    providerId: "fixture",
    displayName: "Fixture",
    contractVersion: 2 as const,
    bindingSchemaVersion: 1,
  };
  const binding = { providerId: "fixture", schemaVersion: 1, payload: { threadId: "original-thread" } };
  const requests: CreateAgentRuntimeRequest[] = [];
  const open = async (request: CreateAgentRuntimeRequest): Promise<AgentRuntime> => {
    requests.push(request);
    await request.eventSink({ type: "binding_changed", binding });
    return {
      manifest,
      capabilities: { steer: "supported", interactions: "unsupported" },
      state: { phase: "idle", queuedRunCount: 0 },
      binding,
      prompt: async (prompt) => {
        await perform(request, prompt);
        return { runId: prompt.runId, status: "completed", output: [], binding };
      },
      steer: async () => undefined,
      followUp: async () => {
        throw new Error("Unexpected follow up");
      },
      respond: async () => undefined,
      abort: async () => undefined,
      waitForIdle: async () => undefined,
      close: async () => undefined,
    };
  };
  const factory: AgentRuntimeFactory = {
    manifest,
    probe: async () => ({ ready: true, issues: [] }),
    create: vi.fn(open),
    resume: vi.fn(open),
  };
  const options = {
    directory: join(root, "sessions"),
    workspaceRoot: join(root, "work"),
    factory,
    configuration: { model: "fixture" },
  };
  const driver = new AncSessionDriver(loop, options);
  const effects: string[] = [];
  const runner = new AncEffectRunner(loop, {
    perform: async (effect, snapshot) => {
      effects.push(effect.kind);
      if (effect.kind === "session.wake") return driver.wake(effect, snapshot);
      if (effect.kind === "session.create") return driver.create(effect);
      return `receipt-${effect.id}`;
    },
    lookup: (effect, snapshot) => driver.lookup(effect, snapshot),
  });
  const drain = async () => {
    for (let i = 0; i < 20; i++) if ((await runner.tick()) === 0) return;
    throw new Error("Fixture did not settle");
  };
  const respond = async (decision: "approve" | "changes", eventId: string) => {
    const snapshot = await loop.store.read("camp");
    const request = Object.values(snapshot?.project.requests ?? {}).find(
      (r) => r.purpose === "start" && r.status === "pending",
    );
    if (!request) throw new Error("Missing pending start request");
    return loop.execute(
      { kind: "human", id: "reviewer", projectIds: ["camp"] },
      {
        operation: "human.respond",
        projectId: "camp",
        eventId,
        requestId: request.id,
        subjectRevision: request.subjectRevision,
        decision,
        text: decision === "changes" ? "Reduce scope to a poster." : "Approve this test scope.",
      },
    );
  };
  return { loop, driver, factory, options, requests, effects, drain, respond };
}

describe("ANC durable project intake", () => {
  it("persists before execution and restores the same admitted identity", async () => {
    const f = await fixture(async (request) => {
      await invoke(request, "anc_project_propose", proposal);
    });
    const id = await f.driver.admitIntake(intake);
    expect(f.factory.create).not.toHaveBeenCalled();
    expect(await f.loop.store.read("camp")).toBeUndefined();
    const restored = new AncSessionDriver(f.loop, f.options);
    expect(await restored.pendingIntakes()).toEqual([id]);
    expect(await restored.admitIntake(intake)).toBe(id);
    const receipt = await restored.startIntake(id);
    expect(await restored.startIntake(id)).toBe(receipt);
    expect(await restored.pendingIntakes()).toEqual([]);
    expect(f.factory.create).toHaveBeenCalledTimes(1);
    const prompt = JSON.parse(await readFile(join(f.options.directory, `${id}.json`), "utf8"));
    expect(prompt.intake.source).toEqual(intake.source);
    expect(prompt.binding.payload.threadId).toBe("original-thread");
  });

  it("rejects conflicting intake contents and people before any model starts", async () => {
    const f = await fixture();
    await expect(f.driver.admitIntake({ ...intake, actorId: "outsider" })).rejects.toThrow("outside");
    await f.driver.admitIntake(intake);
    for (const changed of [
      { text: "A different request" },
      { eventId: "different-message" },
      { source: { ...intake.source, chatId: "other-chat" } },
      { humanIds: ["reviewer", "another-person"] },
    ])
      await expect(f.driver.admitIntake({ ...intake, ...changed })).rejects.toThrow("identity conflict");
    expect(f.factory.create).not.toHaveBeenCalled();
  });

  it("keeps proposal feedback and approved startup on the original owner thread", async () => {
    let turn = 0;
    const f = await fixture(async (request, prompt) => {
      turn++;
      if (turn === 1) {
        const view = JSON.parse(prompt.input.items.find((item) => item.type === "text")?.text ?? "{}");
        expect(view.intake.requester).toBe("reviewer");
        expect(view.state.status).toBe("not_proposed");
        expect(
          (await invoke(request, "anc_project_propose", { ...proposal, sessionId: "model-forged-owner" }, prompt.runId))
            .success,
        ).toBe(true);
      } else if (turn === 2) {
        expect(
          (
            await invoke(
              request,
              "anc_project_revise_proposal",
              {
                brief: "Prepare only a poster.",
                expectedRevision: 1,
                dueAt: 1000,
              },
              prompt.runId,
            )
          ).success,
        ).toBe(true);
      }
    });
    const id = await f.driver.admitIntake(intake);
    await f.driver.startIntake(id);
    expect((await f.loop.store.read("camp"))?.project.sessionId).toBe(id);
    await f.drain();
    expect(f.effects).toEqual(["human.send"]);
    await f.respond("changes", "feedback-one");
    await f.drain();
    expect((await f.loop.store.read("camp"))?.project.revision).toBe(2);
    await f.respond("approve", "approve-two");
    await f.drain();
    const snapshot = await f.loop.store.read("camp");
    expect(snapshot?.project.status).toBe("active");
    expect(snapshot?.project.sessionId).toBe(id);
    expect(snapshot?.project.groupId).toBeTruthy();
    expect(f.effects.filter((kind) => kind === "group.create")).toHaveLength(1);
    expect(f.effects).not.toContain("session.create");
    expect(f.factory.create).toHaveBeenCalledTimes(1);
    expect(f.factory.resume).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(f.factory.resume).mock.calls)
      expect(call[0].binding.payload).toEqual({ threadId: "original-thread" });
  });

  it("rejects model-added participants without persisting or notifying anyone", async () => {
    const f = await fixture(async (request) => {
      const denied = await invoke(request, "anc_project_propose", {
        ...proposal,
        participants: ["reviewer", "outsider"],
      });
      expect(denied.success).toBe(false);
      expect(denied.error?.message).toContain("admitted scope");
    });
    const id = await f.driver.admitIntake(intake);
    await expect(f.driver.startIntake(id)).rejects.toThrow("without a durable project proposal");
    expect(await f.driver.pendingIntakes()).toEqual([]);
    expect(await f.loop.store.read("camp")).toBeUndefined();
    expect(f.effects).toEqual([]);
  });

  it("does not auto-repeat an intake after a lost model outcome", async () => {
    const f = await fixture(async () => {
      throw new Error("lost connection");
    });
    const id = await f.driver.admitIntake(intake);
    await expect(f.driver.startIntake(id)).rejects.toThrow("lost connection");
    const restored = new AncSessionDriver(f.loop, f.options);
    expect(await restored.pendingIntakes()).toEqual([]);
    await expect(restored.startIntake(id)).rejects.toBeInstanceOf(AncDeferred);
    expect(f.factory.create).toHaveBeenCalledTimes(1);
    expect(f.factory.resume).not.toHaveBeenCalled();
  });

  it("does not allow two driver instances to write the same live session", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async (request) => {
      await hold;
      await invoke(request, "anc_project_propose", proposal);
    });
    const id = await f.driver.admitIntake(intake);
    const first = f.driver.startIntake(id);
    try {
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      const other = new AncSessionDriver(f.loop, f.options);
      await expect(other.startIntake(id)).rejects.toBeInstanceOf(AncDeferred);
      expect(f.requests).toHaveLength(1);
    } finally {
      release();
      await first;
    }
  });

  it("refuses to admit over an existing project with a different origin", async () => {
    const f = await fixture();
    await f.loop.execute(
      { kind: "system", id: "fixture", projectIds: ["camp"] },
      {
        operation: "project.propose",
        projectId: "camp",
        eventId: "earlier-proposal",
        ...proposal,
      },
    );
    await expect(f.driver.admitIntake(intake)).rejects.toThrow("already exists");
    expect(f.factory.create).not.toHaveBeenCalled();
  });

  it("does not let an unrelated caller set the owner binding", async () => {
    const f = await fixture();
    await expect(
      f.loop.execute(
        { kind: "agent", id: "agent-one", ownerSessionId: "agent-two", projectIds: ["camp"] },
        {
          operation: "project.propose",
          projectId: "camp",
          eventId: "spoofed",
          ...proposal,
        },
      ),
    ).rejects.toThrow("Invalid owner");
    expect(await f.loop.store.read("camp")).toBeUndefined();
  });
});
