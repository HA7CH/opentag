import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AncDeferred, AncSafeRetry } from "../anc/effect-runner.js";
import { AncFeishuGateway } from "../anc/feishu-gateway.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const scope = {
  appId: "cli_pilot",
  tenantKey: "tenant_pilot",
  brand: "feishu" as const,
  chatIds: ["oc_pilot"],
  humanIds: ["ou_reviewer"],
};
const ref = { appId: "cli_pilot", chatId: "oc_pilot", messageId: "om_approval" };
const target = { type: "chat_id" as const, id: "oc_pilot" };
function message() {
  return {
    message_id: "om_approval",
    chat_id: "oc_pilot",
    deleted: false,
    msg_type: "text",
    parent_id: "om_request",
    sender: { id: "ou_reviewer", id_type: "open_id", sender_type: "user", tenant_key: "tenant_pilot" },
    body: { content: JSON.stringify({ text: "Approved for the displayed version." }) },
  };
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "anc-feishu-"));
  directories.push(directory);
  const fetcher = vi.fn<typeof fetch>(async () =>
    json({ code: 0, data: { message_id: "om_sent", chat_id: "oc_pilot" } }),
  );
  const credential = vi.fn(async () => ({
    appId: "cli_pilot",
    brand: "feishu" as const,
    token: "fixture-private-token",
  }));
  const options = { directory, scope, credential, fetch: fetcher };
  return { directory, fetcher, credential, options, gateway: new AncFeishuGateway(options) };
}

