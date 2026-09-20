import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { ensurePrivateDirectory, readDurableJson, writeDurableJson } from "../storage/durable-file.js";
import { AncDeferred, AncSafeRetry } from "./effect-runner.js";
import { AncFileStore } from "./store.js";

const ExternalId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Target = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat_id"), id: ExternalId }),
  z.object({ type: z.literal("open_id"), id: ExternalId }),
]);
const Reference = z.object({ appId: ExternalId, chatId: ExternalId, messageId: ExternalId });
const Message = z.object({
  message_id: ExternalId,
  chat_id: ExternalId,
  deleted: z.boolean(),
  msg_type: z.string(),
  parent_id: z.string().optional(),
  root_id: z.string().optional(),
  sender: z.object({
    id: ExternalId,
    id_type: z.string(),
    sender_type: z.string(),
    tenant_key: ExternalId,
  }),
  body: z.object({ content: z.string() }),
});
const Envelope = z.object({ code: z.number().int(), data: z.unknown().optional() });
const Sent = z.object({ message_id: ExternalId, chat_id: ExternalId });
const Ledger = z.object({
  digest: z.string(),
  status: z.enum(["sending", "sent", "retryable", "rejected"]),
  attempts: z.number().int().nonnegative(),
  messageId: ExternalId.optional(),
  chatId: ExternalId.optional(),
});
export const AncFeishuScopeSchema = z.object({
  appId: ExternalId,
  tenantKey: ExternalId,
  brand: z.enum(["feishu", "lark"]),
  chatIds: z.array(ExternalId).min(1),
  humanIds: z.array(ExternalId).min(1),
});
export type AncFeishuScope = z.infer<typeof AncFeishuScopeSchema>;
export type AncFeishuReference = z.infer<typeof Reference>;
export type AncFeishuTarget = z.infer<typeof Target>;
export interface AncFeishuGatewayOptions {
  readonly directory: string;
  readonly scope: AncFeishuScope;
  /** Obtain an existing bound-session grant; never log or persist the token. */
  readonly credential: () => Promise<{ appId: string; brand: "feishu" | "lark"; token: string }>;
  readonly fetch?: typeof fetch;
}

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Narrow pilot transport. It is not a second event listener and does not read history.
 * Ingress identity is verified against the exact provider message, not model prose.
 */
export class AncFeishuGateway {
  readonly #scope: AncFeishuScope;
  readonly #locks: AncFileStore;
  readonly #fetch: typeof fetch;
  constructor(readonly options: AncFeishuGatewayOptions) {
    this.#scope = AncFeishuScopeSchema.parse(options.scope);
    this.#locks = new AncFileStore(join(options.directory, "locks"));
    this.#fetch = options.fetch ?? fetch;
  }

  private async headers(): Promise<Record<string, string>> {
    const grant = await this.options.credential();
    if (grant.appId !== this.#scope.appId || grant.brand !== this.#scope.brand || !grant.token)
      throw new Error("Feishu credential scope mismatch");
    return { Authorization: `Bearer ${grant.token}`, "Content-Type": "application/json; charset=utf-8" };
  }

  private url(path: string): string {
    const host = this.#scope.brand === "feishu" ? "open.feishu.cn" : "open.larksuite.com";
    return `https://${host}/open-apis/im/v1/${path}`;
  }

  private allowedTarget(input: AncFeishuTarget): AncFeishuTarget {
    const target = Target.parse(input);
    const allowed = target.type === "chat_id" ? this.#scope.chatIds : this.#scope.humanIds;
    if (!allowed.includes(target.id)) throw new Error("Destination is outside the ANC pilot");
    return target;
  }

  async verifyHuman(reference: AncFeishuReference, signal?: AbortSignal) {
    const ref = Reference.parse(reference);
    if (ref.appId !== this.#scope.appId || !this.#scope.chatIds.includes(ref.chatId))
      throw new Error("Inbound message is outside the ANC pilot");
    const response = await this.#fetch(this.url(`messages/${ref.messageId}?user_id_type=open_id`), {
      headers: await this.headers(),
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
    });
    const result = Envelope.parse(await response.json());
    if (!response.ok || result.code !== 0) throw new Error("Cannot verify the Feishu message");
    const data = z.object({ items: z.array(z.unknown()) }).parse(result.data);
    const message = data.items
      .map((item) => Message.safeParse(item))
      .find((item) => item.success && item.data.message_id === ref.messageId);
    if (!message?.success) throw new Error("The exact Feishu message was not returned");
    this.validateHuman(message.data, ref);
    // Only current, verified plain text is accepted as approval input. Forwarded children are not approvals.
    if (message.data.msg_type !== "text") throw new Error("Approval feedback must be a plain-text message");
    const body = z.object({ text: z.string().trim().min(1).max(16000) }).parse(JSON.parse(message.data.body.content));
    return {
      actorId: message.data.sender.id,
      appId: ref.appId,
      tenantKey: this.#scope.tenantKey,
      chatId: ref.chatId,
      messageId: ref.messageId,
      parentId: message.data.parent_id,
      text: body.text,
    };
  }

