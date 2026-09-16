import type { DirectImMessageDeliveryRequest, RuntimeImSteerRequest } from "@opentag/shared";
import type { ClientLogger } from "../observability/logger.js";

export interface FeishuReactionAuth {
  readonly token: string;
  readonly teamBrand: "feishu" | "lark";
}

type Delivery = DirectImMessageDeliveryRequest | RuntimeImSteerRequest;
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
    const task = this.#track(ref.messageId);
    this.#pending.set(ref.messageId, task);
  }

  async finish(outcome: Outcome): Promise<void> {
    if (!this.#outcome) {
      this.#outcome = outcome;
      this.#resolveFinished(outcome);
    }
    await Promise.all(this.#pending.values());
  }

  async #track(messageId: string): Promise<void> {
    // A steer can be accepted while completion is racing; do not leave a late OnIt behind.
    const processing = this.#outcome ? undefined : await this.#request(messageId, "POST", "OnIt");
    const outcome = await this.#finished;
    if (processing) await this.#request(messageId, "DELETE", processing);
    await this.#request(messageId, "POST", outcome === "completed" ? "DONE" : "ERROR");
  }

  async #request(messageId: string, method: "POST" | "DELETE", value: string): Promise<string | undefined> {
    const host = this.#auth.teamBrand === "lark" ? "open.larksuite.com" : "open.feishu.cn";
    const path = `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`;
    try {
      const response = await this.#fetch(
        `https://${host}${path}${method === "DELETE" ? `/${encodeURIComponent(value)}` : ""}`,
        {
          method,
          redirect: "error",
          headers: { Authorization: `Bearer ${this.#auth.token}`, "Content-Type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify({ reaction_type: { emoji_type: value } }) } : {}),
          signal: AbortSignal.timeout(3000),
        },
      );
      const result = (await response.json()) as { code?: number; data?: { reaction_id?: string } };
      if (!response.ok || result.code !== 0) {
        this.#logger.warn({ messageId, method, status: response.status, code: result.code }, "Turn reaction failed");
        return undefined;
      }
      this.#logger.info({ messageId, method, ...(method === "POST" ? { emoji: value } : {}) }, "Turn reaction updated");
      return result.data?.reaction_id;
    } catch {
      // Never log response bodies or exceptions: they can contain authentication material.
      this.#logger.warn({ messageId, method }, "Turn reaction unavailable");
      return undefined;
    }
  }
}
