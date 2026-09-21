import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HumanMessaging, type HumanMessagingTransport } from "../human-messaging.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "human-messaging-"));
  roots.push(root);
  const send = vi.fn(async () => ({ messageId: "m1", conversationId: "dm" }));
  const lookup = vi.fn(async (): Promise<{ messageId: string; conversationId: string } | undefined> => undefined);
  const reply = {
    id: "r1",
    tenantId: "tenant",
    senderId: "person",
    conversationId: "dm",
    parentMessageId: "m1",
    text: "Please change the heading",
  };
  const readReply = vi.fn(async () => reply);
  const enqueue = vi.fn(async (_reply: unknown) => {});
  const transport: HumanMessagingTransport = { send, lookup, readReply, enqueue };
  const service = new HumanMessaging(root, transport);
  const scope = { sessionId: "session", tenantId: "tenant", people: ["person"] };
  const call = {
    name: "send_msg_to_person",
    input: { person: "person", message: "Please review this draft", request_key: "draft1" },
    runId: "run",
    toolCallId: "tool",
    signal: new AbortController().signal,
  };
  return { root, service, transport, scope, call, send, lookup, reply, enqueue };
}
it("sends once and reuses the receipt across restart and tool call ids", async () => {
  const f = await fixture();
  expect((await f.service.tools(f.scope).handler(f.call)).success).toBe(true);
  const restarted = new HumanMessaging(f.root, f.transport);
  expect((await restarted.tools(f.scope).handler({ ...f.call, toolCallId: "another" })).success).toBe(true);
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("rejects changed content and unauthorized recipients without sending", async () => {
  const f = await fixture();
  const tools = f.service.tools(f.scope);
  await tools.handler(f.call);
  expect((await tools.handler({ ...f.call, input: { ...f.call.input, message: "Different" } })).success).toBe(false);
  expect((await tools.handler({ ...f.call, input: { ...f.call.input, person: "stranger" } })).success).toBe(false);
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("never blindly resends an unknown send", async () => {
  const f = await fixture();
  f.send.mockRejectedValueOnce(new Error("network"));
  expect((await f.service.tools(f.scope).handler(f.call)).success).toBe(false);
  expect((await f.service.tools(f.scope).handler(f.call)).success).toBe(false);
  expect(f.send).toHaveBeenCalledTimes(1);
  f.lookup.mockResolvedValue({ messageId: "m1", conversationId: "dm" });
  expect((await f.service.tools(f.scope).handler(f.call)).success).toBe(true);
});
it("routes a verified quoted reply to its original session only once", async () => {
  const f = await fixture();
  await f.service.tools(f.scope).handler(f.call);
  expect(await f.service.receive("r1")).toBe("queued");
  expect(await f.service.receive("r1")).toBe("queued");
  expect(f.enqueue).toHaveBeenCalledTimes(1);
  expect(f.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session", text: f.reply.text }));
});
it.each(["senderId", "tenantId", "conversationId", "parentMessageId"] as const)(
  "does not route mismatched %s",
  async (field) => {
    const f = await fixture();
    await f.service.tools(f.scope).handler(f.call);
    f.reply[field] = "wrong";
    expect(await f.service.receive("r1")).toBe("unmatched");
    expect(f.enqueue).not.toHaveBeenCalled();
  },
);
it("replays a persisted reply after enqueue fails", async () => {
  const f = await fixture();
  await f.service.tools(f.scope).handler(f.call);
  f.enqueue.mockRejectedValueOnce(new Error("unavailable"));
  await expect(f.service.receive("r1")).rejects.toThrow("unavailable");
  const restarted = new HumanMessaging(f.root, f.transport);
  expect(await restarted.replayReplies()).toBe(1);
  expect(await restarted.replayReplies()).toBe(0);
  expect(f.enqueue.mock.calls[0]).toEqual(f.enqueue.mock.calls[1]);
});
