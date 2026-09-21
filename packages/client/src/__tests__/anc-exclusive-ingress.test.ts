import { randomUUID } from "node:crypto";
import type { DirectImMessageDeliveryRequest, RuntimeImSteerRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentTurnRunner, type ExclusiveImTurnHandler } from "../runtime/agent-turn-runner.js";
import type { SessionBindingStore } from "../runtime/session-binding-store.js";
import type { SessionRuntimeManager } from "../runtime/session-runtime-manager.js";
import type { LiveTurnOwner } from "../runtime/turn-custody-owner.js";
import type { TurnReportOwner } from "../runtime/turn-report-owner.js";
import { recordingLogger } from "./recording-logger.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(handler?: ExclusiveImTurnHandler) {
  const request: DirectImMessageDeliveryRequest = {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: "delivery_1",
    imMessageId: randomUUID(),
    sessionId: "session_1",
    agentId: "agent_1",
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "A test project",
      providerRef: {
        provider: "feishu",
        teamBrand: "feishu",
        appId: "app_1",
        botOpenId: "bot_1",
        chatId: "chat_1",
        messageId: "message_1",
      },
    },
    runtime: {
      revision: {
        agent: { sequence: 1, id: "agent_revision" },
        session: { sequence: 1, id: "session_revision" },
      },
      agentId: "agent_1",
      provider: "codex",
      instructions: { platform: "private platform instructions", agent: "private agent instructions" },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: "workspace_1", mode: "empty_on_create", sharing: "agent" },
    },
  };
  const owner: LiveTurnOwner = {
    inputHash: "a".repeat(64),
    request,
    turnId: "turn_1",
    reservation: {} as LiveTurnOwner["reservation"],
  };
  const credentials = {
    prepare: vi.fn(async () => ({ path: "/fixture/env", provider: "feishu" as const })),
    cleanup: vi.fn(async () => undefined),
  };
  const plan = { prepare: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined) };
  const prompt = vi.fn(async () => ({ runId: "turn_1", status: "completed", output: [] }));
  const ensureRuntime = vi.fn(async () => ({ prompt }));
  const report = vi.fn((input: Parameters<TurnReportOwner["create"]>[0]) => ({
    ...input,
    type: "turn:report" as const,
    requestId: randomUUID(),
    resultHash: "c".repeat(64),
  }));
  const submit = vi.fn(async () => undefined);
  const runner = new AgentTurnRunner({
    exclusiveTurns: handler,
    bindingStore: {
      updateUnresolved: vi.fn(async () => undefined),
      getSteerReceipt: vi.fn(async () => undefined),
    } as unknown as SessionBindingStore,
    connection: { send: vi.fn(async () => undefined), capabilityVersion: () => 2 },
    custody: { markReporting: vi.fn(async () => undefined), recordResult: vi.fn(async () => undefined) },
    reportOwner: { create: report, submit } as unknown as TurnReportOwner,
    credentialEnvironment: credentials,
    turnPlan: plan,
    runtimeManager: {
      sessionKind: () => "visible",
      ensureRuntime,
      cwd: () => "/fixture",
      observe: () => () => undefined,
    } as unknown as SessionRuntimeManager,
    logger: recordingLogger([]),
  });
  return { runner, owner, request, credentials, plan, prompt, ensureRuntime, report, submit };
}
function noLegacy(h: ReturnType<typeof setup>) {
  expect(h.credentials.prepare).not.toHaveBeenCalled();
  expect(h.credentials.cleanup).not.toHaveBeenCalled();
  expect(h.plan.prepare).not.toHaveBeenCalled();
  expect(h.plan.cleanup).not.toHaveBeenCalled();
  expect(h.ensureRuntime).not.toHaveBeenCalled();
}

