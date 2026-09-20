import { setTimeout as delay } from "node:timers/promises";
import { type AncProjectLoop, ancEffectIsCurrent, noteAncEffectProblem } from "./project-loop.js";
import type { AncEffect, AncSnapshot } from "./schemas.js";

export class AncSafeRetry extends Error {}
class AncInvalidDelivery extends Error {}
/** Scheduling pressure before any provider action is not a failed attempt. */
export class AncDeferred extends Error {}
type EffectWork = { id: string; effect: AncEffect; snapshot: AncSnapshot };

function retryStatus(error: unknown, attempts: number): AncEffect["status"] {
  if (!(error instanceof AncSafeRetry)) return "unknown";
  return attempts < 3 ? "pending" : "failed";
}
function recordEffectFailure(s: AncSnapshot, e: AncEffect, error: unknown, now: number): void {
  // Failure after a provider action or during receipt persistence is ambiguous.
  if (error instanceof AncDeferred) {
    e.status = "pending";
    e.attempts--;
    e.nextAttemptAt = now + 1000;
    e.error = "waiting_for_execution_slot_or_reconciliation";
    return;
  }
  e.status = error instanceof AncInvalidDelivery ? "failed" : retryStatus(error, e.attempts);
  e.nextAttemptAt = now + 1000 * 2 ** e.attempts;
  e.error =
    error instanceof AncInvalidDelivery
      ? "artifact_verification_failed"
      : error instanceof AncSafeRetry
        ? "retryable_transport_failure"
        : "outcome_requires_reconciliation";
  if (e.status === "failed" || e.status === "unknown") noteAncEffectProblem(s, e);
}

export interface AncEffectAdapter {
  /** Stable effect ID is the provider idempotency key; return a verifiable receipt. */
  perform(effect: AncEffect, snapshot: AncSnapshot): Promise<string>;
  /** Undefined means the outcome is still unknown, NOT permission to repeat it. */
  lookup(effect: AncEffect, snapshot: AncSnapshot): Promise<string | undefined>;
}
export class AncEffectRunner {
  constructor(
    readonly loop: AncProjectLoop,
    readonly adapter: AncEffectAdapter,
    readonly now = Date.now,
  ) {}

  /** Call only after the previous process is stopped and its worker lock is recovered. */
  async recover(): Promise<void> {
    await this.loop.store.initialize();
    await this.loop.store.lock("effect-worker", async () => {
      for (const id of await this.loop.store.ids()) {
        await this.loop.store.transact(id, async (s) => {
          if (!s) throw new Error("Missing project");
          for (const e of Object.values(s.effects)) if (e.status === "running") e.status = "unknown";
          return { snapshot: s, result: undefined };
        });
      }
    });
  }

  async tick(): Promise<number> {
    await this.loop.store.initialize();
    return this.loop.store.lock("effect-worker", async () => {
      const work: { id: string; effect: AncEffect; snapshot: AncSnapshot }[] = [];
      for (const id of await this.loop.store.ids()) {
        const s = await this.loop.store.read(id);
        if (!s) continue;
        const effects = Object.values(s.effects)
          .filter((e) => this.eligible(e, s))
          .slice(0, 2 - work.length);
        work.push(...effects.map((effect) => ({ id, effect, snapshot: s })));
        if (work.length === 2) break;
      }
      await Promise.all(work.map((w) => this.run(w.id, w.effect, w.snapshot)));
      return work.length;
    });
  }

  /**
   * Owns the worker lock for its lifetime. Two model executions and two short
   * delivery/reconciliation actions have separate lanes, so waiting on a model
   * never delays a human request that is already durable.
   */
  async serve(signal: AbortSignal): Promise<void> {
    await this.loop.store.initialize();
    await this.loop.store.lock("effect-worker", async () => {
      const active = new Map<string, { execution: boolean; promise: Promise<void> }>();
      let failure: { error: unknown } | undefined;
      try {
        while (!signal.aborted && !failure) {
          const executions = [...active.values()].filter((job) => job.execution).length;
          const work = await this.selectWork(2 - executions, 2 - (active.size - executions), new Set(active.keys()));
          for (const item of work) {
            if (signal.aborted) break;
            const key = `${item.id}:${item.effect.id}`;
            const promise = this.run(item.id, item.effect, item.snapshot)
              .catch((error: unknown) => {
                failure = { error };
              })
              .finally(() => active.delete(key));
            active.set(key, { execution: this.isExecution(item.effect), promise });
          }
          await delay(100, undefined, { signal }).catch((error: unknown) => {
            if (!signal.aborted) throw error;
          });
        }
      } finally {
        await Promise.all([...active.values()].map((job) => job.promise));
      }
      if (failure) throw failure.error;
    });
  }

