import type { DirectImMessageDeliveryRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { FeishuTurnReactions } from "../runtime/feishu-turn-reactions.js";

const delivery = (messageId = "om-test", replyRole = "owner", provider = "feishu") =>
  ({
    replyRole,
    attention: "ambient",
    content: { providerRef: { provider, messageId, appId: "cli-bot", botOpenId: "ou-bot" } },
  }) as DirectImMessageDeliveryRequest;
const auth = { token: "test-secret", teamBrand: "feishu" as const };
const claim = (operator = "cli-bot", actionTime = Date.now()) => ({
  reaction_id: "owned-claim",
  action_time: String(actionTime),
  operator: { operator_id: operator, operator_type: "app" },
  reaction_type: { emoji_type: "OnIt" },
});
const envelope = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
function fixture(items: unknown[] = []) {
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, options) =>
      envelope(options?.method === "GET" ? { items } : { reaction_id: "terminal" }),
    );
  const log = { warn: vi.fn(), info: vi.fn() };
  return { request, log, reactions: new FeishuTurnReactions(auth, log, request) };
}

describe("intent-driven Feishu turn reactions", () => {
  it("does not react to receipt or silently processed ambient messages", async () => {
    const { reactions, request } = fixture();
    reactions.start(delivery());
    expect(request).not.toHaveBeenCalled();
    await reactions.finish("completed");
    expect(request.mock.calls.map(([, options]) => options?.method)).toEqual(["GET"]);
    expect(new URL(String(request.mock.calls[0]?.[0])).searchParams.get("page_size")).toBe("50");
  });

  it("finalizes only a claim made by this bot after it decided to handle a message", async () => {
    const { reactions, request } = fixture([claim()]);
    reactions.start(delivery());
    await reactions.finish("completed");
    expect(request.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "DELETE", "POST"]);
    expect(request.mock.calls[1]?.[0]).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om-test/reactions/owned-claim",
    );
    expect(JSON.parse(request.mock.calls[2]?.[1]?.body as string).reaction_type.emoji_type).toBe("DONE");
  });

  it("leaves other actors, old claims, and non-processing reactions alone", async () => {
    const { reactions, request } = fixture([
      claim("other-bot"),
      claim("cli-bot", Date.now() - 60000),
      { ...claim(), operator: { operator_id: "cli-bot", operator_type: "user" } },
      { ...claim(), reaction_type: { emoji_type: "DONE" } },
    ]);
    reactions.start(delivery());
    await reactions.finish("completed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("deduplicates steered messages and excludes observer/Slack copies", async () => {
    const { reactions, request } = fixture();
    reactions.start(delivery("root"));
    reactions.start(delivery("root"));
    reactions.start(delivery("steer"));
    reactions.start(delivery("observer", "observer"));
    reactions.start(delivery("slack", "owner", "slack"));
    await reactions.finish("completed");
    await reactions.finish("failed");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["failed", "cancelled", "unknown"] as const)(
    "marks %s only for messages actually claimed",
    async (outcome) => {
      const { reactions, request } = fixture([claim("ou-bot")]);
      reactions.start(delivery());
      await reactions.finish(outcome);
      expect(JSON.parse(request.mock.calls.at(-1)?.[1]?.body as string).reaction_type.emoji_type).toBe("ERROR");
      const untouched = fixture();
      untouched.reactions.start(delivery());
      await untouched.reactions.finish(outcome);
      expect(untouched.request).toHaveBeenCalledTimes(1);
    },
  );

  it("finds its own claim on a later page without deleting earlier actors", async () => {
    const { reactions, request } = fixture([claim()]);
    request.mockResolvedValueOnce(envelope({ items: [claim("other-bot")], has_more: true, page_token: "next page" }));
    reactions.start(delivery());
    await reactions.finish("completed");
    expect(String(request.mock.calls[1]?.[0])).toContain("page_token=next%20page");
    expect(request.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "GET", "DELETE", "POST"]);
  });

  it("bounds pagination and does not fabricate completion after an API failure", async () => {
    const { reactions, request, log } = fixture();
    request.mockRejectedValueOnce(new Error("test-secret"));
    reactions.start(delivery());
    await reactions.finish("failed");
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("test-secret");
    const pages = fixture();
    pages.request.mockImplementation(async () => envelope({ items: [], has_more: true, page_token: "next" }));
    pages.reactions.start(delivery());
    await pages.reactions.finish("completed");
    expect(pages.request).toHaveBeenCalledTimes(3);
  });

  it("keeps Lark credentials on the Lark host with bounded, non-redirecting requests", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      expect(options?.redirect).toBe("error");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return envelope({ items: [] });
    });
    const reactions = new FeishuTurnReactions(
      { ...auth, teamBrand: "lark" },
      { warn: vi.fn(), info: vi.fn() },
      request,
    );
    reactions.start(delivery());
    await reactions.finish("completed");
    expect(String(request.mock.calls[0]?.[0])).toContain("https://open.larksuite.com/");
  });
});
