import { z } from "zod";

export const AncId = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
const Text = z.string().trim().min(1).max(16000);
const Time = z.number().int().nonnegative();
export const AncArtifactSchema = z.object({
  title: Text,
  uri: Text,
  revision: AncId,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: z.array(Text).min(1).max(20),
});
export const AncTaskSchema = z.object({
  id: AncId,
  goal: Text,
  acceptance: z.array(Text).min(1).max(20),
  dependencies: z.array(AncId),
  reviewerRole: AncId.default("owner"),
  status: z.enum(["ready", "running", "waiting_human", "approved", "delivered", "blocked"]),
  revision: z.number().int().positive(),
  sessionId: Text.optional(),
  artifact: AncArtifactSchema.optional(),
});
export const AncHumanRequestSchema = z.object({
  id: AncId,
  taskId: AncId.optional(),
  recipientId: Text,
  kind: z.enum(["information", "review", "approval", "action"]),
  purpose: z.enum(["start", "amend", "close", "task_review", "question"]),
  question: Text,
  subjectRevision: z.number().int().positive(),
  artifactRevision: AncId.optional(),
  status: z.enum(["pending", "approved", "changes_requested", "answered", "rejected", "superseded", "blocked"]),
  dueAt: Time,
  followUpAt: Time,
  reminded: z.boolean(),
  receipt: Text.optional(),
  response: Text.optional(),
});
export const AncEffectSchema = z.object({
  id: AncId,
  projectId: AncId,
  taskId: AncId.optional(),
  requestId: AncId.optional(),
  kind: z.enum([
    "group.create",
    "session.create",
    "session.wake",
    "human.send",
    "human.remind",
    "artifact.publish",
    "project.archive",
  ]),
  status: z.enum(["pending", "running", "succeeded", "unknown", "failed", "cancelled"]),
  attempts: z.number().int().nonnegative(),
  reconciliationAttempts: z.number().int().nonnegative().optional(),
  /** A recovery wake must not recursively generate more recovery wakes. */
  recoveryOf: AncId.optional(),
  nextAttemptAt: Time,
  projectRevision: z.number().int().positive(),
  taskRevision: z.number().int().positive().optional(),
  artifactRevision: AncId.optional(),
  receipt: Text.optional(),
  error: Text.optional(),
});
export const AncProjectSchema = z.object({
  id: AncId,
  title: Text,
  brief: Text,
  dri: Text,
  participants: z.array(Text).min(1),
  roles: z.record(AncId, Text).default({}),
  status: z.enum(["proposed", "active", "closing", "closed"]),
  revision: z.number().int().positive(),
  pendingBrief: Text.optional(),
  groupId: Text.optional(),
  sessionId: Text.optional(),
  tasks: z.record(AncId, AncTaskSchema),
  requests: z.record(AncId, AncHumanRequestSchema),
});
export const AncSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  project: AncProjectSchema,
  effects: z.record(AncId, AncEffectSchema),
  events: z.array(z.object({ id: AncId, digest: z.string(), at: Time, operation: z.string() })),
});
const Base = z.object({ projectId: AncId, eventId: AncId });
export const AncCommandSchema = z.discriminatedUnion("operation", [
  Base.extend({
    operation: z.literal("project.propose"),
    title: Text,
    brief: Text,
    dri: Text,
    participants: z.array(Text).min(1),
    roles: z.record(AncId, Text).default({}),
    dueAt: Time,
  }),
  Base.extend({
    operation: z.literal("project.amend"),
    brief: Text,
    expectedRevision: z.number().int().positive(),
    dueAt: Time,
  }),
  Base.extend({ operation: z.literal("project.close"), dueAt: Time }),
  Base.extend({
    operation: z.literal("project.revise_proposal"),
    brief: Text,
    expectedRevision: z.number().int().positive(),
    dueAt: Time,
  }),
  Base.extend({
    operation: z.literal("task.dispatch"),
    taskId: AncId,
    goal: Text,
    acceptance: z.array(Text).min(1).max(20),
    dependencies: z.array(AncId).default([]),
    reviewerRole: AncId.default("owner"),
  }),
  Base.extend({
    operation: z.literal("task.revise"),
    taskId: AncId,
    expectedRevision: z.number().int().positive(),
    goal: Text,
    acceptance: z.array(Text).min(1).max(20),
  }),
  Base.extend({
    operation: z.literal("task.report_result"),
    taskId: AncId,
    expectedRevision: z.number().int().positive(),
    artifact: AncArtifactSchema,
    dueAt: Time,
  }),
  Base.extend({
    operation: z.literal("human.request"),
    requestId: AncId,
    taskId: AncId.optional(),
    recipientId: Text,
    kind: z.enum(["information", "review", "approval", "action"]),
    question: Text,
    dueAt: Time,
  }),
  Base.extend({
    operation: z.literal("human.respond"),
    requestId: AncId,
    subjectRevision: z.number().int().positive(),
    artifactRevision: AncId.optional(),
    decision: z.enum(["approve", "changes", "reject", "answer"]),
    text: Text,
  }),
  Base.extend({ operation: z.literal("deadline.check") }),
]);
export type AncCommand = z.infer<typeof AncCommandSchema>;
export type AncArtifact = z.infer<typeof AncArtifactSchema>;
export type AncProject = z.infer<typeof AncProjectSchema>;
export type AncTask = z.infer<typeof AncTaskSchema>;
export type AncHumanRequest = z.infer<typeof AncHumanRequestSchema>;
export type AncEffect = z.infer<typeof AncEffectSchema>;
export type AncSnapshot = z.infer<typeof AncSnapshotSchema>;

/** Caller identity must come from a trusted transport, never model-supplied arguments. */
export interface AncCaller {
  readonly kind: "agent" | "human" | "system";
  readonly id: string;
  readonly projectIds: readonly string[];
}
