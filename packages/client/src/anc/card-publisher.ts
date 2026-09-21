import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { JsonValue } from "../agent-runtime/types.js";
import { readDurableJson, writeDurableJson } from "../storage/durable-file.js";
import { AncSafeRetry } from "./effect-runner.js";
import { ancCardDigest } from "./feishu-card-ledger.js";
import type { AncFeishuGateway, AncFeishuTarget } from "./feishu-gateway.js";
import { type AncPublicOutput, AncPublicOutputSchema, renderAncPublicCards } from "./public-output.js";
import { AncFileStore } from "./store.js";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Binding = z.object({
  projectId: Id,
  runId: z.string().min(1).max(256),
  target: z.object({ type: z.enum(["chat_id", "open_id"]), id: Id }),
  title: z.string().trim().min(1).max(120),
});
export type AncCardBinding = z.infer<typeof Binding>;
const Pending = z.object({
  revision: z.number().int().nonnegative(),
  card: z.json(),
  digest: z.string(),
  status: z.enum(["ready", "sending", "unknown", "blocked"]),
  attempts: z.number().int().nonnegative(),
  lookups: z.number().int().nonnegative(),
});
const Card = z.object({
  id: Id,
  desired: z.json(),
  digest: z.string(),
  messageId: Id.optional(),
  sentDigest: z.string().optional(),
  revision: z.number().int().nonnegative().default(0),
  dueAt: z.number().finite().nonnegative(),
  pending: Pending.optional(),
});
const Record = z.object({
  binding: Binding,
  sequence: z.number().int().positive(),
  snapshotDigest: z.string(),
  cards: z.array(Card).max(128),
});
type Publication = z.infer<typeof Record>;
type CardState = z.infer<typeof Card>;
type Transport = Pick<AncFeishuGateway, "sendCard" | "updateCard" | "lookup" | "reconcileCard">;
type Work = { key: string; card: CardState; target: AncFeishuTarget };
const writers = new Map<string, Promise<unknown>>();
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * A coalescing, durable public-card outbox. Capturing a snapshot never waits for
 * Feishu. The caller checkpoints ordered public projections (not raw reasoning)
 * at a bounded cadence and at terminal events. This is not business delivery.
 */
