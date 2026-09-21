import { createHash } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "../agent-runtime/types.js";
import { writeDurableJson } from "../storage/durable-file.js";
import { AncDeferred, AncSafeRetry } from "./effect-runner.js";

const ExternalId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Status = z.enum(["sending", "sent", "retryable", "rejected"]);
const Update = z.object({
  revision: z.number().int().positive(),
  digest: z.string(),
  status: Status,
  attempts: z.number().int().nonnegative(),
  reconciliations: z.number().int().nonnegative().default(0),
});
export const AncFeishuReceiptSchema = z.object({
  digest: z.string(),
  status: Status,
  attempts: z.number().int().nonnegative(),
  messageId: ExternalId.optional(),
  chatId: ExternalId.optional(),
  msgType: z.enum(["text", "interactive", "file"]).optional(),
  cardDigest: z.string().optional(),
  target: z.object({ type: z.enum(["chat_id", "open_id"]), id: ExternalId }).optional(),
  update: Update.optional(),
});
export type AncFeishuReceipt = z.infer<typeof AncFeishuReceiptSchema>;
export interface AncCardTransport {
  patch(messageId: string, content: string): Promise<Response>;
  /** Exact own-message lookup with sender, tenant and chat verified by the gateway. */
  read(messageId: string, chatId: string): Promise<string>;
}

function ordered(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key] ?? null)]),
    );
  return value;
}
export function ancCardDigest(value: JsonValue): string {
  return createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");
}
export function serializeAncCard(value: JsonValue): string {
  const card = z.json().parse(value);
  z.object({ schema: z.literal("2.0"), config: z.object({ update_multi: z.literal(true) }) }).parse(card);
  const content = JSON.stringify(card);
  // Leave headroom below the provider's 30 KB message limit.
  if (Buffer.byteLength(content, "utf8") > 28000) throw new Error("ANC card exceeds the preview budget");
  return content;
}

function requireCard(record: AncFeishuReceipt): { messageId: string; chatId: string } {
  if (record.status !== "sent" || record.msgType !== "interactive" || !record.messageId || !record.chatId)
    throw new Error("Only a receipted ANC card can be updated");
  return { messageId: record.messageId, chatId: record.chatId };
}
function nextUpdate(record: AncFeishuReceipt, revision: number, digest: string): z.infer<typeof Update> | undefined {
  const prior = record.update;
  if (prior && revision === prior.revision && digest !== prior.digest)
    throw new Error("Card revision reused with different content");
  if (prior && revision < prior.revision) throw new Error("Stale card revision");
  if (prior?.status === "sending") throw new AncDeferred("Reconcile the card update before any later write");
  if (prior?.status === "rejected") throw new Error("Card update is blocked");
  if (prior?.revision === revision) {
    if (prior.status === "sent") return undefined;
    if (prior.attempts >= 3) throw new Error("Card update retry budget exhausted");
    return { ...prior, status: "sending", attempts: prior.attempts + 1 };
  }
  if (prior && prior.status !== "sent") throw new AncDeferred("Complete the pending card revision first");
  if (revision !== (prior?.revision ?? 0) + 1) throw new Error("Card revision is not consecutive");
  return { revision, digest, status: "sending", attempts: 1, reconciliations: 0 };
}
async function acceptResponse(response: Response, path: string, record: AncFeishuReceipt): Promise<void> {
  const result = z.object({ code: z.number().int() }).parse(await response.json());
  const update = record.update;
  if (!update) throw new Error("Missing card update");
  if (response.ok && result.code === 0) {
    update.status = "sent";
    record.cardDigest = update.digest;
    await writeDurableJson(path, record);
    return;
  }
  if (result.code === 230020 && response.status < 500) {
    update.status = "retryable";
    await writeDurableJson(path, record);
    throw new AncSafeRetry("Feishu explicitly rejected the card update for rate limiting");
  }
  if (response.status < 500 && result.code !== 230049) {
    update.status = "rejected";
    await writeDurableJson(path, record);
  }
  throw new Error("Card update failed or its outcome is unknown");
}

/** The gateway must hold the same delivery lock across create, update and reconciliation. */
export async function updateAncFeishuCard(
  path: string,
  record: AncFeishuReceipt,
  revision: number,
  card: JsonValue,
  transport: AncCardTransport,
): Promise<string> {
  const { messageId } = requireCard(record);
  z.number().int().positive().parse(revision);
  const content = serializeAncCard(card);
  const digest = ancCardDigest(card);
  const update = nextUpdate(record, revision, digest);
  if (!update) return messageId;
  record.update = update;
  if (record.cardDigest === digest) {
    update.status = "sent";
    update.attempts = 0;
    await writeDurableJson(path, record);
    return messageId;
  }
  await writeDurableJson(path, record);
  // Never retry an uncertain PATCH, or permit a later revision to overtake it.
  await acceptResponse(await transport.patch(messageId, content), path, record);
  return messageId;
}

export async function reconcileAncFeishuCard(
  path: string,
  record: AncFeishuReceipt,
  revision: number,
  transport: AncCardTransport,
): Promise<string | undefined> {
  const { messageId, chatId } = requireCard(record);
  const update = record.update;
  if (!update || update.revision !== revision) return undefined;
  if (update.status === "sent") return messageId;
  if (update.status !== "sending" || update.reconciliations >= 3) return undefined;
  update.reconciliations++;
  await writeDurableJson(path, record);
  const content = await transport.read(messageId, chatId);
  const current = z.json().parse(JSON.parse(content));
  if (ancCardDigest(current) !== update.digest) return undefined;
  update.status = "sent";
  record.cardDigest = update.digest;
  await writeDurableJson(path, record);
  return messageId;
}