describe("ANC Feishu pilot identity and receipt boundary", () => {
  it("verifies only the exact provider message and preserves the quoted request anchor", async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValue(json({ code: 0, data: { items: [message()] } }));
    expect(await f.gateway.verifyHuman(ref)).toMatchObject({
      actorId: "ou_reviewer",
      chatId: "oc_pilot",
      messageId: "om_approval",
      parentId: "om_request",
      text: "Approved for the displayed version.",
    });
    expect(f.fetcher).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_approval?user_id_type=open_id",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("rejects unconfigured apps, chats, and outbound targets before requesting a token", async () => {
    const f = await fixture();
    await expect(f.gateway.verifyHuman({ ...ref, appId: "cli_other" })).rejects.toThrow("outside");
    await expect(f.gateway.verifyHuman({ ...ref, chatId: "oc_private" })).rejects.toThrow("outside");
    await expect(f.gateway.sendText("delivery", { type: "open_id", id: "ou_other" }, "test")).rejects.toThrow(
      "outside",
    );
    expect(f.credential).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["bot", "tenant", "other_person", "deleted", "wrong_chat", "forwarded_child", "non_text"])(
    "does not treat %s as an authenticated human approval",
    async (variant) => {
      const f = await fixture();
      const item = message();
      if (variant === "bot") item.sender.sender_type = "app";
      if (variant === "tenant") item.sender.tenant_key = "tenant_other";
      if (variant === "other_person") item.sender.id = "ou_other";
      if (variant === "deleted") item.deleted = true;
      if (variant === "wrong_chat") item.chat_id = "oc_private";
      if (variant === "forwarded_child") item.message_id = "om_child";
      if (variant === "non_text") item.msg_type = "merge_forward";
      f.fetcher.mockResolvedValue(json({ code: 0, data: { items: [item] } }));
      await expect(f.gateway.verifyHuman(ref)).rejects.toThrow();
    },
  );

  it("rejects a credential grant for a different application", async () => {
    const f = await fixture();
    f.credential.mockResolvedValue({ appId: "cli_other", brand: "feishu", token: "fixture-private-token" });
    await expect(f.gateway.verifyHuman(ref)).rejects.toThrow("credential scope mismatch");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("persists before POST, reuses the same receipt after restart, and never stores tokens", async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async (_url, init) => {
      const files = (await readdir(f.directory)).filter((name) => name.endsWith(".json"));
      expect(files).toHaveLength(1);
      const ledger = JSON.parse(await readFile(join(f.directory, files[0] ?? ""), "utf8"));
      expect(ledger.status).toBe("sending");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ receive_id: "oc_pilot", msg_type: "text" });
      expect(body.uuid.length).toBeLessThanOrEqual(50);
      return json({ code: 0, data: { message_id: "om_sent", chat_id: "oc_pilot" } });
    });
    expect(await f.gateway.sendText("delivery", target, "Test outcome")).toBe("om_sent");
    const restored = new AncFeishuGateway(f.options);
    expect(await restored.sendText("delivery", target, "Test outcome")).toBe("om_sent");
    expect(await restored.lookup("delivery")).toBe("om_sent");
    await expect(restored.sendText("delivery", target, "Changed outcome")).rejects.toThrow("reused");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const files = (await readdir(f.directory)).filter((name) => name.endsWith(".json"));
    const saved = await readFile(join(f.directory, files[0] ?? ""), "utf8");
    expect(saved).not.toContain("fixture-private-token");
    expect(saved).not.toContain("Test outcome");
    const other = new AncFeishuGateway({ ...f.options, scope: { ...scope, appId: "cli_other" } });
    expect(await other.lookup("delivery")).toBeUndefined();
  });

  it("leaves a lost POST response unresolved across restarts instead of sending again", async () => {
    const f = await fixture();
    f.fetcher.mockRejectedValue(new Error("timeout after send"));
    await expect(f.gateway.sendText("lost", target, "Test outcome")).rejects.toThrow("timeout");
    const restored = new AncFeishuGateway(f.options);
    await expect(restored.sendText("lost", target, "Test outcome")).rejects.toBeInstanceOf(AncDeferred);
    expect(await restored.lookup("lost")).toBeUndefined();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries only an explicit rate-limit rejection with the same idempotency key", async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(json({ code: 230020 }, 400));
    await expect(f.gateway.sendText("rate-limited", target, "Test")).rejects.toBeInstanceOf(AncSafeRetry);
    expect(await f.gateway.sendText("rate-limited", target, "Test")).toBe("om_sent");
    const keys = f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).uuid);
    expect(new Set(keys).size).toBe(1);
  });

  it("does not retry denied sends or in-flight responses", async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(json({ code: 230027 }, 400));
    await expect(f.gateway.sendText("denied", target, "Test")).rejects.toThrow("failed");
    await expect(f.gateway.sendText("denied", target, "Test")).rejects.toThrow("blocked");
    f.fetcher.mockResolvedValueOnce(json({ code: 230049 }, 400));
    await expect(f.gateway.sendText("in-flight", target, "Test")).rejects.toThrow("unknown");
    await expect(f.gateway.sendText("in-flight", target, "Test")).rejects.toBeInstanceOf(AncDeferred);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not accept a receipt from a different destination", async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValue(json({ code: 0, data: { message_id: "om_wrong", chat_id: "oc_wrong" } }));
    await expect(f.gateway.sendText("wrong-receipt", target, "Test")).rejects.toThrow("destination mismatch");
    expect(await f.gateway.lookup("wrong-receipt")).toBeUndefined();
  });
});

function card(content = "Working") {
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    body: { elements: [{ tag: "markdown", content }] },
  };
}
function ownCard(content = card()) {
  return {
    ...message(),
    message_id: "om_sent",
    msg_type: "interactive",
    sender: { id: "cli_pilot", id_type: "app_id", sender_type: "app", tenant_key: "tenant_pilot" },
    body: { content: JSON.stringify(content) },
  };
}
async function receipt(directory: string) {
  const file = (await readdir(directory)).find((name) => name.endsWith(".json"));
  if (!file) throw new Error("No receipt");
  return JSON.parse(await readFile(join(directory, file), "utf8"));
}

