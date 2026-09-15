import { describe, expect, it } from "vitest";
import { redactAcceptanceRecord } from "../runner/redact.js";

describe("acceptance redaction", () => {
  it("redacts secrets without hiding failure names", () => {
    const redacted = redactAcceptanceRecord({
      name: "model",
      status: "failed",
      detail: "DEEPSEEK_API_KEY=sk-secretvalue bearer sk-abcdefghijklmnopqrstuvwxyz token=abc",
      auth: { apiKey: "secret", nested: { password: "p" } },
    });
    expect(redacted.status).toBe("failed");
    expect(redacted.name).toBe("model");
    expect(JSON.stringify(redacted)).not.toMatch(/sk-secretvalue|secretvalue|token=abc/);
    expect(redacted.auth.apiKey).toBe("[redacted]");
    expect(redacted.detail).toMatch(/\[redacted\]/);
  });
});
