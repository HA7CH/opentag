import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent } from "../agent-runtime/types.js";
import {
  type AncPublicOutput,
  AncPublicOutputSchema,
  newAncPublicOutput,
  projectAncPublicEvent,
  renderAncPublicCards,
} from "../anc/public-output.js";

function start(
  id: string,
  phase?: "commentary" | "final_answer",
): Extract<AgentRuntimeEvent, { type: "message_started" }> {
  return { type: "message_started", runId: "run", messageId: id, phase };
}
function done(id: string, text: string, phase?: "commentary" | "final_answer"): AgentRuntimeEvent {
  return { type: "message_completed", runId: "run", messageId: id, text, phase };
}
function delta(id: string, text: string): AgentRuntimeEvent {
  return { type: "message_delta", runId: "run", messageId: id, delta: text };
}
function events(...values: AgentRuntimeEvent[]): AncPublicOutput {
  return values.reduce(projectAncPublicEvent, newAncPublicOutput("run"));
}
function terminal(type: "run_completed" | "run_failed"): AgentRuntimeEvent {
  return {
    type,
    runId: "run",
    result: { runId: "run", status: type === "run_completed" ? "completed" : "failed", output: [] },
  };
}

describe("ANC public output projection", () => {
  it("keeps commentary as progress and fills the same card with the actual answer", () => {
    const progress = events(start("p", "commentary"), done("p", "I will check.", "commentary"));
    expect(progress.cards).toHaveLength(1);
    expect(progress.cards[0]?.status).toBe("working");
    const result = [start("a", "final_answer"), delta("a", "A"), done("a", "Actual answer", "final_answer")].reduce(
      projectAncPublicEvent,
      progress,
    );
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]?.id).toBe(progress.cards[0]?.id);
    expect(result.cards[0]?.status).toBe("answered");
    const rendered = JSON.stringify(renderAncPublicCards(result, "Test"));
    expect(rendered).toContain("Actual answer");
    expect(rendered).toContain("I will check.");
    expect(rendered).not.toContain("Done");
    expect(rendered).not.toContain("Tools");
  });

  it("does not create a new card or expose user input merely because a request was steered", () => {
    const state = events(start("a", "final_answer"), delta("a", "draft"));
    const next = projectAncPublicEvent(state, {
      type: "input_accepted",
      runId: "run",
      input: { items: [{ type: "text", text: "private correction" }] },
    });
    expect(next).toBe(state);
    expect(JSON.stringify(renderAncPublicCards(next, "Test"))).not.toContain("private correction");
  });

  it("renders two actual answers independently even if B finishes before A", () => {
    const state = events(
      start("a", "final_answer"),
      delta("a", "A partial"),
      start("b", "final_answer"),
      delta("b", "B"),
      done("b", "B answer", "final_answer"),
    );
    expect(state.cards.map((card) => card.status)).toEqual(["working", "answered"]);
    const next = projectAncPublicEvent(state, done("a", "A answer", "final_answer"));
    expect(next.cards.map((card) => card.id)).toEqual(state.cards.map((card) => card.id));
    const cards = renderAncPublicCards(next, "Test");
    expect(JSON.stringify(cards[0])).toContain("A answer");
    expect(JSON.stringify(cards[0])).not.toContain("B answer");
    expect(JSON.stringify(cards[1])).toContain("B answer");
  });

  it("does not equate unknown legacy phase with business completion", () => {
    const state = events(
      start("legacy"),
      delta("legacy", "partial"),
      done("legacy", "Legacy text"),
      terminal("run_completed"),
    );
    expect(state.messages[0]?.phase).toBeUndefined();
    const card = JSON.stringify(renderAncPublicCards(state, "Test"));
    expect(card).toContain("Legacy text");
    expect(card).toContain("回复");
    expect(card).not.toContain("Done");
  });

  it("uses a phase learned only at item completion without creating another card", () => {
    const state = events(start("a"), delta("a", "answer"));
    const next = projectAncPublicEvent(state, done("a", "answer", "final_answer"));
    expect(next.cards[0]?.id).toBe(state.cards[0]?.id);
    expect(next.cards).toHaveLength(1);
  });

  it("never copies tool inputs, diagnostics or private reasoning into the projection", () => {
    const state = newAncPublicOutput("run");
    for (const event of [
      { type: "tool_started", runId: "run", toolCallId: "secret", name: "shell", input: { command: "private" } },
      {
        type: "provider_event",
        runId: "run",
        providerId: "codex",
        schemaVersion: 1,
        payload: { reasoning: "private" },
      },
      { type: "provider_warning", runId: "run", code: "secret", message: "private" },
    ] satisfies AgentRuntimeEvent[])
      expect(projectAncPublicEvent(state, event)).toBe(state);
    expect(renderAncPublicCards(state, "Test")).toEqual([]);
  });

  it("ends commentary-only runs as progress, not as a completed deliverable", () => {
    const state = events(start("p", "commentary"), done("p", "Checking", "commentary"), terminal("run_completed"));
    expect(state.cards[0]?.status).toBe("idle");
    expect(JSON.stringify(renderAncPublicCards(state, "Test"))).toContain("尚未产生正式回复");
  });

  it("marks unfinished output interrupted without invalidating an already emitted answer", () => {
    const state = events(
      start("a", "final_answer"),
      done("a", "first", "final_answer"),
      start("b", "final_answer"),
      delta("b", "partial"),
      terminal("run_failed"),
    );
    expect(state.cards.map((card) => card.status)).toEqual(["answered", "interrupted"]);
    expect(JSON.stringify(renderAncPublicCards(state, "Test"))).toContain("暂时中断");
  });

  it("ignores events from another run and rejects terminal or invalid lifecycle mutation", () => {
    const state = newAncPublicOutput("run");
    expect(projectAncPublicEvent(state, { ...start("a"), runId: "other" })).toBe(state);
    expect(projectAncPublicEvent(state, { type: "runtime_closed" })).toBe(state);
    expect(() => projectAncPublicEvent(state, delta("missing", "x"))).toThrow();
    const started = projectAncPublicEvent(state, start("a"));
    expect(() => projectAncPublicEvent(started, start("a"))).toThrow();
    expect(started.messages).toHaveLength(1);
    const finished = projectAncPublicEvent(started, done("a", "text"));
    expect(() => projectAncPublicEvent(finished, delta("a", "late"))).toThrow();
    const ended = projectAncPublicEvent(finished, terminal("run_completed"));
    expect(() => projectAncPublicEvent(ended, start("b"))).toThrow();
  });

  it("bounds previews, escapes mention markup and signals truncation", () => {
    const state = events(
      start("a", "final_answer"),
      done("a", `<at id=all></at>${"中".repeat(30000)}`, "final_answer"),
    );
    expect(state.messages[0]?.truncated).toBe(true);
    const rendered = JSON.stringify(renderAncPublicCards(state, "Test"));
    expect(rendered).not.toContain("<at");
    expect(rendered).toContain("节选");
    expect(Buffer.byteLength(rendered)).toBeLessThan(30000);
    const next = events(start("x"), delta("x", "a".repeat(20001)), delta("x", "later"));
    expect(next.messages[0]?.truncated).toBe(true);
  });

  it("can restore the validated projection and continue the same message/card identities", () => {
    const state = events(start("a", "final_answer"), delta("a", "first"));
    const restored = AncPublicOutputSchema.parse(JSON.parse(JSON.stringify(state)));
    const next = projectAncPublicEvent(restored, done("a", "finished", "final_answer"));
    expect(next.cards[0]?.id).toBe(state.cards[0]?.id);
    expect(state.messages[0]?.text).toBe("first");
  });

  it("honors authoritative commentary classification at completion", () => {
    const state = events(start("p", "final_answer"), done("p", "Only progress", "commentary"));
    expect(state.cards[0]?.answerId).toBeUndefined();
    expect(state.cards[0]?.status).toBe("working");
  });

  it("never overwrites an earlier final answer with later progress or a second legacy answer", () => {
    const state = events(
      start("a"),
      start("b"),
      done("a", "A"),
      done("b", "B"),
      start("p", "commentary"),
      done("p", "progress", "commentary"),
    );
    expect(state.cards).toHaveLength(3);
    expect(state.cards.map((card) => card.status)).toEqual(["answered", "answered", "working"]);
  });
});

it.each(["&", "😀", "中", "<"])("fits the provider byte budget after escaping %s", (character) => {
  const values: AgentRuntimeEvent[] = [];
  for (let i = 0; i < 6; i++)
    values.push(start(`p${i}`, "commentary"), done(`p${i}`, character.repeat(1000), "commentary"));
  values.push(start("answer", "final_answer"), done("answer", character.repeat(15000), "final_answer"));
  const rendered = renderAncPublicCards(events(...values), character.repeat(100));
  expect(rendered).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(rendered[0]?.card), "utf8")).toBeLessThanOrEqual(27000);
  expect(JSON.stringify(rendered)).toContain("节选");
});
