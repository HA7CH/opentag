import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AgentHostedTools } from "./agent-runtime/types.js";
import { ensurePrivateDirectory, readDurableJson, writeDurableJson } from "./storage/durable-file.js";

const Text = z.string().trim().min(1).max(16000);
const Receipt = z.object({ messageId: Text, conversationId: Text });
const RecordSchema = z.object({
  key: Text,
  sessionId: Text,
  tenantId: Text,
  person: Text,
  message: Text,
  receipt: Receipt.optional(),
});
const ReplySchema = z.object({
  id: Text,
  sessionId: Text,
  text: Text,
  senderId: Text,
  delivered: z.boolean(),
});
const Ledger = z.object({
  messages: z.record(z.string(), RecordSchema),
  replies: z.record(z.string(), ReplySchema),
});
type MessageRecord = z.infer<typeof RecordSchema>;
export interface HumanMessageScope {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly people: readonly string[];
}
export interface HumanMessagingTransport {
  /** Resolve exact authorized IDs before constructing the scope; no fuzzy recipient lookup here. */
  send(input: MessageRecord, signal: AbortSignal): Promise<z.infer<typeof Receipt>>;
  /** Reconcile a previous uncertain send. Absence must never be interpreted as permission to resend. */
  lookup(input: MessageRecord): Promise<z.infer<typeof Receipt> | undefined>;
  /** Fetch the original event from the authenticated provider, not model-supplied identity/text. */
  readReply(eventId: string): Promise<{
    id: string;
    tenantId: string;
    senderId: string;
    conversationId: string;
    parentMessageId?: string;
    text: string;
  }>;
  /** Must durably deduplicate id before accepting custody. Acceptance is not completed execution. */
  enqueue(reply: z.infer<typeof ReplySchema>): Promise<void>;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A correspondence ledger, not a project/task state machine. One private directory per bot binding. */
export class HumanMessaging {
  constructor(
    readonly directory: string,
    readonly transport: HumanMessagingTransport,
  ) {}

  private async transaction<T>(action: (ledger: z.infer<typeof Ledger>, save: () => Promise<void>) => Promise<T>) {
    await ensurePrivateDirectory(this.directory, this.directory);
    const lockPath = join(this.directory, "writer.lock");
    const lock = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await lock.writeFile(String(process.pid));
      await lock.sync();
      const path = join(this.directory, "messages.json");
      const ledger = (await readDurableJson(path, (value) => Ledger.parse(value))) ?? { messages: {}, replies: {} };
      return await action(ledger, () => writeDurableJson(path, Ledger.parse(ledger)));
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  tools(scope: HumanMessageScope): AgentHostedTools {
    // Copy runtime-owned admission; a later mutation of a caller's array cannot grant recipients.
    const bound = { ...scope, people: [...scope.people] };
    return {
      definitions: [
        {
          name: "send_msg_to_person",
          description:
            "Contact an authorized person for information, feedback or action. Replies return to this session. Sending is not approval.",
          inputSchema: {
            type: "object",
            properties: {
              person: { type: "string", enum: [...bound.people] },
              message: { type: "string" },
              request_key: { type: "string" },
            },
            required: ["person", "message", "request_key"],
            additionalProperties: false,
          },
        },
      ],
      handler: async (call) => {
        try {
          if (call.name !== "send_msg_to_person") throw new Error("Unknown tool");
          if (call.signal.aborted) throw new Error("Cancelled");
          const input = z.object({ person: Text, message: Text, request_key: Text }).strict().parse(call.input);
          if (!bound.people.includes(input.person)) throw new Error("Recipient is outside the admitted scope");
          const key = hash([bound.tenantId, bound.sessionId, input.request_key]);
          const result = await this.transaction(async (ledger, save) => {
            const previous = ledger.messages[key];
            if (previous && (previous.message !== input.message || previous.person !== input.person))
              throw new Error("Request key conflict");
            if (previous?.receipt) return previous.receipt;
            if (previous) {
              const recovered = await this.transport.lookup(previous);
              if (!recovered)
                throw new Error("Send outcome unknown; inspect the original send, do not create a new request key");
              previous.receipt = Receipt.parse(recovered);
              await save();
              return previous.receipt;
            }
            const record: MessageRecord = {
              key,
              sessionId: bound.sessionId,
              tenantId: bound.tenantId,
              person: input.person,
              message: input.message,
            };
            ledger.messages[key] = record;
            await save();
            record.receipt = Receipt.parse(await this.transport.send(record, call.signal));
            await save();
            return record.receipt;
          });
          return { success: true, content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch {
          return {
            success: false,
            content: [
              {
                type: "text",
                text: "Message not confirmed. Retry identical input with the same request_key; reconcile unknown outcomes before sending again.",
              },
            ],
          };
        }
      },
    };
  }

  /** Called only by authenticated ingress; never exposed as an agent tool. */
  async receive(eventId: string): Promise<"unmatched" | "queued"> {
    const reply = await this.transport.readReply(eventId);
    if (reply.id !== eventId) throw new Error("Provider event identity mismatch");
    return this.transaction(async (ledger, save) => {
      const key = hash([reply.tenantId, reply.id]);
      const previous = ledger.replies[key];
      if (previous) {
        if (previous.text !== reply.text || previous.senderId !== reply.senderId)
          throw new Error("Reply identity conflict");
        if (!previous.delivered) {
          await this.transport.enqueue(structuredClone(previous));
          previous.delivered = true;
          await save();
        }
        return "queued";
      }
      const matches = Object.values(ledger.messages).filter(
        (item) =>
          item.tenantId === reply.tenantId &&
          item.person === reply.senderId &&
          item.receipt?.conversationId === reply.conversationId &&
          item.receipt?.messageId === reply.parentMessageId &&
          reply.parentMessageId !== undefined,
      );
      // Unquoted or ambiguous messages stay in ordinary chat; never guess the most recent project.
      if (matches.length !== 1) return "unmatched";
      const original = matches[0];
      if (!original) return "unmatched";
      const event = ReplySchema.parse({
        id: key,
        sessionId: original.sessionId,
        senderId: reply.senderId,
        text: reply.text,
        delivered: false,
      });
      ledger.replies[key] = event;
      await save();
      await this.transport.enqueue(structuredClone(event));
      event.delivered = true;
      await save();
      return "queued";
    });
  }

  /** Startup recovery for responses persisted before a crash; uses the same queue id. */
  async replayReplies(): Promise<number> {
    return this.transaction(async (ledger, save) => {
      let count = 0;
      for (const reply of Object.values(ledger.replies)) {
        if (reply.delivered) continue;
        await this.transport.enqueue(structuredClone(reply));
        reply.delivered = true;
        await save();
        count++;
      }
      return count;
    });
  }
}
