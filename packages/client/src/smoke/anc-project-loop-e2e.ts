import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRuntimeFactory } from "../agent-runtime/types.js";
import { localArtifactVerifier } from "../anc/artifacts.js";
import { AncEffectRunner } from "../anc/effect-runner.js";
import { AncProjectLoop } from "../anc/project-loop.js";
import type { AncEffect, AncHumanRequest, AncSnapshot } from "../anc/schemas.js";
import { AncSessionDriver } from "../anc/session-driver.js";
import { AncFileStore } from "../anc/store.js";
import { CodexAgentRuntimeFactory } from "../providers/codex/agent-runtime.js";
import { ensurePrivateDirectory, writeDurableJson } from "../storage/durable-file.js";

// Explicit live model test. Human replies and Feishu receipts below are SIMULATED.
// It must never be reported as client delivery, human identity, or production acceptance.
const root = resolve(process.env.ANC_SMOKE_DIRECTORY ?? "/tmp/anc-v4-loop-evidence");
await ensurePrivateDirectory(root, root);
const directory = await mkdtemp(join(root, "loop-"));
const projectId = "native-loop-test";
const loop = new AncProjectLoop(new AncFileStore(join(directory, "state")), {
  verifyArtifact: localArtifactVerifier(directory),
});
const abort = new AbortController();
const timer = setTimeout(() => abort.abort("smoke_deadline"), 20 * 60 * 1000);
const native = new CodexAgentRuntimeFactory({ clientVersion: "anc-v4-loop-smoke" });
const factory: AgentRuntimeFactory = {
  manifest: native.manifest,
  probe: (request) => native.probe(request),
  create: (request) => native.create({ ...request, policy: { ...request.policy, network: "disabled" } }),
  resume: (request) => native.resume({ ...request, policy: { ...request.policy, network: "disabled" } }),
};
const events: { projectId: string; taskId?: string; type: string }[] = [];
const driver = new AncSessionDriver(loop, {
  directory: join(directory, "sessions"),
  workspaceRoot: join(directory, "work"),
  factory,
  configuration: { model: process.env.ANC_SMOKE_MODEL ?? "gpt-6-astra", reasoningEffort: "medium" },
  signal: abort.signal,
  onEvent: async (id, taskId, event) => {
    events.push({ projectId: id, taskId, type: event.type });
  },
});
const simulatedReceipts = new Map<string, string>();
const sideEffects: { id: string; kind: string; taskId?: string }[] = [];
const perform = async (effect: AncEffect, snapshot: AncSnapshot): Promise<string> => {
  if (effect.kind === "session.create") return driver.create(effect);
  if (effect.kind === "session.wake") return driver.wake(effect, snapshot);
  sideEffects.push({ id: effect.id, kind: effect.kind, taskId: effect.taskId });
  const receipt = `SIMULATED_${effect.kind}_${effect.id}`;
  simulatedReceipts.set(effect.id, receipt);
  return receipt;
};
const runner = new AncEffectRunner(loop, {
  perform,
  lookup: async (effect, snapshot) =>
    effect.kind.startsWith("session.") ? driver.lookup(effect, snapshot) : simulatedReceipts.get(effect.id),
});
const simulatedHuman = { kind: "human" as const, id: "simulated-reviewer", projectIds: [projectId] };
let posterChanged = false;
let coursewareDeliveredWhilePosterWaited = false;
const humanEvents: { requestId: string; decision: string; taskId?: string }[] = [];

async function respond(request: AncHumanRequest, decision: "approve" | "changes" | "answer", text: string) {
  await loop.execute(simulatedHuman, {
    operation: "human.respond",
    projectId,
    eventId: `human_${request.id}`,
    requestId: request.id,
    subjectRevision: request.subjectRevision,
    artifactRevision: request.artifactRevision,
    decision,
    text,
  });
  humanEvents.push({ requestId: request.id, decision, taskId: request.taskId });
}

