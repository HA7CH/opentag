import { z } from "zod";
import type { JsonValue } from "../agent-runtime/types.js";

type JsonObject = { [key: string]: JsonValue };
function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unsupported ANC tool schema");
  return value;
}

/**
 * OpenTag supports a deliberately small cross-provider Schema subset. Project
 * constraints remain enforced by Zod in the handler; describe constraints that
 * cannot be expressed on the portable wire rather than weakening validation.
 */
export function portableAncSchema(schema: z.ZodObject): JsonValue {
  const json = JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: "input" }))) as JsonValue;
  return portable(object(json));
}

function portable(schema: JsonObject): JsonObject {
  if (typeof schema.type !== "string") throw new Error("ANC tool schemas require an explicit type");
  const output: JsonObject = { type: schema.type };
  const constraints = [
    "enum",
    "pattern",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "default",
  ];
  const details = constraints
    .filter((key) => schema[key] !== undefined)
    .map((key) => `${key}: ${JSON.stringify(schema[key])}`);
  if (schema.description) details.unshift(String(schema.description));
  if (details.length) output.description = details.join("; ");
  if (schema.type === "object") return portableObject(schema, output);
  if (schema.type === "array") output.items = portable(object(schema.items));
  return output;
}

function portableObject(schema: JsonObject, output: JsonObject): JsonObject {
  output.properties = Object.fromEntries(
    Object.entries(object(schema.properties ?? {})).map(([key, value]) => [key, portable(object(value))]),
  );
  if (schema.required) output.required = schema.required;
  output.additionalProperties = schema.additionalProperties !== false;
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    const valueType = object(schema.additionalProperties).type;
    output.description = [
      output.description,
      `Additional keys map to ${String(valueType)} values; runtime validates every entry.`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return output;
}
