import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent, JsonValue } from "../agent-runtime/types.js";
import { type AncCardBinding, AncCardPublisher } from "../anc/card-publisher.js";
import { AncSafeRetry } from "../anc/effect-runner.js";
import { newAncPublicOutput, projectAncPublicEvent } from "../anc/public-output.js";
import { writeDurableJson } from "../storage/durable-file.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const binding: AncCardBinding = {
  projectId: "project",
  runId: "run",
  target: { type: "chat_id", id: "oc_fixture" },
  title: "Test project",
};
function projection(text: string) {
  return (
    [
      { type: "message_started", runId: "run", messageId: "answer", phase: "final_answer" },
      { type: "message_delta", runId: "run", messageId: "answer", delta: text },
    ] satisfies AgentRuntimeEvent[]
  ).reduce(projectAncPublicEvent, newAncPublicOutput("run"));
}
function finished(text = "Final answer") {
  return projectAncPublicEvent(projection(text), {
    type: "message_completed",
    runId: "run",
    messageId: "answer",
    text,
    phase: "final_answer",
  });
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "anc-card-publisher-"));
  directories.push(directory);
  let now = 10000;
  const transport = {
    sendCard: vi.fn(async (_id: string, _target: AncCardBinding["target"], _card: JsonValue) => "om_card"),
    updateCard: vi.fn(async (_id: string, _revision: number, _card: JsonValue) => "om_card"),
    lookup: vi.fn(async (_id: string): Promise<string | undefined> => undefined),
    reconcileCard: vi.fn(async (_id: string, _revision: number): Promise<string | undefined> => undefined),
  };
  const make = (namespace = "app_tenant") => new AncCardPublisher(directory, namespace, transport, { now: () => now });
  const publisher = make();
  return {
    directory,
    publisher,
    transport,
    make,
    advance: () => {
      now += 1000;
    },
  };
}
async function saved(publisher: AncCardPublisher) {
  const file = (await readdir(publisher.directory)).find((name) => name.endsWith(".json"));
  if (!file) throw new Error("Missing snapshot");
  const path = join(publisher.directory, file);
  return { path, record: JSON.parse(await readFile(path, "utf8")) };
}
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ANC durable coalescing card publisher", () => {
  it("persists before external action and coalesces snapshots into one card", async () => {
    const f = await fixture();
    await f.publisher.capture(binding, 1, projection("A"));
    await f.publisher.capture(binding, 2, projection("AB"));
    expect(f.transport.sendCard).not.toHaveBeenCalled();
    f.transport.sendCard.mockImplementation(async () => {
      const { path, record } = await saved(f.publisher);
      expect(record.cards[0].pending).toMatchObject({ status: "sending", revision: 0, attempts: 1 });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      return "om_card";
    });
    expect(await f.publisher.tick()).toBe(1);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.transport.sendCard.mock.calls[0]?.[2])).toContain("AB");
    expect(await f.publisher.receipts(binding)).toMatchObject([{ messageId: "om_card", revision: 0, status: "sent" }]);
    expect(await f.make().tick()).toBe(0);
  });

  it("does not stall model snapshots behind slow network or overwrite an in-flight payload", async () => {
    const f = await fixture();
    const request = held<string>();
    const started = held<void>();
    await f.publisher.capture(binding, 1, projection("First"));
    f.transport.sendCard.mockImplementation(async () => {
      started.resolve();
      return request.promise;
    });
    const sending = f.publisher.tick();
    await started.promise;
    await f.publisher.capture(binding, 2, projection("Second"));
    const { record } = await saved(f.publisher);
    expect(JSON.stringify(record.cards[0].pending.card)).toContain("First");
    expect(JSON.stringify(record.cards[0].desired)).toContain("Second");
    request.resolve("om_card");
    await sending;
    expect(await f.publisher.tick()).toBe(0);
    f.advance();
    await f.publisher.tick();
    expect(f.transport.updateCard).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.objectContaining({ schema: "2.0" }),
    );
    expect(JSON.stringify(f.transport.updateCard.mock.calls[0]?.[2])).toContain("Second");
  });

  it("continues consecutive revisions after restart and skips unchanged rendering", async () => {
    const f = await fixture();
    await f.publisher.capture(binding, 1, projection("Draft"));
    await f.publisher.tick();
    const restored = f.make();
    await restored.recover();
    await restored.capture(binding, 2, finished());
    f.advance();
    await restored.tick();
    await restored.capture(binding, 3, finished());
    f.advance();
    expect(await restored.tick()).toBe(0);
    expect(f.transport.updateCard).toHaveBeenCalledTimes(1);
    expect(await restored.receipts(binding)).toMatchObject([{ revision: 1, status: "sent" }]);
  });

  it("rejects stale snapshots, changed routes, removed messages and run mismatches", async () => {
    const f = await fixture();
    await f.publisher.capture(binding, 2, projection("Draft"));
    await expect(f.publisher.capture(binding, 1, projection("Old"))).rejects.toThrow("Stale");
    await expect(f.publisher.capture(binding, 2, projection("Changed"))).rejects.toThrow("reused");
    await expect(
      f.publisher.capture({ ...binding, target: { type: "open_id", id: "ou_other" } }, 3, projection("X")),
    ).rejects.toThrow("binding");
    await expect(f.publisher.capture(binding, 3, newAncPublicOutput("run"))).rejects.toThrow("removed");
    await expect(f.publisher.capture(binding, 3, newAncPublicOutput("other"))).rejects.toThrow("mismatch");
    await f.publisher.capture(binding, 2, projection("Draft"));
    await f.publisher.tick();
    expect(JSON.stringify(f.transport.sendCard.mock.calls[0]?.[2])).toContain("Draft");
  });

  it("never repeats an unknown create and blocks after three bounded lookups", async () => {
    const f = await fixture();
    f.transport.sendCard.mockRejectedValue(new Error("lost POST response"));
    await f.publisher.capture(binding, 1, projection("Draft"));
    await f.publisher.tick();
    const restored = f.make();
    await restored.recover();
    for (let i = 0; i < 3; i++) {
      f.advance();
      await restored.tick();
    }
    f.advance();
    expect(await restored.tick()).toBe(0);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(f.transport.lookup).toHaveBeenCalledTimes(3);
    expect(await restored.receipts(binding)).toMatchObject([{ status: "blocked" }]);
  });

  it("recovers a create receipt lost between gateway and publisher without another POST", async () => {
    const f = await fixture();
    await f.publisher.capture(binding, 1, projection("Draft"));
    f.transport.sendCard.mockRejectedValue(new Error("publisher receipt lost"));
    await f.publisher.tick();
    const { path, record } = await saved(f.publisher);
    record.cards[0].pending.status = "sending";
    await writeDurableJson(path, record);
    f.transport.lookup.mockResolvedValue("om_card");
    const restored = f.make();
    await restored.recover();
    f.advance();
    await restored.tick();
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
    expect(await restored.receipts(binding)).toMatchObject([{ messageId: "om_card", status: "sent" }]);
  });

  it("reconciles uncertain updates before a newer revision can be sent", async () => {
    const f = await fixture();
    await f.publisher.capture(binding, 1, projection("A"));
    await f.publisher.tick();
    f.transport.updateCard.mockRejectedValueOnce(new Error("lost PATCH response"));
    await f.publisher.capture(binding, 2, projection("B"));
    f.advance();
    await f.publisher.tick();
    await f.publisher.capture(binding, 3, finished("C"));
    f.advance();
    await f.publisher.tick();
    expect(f.transport.updateCard).toHaveBeenCalledTimes(1);
    expect(f.transport.reconcileCard).toHaveBeenCalledWith(expect.any(String), 1);
    f.transport.reconcileCard.mockResolvedValue("om_card");
    f.advance();
    await f.publisher.tick();
    f.advance();
    await f.publisher.tick();
    expect(f.transport.updateCard.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(JSON.stringify(f.transport.updateCard.mock.calls[1]?.[2])).toContain("C");
  });

  it("retries explicit rejections three times with the identical operation", async () => {
    const f = await fixture();
    f.transport.sendCard.mockRejectedValue(new AncSafeRetry("rate limit"));
    await f.publisher.capture(binding, 1, projection("A"));
    await f.publisher.tick();
    await f.publisher.capture(binding, 2, projection("B"));
    for (let i = 0; i < 2; i++) {
      f.advance();
      await f.publisher.tick();
    }
    f.advance();
    expect(await f.publisher.tick()).toBe(0);
    expect(f.transport.sendCard).toHaveBeenCalledTimes(3);
    const payloads = f.transport.sendCard.mock.calls.map((call) => JSON.stringify(call));
    expect(new Set(payloads).size).toBe(1);
    expect(await f.publisher.receipts(binding)).toMatchObject([{ status: "blocked" }]);
  });

  it("does not accept a changed message ID for an existing card", async () => {
    const f = await fixture();
    await f.publisher.capture(binding, 1, projection("A"));
    await f.publisher.tick();
    f.transport.updateCard.mockResolvedValue("om_wrong");
    await f.publisher.capture(binding, 2, finished());
    f.advance();
    await f.publisher.tick();
    expect(await f.publisher.receipts(binding)).toMatchObject([{ messageId: "om_card", status: "unknown" }]);
  });

  it("separates tenants and projects even when provider run IDs match", async () => {
    const f = await fixture();
    const other = f.make("other_app_tenant");
    await f.publisher.capture(binding, 1, projection("A"));
    await other.capture(binding, 1, projection("B"));
    await f.publisher.capture({ ...binding, projectId: "other_project" }, 1, projection("C"));
    await f.publisher.tick();
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.transport.sendCard.mock.calls)).not.toContain('"B"');
    await other.tick();
    expect(f.transport.sendCard).toHaveBeenCalledTimes(3);
    const ids = f.transport.sendCard.mock.calls.map((call) => call[0]);
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps real answer boundaries and excludes steer and tools", async () => {
    const f = await fixture();
    const output = (
      [
        { type: "input_accepted", runId: "run", input: { items: [{ type: "text", text: "private correction" }] } },
        { type: "message_started", runId: "run", messageId: "second", phase: "final_answer" },
        {
          type: "message_completed",
          runId: "run",
          messageId: "second",
          text: "Independent answer",
          phase: "final_answer",
        },
      ] satisfies AgentRuntimeEvent[]
    ).reduce(projectAncPublicEvent, finished("First answer"));
    await f.publisher.capture(binding, 1, output);
    await f.publisher.tick();
    expect(f.transport.sendCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.transport.sendCard.mock.calls)).not.toContain("private correction");
    expect(JSON.stringify(f.transport.sendCard.mock.calls[0]?.[2])).toContain("First answer");
    expect(JSON.stringify(f.transport.sendCard.mock.calls[1]?.[2])).toContain("Independent answer");
  });

  it("does not run two senders on the same outbox simultaneously", async () => {
    const f = await fixture();
    const request = held<string>();
    const started = held<void>();
    await f.publisher.capture(binding, 1, projection("A"));
    f.transport.sendCard.mockImplementation(async () => {
      started.resolve();
      return request.promise;
    });
    const first = f.publisher.tick();
    await started.promise;
    await expect(f.make().tick()).rejects.toMatchObject({ code: "EEXIST" });
    request.resolve("om_card");
    await first;
    expect(f.transport.sendCard).toHaveBeenCalledTimes(1);
  });

  it("serves until stopped and drains an already-sent operation", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const request = held<string>();
    const started = held<void>();
    await f.publisher.capture(binding, 1, projection("A"));
    f.transport.sendCard.mockImplementation(async () => {
      started.resolve();
      return request.promise;
    });
    const serving = f.publisher.serve(controller.signal);
    await started.promise;
    controller.abort();
    request.resolve("om_card");
    await serving;
    expect(await f.publisher.receipts(binding)).toMatchObject([{ status: "sent" }]);
  });

  it("validates the update rate without allowing sub-second publisher loops", async () => {
    const f = await fixture();
    expect(() => new AncCardPublisher(f.directory, "app", f.transport, { intervalMs: 10 })).toThrow("cadence");
  });
});
