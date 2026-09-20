import { createHash } from "node:crypto";
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
import { ancAgentView, createAncHostedTools } from "./hosted-tools.js";
import type { AncProjectLoop } from "./project-loop.js";
import { type AncEffect, AncId, type AncSnapshot } from "./schemas.js";

const Binding = z.object({ providerId: z.string(), schemaVersion: z.number(), payload: z.json() });
const Session = z.object({
  id: AncId,
  projectId: AncId,
  taskId: AncId.optional(),
  binding: Binding.optional(),
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

/** Persists thread bindings and run receipts; never replaces a session to resolve errors. */
export class AncSessionDriver {
  readonly #active = new Map<string, AgentRuntime>();
  readonly #opening = new Set<string>();
  constructor(
    readonly loop: AncProjectLoop,
    readonly options: AncSessionDriverOptions,
  ) {}
  private path(id: string): string {
    return join(this.options.directory, `${AncId.parse(id)}.json`);
  }
  private async read(id: string): Promise<SessionRecord> {
    const record = await readDurableJson(this.path(id), (value) => Session.parse(value));
    if (!record) throw new Error("Unknown ANC session");
    return record;
  }
  async create(e: AncEffect): Promise<string> {
    await ensurePrivateDirectory(this.options.directory, this.options.directory);
    const id = `session_${createHash("sha256").update(e.id).digest("hex").slice(0, 32)}`;
    const existing = await readDurableJson(this.path(id), (value) => Session.parse(value));
    if (existing) {
      if (existing.projectId !== e.projectId || existing.taskId !== e.taskId)
        throw new Error("Session identity mismatch");
      return id;
    }
    await writeDurableJson(this.path(id), { id, projectId: e.projectId, taskId: e.taskId, runs: {} });
    return id;
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
  private checkPreviousRun(record: SessionRecord, e: AncEffect): string | undefined {
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
    this.reserve(id);
    let runtime: AgentRuntime | undefined;
    try {
      const record = await this.read(id);
      const priorReceipt = this.checkPreviousRun(record, e);
      if (priorReceipt) return priorReceipt;
      record.runs[e.id] = { status: "running" };
      await writeDurableJson(this.path(id), record);
      const scope = { projectId: record.projectId, sessionId: id, taskId: record.taskId };
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
        input: {
          items: [
            {
              type: "text",
              text: JSON.stringify({
                trigger: { id: e.id, kind: e.kind },
                state: ancAgentView(s, scope),
                instruction:
                  "Read the current state, take the next authorized steps, and stop when waiting or blocked. Report verified task artifacts with anc_task_report_result.",
              }),
            },
          ],
        },
      });
      record.binding = result.binding ?? runtime.binding ?? record.binding;
      record.runs[e.id] = {
        status: result.status === "completed" ? "completed" : "failed",
        receipt: `${id}:${result.runId}:${result.status}`,
      };
      await writeDurableJson(this.path(id), record);
      if (result.status !== "completed") throw new Error("Codex execution failed; inspect the recorded result");
      const completedRun = record.runs[e.id];
      if (!completedRun?.receipt) throw new Error("Missing completed receipt");
      return completedRun.receipt;
    } finally {
      this.#opening.delete(id);
      this.#active.delete(id);
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
