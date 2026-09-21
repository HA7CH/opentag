import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AncDeferred, type AncEffectRunner } from "./effect-runner.js";
import type { AncProjectLoop } from "./project-loop.js";
import type { AncSessionDriver } from "./session-driver.js";

export interface AncPilotWorkerOptions {
  readonly pollMs?: number;
  readonly deadlineScanMs?: number;
  readonly now?: () => number;
  /** A durable unresolved session is reported once; diagnostics must not contain model text. */
  readonly onIntakeBlocked: (sessionId: string, state: "running" | "failed") => Promise<void>;
}
type SessionWorker = Pick<
  AncSessionDriver,
  "pendingIntakes" | "startIntake" | "intakeStatus" | "recoverDeadLocks" | "hasActiveWork"
>;

/** One pilot owner, existing durable queues, no new database or always-running model. */
export class AncPilotWorker {
  #paused = false;
  #running = false;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #deadlineScanMs: number;
  constructor(
    readonly loop: AncProjectLoop,
    readonly sessions: SessionWorker,
    readonly effects: AncEffectRunner,
    readonly options: AncPilotWorkerOptions,
  ) {
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? 1000;
    this.#deadlineScanMs = options.deadlineScanMs ?? 60000;
    if (
      !Number.isFinite(this.#pollMs) ||
      this.#pollMs < 10 ||
      !Number.isFinite(this.#deadlineScanMs) ||
      this.#deadlineScanMs < 10
    )
      throw new Error("Invalid pilot worker interval");
  }

  pause(): void {
    this.#paused = true;
  }
  resume(): void {
    this.#paused = false;
  }
  get hasProtectedWork(): boolean {
    return this.sessions.hasActiveWork || this.effects.activeCount > 0;
  }

  async serve(signal: AbortSignal): Promise<void> {
    if (this.#running) throw new Error("Pilot worker already started");
    this.#running = true;
    try {
      signal.throwIfAborted();
      await this.loop.store.recoverDeadLocks();
      await this.loop.store.lock("pilot-runtime", async () => {
        await this.sessions.recoverDeadLocks();
        await this.effects.recover();
        await this.runLoops(signal);
      });
    } finally {
      this.#running = false;
    }
  }

  private async runLoops(signal: AbortSignal): Promise<void> {
    const stop = new AbortController();
    const combined = AbortSignal.any([signal, stop.signal]);
    let failure: { error: unknown } | undefined;
    const guard = async (work: Promise<void>) => {
      try {
        await work;
      } catch (error) {
        failure ??= { error };
        stop.abort();
      }
    };
    await Promise.all([guard(this.effects.serve(combined, () => !this.#paused)), guard(this.pump(combined))]);
    if (failure) throw failure.error;
  }

  private async pump(signal: AbortSignal): Promise<void> {
    const active = new Map<string, Promise<void>>();
    let failure: { error: unknown } | undefined;
    let nextDeadlineScan = 0;
    try {
      while (!signal.aborted && !failure) {
        if (!this.#paused) {
          if (this.#now() >= nextDeadlineScan) {
            await this.checkDeadlines();
            nextDeadlineScan = this.#now() + this.#deadlineScanMs;
          }
          await this.startReady(active, signal, (error) => {
            failure = { error };
          });
        }
        await delay(this.#pollMs, undefined, { signal }).catch((error: unknown) => {
          if (!signal.aborted) throw error;
        });
      }
    } finally {
      await Promise.all(active.values());
    }
    if (failure) throw failure.error;
  }

  private async startReady(
    active: Map<string, Promise<void>>,
    signal: AbortSignal,
    onFailure: (error: unknown) => void,
  ): Promise<void> {
    for (const id of await this.sessions.pendingIntakes()) {
      if (signal.aborted || this.#paused || active.size >= 2) break;
      if (active.has(id)) continue;
      const job = this.runIntake(id)
        .catch(onFailure)
        .finally(() => active.delete(id));
      active.set(id, job);
    }
  }

  private async runIntake(id: string): Promise<void> {
    try {
      await this.sessions.startIntake(id);
    } catch (error) {
      if (error instanceof AncDeferred) return;
      const state = await this.sessions.intakeStatus(id);
      // An I/O failure before durable claim is not safely absorbed as a model failure.
      if (state === "accepted" || state === "completed") throw error;
      await this.options.onIntakeBlocked(id, state);
    }
  }

  async checkDeadlines(): Promise<void> {
    const now = this.#now();
    for (const projectId of await this.loop.store.ids()) {
      const snapshot = await this.loop.store.read(projectId);
      if (!snapshot || snapshot.project.status === "closed") continue;
      const due = Object.values(snapshot.project.requests).find(
        (request) => request.status === "pending" && now >= (request.reminded ? request.followUpAt : request.dueAt),
      );
      if (!due) continue;
      const eventId = createHash("sha256")
        .update(JSON.stringify([projectId, due.id, due.reminded ? "block" : "remind"]))
        .digest("hex");
      await this.loop.execute(
        { kind: "system", id: "anc-deadline-worker", projectIds: [projectId] },
        {
          operation: "deadline.check",
          projectId,
          eventId,
        },
      );
    }
  }
}
