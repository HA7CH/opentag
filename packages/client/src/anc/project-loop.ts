import { createHash } from "node:crypto";
import {
  type AncArtifact,
  type AncCaller,
  type AncCommand,
  AncCommandSchema,
  type AncEffect,
  type AncHumanRequest,
  type AncProject,
  type AncSnapshot,
  type AncTask,
} from "./schemas.js";
import type { AncFileStore } from "./store.js";

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function key(seed: string): string {
  return `anc_${digest(seed).slice(0, 28)}`;
}
function effect(s: AncSnapshot, seed: string, kind: AncEffect["kind"], fields: Partial<AncEffect> = {}): void {
  const id = key(`${seed}:${kind}`);
  if (s.effects[id]) return;
  const t = fields.taskId ? s.project.tasks[fields.taskId] : undefined;
  s.effects[id] = {
    id,
    projectId: s.project.id,
    kind,
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    projectRevision: s.project.revision,
    taskRevision: t?.revision,
    artifactRevision: t?.artifact?.revision,
    ...fields,
  };
}
function humanRequest(s: AncSnapshot, r: AncHumanRequest): void {
  requireCondition(!s.project.requests[r.id], "Human request ID already exists");
  s.project.requests[r.id] = r;
  effect(s, r.id, "human.send", { requestId: r.id, taskId: r.taskId });
}
function request(
  p: AncProject,
  id: string,
  purpose: AncHumanRequest["purpose"],
  question: string,
  dueAt: number,
  fields: Partial<AncHumanRequest> = {},
): AncHumanRequest {
  return {
    id,
    recipientId: p.dri,
    kind: "approval",
    purpose,
    question,
    subjectRevision: p.revision,
    status: "pending",
    dueAt,
    followUpAt: dueAt + 24 * 60 * 60 * 1000,
    reminded: false,
    ...fields,
  };
}
function wake(s: AncSnapshot, seed: string, taskId?: string, recoveryOf?: string): void {
  if (!(taskId ? s.project.tasks[taskId]?.sessionId : s.project.sessionId)) return;
  effect(s, seed, "session.wake", { taskId, recoveryOf });
}
function task(s: AncSnapshot, id: string): AncTask {
  const found = s.project.tasks[id];
  requireCondition(found, "Unknown task");
  return found;
}
function expireRequestEffects(s: AncSnapshot, requestId: string): void {
  for (const e of Object.values(s.effects)) {
    if (e.requestId === requestId && e.status === "pending") e.status = "cancelled";
  }
}
function supersedeTaskRequests(s: AncSnapshot, taskId: string): void {
  for (const r of Object.values(s.project.requests)) {
    if (r.taskId === taskId && (r.status === "pending" || r.status === "blocked")) {
      r.status = "superseded";
      expireRequestEffects(s, r.id);
    }
  }
}

/** A stale completion may be recorded, but must never advance the new revision. */
export function ancEffectIsCurrent(s: AncSnapshot, e: AncEffect): boolean {
  if (e.projectRevision !== s.project.revision) return false;
  if (e.taskId && e.taskRevision !== s.project.tasks[e.taskId]?.revision) return false;
  if (e.kind === "artifact.publish") {
    const t = e.taskId ? s.project.tasks[e.taskId] : undefined;
    return t?.status === "approved" && t.artifact?.revision === e.artifactRevision;
  }
  if (e.kind === "human.send" || e.kind === "human.remind") {
    const r = e.requestId ? s.project.requests[e.requestId] : undefined;
    return r?.status === "pending" || r?.status === "blocked";
  }
  return s.project.status !== "closed" || e.kind === "project.archive";
}

/** Persist a bounded recovery notification in the same transaction as the failure. */
export function noteAncEffectProblem(s: AncSnapshot, e: AncEffect): void {
  if (!ancEffectIsCurrent(s, e) || e.recoveryOf) return;
  if (e.status === "failed" && e.taskId && (e.kind === "session.create" || e.kind === "session.wake")) {
    const work = s.project.tasks[e.taskId];
    if (work && (work.status === "running" || work.status === "ready")) work.status = "blocked";
  }
  wake(s, `${e.id}:recovery`, undefined, e.id);
}