describe("ANC Feishu card delivery and revision safety", () => {
  it("sends a Card 2.0 payload directly into the chat and reuses its durable receipt", async () => {
    const f = await fixture();
    expect(await f.gateway.sendCard("card", target, card())).toBe("om_sent");
    const payload = JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({ receive_id: "oc_pilot", msg_type: "interactive" });
    expect(JSON.parse(payload.content)).toEqual(card());
    expect(payload).not.toHaveProperty("reply_in_thread");
    expect(await new AncFeishuGateway(f.options).sendCard("card", target, card())).toBe("om_sent");
    await expect(f.gateway.sendText("card", target, "Changed")).rejects.toThrow("reused");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const saved = await receipt(f.directory);
    expect(saved).toMatchObject({ msgType: "interactive", target });
    expect(JSON.stringify(saved)).not.toContain("Working");
  });

  it("validates cards and destinations before making a send", async () => {
    const f = await fixture();
    await expect(f.gateway.sendCard("card", target, { schema: "2.0", config: {} })).rejects.toThrow();
    await expect(f.gateway.sendCard("card", target, card("中".repeat(20000)))).rejects.toThrow("budget");
    await expect(f.gateway.sendCard("card", { type: "open_id", id: "ou_other" }, card())).rejects.toThrow("outside");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.credential).not.toHaveBeenCalled();
  });

  it("persists each revision before PATCH and never replays or overwrites an older revision", async () => {
    const f = await fixture();
    await f.gateway.sendCard("card", target, card());
    f.fetcher.mockImplementation(async (url, init) => {
      expect(String(url).endsWith("/messages/om_sent")).toBe(true);
      expect(init?.method).toBe("PATCH");
      expect((await receipt(f.directory)).update).toMatchObject({ revision: 1, status: "sending" });
      expect(JSON.parse(String(init?.body))).toEqual({ content: JSON.stringify(card("Answer")) });
      return json({ code: 0, data: {} });
    });
    expect(await f.gateway.updateCard("card", 1, card("Answer"))).toBe("om_sent");
    const restored = new AncFeishuGateway(f.options);
    expect(await restored.updateCard("card", 1, card("Answer"))).toBe("om_sent");
    await expect(restored.updateCard("card", 1, card("Changed"))).rejects.toThrow("reused");
    await expect(restored.updateCard("card", 3, card("Skipped"))).rejects.toThrow("consecutive");
    f.fetcher.mockResolvedValue(json({ code: 0, data: {} }));
    await restored.updateCard("card", 2, card("Final"));
    await expect(restored.updateCard("card", 1, card("Answer"))).rejects.toThrow("Stale");
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it("acknowledges an unchanged body without sending an unnecessary PATCH", async () => {
    const f = await fixture();
    await f.gateway.sendCard("card", target, card());
    expect(await f.gateway.updateCard("card", 1, card())).toBe("om_sent");
    expect((await receipt(f.directory)).update).toMatchObject({ revision: 1, attempts: 0, status: "sent" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("reconciles a lost PATCH response by exact original card content before advancing", async () => {
    const f = await fixture();
    await f.gateway.sendCard("card", target, card());
    f.fetcher.mockRejectedValueOnce(new Error("lost update response"));
    await expect(f.gateway.updateCard("card", 1, card("Answer"))).rejects.toThrow("lost");
    const restored = new AncFeishuGateway(f.options);
    await expect(restored.updateCard("card", 2, card("Later"))).rejects.toBeInstanceOf(AncDeferred);
    f.fetcher.mockResolvedValueOnce(json({ code: 0, data: { items: [ownCard(card("Answer"))] } }));
    expect(await restored.reconcileCard("card", 1)).toBe("om_sent");
    expect(String(f.fetcher.mock.calls[2]?.[0])).toContain("card_msg_content_type=user_card_content");
    expect(await restored.reconcileCard("card", 1)).toBe("om_sent");
    f.fetcher.mockResolvedValue(json({ code: 0, data: {} }));
    expect(await restored.updateCard("card", 2, card("Later"))).toBe("om_sent");
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not infer permission to resend after three unsuccessful lookups", async () => {
    const f = await fixture();
    await f.gateway.sendCard("card", target, card());
    f.fetcher.mockRejectedValueOnce(new Error("timeout"));
    await expect(f.gateway.updateCard("card", 1, card("Answer"))).rejects.toThrow("timeout");
    f.fetcher.mockImplementation(async () => json({ code: 0, data: { items: [ownCard()] } }));
    for (let i = 0; i < 5; i++) expect(await f.gateway.reconcileCard("card", 1)).toBeUndefined();
    await expect(f.gateway.updateCard("card", 1, card("Answer"))).rejects.toBeInstanceOf(AncDeferred);
    expect(f.fetcher).toHaveBeenCalledTimes(5);
    expect((await receipt(f.directory)).update).toMatchObject({ status: "sending", reconciliations: 3 });
  });

  it.each(["wrong_id", "wrong_chat", "deleted", "other_app", "other_tenant", "user", "text"])(
    "rejects %s when reconciling a card",
    async (variant) => {
      const f = await fixture();
      await f.gateway.sendCard("card", target, card());
      f.fetcher.mockRejectedValueOnce(new Error("timeout"));
      await expect(f.gateway.updateCard("card", 1, card("Answer"))).rejects.toThrow();
      const item = ownCard(card("Answer"));
      if (variant === "wrong_id") item.message_id = "om_other";
      if (variant === "wrong_chat") item.chat_id = "oc_other";
      if (variant === "deleted") item.deleted = true;
      if (variant === "other_app") item.sender.id = "cli_other";
      if (variant === "other_tenant") item.sender.tenant_key = "other";
      if (variant === "user") item.sender.sender_type = "user";
      if (variant === "text") item.msg_type = "text";
      f.fetcher.mockResolvedValue(json({ code: 0, data: { items: [item] } }));
      await expect(f.gateway.reconcileCard("card", 1)).rejects.toThrow();
      expect((await receipt(f.directory)).update.status).toBe("sending");
    },
  );

  it("retries only explicit rate rejection, at most three times, on the same revision", async () => {
    const f = await fixture();
    await f.gateway.sendCard("card", target, card());
    f.fetcher.mockImplementation(async () => json({ code: 230020 }, 400));
    for (let i = 0; i < 3; i++)
      await expect(f.gateway.updateCard("card", 1, card("Answer"))).rejects.toBeInstanceOf(AncSafeRetry);
    await expect(f.gateway.updateCard("card", 1, card("Answer"))).rejects.toThrow("budget");
    await expect(f.gateway.updateCard("card", 2, card("Other"))).rejects.toBeInstanceOf(AncDeferred);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not update text messages, unknown sends, or an expired permission scope", async () => {
    const f = await fixture();
    await f.gateway.sendText("text", target, "Text");
    await expect(f.gateway.updateCard("text", 1, card())).rejects.toThrow("receipted");
    await expect(f.gateway.updateCard("missing", 1, card())).rejects.toThrow("Unknown");
    expect(await f.gateway.reconcileCard("missing", 1)).toBeUndefined();
    await f.gateway.sendCard("card", target, card());
    const restricted = new AncFeishuGateway({ ...f.options, scope: { ...scope, chatIds: ["oc_other"] } });
    await expect(restricted.updateCard("card", 1, card("Answer"))).rejects.toThrow("outside");
    await expect(restricted.reconcileCard("card", 1)).rejects.toThrow("outside");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("blocks permission failures and uncertain server responses without creating another card", async () => {
    const f = await fixture();
    await f.gateway.sendCard("card", target, card());
    f.fetcher.mockResolvedValueOnce(json({ code: 230027 }, 400));
    await expect(f.gateway.updateCard("card", 1, card("Answer"))).rejects.toThrow("failed");
    await expect(f.gateway.updateCard("card", 2, card("Later"))).rejects.toThrow("blocked");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not mark an update in flight when credential retrieval fails before dispatch", async () => {
    const f = await fixture();
    await f.gateway.sendCard("card", target, card());
    f.credential.mockRejectedValueOnce(new Error("grant unavailable"));
    await expect(f.gateway.updateCard("card", 1, card("Answer"))).rejects.toThrow("grant");
    expect((await receipt(f.directory)).update).toBeUndefined();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});