  private validateHuman(message: z.infer<typeof Message>, ref: AncFeishuReference): void {
    const sender = message.sender;
    if (message.deleted || message.chat_id !== ref.chatId) throw new Error("Deleted or wrong-chat feedback");
    if (sender.sender_type !== "user" || sender.id_type !== "open_id") throw new Error("Feedback is not from a human");
    if (sender.tenant_key !== this.#scope.tenantKey || !this.#scope.humanIds.includes(sender.id))
      throw new Error("Human is outside the ANC pilot");
  }

  private ledgerPath(id: string): string {
    return join(
      this.options.directory,
      `${sha([this.#scope.appId, this.#scope.brand, this.#scope.tenantKey, id])}.json`,
    );
  }

  async lookup(deliveryId: string): Promise<string | undefined> {
    const record = await readDurableJson(this.ledgerPath(deliveryId), (value) => Ledger.parse(value));
    return record?.status === "sent" ? record.messageId : undefined;
  }

  async sendText(deliveryId: string, input: AncFeishuTarget, text: string, signal?: AbortSignal): Promise<string> {
    const target = this.allowedTarget(input);
    ExternalId.parse(deliveryId);
    if (!text.trim() || Buffer.byteLength(text, "utf8") > 16000) throw new Error("Invalid short message");
    await ensurePrivateDirectory(this.options.directory, this.options.directory);
    await this.#locks.initialize();
    return this.#locks.lock(sha(deliveryId), () => this.sendLocked(deliveryId, target, text, signal));
  }

  private async sendLocked(id: string, target: AncFeishuTarget, text: string, signal?: AbortSignal): Promise<string> {
    const path = this.ledgerPath(id);
    const digest = sha({ scope: this.#scope.appId, target, text });
    const previous = await readDurableJson(path, (value) => Ledger.parse(value));
    if (previous && previous.digest !== digest) throw new Error("Delivery ID reused with different content");
    if (previous?.status === "sent" && previous.messageId) return previous.messageId;
    if (previous?.status === "sending")
      throw new AncDeferred("Reconcile the previous send; never repeat an unknown outcome");
    if (previous?.status === "rejected" || (previous?.attempts ?? 0) >= 3)
      throw new Error("Feishu delivery is blocked");
    const headers = await this.headers();
    signal?.throwIfAborted();
    const record: z.infer<typeof Ledger> = { digest, status: "sending", attempts: (previous?.attempts ?? 0) + 1 };
    await writeDurableJson(path, record);
    // Persist before POST. A timeout, redirect, malformed reply, or lost receipt leaves "sending".
    const response = await this.#fetch(this.url(`messages?receive_id_type=${target.type}`), {
      method: "POST",
      headers,
      redirect: "error",
      body: JSON.stringify({
        receive_id: target.id,
        msg_type: "text",
        content: JSON.stringify({ text }),
        uuid: `anc_${sha(id).slice(0, 40)}`,
      }),
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
    });
    return this.recordResponse(response, path, record, target);
  }

  private async recordResponse(
    response: Response,
    path: string,
    record: z.infer<typeof Ledger>,
    target: AncFeishuTarget,
  ): Promise<string> {
    const result = Envelope.parse(await response.json());
    if (result.code === 230020 && response.status < 500) {
      record.status = "retryable";
      await writeDurableJson(path, record);
      throw new AncSafeRetry("Feishu rate limit rejected the send");
    }
    if (!response.ok || result.code !== 0) {
      if (response.status < 500 && result.code !== 230049) {
        record.status = "rejected";
        await writeDurableJson(path, record);
      }
      throw new Error("Feishu send failed or its outcome is unknown");
    }
    const sent = Sent.parse(result.data);
    if (target.type === "chat_id" && sent.chat_id !== target.id) throw new Error("Feishu receipt destination mismatch");
    record.status = "sent";
    record.messageId = sent.message_id;
    record.chatId = sent.chat_id;
    await writeDurableJson(path, record);
    return sent.message_id;
  }
}