type Command<O extends AncCommand["operation"]> = Extract<AncCommand, { operation: O }>;

function amend(s: AncSnapshot, c: Command<"project.amend">): void {
  const p = s.project;
  requireCondition(
    p.status === "active" && p.revision === c.expectedRevision && !p.pendingBrief,
    "Stale or pending amendment",
  );
  requireCondition(
    !Object.values(s.effects).some(
      (e) => e.kind === "artifact.publish" && (e.status === "running" || e.status === "unknown"),
    ),
    "Reconcile publication before amendment",
  );
  p.pendingBrief = c.brief;
  humanRequest(s, request(p, key(c.eventId), "amend", c.brief, c.dueAt));
}
function reviseProposal(s: AncSnapshot, c: Command<"project.revise_proposal">): void {
  const p = s.project;
  requireCondition(p.status === "proposed" && p.revision === c.expectedRevision, "Stale proposal");
  for (const r of Object.values(p.requests)) {
    if (r.purpose !== "start") continue;
    r.status = "superseded";
    expireRequestEffects(s, r.id);
  }
  p.brief = c.brief;
  p.revision++;
  humanRequest(s, request(p, key(c.eventId), "start", c.brief, c.dueAt));
}
function proposeClose(s: AncSnapshot, c: Command<"project.close">): void {
  const p = s.project;
  requireCondition(p.status === "active" && !p.pendingBrief, "Project cannot close");
  requireCondition(
    Object.values(p.tasks).length > 0 && Object.values(p.tasks).every((t) => t.status === "delivered"),
    "Deliver all tasks before closing",
  );
  requireCondition(
    !Object.values(p.requests).some((r) => r.status === "pending" || r.status === "blocked"),
    "Resolve human requests before closing",
  );
  p.status = "closing";
  humanRequest(
    s,
    request(p, key(c.eventId), "close", "Review the delivered outcomes and confirm project closure.", c.dueAt),
  );
}
function dispatch(s: AncSnapshot, c: Command<"task.dispatch">): void {
  const p = s.project;
  requireCondition(p.status === "active" && p.groupId && p.sessionId && !p.pendingBrief, "Project is not ready");
  requireCondition(!p.tasks[c.taskId], "Task already exists");
  requireCondition(
    p.roles[c.reviewerRole] && p.participants.includes(p.roles[c.reviewerRole] ?? ""),
    "Unknown reviewer role",
  );
  for (const dependency of c.dependencies)
    requireCondition(p.tasks[dependency] && dependency !== c.taskId, "Unknown or cyclic dependency");
  p.tasks[c.taskId] = {
    id: c.taskId,
    goal: c.goal,
    acceptance: c.acceptance,
    dependencies: c.dependencies,
    reviewerRole: c.reviewerRole,
    status: "ready",
    revision: 1,
    artifactHistory: [],
  };
}
function reviseTask(s: AncSnapshot, c: Command<"task.revise">): void {
  const t = task(s, c.taskId);
  requireCondition(
    s.project.status === "active" && !s.project.pendingBrief && t.revision === c.expectedRevision,
    "Stale task revision",
  );
  requireCondition(t.status === "blocked", "Only blocked tasks may be replanned");
  supersedeTaskRequests(s, t.id);
  t.revision++;
  t.goal = c.goal;
  t.acceptance = c.acceptance;
  delete t.artifact;
  t.status = "ready";
}
function report(s: AncSnapshot, c: Command<"task.report_result">): void {
  const p = s.project;
  const t = task(s, c.taskId);
  requireCondition(p.status === "active" && !p.pendingBrief, "Project is not ready for results");
  requireCondition(t.status === "running" && t.revision === c.expectedRevision, "Stale or non-running task result");
  requireCondition(
    !t.artifactHistory.some((a) => a.revision === c.artifact.revision),
    "Artifact revision was already used",
  );
  supersedeTaskRequests(s, t.id);
  t.artifactHistory.push(c.artifact);
  t.artifact = c.artifact;
  t.status = "waiting_human";
  humanRequest(
    s,
    request(p, key(c.eventId), "task_review", `Review: ${c.artifact.title}`, c.dueAt, {
      taskId: t.id,
      kind: "review",
      subjectRevision: t.revision,
      artifactRevision: c.artifact.revision,
      recipientId: p.roles[t.reviewerRole] ?? p.dri,
    }),
  );
}
function ask(s: AncSnapshot, c: Command<"human.request">): void {
  const p = s.project;
  requireCondition(
    p.status === "active" && !p.pendingBrief && p.participants.includes(c.recipientId),
    "Human recipient is outside the project or amendment is pending",
  );
  const t = c.taskId ? task(s, c.taskId) : undefined;
  requireCondition(!t || t.status === "running", "Task is not running");
  requireCondition(
    !Object.values(p.requests).some((r) => r.taskId === c.taskId && (r.status === "pending" || r.status === "blocked")),
    "Resolve or supersede the existing human request first",
  );
  if (t) t.status = "waiting_human";
  humanRequest(
    s,
    request(p, c.requestId, "question", c.question, c.dueAt, {
      kind: c.kind,
      recipientId: c.recipientId,
      taskId: c.taskId,
      subjectRevision: t?.revision ?? p.revision,
    }),
  );
}
function deadlines(s: AncSnapshot, now: number): void {
  for (const r of Object.values(s.project.requests)) {
    if (r.status !== "pending") continue;
    if (!r.reminded && now >= r.dueAt) {
      r.reminded = true;
      effect(s, r.id, "human.remind", { requestId: r.id, taskId: r.taskId });
    } else if (r.reminded && now >= r.followUpAt) {
      r.status = "blocked";
      if (r.taskId) task(s, r.taskId).status = "blocked";
      wake(s, `${r.id}:overdue`);
    }
  }
}

