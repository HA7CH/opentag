import { createHash } from "node:crypto";
import type { AncFeishuGateway, AncFeishuReference } from "./feishu-gateway.js";
import type { AncProjectLoop } from "./project-loop.js";
import type { AncCommand, AncHumanRequest, AncSnapshot } from "./schemas.js";

type HumanMessage = Awaited<ReturnType<AncFeishuGateway["verifyHuman"]>>;
type Decision = Extract<AncCommand, { operation: "human.respond" }>["decision"];
export type AncFeedbackResult =
  | { status: "applied"; projectId: string; requestId: string }
  | { status: "acknowledged" | "clarify" | "unmatched" | "stale" };

const ACKNOWLEDGEMENTS = new Set(["收到", "已收到", "知道了", "谢谢", "received", "noted", "thanks"]);
const APPROVALS = new Set(["批准", "同意", "确认通过", "认可当前方向", "可以", "可以了", "approve", "approved"]);
function normalized(text: string): string {
  return text
    .trim()
    .replace(/[。.!！]+$/u, "")
    .toLowerCase();
}
function decisionFor(request: AncHumanRequest, text: string): Decision | undefined {
  const exact = normalized(text);
  if (/^(拒绝|不同意|reject)(?:$|[:：]\s*\S)/iu.test(text.trim())) return "reject";
  if (/^(修改|需要修改|建议修改|changes?)[:：]\s*\S/iu.test(text.trim())) return "changes";
  if (request.kind === "information") return "answer";
  if (request.kind === "action") return /^(完成|已完成|done)[:：]\s*\S/iu.test(text.trim()) ? "answer" : undefined;
  return APPROVALS.has(exact) ? "approve" : undefined;
}
function eventId(message: HumanMessage): string {
  return (
    "reply_" +
    createHash("sha256")
      .update(JSON.stringify([message.tenantKey, message.appId, message.actorId, message.messageId]))
      .digest("hex")
  );
}
function anchor(text: string): { requestId?: string; body: string } {
  const explicit = /^#确认:([A-Za-z0-9_-]{1,96})\s+([\s\S]+)$/u.exec(text.trim());
  return { requestId: explicit?.[1], body: explicit?.[2] ?? text };
}
function matches(
  snapshots: readonly AncSnapshot[],
  message: HumanMessage,
  requestId?: string,
): { snapshot: AncSnapshot; request: AncHumanRequest }[] {
  return snapshots.flatMap((snapshot) => {
    if (!snapshot.project.participants.includes(message.actorId)) return [];
    return Object.values(snapshot.project.requests)
      .filter(
        (request) =>
          request.recipientId === message.actorId &&
          Boolean(request.receipt) &&
          (!requestId || request.id === requestId) &&
          (!message.parentId || request.receipt === message.parentId),
      )
      .map((request) => ({ snapshot, request }));
  });
}

/**
 * The gateway re-fetches the exact allowed message before any state mutation.
 * Approval is never inferred by a model or from a global last-active project.
 * This handler sends nothing; its caller owns the one visible reply.
 */
export class AncFeishuFeedback {
  constructor(
    readonly loop: AncProjectLoop,
    readonly gateway: Pick<AncFeishuGateway, "verifyHuman">,
  ) {}

  async accept(reference: AncFeishuReference, signal?: AbortSignal): Promise<AncFeedbackResult> {
    const message = await this.gateway.verifyHuman(reference, signal);
    const { requestId, body } = anchor(message.text);
    if (ACKNOWLEDGEMENTS.has(normalized(body))) return { status: "acknowledged" };
    if (!requestId && !message.parentId)
      return { status: APPROVALS.has(normalized(body)) || message.text.startsWith("#确认") ? "clarify" : "unmatched" };
    const snapshots: AncSnapshot[] = [];
    for (const id of await this.loop.store.ids()) {
      const snapshot = await this.loop.store.read(id);
      if (snapshot) snapshots.push(snapshot);
    }
    const candidates = matches(snapshots, message, requestId);
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (!only) return { status: "clarify" };
    const { snapshot, request } = only;
    const decision = decisionFor(request, body);
    if (!decision) return { status: "clarify" };
    const id = eventId(message);
    const duplicate = snapshot.events.some((event) => event.id === id);
    if (!duplicate && request.status !== "pending" && request.status !== "blocked") return { status: "stale" };
    const projectId = snapshot.project.id;
    // The loop atomically checks recipient, current task/scope/artifact revision,
    // command identity, and exact artifact bytes before recording an approval.
    await this.loop.execute(
      { kind: "human", id: message.actorId, projectIds: [projectId] },
      {
        operation: "human.respond",
        projectId,
        eventId: id,
        requestId: request.id,
        subjectRevision: request.subjectRevision,
        artifactRevision: request.artifactRevision,
        decision,
        text: body,
      },
    );
    return { status: "applied", projectId, requestId: request.id };
  }
}
