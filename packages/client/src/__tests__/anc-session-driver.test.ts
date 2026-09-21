import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentPromptRequest,
  AgentRunResult,
  AgentRuntime,
  AgentRuntimeBinding,
  AgentRuntimeFactory,
  CreateAgentRuntimeRequest,
  ResumeAgentRuntimeRequest,
} from "../agent-runtime/types.js";
import { AncDeferred } from "../anc/effect-runner.js";
import { AncProjectLoop } from "../anc/project-loop.js";
import { type AncEffect, AncSnapshotSchema } from "../anc/schemas.js";
import { AncSessionDriver } from "../anc/session-driver.js";
import { AncFileStore } from "../anc/store.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const manifest = { providerId: "test", displayName: "Test", contractVersion: 2 as const, bindingSchemaVersion: 1 };
const binding: AgentRuntimeBinding = {
  providerId: "test",
  schemaVersion: 1,
  payload: { threadId: "persistent-thread" },
};
const completed = (request: AgentPromptRequest): AgentRunResult => ({
  runId: request.runId,
  status: "completed",
  output: [],
  binding,
});
function effect(id: string, kind: AncEffect["kind"] = "session.wake", taskId?: string): AncEffect {
  return {
    id,
    kind,
    projectId: "camp",
    taskId,
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    projectRevision: 1,
    taskRevision: taskId ? 1 : undefined,
  };
}
async function fixture(
  run: (request: AgentPromptRequest) => Promise<AgentRunResult> = async (request) => completed(request),
) {
  const root = await mkdtemp(join(tmpdir(), "anc-session-"));
  folders.push(root);
  const loop = new AncProjectLoop(new AncFileStore(join(root, "state")), { verifyArtifact: async () => undefined });
  const instances: AgentRuntime[] = [];
  const open = async (request: CreateAgentRuntimeRequest) => {
    const state = {
      phase: "idle" as "idle" | "running",
      queuedRunCount: 0,
      activeRunId: undefined as string | undefined,
    };
    const runtime: AgentRuntime = {
      manifest,
      capabilities: { steer: "supported", interactions: "unsupported" },
      state,
      binding,
      prompt: vi.fn(async (input) => {
        state.phase = "running";
        state.activeRunId = input.runId;
        try {
          return await run(input);
        } finally {
          state.phase = "idle";
          state.activeRunId = undefined;
        }
      }),
      steer: vi.fn(async () => undefined),
      followUp: vi.fn(async (input) => run(input)),
      respond: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    await request.eventSink({ type: "binding_changed", binding });
    instances.push(runtime);
    return runtime;
  };
  const factory: AgentRuntimeFactory = {
    manifest,
    probe: vi.fn(async () => ({ ready: true, issues: [] })),
    create: vi.fn(open),
    resume: vi.fn(async (request: ResumeAgentRuntimeRequest) => open(request)),
  };
  const options = {
    directory: join(root, "sessions"),
    workspaceRoot: join(root, "work"),
    factory,
    configuration: { model: "test" },
  };
  const driver = new AncSessionDriver(loop, options);
  const snapshot = AncSnapshotSchema.parse({
    schemaVersion: 1,
    project: {
      id: "camp",
      title: "Camp",
      brief: "Isolated test",
      dri: "reviewer",
      participants: ["reviewer"],
      roles: { owner: "reviewer" },
      status: "active",
      revision: 1,
      tasks: {},
      requests: {},
    },
    effects: {},
    events: [],
  });
  snapshot.project.sessionId = await driver.create(effect("create-owner", "session.create"));
  return { driver, loop, options, snapshot, factory, instances };
}

describe("ANC exact-thread execution", () => {
  it("persists exact bindings, resumes them, and reuses completed receipts", async () => {
    const f = await fixture();
    const first = effect("wake-one");
    const receipt = await f.driver.wake(first, f.snapshot);
    expect(await f.driver.lookup(first, f.snapshot)).toBe(receipt);
    expect(await f.driver.wake(first, f.snapshot)).toBe(receipt);
    expect(f.factory.create).toHaveBeenCalledTimes(1);
    const restored = new AncSessionDriver(f.loop, f.options);
    await restored.wake(effect("wake-two"), f.snapshot);
    expect(f.factory.resume).toHaveBeenCalledWith(expect.objectContaining({ binding }));
    expect(f.instances.every((runtime) => vi.mocked(runtime.close).mock.calls.length === 1)).toBe(true);
  });

  it("does not start a different run after an unresolved previous execution", async () => {
    const f = await fixture(async () => {
      throw new Error("connection lost");
    });
    await expect(f.driver.wake(effect("lost-run"), f.snapshot)).rejects.toThrow("connection lost");
    expect(await f.driver.lookup(effect("lost-run"), f.snapshot)).toBeUndefined();
    const restored = new AncSessionDriver(f.loop, f.options);
    await expect(restored.wake(effect("new-event"), f.snapshot)).rejects.toBeInstanceOf(AncDeferred);
    expect(f.factory.create).toHaveBeenCalledTimes(1);
    expect(f.factory.resume).not.toHaveBeenCalled();
    expect(f.instances[0]?.close).toHaveBeenCalledOnce();
  });

  it("never turns a failed model result into a successful receipt", async () => {
    const f = await fixture(async (request) => ({ ...completed(request), status: "failed" }));
    await expect(f.driver.wake(effect("failed-run"), f.snapshot)).rejects.toThrow("Codex execution failed");
    expect(await f.driver.lookup(effect("failed-run"), f.snapshot)).toBeUndefined();
    await expect(f.driver.wake(effect("next-run"), f.snapshot)).rejects.toBeInstanceOf(AncDeferred);
    expect(f.instances[0]?.close).toHaveBeenCalledOnce();
  });

  it("limits executions to two while steering the original active run", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async (request) => {
      await hold;
      return completed(request);
    });
    for (const id of ["poster", "courseware", "extra"]) {
      f.snapshot.project.tasks[id] = {
        id,
        goal: id,
        acceptance: ["Readable artifact"],
        dependencies: [],
        reviewerRole: "owner",
        status: "running",
        revision: 1,
        artifactHistory: [],
        sessionId: await f.driver.create(effect(`create-${id}`, "session.create", id)),
      };
    }
    const first = f.driver.wake(effect("poster-run", "session.wake", "poster"), f.snapshot);
    const second = f.driver.wake(effect("courseware-run", "session.wake", "courseware"), f.snapshot);
    try {
      await vi.waitFor(() => expect(f.instances).toHaveLength(2), { timeout: 60000 });
      await expect(f.driver.wake(effect("extra-run", "session.wake", "extra"), f.snapshot)).rejects.toBeInstanceOf(
        AncDeferred,
      );
      const id = f.snapshot.project.tasks.poster?.sessionId;
      if (!id) throw new Error("Missing poster session");
      expect(await f.driver.steer(id, "Please simplify the title")).toBe(true);
      const steered = f.instances.flatMap((runtime) => vi.mocked(runtime.steer).mock.calls);
      expect(steered).toEqual([
        [{ expectedRunId: "poster-run", input: { items: [{ type: "text", text: "Please simplify the title" }] } }],
      ]);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    await f.driver.wake(effect("extra-run", "session.wake", "extra"), f.snapshot);
    expect(f.factory.create).toHaveBeenCalledTimes(3);
  });
});