export interface AncLoopOptions {
  readonly now?: () => number;
  /** Must verify local bytes, expected digest, and required checks before accepting model claims. */
  readonly verifyArtifact: (artifact: AncArtifact) => Promise<void>;
  /** Review copies must be outside agent-writable workspaces. Do not alter revision or digest. */
  readonly retainArtifact?: (artifact: AncArtifact) => Promise<AncArtifact>;
}

export class AncProjectLoop {
  readonly #now: () => number;
  constructor(
    readonly store: AncFileStore,
    readonly options: AncLoopOptions,
  ) {
    this.#now = options.now ?? Date.now;
  }

  async execute(caller: AncCaller, input: unknown): Promise<AncSnapshot> {
    const command = AncCommandSchema.parse(input);
    requireCondition(caller.projectIds.includes(command.projectId), "Project access denied");
    if (command.operation === "human.respond")
      requireCondition(caller.kind === "human", "Only an authenticated human may respond");
    else if (command.operation === "deadline.check")
      requireCondition(caller.kind === "system", "Only the scheduler may check deadlines");
    else
      requireCondition(caller.kind === "agent" || caller.kind === "system", "Use the project agent for this operation");
    const hash = digest({ caller: { kind: caller.kind, id: caller.id }, command });
    return this.store.transact(command.projectId, async (previous) => {
      const duplicate = previous?.events.find((event) => event.id === command.eventId);
      if (duplicate) {
        requireCondition(duplicate.digest === hash, "Idempotency key reused with different content");
        requireCondition(previous, "Missing duplicate state");
        return { snapshot: previous, result: previous };
      }
      const snapshot = previous ? structuredClone(previous) : this.create(command);
      await this.prepareArtifact(snapshot, caller, command);
      this.apply(snapshot, caller, command);
      snapshot.events.push({ id: command.eventId, digest: hash, at: this.#now(), operation: command.operation });
      return { snapshot, result: structuredClone(snapshot) };
    });
  }

  private async prepareArtifact(s: AncSnapshot, caller: AncCaller, c: AncCommand): Promise<void> {
    if (c.operation === "task.report_result") {
      await this.options.verifyArtifact(c.artifact);
      if (this.options.retainArtifact) {
        const retained = await this.options.retainArtifact(c.artifact);
        requireCondition(
          retained.revision === c.artifact.revision && retained.sha256 === c.artifact.sha256,
          "Retention changed artifact identity",
        );
        c.artifact = retained;
        await this.options.verifyArtifact(retained);
      }
    } else if (c.operation === "human.respond" && c.decision === "approve") {
      const { r, t } = this.validateResponse(s, caller, c);
      if (r.purpose === "task_review" && t?.artifact) await this.options.verifyArtifact(t.artifact);
    }
  }

  /** Check again before external delivery; the adapter must upload these same verified bytes. */
  async verifyDelivery(e: AncEffect, s: AncSnapshot): Promise<void> {
    const review = e.requestId ? s.project.requests[e.requestId]?.purpose === "task_review" : false;
    if (e.kind !== "artifact.publish" && !((e.kind === "human.send" || e.kind === "human.remind") && review)) return;
    const artifact = e.taskId ? s.project.tasks[e.taskId]?.artifact : undefined;
    requireCondition(artifact && artifact.revision === e.artifactRevision, "Missing delivery artifact revision");
    await this.options.verifyArtifact(artifact);
  }

  private create(c: AncCommand): AncSnapshot {
    requireCondition(c.operation === "project.propose", "Unknown project");
    requireCondition(c.participants.includes(c.dri), "DRI must be a participant");
    requireCondition(
      Object.values(c.roles).every((person) => c.participants.includes(person)),
      "Role member is outside the project",
    );
    return {
      schemaVersion: 1,
      project: {
        id: c.projectId,
        title: c.title,
        brief: c.brief,
        dri: c.dri,
        participants: [...new Set(c.participants)],
        roles: { ...c.roles, owner: c.dri },
        status: "proposed",
        revision: 1,
        tasks: {},
        requests: {},
      },
      effects: {},
      events: [],
    };
  }

  private apply(s: AncSnapshot, caller: AncCaller, c: AncCommand): void {
    requireCondition(s.project.status !== "closed", "Project is closed");
    switch (c.operation) {
      case "project.propose":
        requireCondition(s.events.length === 0, "Project already exists");
        humanRequest(s, request(s.project, key(c.eventId), "start", c.brief, c.dueAt));
        break;
      case "project.amend":
        amend(s, c);
        break;
      case "project.revise_proposal":
        reviseProposal(s, c);
        break;
      case "project.close":
        proposeClose(s, c);
        break;
      case "task.dispatch":
        dispatch(s, c);
        this.scheduleReady(s);
        break;
      case "task.revise":
        reviseTask(s, c);
        this.scheduleReady(s);
        break;
      case "task.report_result":
        report(s, c);
        break;
      case "human.request":
        ask(s, c);
        break;
      case "human.respond":
        this.respond(s, caller, c);
        break;
      case "deadline.check":
        deadlines(s, this.#now());
        break;
    }
  }

  private validateResponse(s: AncSnapshot, caller: AncCaller, c: Command<"human.respond">) {
    const p = s.project;
    const r = p.requests[c.requestId];
    requireCondition(r && r.recipientId === caller.id, "Human request recipient mismatch");
    requireCondition(r.status === "pending" || r.status === "blocked", "Human request is no longer pending");
    const t = r.taskId ? task(s, r.taskId) : undefined;
    requireCondition(!t || !p.pendingBrief, "Resolve the project amendment before task feedback");
    requireCondition(
      c.subjectRevision === r.subjectRevision && r.subjectRevision === (t?.revision ?? p.revision),
      "Stale subject revision",
    );
    requireCondition(
      c.artifactRevision === r.artifactRevision &&
        (!r.artifactRevision || t?.artifact?.revision === r.artifactRevision),
      "Stale artifact approval",
    );
    requireCondition(
      c.decision !== "answer" || r.kind === "information" || r.kind === "action",
      "An acknowledgement is not approval",
    );
    requireCondition(
      c.decision !== "approve" || r.kind === "approval" || r.kind === "review",
      "Answer this request instead of approving it",
    );
    return { p, r, t };
  }

  private amendResponse(s: AncSnapshot, c: Command<"human.respond">): void {
    const p = s.project;
    if (c.decision === "approve") {
      requireCondition(p.pendingBrief, "Missing amendment");
      p.brief = p.pendingBrief;
      p.revision++;
      for (const work of Object.values(p.tasks)) {
        supersedeTaskRequests(s, work.id);
        work.revision++;
        work.status = "blocked";
      }
    }
    delete p.pendingBrief;
    wake(s, c.eventId);
  }

  private taskResponse(s: AncSnapshot, r: AncHumanRequest, t: AncTask, c: Command<"human.respond">): void {
    if (r.purpose === "task_review" && c.decision === "approve") {
      t.status = "approved";
      effect(s, r.id, "artifact.publish", { taskId: t.id, requestId: r.id });
    } else if (c.decision === "reject") {
      t.status = "blocked";
      wake(s, c.eventId);
    } else {
      t.revision++;
      t.status = "running";
      wake(s, c.eventId, t.id);
    }
  }

  private respond(s: AncSnapshot, caller: AncCaller, c: Command<"human.respond">): void {
    const { p, r, t } = this.validateResponse(s, caller, c);
    const statuses = {
      approve: "approved",
      changes: "changes_requested",
      reject: "rejected",
      answer: "answered",
    } as const;
    r.status = statuses[c.decision];
    r.response = c.text;
    expireRequestEffects(s, r.id);
    if (r.purpose === "amend") {
      this.amendResponse(s, c);
      return;
    }
    if (t) {
      this.taskResponse(s, r, t, c);
      return;
    }
    if (r.purpose === "start" && c.decision === "approve") {
      p.status = "active";
      effect(s, p.id, "group.create");
      return;
    }
    if (r.purpose === "close") {
      p.status = c.decision === "approve" ? "closed" : "active";
      if (p.status === "closed") {
        effect(s, p.id, "project.archive");
        return;
      }
    }
    wake(s, c.eventId);
  }
  scheduleReady(s: AncSnapshot): void {
    for (const t of Object.values(s.project.tasks)) {
      if (t.status !== "ready") continue;
      if (!t.dependencies.every((id) => s.project.tasks[id]?.status === "delivered")) continue;
      if (t.sessionId) {
        t.status = "running";
        wake(s, `${s.project.id}:${t.id}:${t.revision}`, t.id);
      } else effect(s, `${s.project.id}:${t.id}:${t.revision}`, "session.create", { taskId: t.id });
    }
  }

  async completeEffect(projectId: string, effectId: string, receipt: string): Promise<void> {
    await this.store.transact(projectId, async (s) => {
      requireCondition(s, "Unknown project");
      const e = s.effects[effectId];
      requireCondition(e && (e.status === "running" || e.status === "unknown"), "Effect is not in flight");
      requireCondition(receipt.length > 0, "Missing provider receipt");
      e.status = "succeeded";
      e.receipt = receipt;
      if (!ancEffectIsCurrent(s, e)) return { snapshot: s, result: undefined };
      this.applyReceipt(s, e, receipt);
      return { snapshot: s, result: undefined };
    });
  }

  private applyReceipt(s: AncSnapshot, e: AncEffect, receipt: string): void {
    const p = s.project;
    if (e.kind === "group.create") {
      p.groupId = receipt;
      effect(s, p.id, "session.create");
    } else if (e.kind === "session.create") {
      if (e.taskId) {
        const t = task(s, e.taskId);
        t.sessionId = receipt;
        t.status = "running";
      } else p.sessionId = receipt;
      wake(s, e.id, e.taskId);
    } else if (e.kind === "human.send" && e.requestId) {
      const r = p.requests[e.requestId];
      requireCondition(r, "Missing human request");
      r.receipt = receipt;
    } else if (e.kind === "artifact.publish" && e.taskId) {
      task(s, e.taskId).status = "delivered";
      this.scheduleReady(s);
      wake(s, e.id);
    }
  }
}