  private isExecution(effect: AncEffect): boolean {
    return effect.kind === "session.wake" && effect.status === "pending";
  }

  private async selectWork(executionSlots: number, actionSlots: number, active: Set<string>): Promise<EffectWork[]> {
    const work: EffectWork[] = [];
    const slots = { execution: executionSlots, action: actionSlots };
    for (const id of await this.loop.store.ids()) {
      const snapshot = await this.loop.store.read(id);
      if (!snapshot) continue;
      work.push(...this.takeAvailable(id, snapshot, active, slots));
      if (slots.execution + slots.action === 0) break;
    }
    return work;
  }

  private takeAvailable(
    id: string,
    snapshot: AncSnapshot,
    active: Set<string>,
    slots: { execution: number; action: number },
  ): EffectWork[] {
    const work: EffectWork[] = [];
    for (const effect of Object.values(snapshot.effects)) {
      if (!this.eligible(effect, snapshot) || active.has(`${id}:${effect.id}`)) continue;
      const lane = this.isExecution(effect) ? "execution" : "action";
      if (slots[lane] <= 0) continue;
      slots[lane]--;
      work.push({ id, effect, snapshot });
    }
    return work;
  }

  private eligible(e: AncEffect, s: AncSnapshot): boolean {
    if (e.nextAttemptAt > this.now()) return false;
    if (e.status !== "pending" && e.status !== "unknown") return false;
    return !(s.project.pendingBrief && e.kind === "artifact.publish");
  }

  private async run(id: string, candidate: AncEffect, previous: AncSnapshot): Promise<void> {
    if (candidate.status === "unknown") {
      try {
        const receipt = await this.adapter.lookup(candidate, previous);
        if (receipt) {
          await this.loop.completeEffect(id, candidate.id, receipt);
          return;
        }
      } catch {
        /* Reconciliation failure is still unknown, never permission to resend. */
      }
      await this.loop.store.transact(id, async (s) => {
        if (!s) throw new Error("Missing project");
        const e = s.effects[candidate.id];
        if (e?.status === "unknown") {
          e.reconciliationAttempts = (e.reconciliationAttempts ?? 0) + 1;
          // An unknown side effect never becomes safe to repeat just because a timer elapsed.
          e.nextAttemptAt = e.reconciliationAttempts < 3 ? this.now() + 60000 : Number.MAX_SAFE_INTEGER;
          noteAncEffectProblem(s, e);
        }
        return { snapshot: s, result: undefined };
      });
      return;
    }
    const claimed = await this.loop.store.transact(id, async (s) => {
      if (!s) throw new Error("Missing project");
      const e = s.effects[candidate.id];
      if (e?.status !== "pending") return { snapshot: s, result: undefined };
      if (!ancEffectIsCurrent(s, e)) {
        e.status = "cancelled";
        return { snapshot: s, result: undefined };
      }
      e.status = "running";
      e.attempts++;
      return { snapshot: s, result: structuredClone(s) };
    });
    if (!claimed) return;
    try {
      const e = claimed.effects[candidate.id];
      if (!e) throw new Error("Missing claimed effect");
      try {
        await this.loop.verifyDelivery(e, claimed);
      } catch {
        throw new AncInvalidDelivery("Artifact verification failed before any external send");
      }
      const receipt = await this.adapter.perform(e, claimed);
      await this.loop.completeEffect(id, e.id, receipt);
    } catch (error) {
      await this.loop.store.transact(id, async (s) => {
        if (!s) throw new Error("Missing project");
        const e = s.effects[candidate.id];
        if (!e) throw new Error("Missing effect");
        recordEffectFailure(s, e, error, this.now());
        return { snapshot: s, result: undefined };
      });
    }
  }
}
