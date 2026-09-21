import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentRuntimeEvent, JsonValue } from "../agent-runtime/types.js";

const Phase = z.enum(["commentary", "final_answer"]);
const Message = z.object({
  id: z.string().min(1).max(256),
  cardId: z.string(),
  text: z.string().max(20000),
  phase: Phase.optional(),
  complete: z.boolean(),
  truncated: z.boolean(),
});
const Card = z.object({
  id: z.string(),
  answerId: z.string().optional(),
  status: z.enum(["working", "answered", "idle", "interrupted"]),
});
export const AncPublicOutputSchema = z.object({
  runId: z.string().min(1).max(256),
  status: z.enum(["running", "completed", "interrupted"]),
  messages: z.array(Message).max(256),
  cards: z.array(Card).max(128),
});
export type AncPublicOutput = z.infer<typeof AncPublicOutputSchema>;
type PublicMessage = z.infer<typeof Message>;
type PublicCard = z.infer<typeof Card>;

/** UI-only projection. Business completion and delivery are never inferred from these events.
 * The caller must persist snapshots/receipts before sending, and serialize event ingestion.
 * Tool events, raw reasoning, provider diagnostics and user input never enter the public view.
 */
export function newAncPublicOutput(runId: string): AncPublicOutput {
  return AncPublicOutputSchema.parse({ runId, status: "running", messages: [], cards: [] });
}

function createCard(state: AncPublicOutput, messageId: string): PublicCard {
  const id =
    "card_" +
    createHash("sha256")
      .update(JSON.stringify([state.runId, messageId]))
      .digest("hex")
      .slice(0, 24);
  const card: PublicCard = { id, status: "working" };
  state.cards.push(card);
  return card;
}

function startMessage(state: AncPublicOutput, id: string, phase?: PublicMessage["phase"]): PublicMessage {
  if (state.messages.some((message) => message.id === id)) throw new Error("Duplicate public message start");
  const card =
    state.cards.find((candidate) => candidate.status === "working" && !candidate.answerId) ?? createCard(state, id);
  if (phase === "final_answer") card.answerId = id;
  const message: PublicMessage = { id, cardId: card.id, text: "", phase, complete: false, truncated: false };
  state.messages.push(message);
  return message;
}

function setText(message: PublicMessage, text: string): void {
  message.truncated = text.length > 20000;
  message.text = text.slice(0, 20000);
  // Avoid persisting a split UTF-16 surrogate at the preview boundary.
  const last = message.text.charCodeAt(message.text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) message.text = message.text.slice(0, -1);
}

function completeMessage(state: AncPublicOutput, message: PublicMessage, phase: PublicMessage["phase"]): void {
  message.phase = phase ?? message.phase;
  message.complete = true;
  if (message.phase === "commentary") {
    const progressCard = state.cards.find((candidate) => candidate.id === message.cardId);
    if (progressCard?.answerId === message.id) delete progressCard.answerId;
    return;
  }
  let card = state.cards.find((candidate) => candidate.id === message.cardId);
  if (!card || (card.answerId && card.answerId !== message.id)) card = createCard(state, message.id);
  message.cardId = card.id;
  card.answerId = message.id;
  card.status = "answered";
}

function finishRun(state: AncPublicOutput, completed: boolean): void {
  state.status = completed ? "completed" : "interrupted";
  for (const card of state.cards) {
    if (card.status === "working") card.status = completed ? "idle" : "interrupted";
  }
}

function updateMessage(
  state: AncPublicOutput,
  event: Extract<AgentRuntimeEvent, { type: "message_delta" | "message_completed" }>,
): void {
  const message = state.messages.find((candidate) => candidate.id === event.messageId);
  if (!message || message.complete) throw new Error("Public message lifecycle mismatch");
  if (event.type === "message_delta") {
    const wasTruncated = message.truncated;
    setText(message, message.text + event.delta);
    message.truncated ||= wasTruncated;
    return;
  }
  setText(message, event.text);
  completeMessage(state, message, event.phase);
}

const PUBLIC_EVENT_TYPES = new Set([
  "message_started",
  "message_delta",
  "message_completed",
  "run_completed",
  "run_failed",
  "run_aborted",
  "run_cancelled",
]);

/** Call only with validated, ordered runtime events. Steer does not create a card. */
export function projectAncPublicEvent(previous: AncPublicOutput, event: AgentRuntimeEvent): AncPublicOutput {
  if (!("runId" in event) || event.runId !== previous.runId || !PUBLIC_EVENT_TYPES.has(event.type)) return previous;
  const state = AncPublicOutputSchema.parse(previous);
  if (state.status !== "running") throw new Error("Public output run is already terminal");
  if (event.type === "message_started") startMessage(state, event.messageId, event.phase);
  else if (event.type === "message_delta" || event.type === "message_completed") updateMessage(state, event);
  else finishRun(state, event.type === "run_completed");
  return AncPublicOutputSchema.parse(state);
}

function preview(text: string, limit: number): string {
  const clipped = text.length > limit ? `${text.slice(0, limit)}…（此处仅显示节选）` : text;
  // Never let model-authored markup manufacture a mention or person resource.
  return clipped.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const CARD_LABELS = { working: "正在处理", answered: "回复", interrupted: "暂时中断", idle: "进展" };
const EMPTY_TEXT = {
  working: "正在处理…",
  answered: "本轮未返回可显示的内容。",
  interrupted: "本次处理已中断，项目状态以待办和交付记录为准。",
  idle: "本轮进展已记录，尚未产生正式回复。",
};

function cardElements(state: AncPublicOutput, card: PublicCard, limit: number): JsonValue[] {
  const messages = state.messages.filter((message) => message.cardId === card.id);
  const answer = messages.find((message) => message.id === card.answerId);
  const progress = messages.filter((message) => message.id !== card.answerId && message.text).slice(-6);
  const elements: JsonValue[] = [];
  if (progress.length)
    elements.push({
      tag: "collapsible_panel",
      element_id: "progress",
      expanded: false,
      header: { title: { tag: "plain_text", content: "处理进展" } },
      elements: progress.map((message) => ({
        tag: "markdown",
        content: preview(message.text, Math.min(500, Math.floor(limit / 10))),
      })),
    });
  elements.push({
    tag: "markdown",
    element_id: "main_text",
    content: answer?.text ? preview(answer.text, limit) : EMPTY_TEXT[card.status],
  });
  return elements;
}

function renderCard(state: AncPublicOutput, card: PublicCard, title: string, limit: number): JsonValue {
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default", enable_forward: false },
    header: {
      title: { tag: "plain_text", content: title.slice(0, 60) },
      subtitle: { tag: "plain_text", content: CARD_LABELS[card.status] },
      template: card.status === "interrupted" ? "orange" : "blue",
    },
    body: { direction: "vertical", vertical_spacing: "8px", elements: cardElements(state, card, limit) },
  };
}

/** Card 2.0 data only; this function sends nothing and exposes no approval callbacks. */
export function renderAncPublicCards(input: AncPublicOutput, title: string): { id: string; card: JsonValue }[] {
  const state = AncPublicOutputSchema.parse(input);
  return state.cards.map((card) => {
    let limit = 5000;
    let content = renderCard(state, card, title, limit);
    // UTF-8 and escaped markup can exceed a character-count estimate.
    while (Buffer.byteLength(JSON.stringify(content), "utf8") > 27000 && limit > 128) {
      limit = Math.floor(limit / 2);
      content = renderCard(state, card, title, limit);
    }
    return { id: card.id, card: content };
  });
}
