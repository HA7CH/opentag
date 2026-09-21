import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent } from "../agent-runtime/types.js";
import type { AncCardBinding } from "../anc/card-publisher.js";
import { AncPublicCardStream } from "../anc/public-card-stream.js";

const binding: AncCardBinding = {
  projectId: "project",
  runId: "run",
  target: { type: "chat_id", id: "oc_test" },
  title: "Test",
};
const start: AgentRuntimeEvent = {
  type: "message_started",
  runId: "run",
  messageId: "answer",
  phase: "final_answer",
};
const delta = (text: string): AgentRuntimeEvent => ({
  type: "message_delta",
  runId: "run",
  messageId: "answer",
  delta: text,
});
const terminal: AgentRuntimeEvent = {
  type: "run_completed",
  runId: "run",
  result: { runId: "run", status: "completed", output: [] },
};
function setup() {
  let now = 0;
  const capture = vi.fn(async () => {});
  const stream = new AncPublicCardStream({ capture }, binding, () => now);
  return {
    capture,
    stream,
    advance: () => {
      now += 1000;
    },
  };
}
describe("ANC public card stream checkpointing", () => {
  it("never publishes private events or steered user input", async () => {
    const f = setup();
    f.stream.accept({
      type: "input_accepted",
      runId: "run",
      input: { items: [{ type: "text", text: "private" }] },
    });
    await f.stream.checkpointIfDue();
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.stream.dirty).toBe(false);
  });
  it("coalesces deltas between one-second checkpoints", async () => {
    const f = setup();
    f.stream.accept(start);
    await f.stream.checkpointIfDue();
    for (let i = 0; i < 100; i++) {
      f.stream.accept(delta("x"));
      await f.stream.checkpointIfDue();
    }
    expect(f.capture).toHaveBeenCalledTimes(1);
    f.advance();
    await f.stream.checkpointIfDue();
    expect(f.capture).toHaveBeenLastCalledWith(
      binding,
      101,
      expect.objectContaining({
        messages: [expect.objectContaining({ text: "x".repeat(100) })],
      }),
    );
    expect(f.stream.dirty).toBe(false);
  });
  it("flushes the terminal snapshot even inside the normal checkpoint interval", async () => {
    const f = setup();
    f.stream.accept(start);
    await f.stream.checkpointIfDue();
    f.stream.accept(delta("final"));
    f.stream.accept(terminal);
    await f.stream.checkpointIfDue();
    expect(f.capture).toHaveBeenCalledTimes(2);
    expect(f.stream.terminal).toBe(true);
    expect(f.stream.dirty).toBe(false);
    await f.stream.checkpoint();
    expect(f.capture).toHaveBeenCalledTimes(2);
  });
  it("accepts new output while a disk checkpoint is pending and flushes it in order", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const capture = vi.fn(async () => {});
    capture.mockImplementationOnce(() => pending);
    const stream = new AncPublicCardStream({ capture }, binding);
    stream.accept(start);
    const first = stream.checkpoint();
    stream.accept(delta("later"));
    const second = stream.checkpoint();
    resolve();
    await Promise.all([first, second]);
    expect(capture.mock.calls).toHaveLength(2);
    expect(capture).toHaveBeenLastCalledWith(
      binding,
      2,
      expect.objectContaining({
        messages: [expect.objectContaining({ text: "later" })],
      }),
    );
    expect(stream.dirty).toBe(false);
  });
  it("propagates persistence failures and retains a retryable dirty snapshot", async () => {
    const f = setup();
    f.capture.mockRejectedValueOnce(new Error("disk full"));
    f.stream.accept(start);
    await expect(f.stream.checkpoint()).rejects.toThrow("disk full");
    expect(f.stream.dirty).toBe(true);
    await f.stream.checkpoint();
    expect(f.stream.dirty).toBe(false);
  });
});
