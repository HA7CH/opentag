import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nodeImageReference, RUNNER_PINS, runnerResourceLimits } from "../runner/pins.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("pins come from existing Node/pnpm/CLI coordinates and do not use latest", async () => {
  const nodeVersion = (await readFile(join(repoRoot, "scripts/portable/node-version.txt"), "utf8")).trim();
  const root = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const cli = JSON.parse(await readFile(join(repoRoot, "apps/cli/package.json"), "utf8"));
  assert.equal(RUNNER_PINS.nodeVersion, nodeVersion);
  assert.equal(RUNNER_PINS.pnpmVersion, root.packageManager.replace(/^pnpm@/, ""));
  assert.equal(RUNNER_PINS.cliSourceVersion, cli.version);
  assert.equal(RUNNER_PINS.contextTreeVersion, cli.dependencies["@first-tree-ai/context-tree"]);
  assert.equal(RUNNER_PINS.piVersion, "0.84.2");
  assert.equal(RUNNER_PINS.image.platform, "linux/amd64");
  assert.match(RUNNER_PINS.image.digest, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(nodeImageReference(), /latest/);
  assert.equal(RUNNER_PINS.git.source, "node-image");
  assert.equal(RUNNER_PINS.git.probe, "git version 2.39.5");
  assert.equal(runnerResourceLimits().cpus, "1");
  assert.equal(runnerResourceLimits().memoryBytes, 1_073_741_824);
});

test("Pi lockfile pins 0.84.2 outside the workspace lock", async () => {
  const lock = JSON.parse(await readFile(join(repoRoot, "scripts/runner/pi/package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/@earendil-works/pi-coding-agent"].version, "0.84.2");
  for (const name of ["pi-agent-core", "pi-ai", "pi-client", "pi-protocol", "pi-telemetry", "pi-tui"]) {
    const pkg = lock.packages[`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/${name}`];
    assert.equal(pkg.version, "0.84.2");
    assert.match(pkg.integrity, /^sha512-/);
  }
  const dockerfile = await readFile(join(repoRoot, "scripts/runner/Dockerfile"), "utf8");
  assert.doesNotMatch(dockerfile, /COPY \./);
  assert.match(dockerfile, /\/usr\/sbin\/groupadd/);
  assert.match(dockerfile, /linux\/amd64|NODE_IMAGE/);
});