async function serviceRequests(snapshot: AncSnapshot): Promise<void> {
  for (const request of Object.values(snapshot.project.requests)) {
    if (request.status !== "pending" || !request.receipt) continue;
    if (request.taskId === "poster" && request.purpose === "task_review" && !posterChanged) {
      if (snapshot.project.tasks.courseware?.status !== "delivered") continue;
      coursewareDeliveredWhilePosterWaited = true;
      posterChanged = true;
      await respond(
        request,
        "changes",
        "Change the visible poster title to Beijing Camp - Reviewed Test. Keep date and location explicitly unconfirmed. Produce a new artifact revision, validate the file and report it again.",
      );
    } else if (request.kind === "information" || request.kind === "action") {
      await respond(
        request,
        "answer",
        "This is an isolated fixture. Date and venue remain unconfirmed placeholders; perform no real-world action. Complete the local test artifacts only.",
      );
    } else {
      await respond(
        request,
        "approve",
        "I am the simulated reviewer for this isolated test. Approve only the displayed test version/action; no real publication or commitment.",
      );
    }
  }
}

await loop.execute(
  { kind: "system", id: "isolated-test", projectIds: [projectId] },
  {
    operation: "project.propose",
    projectId,
    eventId: "proposal",
    title: "Beijing Camp protocol test - not a real event",
    brief:
      "Isolated orchestration test. As project owner, dispatch exactly two independent tasks with IDs poster and courseware. poster: create a simple but valid local SVG poster containing Beijing Camp - Test, and explicitly unconfirmed date and venue; validate SVG and calculate SHA256. courseware: create a local Markdown teaching outline with 3 short sections and a clearly marked test disclaimer; validate and calculate SHA256. No external publication, APIs, downloads, or real people. Workers should write files in their own workspaces then call anc_task_report_result with a file URL, real SHA256, validation evidence, a unique artifact revision and dueAt one day ahead. When human feedback arrives, revise the existing task rather than create a new task. After both artifacts are approved and delivered, propose project closure. Do not wait for another user prompt to continue.",
    dri: "simulated-reviewer",
    participants: ["simulated-reviewer"],
    dueAt: Date.now() + 86400000,
  },
);
let serviceFailure: unknown;
const service = runner.serve(abort.signal).catch((error: unknown) => {
  serviceFailure = error;
  abort.abort("effect_worker_failed");
});
let complete = false;
try {
  while (!abort.signal.aborted) {
    const snapshot = await loop.store.read(projectId);
    if (!snapshot) throw new Error("Missing native test project");
    await serviceRequests(snapshot);
    const archived = Object.values(snapshot.effects).some(
      (effect) => effect.kind === "project.archive" && effect.status === "succeeded",
    );
    if (snapshot.project.status === "closed" && archived) {
      complete = true;
      break;
    }
    await delay(500, undefined, { signal: abort.signal }).catch((error: unknown) => {
      if (!abort.signal.aborted) throw error;
    });
  }
} finally {
  abort.abort("smoke_finished");
  clearTimeout(timer);
  await service;
  const snapshot = await loop.store.read(projectId);
  await writeDurableJson(join(directory, "evidence.json"), {
    scope: "real Codex project/worker executions; simulated human identities and Feishu receipts",
    feishuTested: false,
    complete,
    posterChanged,
    coursewareDeliveredWhilePosterWaited,
    serviceFailed: Boolean(serviceFailure),
    humanEvents,
    sideEffects,
    events,
    snapshot,
  });
  console.log(
    JSON.stringify({ directory, complete, posterChanged, coursewareDeliveredWhilePosterWaited, feishuTested: false }),
  );
}
if (!complete || !posterChanged || !coursewareDeliveredWhilePosterWaited || serviceFailure)
  throw new Error("Native orchestration smoke did not satisfy all acceptance checks; inspect retained evidence");