describe("exclusive IM input custody", () => {
  it("does not report successful turn completion when shutdown follows a durable acceptance", async () => {
    const gate = deferred<void>();
    const accept = vi.fn(() => gate.promise);
    const h = setup({ owns: () => true, accept });
    h.runner.start(h.owner);
    await vi.waitFor(() => expect(accept).toHaveBeenCalledOnce());
    h.runner.stop();
    gate.resolve();
    await h.runner.settled();
    noLegacy(h);
    expect(h.report).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "cancelled",
        executionEffects: "may_have_occurred",
        errorReason: "client_shutdown",
      }),
    );
  });

  it("waits for durable acceptance without preparing a second model or CLI reply path", async () => {
    const gate = deferred<void>();
    const handler = { owns: vi.fn(() => true), accept: vi.fn(() => gate.promise) };
    const h = setup(handler);
    h.runner.start(h.owner);
    await vi.waitFor(() => expect(handler.accept).toHaveBeenCalledOnce());
    expect(handler.accept).toHaveBeenCalledWith(h.request, expect.any(AbortSignal));
    expect(h.runner.activeCount).toBe(1);
    expect(h.report).not.toHaveBeenCalled();
    noLegacy(h);
    gate.resolve();
    await h.runner.settled();
    expect(h.report).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        executionEffects: "completed",
      }),
    );
    expect(h.report.mock.calls[0]?.[0].finalText).toBeUndefined();
    expect(h.report.mock.calls[0]?.[0].outgoingReplies).toBeUndefined();
    expect(h.submit).toHaveBeenCalledOnce();
    noLegacy(h);
  });

  it.each(["accept", "classify"] as const)("never falls back when %s fails", async (where) => {
    const h = setup({
      owns: () => {
        if (where === "classify") throw new Error("classification failed");
        return true;
      },
      accept: async () => {
        throw new Error("unknown durable write outcome");
      },
    });
    h.runner.start(h.owner);
    await h.runner.settled();
    noLegacy(h);
    expect(h.report).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "unknown",
        errorReason: "turn_state_unknown",
        executionEffects: "may_have_occurred",
      }),
    );
  });

  it("leaves non-pilot messages on the original path", async () => {
    const accept = vi.fn(async () => undefined);
    const h = setup({ owns: () => false, accept });
    h.runner.start(h.owner);
    await h.runner.settled();
    expect(accept).not.toHaveBeenCalled();
    expect(h.prompt).toHaveBeenCalledOnce();
    expect(h.credentials.prepare).toHaveBeenCalledOnce();
    expect(h.credentials.cleanup).toHaveBeenCalledOnce();
    expect(h.plan.prepare).toHaveBeenCalledOnce();
  });

  it("propagates shutdown to the handoff and waits for its durable outcome", async () => {
    const entered = deferred<AbortSignal>();
    const h = setup({
      owns: () => true,
      accept: async (_request, signal) => {
        entered.resolve(signal);
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    });
    h.runner.start(h.owner);
    const signal = await entered.promise;
    h.runner.stop();
    expect(signal.aborted).toBe(true);
    await h.runner.settled();
    noLegacy(h);
    expect(h.report).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "cancelled",
        errorReason: "client_shutdown",
      }),
    );
  });

  it("does not label an overlapping message as native-steered before acceptance", async () => {
    const gate = deferred<void>();
    const accept = vi.fn(() => gate.promise);
    const h = setup({ owns: () => true, accept });
    h.runner.start(h.owner);
    await vi.waitFor(() => expect(accept).toHaveBeenCalledOnce());
    const request: RuntimeImSteerRequest = {
      type: "im:steer",
      requestId: randomUUID(),
      deliveryId: "delivery_2",
      imMessageId: randomUUID(),
      sessionId: h.request.sessionId,
      agentId: h.request.agentId,
      placementGeneration: 1,
      rootDeliveryId: h.request.deliveryId,
      expectedTurnId: h.owner.turnId,
      attention: "direct",
      content: h.request.content,
    };
    await expect(h.runner.steer(request)).resolves.toMatchObject({ status: "retry", reason: "turn_starting" });
    gate.resolve();
    await h.runner.settled();
    await expect(h.runner.steer(request)).resolves.toMatchObject({ status: "deferred", reason: "turn_not_running" });
    noLegacy(h);
  });
});
