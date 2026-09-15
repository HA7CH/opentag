import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRunnerCli } from "../runner/cli.js";
import { RUNNER_IDENTITY_SCHEMA_VERSION } from "../runner/types.js";

const directories: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: {
      write(chunk: string) {
        stdout.push(chunk);
      },
      chunks: stdout,
    },
    stderr: {
      write(chunk: string) {
        stderr.push(chunk);
      },
      chunks: stderr,
    },
  };
}

describe("runner CLI entry", () => {
  it("exits nonzero for missing or invalid config without hanging", async () => {
    const missing = io();
    expect(await runRunnerCli([], missing)).toBe(2);
    expect(missing.stderr.chunks.join("")).toMatch(/missing command/);
    const cwd = await mkdtemp(join(tmpdir(), "opentag-runner-cli-"));
    directories.push(cwd);
    const identity = io();
    expect(await runRunnerCli(["identity"], identity, cwd)).toBe(1);
    expect(identity.stderr.chunks.join("")).toMatch(/identity file is missing/);
  });

  it("prints a stored identity record", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opentag-runner-id-"));
    directories.push(cwd);
    await writeFile(
      join(cwd, "identity.json"),
      `${JSON.stringify({
        schemaVersion: RUNNER_IDENTITY_SCHEMA_VERSION,
        channel: "prod",
        version: "0.0.5",
        sourceSha: "440dfed53c3bb22a8527cd731f82e9b9006bd9b5",
        sourceDirty: false,
        cliPackageName: "open-tag",
        nodeVersion: "v24.19.0",
        pnpmVersion: "10.12.1",
        piPackage: "@earendil-works/pi-coding-agent",
        piVersion: "0.84.2",
        contextTreeVersion: "0.1.14",
        toolLock: {
          node: "v24.19.0",
          pnpm: "10.12.1",
          piPackage: "@earendil-works/pi-coding-agent",
          piVersion: "0.84.2",
        },
      })}\n`,
    );
    const captured = io();
    expect(await runRunnerCli(["identity", "--json"], captured, cwd)).toBe(0);
    expect(captured.stdout.chunks.join("")).toMatch(/"version":"0.0.5"/);
  });
});
