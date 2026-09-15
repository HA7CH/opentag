import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isCredentialPath,
  isInsideRoot,
  listStagedRelativeFiles,
  stageRunnerBuildContext,
} from "../runner/build-context.mjs";

async function fixture() {
  const source = await mkdtemp(join(tmpdir(), "opentag-ctx-src-"));
  const dest = await mkdtemp(join(tmpdir(), "opentag-ctx-dst-"));
  await writeFile(join(source, "keep.txt"), "ok\n");
  await mkdir(join(source, "src"));
  await writeFile(join(source, "src/index.ts"), "export {}\n");
  return { source, dest };
}

test("staged context copies the allowlist and omits identity-only extras", async () => {
  const { source, dest } = await fixture();
  try {
    await rm(dest, { recursive: true, force: true });
    await stageRunnerBuildContext({
      sourceRoot: source,
      destination: dest,
      allowlist: ["keep.txt", "src"],
      identity: { version: "0.0.5" },
    });
    const files = listStagedRelativeFiles(dest);
    assert.ok(files.includes("keep.txt"));
    assert.ok(files.includes("src/index.ts"));
    assert.ok(files.includes("runner-identity.json"));
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test("symlinks and credential files are rejected even in-root", async () => {
  const { source, dest } = await fixture();
  try {
    await writeFile(join(source, "src/auth.json"), '{"token":"x"}\n');
    await rm(dest, { recursive: true, force: true });
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["src"] }),
      /credential/,
    );
    assert.equal(isCredentialPath("src/auth.json"), true);
    await symlink(join(source, "keep.txt"), join(source, "link"));
    await rm(dest, { recursive: true, force: true });
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["link"] }),
      /symlink/,
    );
    assert.equal(isInsideRoot(source, join(source, "keep.txt")), true);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test("denied names cannot be allowlisted and destinations cannot be reused", async () => {
  const { source, dest } = await fixture();
  try {
    await writeFile(join(source, ".env"), "SECRET=1\n");
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: [".env"] }),
      /denied/,
    );
    await writeFile(join(dest, "already"), "nope\n");
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["keep.txt"] }),
      /not empty/,
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test("symlink ancestor directories cannot smuggle outside files into the context", async () => {
  const { source, dest } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "opentag-ctx-out-"));
  try {
    await writeFile(join(outside, "code.ts"), "export const leaked = true\n");
    await symlink(outside, join(source, "src", "nested"));
    // Leaf lstat sees a regular file; the symlinked ancestor must still be rejected.
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["src/nested/code.ts"] }),
      /symlink ancestor/,
    );
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    // The symlinked directory itself stays rejected when allowlisted or scanned.
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["src/nested"] }),
      /symlink/,
    );
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: dest, allowlist: ["src"] }),
      /symlink/,
    );
    const staged = listStagedRelativeFiles(dest);
    assert.equal(
      staged.some((file) => file.includes("code.ts")),
      false,
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("destination symlink and physical overlap with the source tree are rejected", async () => {
  const { source, dest } = await fixture();
  const alias = await mkdtemp(join(tmpdir(), "opentag-ctx-alias-"));
  try {
    const linked = join(alias, "linked-dest");
    await symlink(dest, linked);
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: linked, allowlist: ["keep.txt"] }),
      /symlink/,
    );
    // A destination physically inside the canonical source tree is rejected even through an alias.
    const inner = join(source, "staged");
    await mkdir(inner, { recursive: true });
    assert.throws(
      () => stageRunnerBuildContext({ sourceRoot: source, destination: inner, allowlist: ["keep.txt"] }),
      /source tree/,
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
    await rm(alias, { recursive: true, force: true });
  }
});