export class AncCardPublisher {
  readonly #store: AncFileStore;
  readonly #now: () => number;
  readonly #interval: number;
  constructor(
    directory: string,
    readonly namespace: string,
    readonly transport: Transport,
    options: { now?: () => number; intervalMs?: number } = {},
  ) {
    Id.parse(namespace);
    this.directory = join(directory, hash(namespace));
    this.#store = new AncFileStore(this.directory);
    this.#now = options.now ?? Date.now;
    this.#interval = options.intervalMs ?? 1000;
    if (!Number.isFinite(this.#interval) || this.#interval < 1000) throw new Error("Unsafe card update cadence");
  }

  readonly directory: string;
  private key(binding: AncCardBinding): string {
    return hash([this.namespace, binding.projectId, binding.runId]);
  }
  private path(key: string): string {
    return join(this.directory, `${key}.json`);
  }
  private async read(key: string): Promise<Publication | undefined> {
    return readDurableJson(this.path(key), (value) => Record.parse(value));
  }
  private async change<T>(
    key: string,
    action: (record: Publication | undefined) => Promise<{ record: Publication; result: T }>,
  ): Promise<T> {
    await this.#store.initialize();
    const identity = this.path(key);
    const previous = writers.get(identity) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() =>
        this.#store.lock(key, async () => {
          const result = await action(await this.read(key));
          await writeDurableJson(this.path(key), Record.parse(result.record));
          return result.result;
        }),
      );
    writers.set(identity, write);
    try {
      return await write;
    } finally {
      if (writers.get(identity) === write) writers.delete(identity);
    }
  }

  /** Sequence belongs to this run, is monotonic, and is persisted with the desired cards. */
  async capture(input: AncCardBinding, sequence: number, output: AncPublicOutput): Promise<void> {
    const binding = Binding.parse(input);
    z.number().int().positive().parse(sequence);
    const state = AncPublicOutputSchema.parse(output);
    if (state.runId !== binding.runId) throw new Error("Public projection run mismatch");
    const rendered = renderAncPublicCards(state, binding.title);
    const snapshotDigest = hash(rendered);
    await this.change(this.key(binding), async (prior) => {
      this.validateSnapshot(prior, binding, sequence, snapshotDigest);
      const record: Publication = prior ?? { binding, sequence, snapshotDigest, cards: [] };
      for (const item of rendered) {
        const digest = ancCardDigest(item.card);
        const existing = record.cards.find((card) => card.id === item.id);
        if (existing) {
          existing.desired = item.card;
          existing.digest = digest;
        } else {
          record.cards.push({ id: item.id, desired: item.card, digest, revision: 0, dueAt: 0 });
        }
      }
      // Retained cards cannot silently disappear from a newer projection.
      if (record.cards.some((card) => !rendered.some((item) => item.id === card.id)))
        throw new Error("Public snapshot removed an existing message");
      record.sequence = sequence;
      record.snapshotDigest = snapshotDigest;
      return { record, result: undefined };
    });
  }

  private validateSnapshot(prior: Publication | undefined, binding: AncCardBinding, sequence: number, digest: string) {
    if (!prior) return;
    if (hash(prior.binding) !== hash(binding)) throw new Error("Card routing binding changed");
    if (sequence < prior.sequence) throw new Error("Stale public snapshot");
    if (sequence === prior.sequence && prior.snapshotDigest !== digest)
      throw new Error("Public snapshot sequence reused");
  }

  async receipts(input: AncCardBinding) {
    const binding = Binding.parse(input);
    const record = await this.read(this.key(binding));
    if (!record) return [];
    if (hash(record.binding) !== hash(binding)) throw new Error("Card routing binding changed");
    return record.cards.map((card) => ({
      cardId: card.id,
      messageId: card.messageId,
      revision: card.revision,
      status: card.pending?.status ?? (card.digest === card.sentDigest ? "sent" : "ready"),
    }));
  }

  /** Safe only after the previous worker has stopped; never resends an in-flight operation. */
  async recover(): Promise<void> {
    await this.#store.recoverDeadLocks();
    await this.#store.lock("card-publisher", async () => {
      for (const key of await this.keys()) {
        await this.change(key, async (record) => {
          if (!record) throw new Error("Missing public-card record");
          for (const card of record.cards) if (card.pending?.status === "sending") card.pending.status = "unknown";
          return { record, result: undefined };
        });
      }
    });
  }
  private async keys(): Promise<string[]> {
    await this.#store.initialize();
    return (await readdir(this.directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => name.slice(0, -5));
  }

  private eligible(card: CardState): boolean {
    return (
      card.dueAt <= this.#now() &&
      card.pending?.status !== "blocked" &&
      card.pending?.status !== "sending" &&
      (card.pending !== undefined || card.sentDigest !== card.digest)
    );
  }
  private async select(): Promise<Work[]> {
    const work: Work[] = [];
    for (const key of await this.keys()) {
      const record = await this.read(key);
      if (!record) continue;
      for (const card of record.cards) {
        if (this.eligible(card)) work.push({ key, card, target: record.binding.target });
        if (work.length === 2) return work;
      }
    }
    return work;
  }

  /** At most two short network operations; no locks shared with model event capture. */
  async tick(): Promise<number> {
    await this.#store.initialize();
    return this.#store.lock("card-publisher", async () => {
      const work = await this.select();
      // Preserve provider message order within a run; independent runs may send concurrently.
      await Promise.all(
        [...new Set(work.map((item) => item.key))].map(async (key) => {
          for (const item of work.filter((candidate) => candidate.key === key)) await this.perform(item);
        }),
      );
      return work.length;
    });
  }
  async serve(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await delay(this.#interval, undefined, { signal }).catch((error: unknown) => {
        if (!signal.aborted) throw error;
      });
    }
  }

  private async claim(work: Work): Promise<CardState> {
    return this.change(work.key, async (record) => {
      const card = record?.cards.find((item) => item.id === work.card.id);
      if (!record || !card || !this.eligible(card)) throw new Error("Public-card claim changed");
      card.pending ??= {
        revision: card.messageId ? card.revision + 1 : 0,
        card: card.desired,
        digest: card.digest,
        status: "ready",
        attempts: 0,
        lookups: 0,
      };
      if (card.pending.status === "unknown") card.pending.lookups++;
      else {
        card.pending.status = "sending";
        card.pending.attempts++;
      }
      card.dueAt = this.#now() + this.#interval;
      return { record, result: structuredClone(card) };
    });
  }

  private async perform(work: Work): Promise<void> {
    const claimed = await this.claim(work);
    const pending = claimed.pending;
    if (!pending) throw new Error("Missing public-card operation");
    const deliveryId = `pub_${hash([work.key, claimed.id]).slice(0, 48)}`;
    let messageId: string | undefined;
    let safeRetry = false;
    try {
      if (pending.status === "unknown") {
        messageId =
          pending.revision === 0
            ? await this.transport.lookup(deliveryId)
            : await this.transport.reconcileCard(deliveryId, pending.revision);
      } else {
        messageId =
          pending.revision === 0
            ? await this.transport.sendCard(deliveryId, work.target, pending.card as JsonValue)
            : await this.transport.updateCard(deliveryId, pending.revision, pending.card as JsonValue);
      }
      if (messageId) Id.parse(messageId);
      if (claimed.messageId && messageId !== undefined && claimed.messageId !== messageId)
        throw new Error("Public-card receipt changed identity");
    } catch (error) {
      messageId = undefined;
      safeRetry = pending.status !== "unknown" && error instanceof AncSafeRetry;
    }
    await this.finish(work, claimed, messageId, safeRetry);
  }
  private async finish(work: Work, claimed: CardState, messageId: string | undefined, safeRetry: boolean) {
    return this.change(work.key, async (record) => {
      const card = record?.cards.find((item) => item.id === claimed.id);
      const pending = card?.pending;
      if (!record || !card || !pending || hash(pending) !== hash(claimed.pending))
        throw new Error("Public-card operation changed before receipt");
      // Start the cooldown after the response, not before a potentially slow HTTP request.
      card.dueAt = this.#now() + this.#interval;
      if (messageId) {
        card.messageId = messageId;
        card.sentDigest = pending.digest;
        card.revision = pending.revision;
        delete card.pending;
      } else if (safeRetry) {
        pending.status = pending.attempts < 3 ? "ready" : "blocked";
      } else {
        pending.status = pending.lookups < 3 ? "unknown" : "blocked";
      }
      return { record, result: undefined };
    });
  }
}
