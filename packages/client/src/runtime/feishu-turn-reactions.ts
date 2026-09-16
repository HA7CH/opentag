import type { DirectImMessageDeliveryRequest, RuntimeImSteerRequest } from "@opentag/shared";
import type { ClientLogger } from "../observability/logger.js";

export interface FeishuReactionAuth {
  readonly token: string;
  readonly teamBrand: "feishu" | "lark";
}

type Delivery = DirectImMessageDeliveryRequest | RuntimeImSteerRequest;
type FeishuReference = Extract<Delivery["content"]["providerRef"], { provider: "feishu" }>;
interface ReactionData {
  reaction_id?: string;
  items?: Array<{
    reaction_id?: string;
    action_time?: string;
    operator?: { operator_id?: string; operator_type?: string };
    reaction_type?: { emoji_type?: string };
  }>;
  has_more?: boolean;
  page_token?: string;
}

type Outcome = "completed" | "failed" | "cancelled" | "unknown";

/** Best-effort UI feedback; never makes a model turn depend on provider availability. */
export class FeishuTurnReactions {
  readonly #pending = new Map<string, Promise<void>>();
  readonly #auth: FeishuReactionAuth;
  readonly #logger: Pick<ClientLogger, "warn" | "info">;
  readonly #fetch: typeof fetch;
  #outcome?: Outcome;
  #resolveFinished!: (outcome: Outcome) => void;
  readonly #finished = new Promise<Outcome>((resolve) => {
    this.#resolveFinished = resolve;
  });

  constructor(auth: FeishuReactionAuth, logger: Pick<ClientLogger, "warn" | "info">, request = fetch) {
    this.#auth = auth;
    this.#logger = logger;
    this.#fetch = request;
  }

  start(request: Delivery): void {
    const ref = request.content.providerRef;
    // Observer copies must never mutate the provider. Deduplicate steered deliveries too.
    if (ref.provider !== "feishu" || request.replyRole === "observer" || this.#pending.has(ref.messageId)) return;
    const task = this.#track(ref, Date.now());
    this.#pending.set(ref.messageId, task);
  }

  async finish(outcome: Outcome): Promise<void> {
    if (!this.#outcome) {
      this.#outcome = outcome;
      this.#resolveFinished(outcome);
    }
    await Promise.all(this.#pending.values());
  }

  async #track(ref: FeishuReference, registeredAt: number): Promise<void> {
    // Receipt is not acceptance. The model explicitly accepts work through native OnIt.
    const outcome = await this.#finished;
    const processing = await this.#ownedProcessing(ref, registeredAt);
    if (!processing) return;
    await this.#request(ref.messageId, "DELETE", processing);
    await this.#request(ref.messageId, "POST", outcome === "completed" ? "DONE" : "ERROR");
  }

  async #ownedProcessing(ref: FeishuReference, registeredAt: number): Promise<string | undefined> {
    let pageToken = "";
    // Bound provider work even in unusually large groups. Never remove another actor's reaction.
    for (let page = 0; page < 3; page++) {
      const data = await this.#request(ref.messageId, "GET", pageToken);
      const own = data?.items?.find(
        (item) =>
          item.reaction_type?.emoji_type === "OnIt" &&
          item.operator?.operator_type === "app" &&
          [ref.appId, ref.botOpenId].includes(item.operator?.operator_id ?? "") &&
          Number(item.action_time) >= registeredAt - 2000,
      );
      if (own?.reaction_id) return own.reaction_id;
      if (!data?.has_more || !data.page_token) return undefined;
      pageToken = data.page_token;
    }
    return undefined;
  }

  async #request(
    messageId: string,
    method: "POST" | "DELETE" | "GET",
    value: string,
  ): Promise<ReactionData | undefined> {
    const host = this.#auth.teamBrand === "lark" ? "open.larksuite.com" : "open.feishu.cn";
    const path = `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`;
    const suffix =
      method === "DELETE"
        ? `/${encodeURIComponent(value)}`
        : method === "GET"
          ? `?reaction_type=OnIt&page_size=100${value ? `&page_token=${encodeURIComponent(value)}` : ""}`
          : "";
    try {
      const response = await this.#fetch(`https://${host}${path}${suffix}`, {
        method,
        redirect: "error",
        headers: { Authorization: `Bearer ${this.#auth.token}`, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ reaction_type: { emoji_type: value } }) } : {}),
        signal: AbortSignal.timeout(3000),
      });
      const result = (await response.json()) as { code?: number; data?: { reaction_id?: string } };
      if (!response.ok || result.code !== 0) {
        this.#logger.warn({ messageId, method, status: response.status, code: result.code }, "Turn reaction failed");
        return undefined;
      }
      if (method !== "GET")
        this.#logger.info(
          { messageId, method, ...(method === "POST" ? { emoji: value } : {}) },
          "Turn reaction updated",
        );
      return result.data;
    } catch {
      // Never log response bodies or exceptions: they can contain authentication material.
      this.#logger.warn({ messageId, method }, "Turn reaction unavailable");
      return undefined;
    }
  }
}
