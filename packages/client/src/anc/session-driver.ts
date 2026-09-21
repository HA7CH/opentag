import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  AgentRuntime,
  AgentRuntimeBinding,
  AgentRuntimeEvent,
  AgentRuntimeFactory,
  CreateAgentRuntimeRequest,
} from "../agent-runtime/types.js";
import { ensurePrivateDirectory, readDurableJson, writeDurableJson } from "../storage/durable-file.js";
import { AncDeferred } from "./effect-runner.js";
import { type AncAgentScope, ancAgentView, createAncHostedTools } from "./hosted-tools.js";
import type { AncProjectLoop } from "./project-loop.js";
import { type AncEffect, AncId, type AncSnapshot } from "./schemas.js";
import { AncFileStore } from "./store.js";

const Intake = z.object({
  projectId: AncId,
  eventId: AncId,
  actorId: AncId,
  humanIds: z.array(AncId).min(1).max(32),
  text: z.string().trim().min(1).max(16000),
  source: z.object({ appId: AncId, chatId: AncId, messageId: AncId }),
});
type Execution = Pick<AncEffect, "id" | "projectId" | "taskId"> & { kind: string };
const Binding = z.object({ providerId: z.string(), schemaVersion: z.number(), payload: z.json() });
const Session = z.object({
  id: AncId,
  projectId: AncId,
  taskId: AncId.optional(),
  binding: Binding.optional(),
  intake: Intake.optional(),
  runs: z.record(
    AncId,
    z.object({ status: z.enum(["running", "completed", "failed"]), receipt: z.string().optional() }),
  ),
});
type SessionRecord = z.infer<typeof Session>;
export interface AncSessionDriverOptions {
  readonly directory: string;
  readonly workspaceRoot: string;
  readonly factory: AgentRuntimeFactory;
  readonly configuration: CreateAgentRuntimeRequest["configuration"];
  readonly runTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Only assistant-visible progress may be rendered; tool/provider diagnostics remain private. */
  readonly onEvent?: (projectId: string, taskId: string | undefined, event: AgentRuntimeEvent) => Promise<void>;
}

function promptText(record: SessionRecord, e: Execution, scope: AncAgentScope, snapshot?: AncSnapshot): string {
  return JSON.stringify({
    trigger: { id: e.id, kind: e.kind },
    state: snapshot ? ancAgentView(snapshot, scope) : { status: "not_proposed" },
    intake:
      !snapshot && record.intake
        ? {
            goal: record.intake.text,
            requester: record.intake.actorId,
            permittedParticipants: record.intake.humanIds,
          }
        : undefined,
    instruction: snapshot
      ? "Read the current state, take the next authorized steps, and stop when waiting or blocked. Report verified task artifacts with anc_task_report_result."
      : "Propose a concise project with anc_project_propose. Use the intake requester as DRI and only permitted participants. Flag unknown details; do not start work or create a group before human approval. After persisting the proposal, end this run.",
  });
}

