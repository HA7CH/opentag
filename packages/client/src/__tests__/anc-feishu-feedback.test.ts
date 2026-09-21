import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AncFeishuFeedback } from "../anc/feishu-feedback.js";
import { AncProjectLoop } from "../anc/project-loop.js";
import { AncFileStore } from "../anc/store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const reference = { appId: "cli_test", chatId: "oc_test", messageId: "om_reply" };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "anc-feedback-"));
  directories.push(directory);
  const loop = new AncProjectLoop(new AncFileStore(directory), { now: () => 100, verifyArtifact: async () => {} });
  const agent = { kind: "agent" as const, id: "owner", projectIds: ["camp"] };
  const proposed = await loop.execute(agent, {
    operation: "project.propose",
    projectId: "camp",
    eventId: "proposal",
    title: "Test camp",
    brief: "Test only",
    dri: "ou_reviewer",
    participants: ["ou_reviewer"],
    dueAt: 1000,
  });
  const request = Object.values(proposed.project.requests)[0];
  if (!request) throw new Error("No proposal request");
  await loop.store.transact("camp", async (snapshot) => {
    if (!snapshot) throw new Error("No project");
    const current = snapshot.project.requests[request.id];
    if (!current) throw new Error("Missing request");
    current.receipt = "om_request";
    return { snapshot, result: undefined };
  });
  const message = {
    actorId: "ou_reviewer",
    appId: "cli_test",
    tenantKey: "tenant_test",
    chatId: "oc_test",
    messageId: "om_reply",
    parentId: "om_request" as string | undefined,
    text: "批准",
  };
  const verifyHuman = vi.fn(async () => ({ ...message }));
  const feedback = new AncFeishuFeedback(loop, { verifyHuman });
  const state = () => loop.store.read("camp");
  return { loop, agent, request, message, feedback, verifyHuman, state };
}
describe("ANC verified Feishu feedback", () => {
  it("checks the exact message and applies a version-bound approval with one continuation", async () => {
    const f = await fixture();
    expect(await f.feedback.accept(reference)).toEqual({
      status: "applied",
      projectId: "camp",
      requestId: f.request.id,
    });
    expect(f.verifyHuman).toHaveBeenCalledWith(reference, undefined);
    const snapshot = await f.state();
    expect(snapshot?.project.status).toBe("active");
    expect(snapshot?.project.requests[f.request.id]?.status).toBe("approved");
    expect(Object.values(snapshot?.effects ?? {}).filter((effect) => effect.kind === "group.create")).toHaveLength(1);
    expect(await f.feedback.accept(reference)).toMatchObject({ status: "applied" });
    expect((await f.state())?.events.filter((event) => event.operation === "human.respond")).toHaveLength(1);
  });
  it("does not trust an inbound actor until the gateway has verified it", async () => {
    const f = await fixture();
    f.verifyHuman.mockRejectedValue(new Error("wrong tenant"));
    await expect(f.feedback.accept(reference)).rejects.toThrow("wrong tenant");
    expect((await f.state())?.project.status).toBe("proposed");
  });
  it.each(["收到", "已收到。", "谢谢", "noted"])("does not approve an acknowledgement: %s", async (text) => {
    const f = await fixture();
    f.message.text = text;
    expect(await f.feedback.accept(reference)).toEqual({ status: "acknowledged" });
    expect((await f.state())?.project.requests[f.request.id]?.status).toBe("pending");
  });
  it("asks to anchor a bare yes even if there is currently only one pending request", async () => {
    const f = await fixture();
    f.message.parentId = undefined;
    f.message.text = "可以";
    expect(await f.feedback.accept(reference)).toEqual({ status: "clarify" });
    expect((await f.state())?.project.status).toBe("proposed");
  });
  it("routes an explicit confirmation reference across allowed channels", async () => {
    const f = await fixture();
    f.message.parentId = undefined;
    f.message.chatId = "oc_other_allowed";
    f.message.text = `#确认:${f.request.id} 同意。`;
    expect(await f.feedback.accept({ ...reference, chatId: f.message.chatId })).toMatchObject({ status: "applied" });
    expect((await f.state())?.project.status).toBe("active");
  });
  it("does not accept a mismatching quote and explicit reference", async () => {
    const f = await fixture();
    f.message.parentId = "om_other_request";
    f.message.text = `#确认:${f.request.id} 批准`;
    expect(await f.feedback.accept(reference)).toEqual({ status: "clarify" });
    expect((await f.state())?.project.status).toBe("proposed");
  });
  it("does not let a different authorized colleague approve the recipient's request", async () => {
    const f = await fixture();
    f.message.actorId = "ou_colleague";
    expect(await f.feedback.accept(reference)).toEqual({ status: "clarify" });
    expect((await f.state())?.project.status).toBe("proposed");
  });
  it("turns explicit revision feedback into a durable continuation, not approval", async () => {
    const f = await fixture();
    f.message.text = "需要修改：先只做海报。";
    expect(await f.feedback.accept(reference)).toMatchObject({ status: "applied" });
    expect((await f.state())?.project.requests[f.request.id]?.status).toBe("changes_requested");
    expect((await f.state())?.project.status).toBe("proposed");
  });
  it("does not infer authorization from vague or conditional prose", async () => {
    const f = await fixture();
    f.message.text = "可以吗？如果大家同意的话应该可以";
    expect(await f.feedback.accept(reference)).toEqual({ status: "clarify" });
    expect((await f.state())?.project.status).toBe("proposed");
  });
  it("rejects an edited replay of an already-applied message", async () => {
    const f = await fixture();
    await f.feedback.accept(reference);
    f.message.text = "需要修改：改变范围";
    await expect(f.feedback.accept(reference)).rejects.toThrow("Idempotency");
    expect((await f.state())?.project.status).toBe("active");
  });
  it("does not approve a stale card after the proposal has changed", async () => {
    const f = await fixture();
    await f.loop.execute(f.agent, {
      operation: "project.revise_proposal",
      projectId: "camp",
      eventId: "revision",
      brief: "Changed scope",
      expectedRevision: 1,
      dueAt: 1000,
    });
    expect(await f.feedback.accept(reference)).toEqual({ status: "stale" });
    expect((await f.state())?.project.status).toBe("proposed");
    expect((await f.state())?.project.revision).toBe(2);
  });
  it("requires an actual request-delivery receipt before approval", async () => {
    const f = await fixture();
    await f.loop.store.transact("camp", async (snapshot) => {
      if (!snapshot?.project.requests[f.request.id]) throw new Error("No request");
      delete snapshot.project.requests[f.request.id]?.receipt;
      return { snapshot, result: undefined };
    });
    f.message.text = `#确认:${f.request.id} 批准`;
    expect(await f.feedback.accept(reference)).toEqual({ status: "clarify" });
    expect((await f.state())?.project.status).toBe("proposed");
  });
  it("keeps unrelated messages out of the approval path", async () => {
    const f = await fixture();
    f.message.parentId = undefined;
    f.message.text = "我们还需要准备另一场活动";
    expect(await f.feedback.accept(reference)).toEqual({ status: "unmatched" });
    expect((await f.state())?.events).toHaveLength(1);
  });
});
