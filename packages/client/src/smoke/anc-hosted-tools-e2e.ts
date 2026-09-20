import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentRuntime, AgentRuntimeEvent, CreateAgentRuntimeRequest } from "../agent-runtime/types.js";
import { localArtifactVerifier } from "../anc/artifacts.js";
import { createAncHostedTools } from "../anc/hosted-tools.js";
import { AncProjectLoop } from "../anc/project-loop.js";
import { AncFileStore } from "../anc/store.js";
import { CodexAgentRuntimeFactory } from "../providers/codex/agent-runtime.js";
import { ensurePrivateDirectory, writeDurableJson } from "../storage/durable-file.js";

// Explicit live test, not part of network-free unit tests. Retain evidence for review.
const root = resolve(process.env.ANC_SMOKE_DIRECTORY ?? "/tmp/anc-v4-native-evidence");
await ensurePrivateDirectory(root, root);
const directory = await mkdtemp(join(root, "run-"));
const loop = new AncProjectLoop(new AncFileStore(join(directory, "state")), {
  verifyArtifact: localArtifactVerifier(directory),
});
const projectId = "native-codex-protocol-test";
const events: { type: string; runId?: string }[] = [];
const factory = new CodexAgentRuntimeFactory({ clientVersion: "anc-v4-pilot" });
const request: CreateAgentRuntimeRequest = {
  workspace: { cwd: directory },
  configuration: { model: process.env.ANC_SMOKE_MODEL ?? "gpt-6-astra", reasoningEffort: "medium" },
  policy: { fileSystem: "read-only", network: "disabled", approvals: "never", tools: { mode: "provider-default" } },
  hostedTools: createAncHostedTools(loop, { projectId, sessionId: "native-test-owner" }),
  systemPrompt:
    "This is an isolated ANC protocol test. Follow the specified hosted-tool request exactly. Do not access files, run shell commands, create external resources, approve requests, or send messages.",
  eventSink: (event: AgentRuntimeEvent) => {
    events.push({ type: event.type, ...("runId" in event ? { runId: event.runId } : {}) });
  },
};
let runtime: AgentRuntime | undefined;
try {
  runtime = await factory.create(request);
  const binding = runtime.binding;
  if (!binding) throw new Error("Missing created binding");
  const first = await runtime.prompt({
    runId: "propose-live",
    signal: AbortSignal.timeout(180000),
    input: {
      items: [
        {
          type: "text",
          text: `Call anc_project_propose exactly once with title "Isolated protocol test", brief "Prepare a poster and courseware in a marked test only; no external publication.", dri "test-reviewer", participants ["test-reviewer"], roles {"poster-reviewer":"test-reviewer","courseware-reviewer":"test-reviewer"}, dueAt ${Date.now() + 86400000}. End immediately after the tool returns. Do not simulate approval.`,
        },
      ],
    },
  });
  if (first.status !== "completed") throw new Error(`Native tool turn failed: ${first.error?.code ?? first.status}`);
  const proposed = await loop.store.read(projectId);
  if (proposed?.project.status !== "proposed" || Object.keys(proposed.project.requests).length !== 1)
    throw new Error("Native tool did not persist exactly one proposal");
  await runtime.close();
  runtime = undefined;
  runtime = await factory.resume({ ...request, binding });
  if (JSON.stringify(runtime.binding) !== JSON.stringify(binding)) throw new Error("Resume changed the Codex thread");
  const second = await runtime.prompt({
    runId: "resume-live",
    signal: AbortSignal.timeout(180000),
    input: {
      items: [
        {
          type: "text",
          text: "Call anc_state and confirm the project is still proposed and waiting for test-reviewer. Do not issue any other tool call. Reply with ANC_V4_NATIVE_RESUME_OK.",
        },
      ],
    },
  });
  if (second.status !== "completed" || !second.output.some((x) => x.text.includes("ANC_V4_NATIVE_RESUME_OK")))
    throw new Error("Native resume did not verify state");
  const proof = {
    scope: "native Codex hosted tools and exact-thread resume only; no Feishu delivery",
    binding,
    firstStatus: first.status,
    secondStatus: second.status,
    proposalCount: 1,
    events,
  };
  await writeDurableJson(join(directory, "evidence.json"), proof);
  console.log(
    JSON.stringify({
      directory,
      firstStatus: first.status,
      secondStatus: second.status,
      events: events.length,
      feishuTested: false,
    }),
  );
} finally {
  await runtime?.close();
}
