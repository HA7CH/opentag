import type { AgentRuntimeEvent } from "../agent-runtime/types.js";
import type { AncCardBinding, AncCardPublisher } from "./card-publisher.js";
import { newAncPublicOutput, projectAncPublicEvent } from "./public-output.js";

/**
 * One ordered Codex run. Stream ingestion does not perform network I/O.
 * The owner calls checkpointIfDue from its one-second background tick and after
 * accept. Terminal events checkpoint immediately. A crash may lose at most the
 * uncheckpointed public preview; durable business state is independent of it.
 */
export class AncPublicCardStream {
  #output;
  #sequence = 0;
  #savedSequence = 0;
  #lastCheckpointAt = Number.NEGATIVE_INFINITY;
  #writing: Promise<void> | undefined;
  constructor(
    readonly publisher: Pick<AncCardPublisher, "capture">,
    readonly binding: AncCardBinding,
    readonly now = Date.now,
  ) {
    this.#output = newAncPublicOutput(binding.runId);
  }

  get terminal(): boolean {
    return this.#output.status !== "running";
  }
  get dirty(): boolean {
    return this.#sequence > this.#savedSequence;
  }

  accept(event: AgentRuntimeEvent): void {
    const output = projectAncPublicEvent(this.#output, event);
    if (output === this.#output) return;
    this.#output = output;
    this.#sequence++;
  }

  /** The first public item and the final snapshot are durable before returning. */
  async checkpointIfDue(): Promise<void> {
    if (!this.dirty || (!this.terminal && this.now() - this.#lastCheckpointAt < 1000)) return;
    await this.checkpoint();
  }

  /** Also used before a graceful shutdown. Concurrent checkpoints remain ordered. */
  async checkpoint(): Promise<void> {
    if (this.#writing) {
      await this.#writing;
      if (this.dirty) await this.checkpoint();
      return;
    }
    if (!this.dirty) return;
    const sequence = this.#sequence;
    const output = this.#output;
    this.#writing = this.publisher.capture(this.binding, sequence, output);
    try {
      await this.#writing;
      this.#savedSequence = sequence;
      this.#lastCheckpointAt = this.now();
    } finally {
      this.#writing = undefined;
    }
  }
}