/** Persists thread bindings and run receipts; never replaces a session to resolve errors. */
export class AncSessionDriver {
  readonly #active = new Map<string, AgentRuntime>();
  readonly #opening = new Set<string>();
  readonly #locks: AncFileStore;
  constructor(
    readonly loop: AncProjectLoop,
    readonly options: AncSessionDriverOptions,
  ) {
    this.#locks = new AncFileStore(join(options.directory, "locks"));
  }
  private path(id: string): string {
    return join(this.options.directory, `${AncId.parse(id)}.json`);
  }
  private async read(id: string): Promise<SessionRecord> {
    const record = await readDurableJson(this.path(id), (value) => Session.parse(value));
    if (!record) throw new Error("Unknown ANC session");
    return record;
  }
  private async locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    await this.#locks.initialize();
    let acquired = false;
    try {
      return await this.#locks.lock(id, () => {
        acquired = true;
        return work();
      });
    } catch (error) {
      if (!acquired && (error as NodeJS.ErrnoException).code === "EEXIST")
        throw new AncDeferred("Session has another writer");
      throw error;
    }
  }

  /** Only a verified transport may admit an intake; this is never an agent tool. */
  async admitIntake(input: unknown): Promise<string> {
    const intake = Intake.parse(input);
    if (!intake.humanIds.includes(intake.actorId)) throw new Error("Intake actor is outside the admitted scope");
    intake.humanIds = [...new Set(intake.humanIds)].sort();
    const id = `session_${createHash("sha256").update(`intake:${intake.projectId}`).digest("hex").slice(0, 32)}`;
    await ensurePrivateDirectory(this.options.directory, this.options.directory);
    return this.locked(id, async () => {
      const prior = await readDurableJson(this.path(id), (value) => Session.parse(value));
      if (prior) {
        if (JSON.stringify(prior.intake) !== JSON.stringify(intake)) throw new Error("Intake identity conflict");
        return id;
      }
      if (await this.loop.store.read(intake.projectId)) throw new Error("Project already exists");
      await writeDurableJson(this.path(id), { id, projectId: intake.projectId, intake, runs: {} });
      return id;
    });
  }

  /** Accepted but not yet started work survives process exit without inventing a new event. */
  async pendingIntakes(): Promise<string[]> {
    await ensurePrivateDirectory(this.options.directory, this.options.directory);
    const pending: string[] = [];
    for (const name of await readdir(this.options.directory)) {
      if (!name.endsWith(".json")) continue;
      const record = await this.read(name.slice(0, -5));
      if (record.intake && !record.runs[record.intake.eventId]) pending.push(record.id);
    }
    return pending.sort();
  }

  get hasActiveWork(): boolean {
    return this.#active.size + this.#opening.size > 0;
  }

  async intakeStatus(id: string): Promise<"accepted" | "running" | "completed" | "failed"> {
    const record = await this.read(id);
    if (!record.intake) throw new Error("Session has no admitted intake");
    return record.runs[record.intake.eventId]?.status ?? "accepted";
  }

  /** Only proven-dead PID locks are removed; unresolved model runs remain blocked. */
  async recoverDeadLocks(): Promise<number> {
    return this.#locks.recoverDeadLocks();
  }

  async startIntake(id: string): Promise<string> {
    const record = await this.read(id);
    if (!record.intake) throw new Error("Session has no admitted intake");
    return this.execute(id, { id: record.intake.eventId, projectId: record.projectId, kind: "project.intake" });
  }

  async create(e: AncEffect): Promise<string> {
    await ensurePrivateDirectory(this.options.directory, this.options.directory);
    const id = `session_${createHash("sha256").update(e.id).digest("hex").slice(0, 32)}`;
    return this.locked(id, async () => {
      const existing = await readDurableJson(this.path(id), (value) => Session.parse(value));
      if (existing) {
        if (existing.projectId !== e.projectId || existing.taskId !== e.taskId)
          throw new Error("Session identity mismatch");
        return id;
      }
      await writeDurableJson(this.path(id), { id, projectId: e.projectId, taskId: e.taskId, runs: {} });
      return id;
    });
  }
  async lookup(e: AncEffect, s: AncSnapshot): Promise<string | undefined> {
    if (e.kind === "session.create") {
      const id = `session_${createHash("sha256").update(e.id).digest("hex").slice(0, 32)}`;
      return (await readDurableJson(this.path(id), (value) => Session.parse(value)))?.id;
    }
    const id = e.taskId ? s.project.tasks[e.taskId]?.sessionId : s.project.sessionId;
    if (!id) return undefined;
    const run = (await this.read(id)).runs[e.id];
    return run?.status === "completed" ? run.receipt : undefined;
  }
  private reserve(id: string): void {
    if (this.#active.has(id) || this.#opening.has(id)) throw new AncDeferred("Session is busy");
    if (this.#active.size + this.#opening.size >= 2) throw new AncDeferred("Two execution slots are occupied");
    this.#opening.add(id);
  }
  private checkPreviousRun(record: SessionRecord, e: Execution): string | undefined {
    if (record.projectId !== e.projectId || record.taskId !== e.taskId) throw new Error("Session scope mismatch");
    const previous = record.runs[e.id];
    if (previous?.status === "completed" && previous.receipt) return previous.receipt;
    if (Object.values(record.runs).some((run) => run.status !== "completed"))
      throw new AncDeferred("Reconcile the unresolved run before starting any new work in this session");
    return undefined;
  }

  async wake(e: AncEffect, s: AncSnapshot): Promise<string> {
    const id = e.taskId ? s.project.tasks[e.taskId]?.sessionId : s.project.sessionId;
    if (!id) throw new Error("Session has not been established");
    return this.execute(id, e, s);
  }

  private async execute(id: string, e: Execution, snapshot?: AncSnapshot): Promise<string> {
    this.reserve(id);
    try {
      return await this.locked(id, () => this.executeLocked(id, e, snapshot));
    } finally {
      this.#opening.delete(id);
      this.#active.delete(id);
    }
  }

  private async executeLocked(id: string, e: Execution, snapshot?: AncSnapshot): Promise<string> {
    let runtime: AgentRuntime | undefined;
    try {
      const record = await this.read(id);
      const priorReceipt = this.checkPreviousRun(record, e);
      if (priorReceipt) return priorReceipt;
      record.runs[e.id] = { status: "running" };
      await writeDurableJson(this.path(id), record);
      const scope = {
        projectId: record.projectId,
        sessionId: id,
        taskId: record.taskId,
        humanIds: record.intake?.humanIds,
      };
      const cwd = join(this.options.workspaceRoot, record.projectId, record.taskId ?? "owner");
      await ensurePrivateDirectory(this.options.workspaceRoot, cwd);
      const request: CreateAgentRuntimeRequest = {
        workspace: { cwd, writableRoots: [cwd] },
        configuration: this.options.configuration,
        policy: {
          fileSystem: "workspace-write",
          network: "enabled",
          approvals: "never",
          tools: { mode: "provider-default" },
        },
        hostedTools: createAncHostedTools(this.loop, scope),
        systemPrompt:
          "You are an ANC project agent. Use the hosted ANC tools as the authoritative project state. Do the work you can do, verify actual artifacts, and ask humans only for missing information, review, authorization or real-world action. When waiting for a human, end this run; their response will resume this same session. Never simulate human approval, send messages through another channel, or claim delivery from a model response. Do not turn conversations into authority. Scope changes require project amendment approval. Use concise natural language.",
        eventSink: async (event) => {
          if (event.type === "binding_changed") {
            record.binding = event.binding;
            await writeDurableJson(this.path(id), record);
          }
          await this.options.onEvent?.(record.projectId, record.taskId, event);
        },
      };
      runtime = record.binding
        ? await this.options.factory.resume({ ...request, binding: record.binding as AgentRuntimeBinding })
        : await this.options.factory.create(request);
      this.#active.set(id, runtime);
      this.#opening.delete(id);
      const result = await runtime.prompt({
        runId: e.id,
        signal: AbortSignal.any([
          AbortSignal.timeout(this.options.runTimeoutMs ?? 600000),
          ...(this.options.signal ? [this.options.signal] : []),
        ]),
        input: { items: [{ type: "text", text: promptText(record, e, scope, snapshot) }] },
      });
      const missingProposal =
        e.kind === "project.intake" && (await this.loop.store.read(record.projectId))?.project.sessionId !== id;
      record.binding = result.binding ?? runtime.binding ?? record.binding;
      record.runs[e.id] = {
        status: result.status === "completed" && !missingProposal ? "completed" : "failed",
        receipt: `${id}:${result.runId}:${missingProposal ? "failed" : result.status}`,
      };
      await writeDurableJson(this.path(id), record);
      if (missingProposal) throw new Error("Intake ended without a durable project proposal");
      if (result.status !== "completed") throw new Error("Codex execution failed; inspect the recorded result");
      const completedRun = record.runs[e.id];
      if (!completedRun?.receipt) throw new Error("Missing completed receipt");
      return completedRun.receipt;
    } finally {
      await runtime?.close();
    }
  }
  async steer(sessionId: string, text: string): Promise<boolean> {
    const runtime = this.#active.get(sessionId);
    const runId = runtime?.state.activeRunId;
    if (!runtime || !runId || runtime.capabilities.steer !== "supported") return false;
    await runtime.steer({ expectedRunId: runId, input: { items: [{ type: "text", text }] } });
    return true;
  }
}
