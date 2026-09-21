import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inventory } from "../anc-inventory.mjs";

test("ANC inventory hashes approved sources without promoting them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anc-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "project.md"), "Confirmed source");
  const result = await inventory([{ id: "projects", path: root }]);
  assert.equal(result.roots[0].status, "indexed");
  assert.equal(result.entries[0].sha256, createHash("sha256").update("Confirmed source").digest("hex"));
  assert.equal(result.entries[0].disposition, "pending-review");
  assert.equal(result.entries[0].category, "project-state");
  assert.equal(result.entries[0].reason, "indexed_not_migrated");
});

test("ANC inventory does not follow symlinks or hash credentials and caches", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "anc-inventory-boundary-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "source");
  await mkdir(root);
  await mkdir(join(root, "secrets"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(base, "outside.md"), "not in scope");
  await writeFile(join(root, ".env"), "private fixture");
  await writeFile(join(root, "auth.json"), "private fixture");
  await writeFile(join(root, "secrets", "plain.txt"), "private fixture");
  await writeFile(join(root, "node_modules", "cached.txt"), "cache");
  await symlink(join(base, "outside.md"), join(root, "linked.md"));
  const result = await inventory([{ id: "context", path: root }]);
  assert.equal(result.roots[0].files, 0);
  assert.equal(result.entries.length, 5);
  assert.ok(result.entries.every((entry) => entry.disposition === "excluded" && !("sha256" in entry)));
});

test("ANC inventory fails closed on missing or symlinked roots", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "anc-inventory-roots-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  await mkdir(root);
  await symlink(root, join(base, "alias"));
  const result = await inventory([
    { id: "missing", path: join(base, "missing") },
    { id: "alias", path: join(base, "alias") },
  ]);
  assert.ok(result.roots.every((entry) => entry.status === "incomplete"));
  assert.equal(result.entries.length, 0);
});
