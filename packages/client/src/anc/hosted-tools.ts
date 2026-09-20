import { createHash } from "node:crypto";
import type { z } from "zod";
import type { AgentHostedToolCall, AgentHostedTools, JsonValue } from "../agent-runtime/types.js";
import { portableAncSchema } from "./portable-schema.js";
import type { AncProjectLoop } from "./project-loop.js";
import { AncCommandSchema, type AncSnapshot } from "./schemas.js";

export interface AncAgentScope {
  readonly projectId: string;
  readonly sessionId: string;
  /** Absent only for the project owner. Set by the runtime, never by the model. */
  readonly taskId?: string;
}

function permitted(operation: string, scope: AncAgentScope): boolean {
  if (operation === "human.respond" || operation === "deadline.check") return false;
  if (!scope.taskId) return true;
  return operation === "task.report_result" || operation === "human.request";
}

function scopedInput(call: AgentHostedToolCall, scope: AncAgentScope): Record<string, JsonValue> {
  if (!call.input || typeof call.input !== "object" || Array.isArray(call.input))
    throw new Error("Expected command object");
  if (scope.taskId && call.input.taskId !== scope.taskId) throw new Error("Task scope mismatch");
  return call.input;
}

/** Worker visibility is task-scoped; the owner sees only its authorized project. */
export function ancAgentView(snapshot: AncSnapshot, scope: AncAgentScope): unknown {
  const deliveryIssues = Object.values(snapshot.effects)
    .filter((effect) => effect.status === "failed" || effect.status === "unknown")
    .filter((effect) => !scope.taskId || effect.taskId === scope.taskId)
    .map(({ id, kind, status, taskId, error, receipt }) => ({ id, kind, status, taskId, error, receipt }));
  if (!scope.taskId) return { project: snapshot.project, deliveryIssues };
  const task = snapshot.project.tasks[scope.taskId];
  if (!task) throw new Error("Unknown scoped task");
  return {
    project: { id: snapshot.project.id, title: snapshot.project.title, brief: snapshot.project.brief },
    task,
    deliveryIssues,
    humanRequests: Object.values(snapshot.project.requests).filter((r) => r.taskId === scope.taskId),
  };
}

/** No approval tool is exposed. Human identity must enter through a verified IM transport. */
export function createAncHostedTools(loop: AncProjectLoop, scope: AncAgentScope): AgentHostedTools {
  const operations = new Map(
    AncCommandSchema.options
      .filter((schema) => permitted(schema.shape.operation.value, scope))
      .map((schema) => [`anc_${schema.shape.operation.value.replaceAll(".", "_")}` as string, schema] as const),
  );
  return {
    definitions: [
      {
        name: "anc_state",
        description: "Read this project or assigned task and pending human feedback.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      ...[...operations].map(([name, schema]) => ({
        name,
        description: `Persist ${schema.shape.operation.value}. The runtime supplies project, event and actor identity.`,
        inputSchema: portableAncSchema(
          (schema as z.ZodObject).omit({ projectId: true, eventId: true, operation: true }),
        ),
      })),
    ],
    handler: async (call) => {
      try {
        if (call.signal.aborted) throw new Error("Tool call cancelled");
        if (call.name === "anc_state") {
          const snapshot = await loop.store.read(scope.projectId);
          return {
            success: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(snapshot ? ancAgentView(snapshot, scope) : { status: "not_proposed" }),
              },
            ],
          };
        }
        const schema = operations.get(call.name);
        if (!schema) throw new Error("Tool not available in this session");
        const input = scopedInput(call, scope);
        const eventId = createHash("sha256")
          .update(JSON.stringify([scope.sessionId, call.runId, call.toolCallId]))
          .digest("hex");
        const snapshot = await loop.execute(
          { kind: "agent", id: scope.sessionId, projectIds: [scope.projectId] },
          {
            ...input,
            projectId: scope.projectId,
            eventId,
            operation: schema.shape.operation.value,
          },
        );
        return { success: true, content: [{ type: "text", text: JSON.stringify(ancAgentView(snapshot, scope)) }] };
      } catch (error) {
        // Validation messages contain no file contents or transport credentials.
        const message = error instanceof Error ? error.message : "ANC tool rejected";
        return {
          success: false,
          content: [{ type: "text", text: message }],
          error: { code: "anc_command_rejected", message },
        };
      }
    },
  };
}
