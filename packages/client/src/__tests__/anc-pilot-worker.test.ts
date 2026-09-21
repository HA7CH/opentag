import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AncDeferred, AncEffectRunner } from "../anc/effect-runner.js";
import { AncPilotWorker } from "../anc/pilot-worker.js";
import { AncProjectLoop } from "../anc/project-loop.js";
import { AncFileStore } from "../anc/store.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
type Status = "accepted" | "running" | "completed" | "failed";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anc-worker-"));
  folders.push(root);
  let now = 100;
  const loop = new AncProjectLoop(new AncFileStore(join(root, "projects")), {
    now: () => now,
    verifyArtifact: async () => undefined,
  });
  const status = new Map<string, Status>();
  const inFlight = new Set<string>();
  let peak = 0;
  const work = vi.fn(async (_id: string): Promise<void> => undefined);
  const sessions = {
    pendingIntakes: async () => [...status].filter(([, state]) => state === "accepted").map(([id]) => id),
    startIntake: vi.fn(async (id: string) => {
      status.set(id, "running");
      inFlight.add(id);
      peak = Math.max(peak, inFlight.size);
      try {
        await work(id);
        status.set(id, "completed");
        return `receipt-${id}`;
      } finally {
        inFlight.delete(id);
      }
    }),
    intakeStatus: async (id: string) => status.get(id) ?? "accepted",
    recoverDeadLocks: async () => 0,
    get hasActiveWork() {
      return inFlight.size > 0;
    },
  };
  const delivered: string[] = [];
  const adapter = {
    perform: vi.fn(async (effect: { id: string; kind: string }) => {
      delivered.push(effect.kind);
      return `receipt-${effect.id}`;
    }),
    lookup: vi.fn(async () => undefined),
  };
  const effects = new AncEffectRunner(loop, adapter, () => now);
  const blocked = vi.fn(async () => undefined);
  const options = { pollMs: 10, deadlineScanMs: 10, now: () => now, onIntakeBlocked: blocked };
  const worker = new AncPilotWorker(loop, sessions, effects, options);
  const propose = () =>
    loop.execute(
      { kind: "system", id: "fixture", projectIds: ["camp"] },
      {
        operation: "project.propose",
        projectId: "camp",
        eventId: "proposal",
        title: "Test",
        brief: "Isolated test",
        dri: "reviewer",
        participants: ["reviewer"],
        dueAt: 1000,
      },
    );
  const eventCount = async () => (await loop.store.read("camp"))?.events.length ?? 0;
  return {
    loop,
    status,
    sessions,
    work,
    effects,
    adapter,
    worker,
    delivered,
    blocked,
    options,
    propose,
    eventCount,
    peak: () => peak,
    time: (value: number) => {
      now = value;
    },
  };
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("ANC pilot background progression", () => {
  it("limits intake execution while delivering durable human requests in a separate lane", async () => {
    const f = await fixture();
    const gate = latch();
    f.work.mockImplementation(async () => gate.promise);
    for (const id of ["first", "second", "third"]) f.status.set(id, "accepted");
    await f.propose();
    const controller = new AbortController();
    const service = f.worker.serve(controller.signal);
    try {
      await vi.waitFor(() => {
        expect(f.sessions.startIntake).toHaveBeenCalledTimes(2);
        expect(f.delivered).toEqual(["human.send"]);
      });
      expect(f.worker.hasProtectedWork).toBe(true);
      expect(f.peak()).toBe(2);
      gate.release();
      await vi.waitFor(() => expect([...f.status.values()]).toEqual(["completed", "completed", "completed"]));
      expect(f.peak()).toBe(2);
    } finally {
      gate.release();
      controller.abort();
      await service;
    }
  });

  it("adds no deadline events while idle, follows up once, then blocks without repeated reminders", async () => {
    const f = await fixture();
    await f.propose();
    const initial = await f.eventCount();
    for (let i = 0; i < 4; i++) await f.worker.checkDeadlines();
    expect(await f.eventCount()).toBe(initial);
    f.time(1000);
    await f.worker.checkDeadlines();
    await f.worker.checkDeadlines();
    expect(await f.eventCount()).toBe(initial + 1);
    f.time(1000 + 86400000);
    await f.worker.checkDeadlines();
    await f.worker.checkDeadlines();
    const snapshot = await f.loop.store.read("camp");
    expect(Object.values(snapshot?.project.requests ?? {})[0]?.status).toBe("blocked");
    expect(Object.values(snapshot?.effects ?? {}).filter((effect) => effect.kind === "human.remind")).toHaveLength(1);
    expect(await f.eventCount()).toBe(initial + 2);
    expect(f.sessions.startIntake).not.toHaveBeenCalled();
  });

  it("pauses new model and delivery work, then resumes the same queues", async () => {
    const f = await fixture();
    await f.propose();
    f.status.set("first", "accepted");
    f.worker.pause();
    const controller = new AbortController();
    const service = f.worker.serve(controller.signal);
    try {
      await delay(80);
      expect(f.sessions.startIntake).not.toHaveBeenCalled();
      expect(f.adapter.perform).not.toHaveBeenCalled();
      f.worker.resume();
      await vi.waitFor(() => {
        expect(f.status.get("first")).toBe("completed");
        expect(f.delivered).toEqual(["human.send"]);
      });
    } finally {
      controller.abort();
      await service;
    }
  });

  it("preserves a delivery already in flight when paused and waits for its receipt on shutdown", async () => {
    const f = await fixture();
    await f.propose();
    const gate = latch();
    f.adapter.perform.mockImplementation(async () => {
      await gate.promise;
      return "actual-receipt";
    });
    const controller = new AbortController();
    const service = f.worker.serve(controller.signal);
    let stopped = false;
    const finished = service.then(() => {
      stopped = true;
    });
    try {
      await vi.waitFor(() => expect(f.effects.activeCount).toBe(1));
      f.worker.pause();
      expect(f.worker.hasProtectedWork).toBe(true);
      controller.abort();
      await delay(30);
      expect(stopped).toBe(false);
      gate.release();
      await finished;
      expect(f.worker.hasProtectedWork).toBe(false);
      const snapshot = await f.loop.store.read("camp");
      expect(Object.values(snapshot?.project.requests ?? {})[0]?.receipt).toBe("actual-receipt");
    } finally {
      gate.release();
      controller.abort();
      await finished;
    }
  });

  it("reports an uncertain intake once and continues unrelated accepted work", async () => {
    const f = await fixture();
    f.status.set("uncertain", "accepted");
    f.status.set("other", "accepted");
    f.work.mockImplementation(async (id) => {
      if (id === "uncertain") throw new Error("Provider lost response");
    });
    const controller = new AbortController();
    const service = f.worker.serve(controller.signal);
    try {
      await vi.waitFor(() => {
        expect(f.blocked).toHaveBeenCalledWith("uncertain", "running");
        expect(f.status.get("other")).toBe("completed");
      });
      await delay(50);
      expect(f.blocked).toHaveBeenCalledTimes(1);
      expect(f.sessions.startIntake).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      await service;
    }
  });

  it("retries capacity deferral without converting it into an execution failure", async () => {
    const f = await fixture();
    f.status.set("first", "accepted");
    f.sessions.startIntake.mockImplementationOnce(async () => {
      throw new AncDeferred("busy");
    });
    const controller = new AbortController();
    const service = f.worker.serve(controller.signal);
    try {
      await vi.waitFor(() => expect(f.status.get("first")).toBe("completed"));
      expect(f.sessions.startIntake).toHaveBeenCalledTimes(2);
      expect(f.blocked).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await service;
    }
  });

  it("fails closed when intake state could not be durably claimed", async () => {
    const f = await fixture();
    f.status.set("first", "accepted");
    f.sessions.startIntake.mockImplementation(async () => {
      throw new Error("disk failure");
    });
    await expect(f.worker.serve(new AbortController().signal)).rejects.toThrow("disk failure");
    expect(f.sessions.startIntake).toHaveBeenCalledTimes(1);
    expect(f.blocked).not.toHaveBeenCalled();
  });

  it("allows only one pilot process to own the project store", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const entered = vi.spyOn(f.effects, "serve");
    const service = f.worker.serve(controller.signal);
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
      const second = new AncPilotWorker(f.loop, f.sessions, f.effects, f.options);
      await expect(second.serve(new AbortController().signal)).rejects.toThrow();
      expect(entered).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await service;
    }
  });
  it("ignores a deadline selected immediately before project closure", async () => {
    const f = await fixture();
    await f.propose();
    f.time(1000);
    const execute = f.loop.execute.bind(f.loop);
    vi.spyOn(f.loop, "execute").mockImplementation(async (caller, command) => {
      await f.loop.store.transact("camp", async (snapshot) => {
        if (!snapshot) throw new Error("Missing fixture");
        snapshot.project.status = "closed";
        return { snapshot, result: undefined };
      });
      return execute(caller, command);
    });
    await expect(f.worker.checkDeadlines()).resolves.toBeUndefined();
    const snapshot = await f.loop.store.read("camp");
    expect(Object.values(snapshot?.effects ?? {}).some((effect) => effect.kind === "human.remind")).toBe(false);
  });
});
