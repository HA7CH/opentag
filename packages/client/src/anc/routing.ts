import type { AncHumanRequest, AncSnapshot } from "./schemas.js";

export interface AncReplyAnchor {
  readonly actorId: string;
  readonly requestId?: string;
  readonly replyToMessageId?: string;
  readonly projectId?: string;
}
export type AncReplyRoute =
  | { readonly status: "matched"; readonly projectId: string; readonly request: AncHumanRequest }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly { projectId: string; requestId: string; question: string }[];
    }
  | { readonly status: "unmatched" };

/** Transport-authenticated actor + explicit anchors, never a global "last active project". */
export function routeAncHumanReply(anchor: AncReplyAnchor, snapshots: readonly AncSnapshot[]): AncReplyRoute {
  const matches = snapshots.flatMap((snapshot) => {
    const p = snapshot.project;
    if (p.status === "closed" || !p.participants.includes(anchor.actorId)) return [];
    if (anchor.projectId && p.id !== anchor.projectId) return [];
    return Object.values(p.requests)
      .filter((r) => r.recipientId === anchor.actorId && (r.status === "pending" || r.status === "blocked"))
      .filter((r) => !anchor.requestId || r.id === anchor.requestId)
      .filter((r) => !anchor.replyToMessageId || r.receipt === anchor.replyToMessageId)
      .map((request) => ({ projectId: p.id, request }));
  });
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only) return { status: "matched", ...only };
  if (matches.length === 0) return { status: "unmatched" };
  return {
    status: "ambiguous",
    candidates: matches.map((m) => ({ projectId: m.projectId, requestId: m.request.id, question: m.request.question })),
  };
}
