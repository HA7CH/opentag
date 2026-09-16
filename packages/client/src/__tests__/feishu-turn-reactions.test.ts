import type { DirectImMessageDeliveryRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { FeishuTurnReactions } from "../runtime/feishu-turn-reactions.js";

const delivery = (messageId = "om-test", replyRole = "owner", provider = "feishu") =>
  ({
    replyRole,
    content: { providerRef: { provider, messageId } },
  }) as DirectImMessageDeliveryRequest;
const auth = { token: "test-secret", teamBrand: "feishu" as const };
const logger = () => ({ warn: vi.fn(), info: vi.fn() });
const success = () => new Response(JSON.stringify({ code: 0, data: { reaction_id: "r-processing" } }));

function fixture() {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => success());
  const log = logger();
  return { request, log, reactions: new FeishuTurnReactions(auth, log, request) };
}

describe("Feishu turn reactions", () => {
  it("adds processing immediately, deletes only its own reaction, then marks completion", async () => {
    const { reactions, request } = fixture();
    reactions.start(delivery());
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).toEqual({ reaction_type: { emoji_type: "OnIt" } });
    await reactions.finish("completed");
    expect(request.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "DELETE", "POST"]);
    expect(request.mock.calls[1]?.[0]).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om-test/reactions/r-processing",
    );
    expect(JSON.parse(request.mock.calls[2]?.[1]?.body as string).reaction_type.emoji_type).toBe("DONE");
  });

  it("deduplicates root and steered messages and skips observer/Slack copies", async () => {
    const { reactions, request } = fixture();
    reactions.start(delivery("root"));
    reactions.start(delivery("root"));
    reactions.start(delivery("steer"));
    reactions.start(delivery("observer", "observer"));
    reactions.start(delivery("slack", "owner", "slack"));
    await reactions.finish("completed");
    expect(request).toHaveBeenCalledTimes(6);
    await reactions.finish("failed");
    expect(request).toHaveBeenCalledTimes(6);
  });

  it.each(["failed", "cancelled", "unknown"] as const)("does not show success for %s", async (outcome) => {
    const { reactions, request } = fixture();
    reactions.start(delivery());
    await reactions.finish(outcome);
    expect(JSON.parse(request.mock.calls.at(-1)?.[1]?.body as string).reaction_type.emoji_type).toBe("ERROR");
  });

  it("cleans a slow processing request even when the turn already finished", async () => {
    const { reactions, request } = fixture();
    let release!: (response: Response) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    reactions.start(delivery());
    const finishing = reactions.finish("completed");
    expect(request).toHaveBeenCalledTimes(1);
    release(success());
    await finishing;
    expect(request.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "DELETE", "POST"]);
    reactions.start(delivery("late-steer"));
    await reactions.finish("completed");
    expect(request).toHaveBeenCalledTimes(4);
    expect(JSON.parse(request.mock.calls[3]?.[1]?.body as string).reaction_type.emoji_type).toBe("DONE");
  });

  it("contains network and API failures without leaking credentials or deleting unknown reactions", async () => {
    const { reactions, request, log } = fixture();
    request.mockRejectedValueOnce(new Error("test-secret"));
    request.mockResolvedValueOnce(new Response(JSON.stringify({ code: 99991672, msg: "test-secret" })));
    reactions.start(delivery());
    await expect(reactions.finish("failed")).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("test-secret");
  });

  it("uses the Lark host with a bounded signal and disables redirects", async () => {
    const log = logger();
    const request = vi.fn<typeof fetch>().mockImplementation((_url, options) => {
      expect(options?.redirect).toBe("error");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(success());
    });
    const reactions = new FeishuTurnReactions({ ...auth, teamBrand: "lark" }, log, request);
    reactions.start(delivery());
    await reactions.finish("completed");
    expect(String(request.mock.calls[0]?.[0])).toContain("https://open.larksuite.com/");
  });
});
