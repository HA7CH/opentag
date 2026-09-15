import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageFilteredPiConfig } from "../e2e/runner-toolchain/pi-config-guard.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opentag-pi-guard-"));
  return {
    root,
    source: join(root, "config"),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeSource(source, files) {
  await mkdir(source, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(source, name), typeof value === "string" ? value : JSON.stringify(value));
  }
}

test("a narrow selected-provider directory stages with strict modes", async () => {
  const { source, cleanup } = await fixture();
  try {
    await writeSource(source, {
      "auth.json": { deepseek: { type: "api_key", key: "sk-test" } },
      "settings.json": { defaultProvider: "deepseek", defaultModel: "m", theme: "dark" },
      "models.json": { providers: { deepseek: { baseUrl: "https://example.invalid" } } },
    });
    const staged = stageFilteredPiConfig({ source, provider: "deepseek" });
    const stagedAuth = JSON.parse(await readFile(join(staged, "auth.json"), "utf8"));
    assert.deepEqual(Object.keys(stagedAuth), ["deepseek"]);
    const stagedSettings = JSON.parse(await readFile(join(staged, "settings.json"), "utf8"));
    assert.deepEqual(
      Object.keys(stagedSettings).sort(),
      ["defaultModel", "defaultProvider"],
      "unsafe settings keys are filtered",
    );
    assert.equal((await lstat(staged)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(staged, "auth.json"))).mode & 0o777, 0o600);
  } finally {
    await cleanup();
  }
});

test("non-selected provider auth entries are rejected, not copied", async () => {
  const { source, cleanup } = await fixture();
  try {
    await writeSource(source, { "auth.json": { anthropic: { type: "api_key", key: "x" } } });
    assert.throws(() => stageFilteredPiConfig({ source, provider: "deepseek" }), /outside the selected provider/);
  } finally {
    await cleanup();
  }
});

const REJECTION_CASES = [
  { name: "extra-file", files: { "auth.json": { deepseek: {} }, "notes.txt": "x" }, pattern: /unexpected entry/ },
  { name: "missing-auth", files: { "settings.json": {} }, pattern: /missing auth\.json/ },
  {
    name: "shell-indirection",
    files: { "auth.json": { deepseek: { type: "api_key", key: "!security find-generic-password" } } },
    pattern: /shell-command credential indirection/,
  },
  {
    name: "settings-shell-indirection",
    files: { "auth.json": { deepseek: {} }, "settings.json": { defaultModel: "!evil" } },
    pattern: /shell-command credential indirection/,
  },
  {
    name: "wrong-default-provider",
    files: { "auth.json": { deepseek: {} }, "settings.json": { defaultProvider: "openai" } },
    pattern: /outside the selected provider/,
  },
];

for (const { name, files, pattern } of REJECTION_CASES) {
  test(`rejects ${name}`, async () => {
    const { source, cleanup } = await fixture();
    try {
      await writeSource(source, files);
      assert.throws(() => stageFilteredPiConfig({ source, provider: "deepseek" }), pattern);
    } finally {
      await cleanup();
    }
  });
}

test("rejects symlink sources, symlink files, HOME, and invalid providers", async () => {
  const { root, source, cleanup } = await fixture();
  try {
    await writeSource(source, { "auth.json": { deepseek: {} } });
    const alias = join(root, "alias");
    await symlink(source, alias);
    assert.throws(() => stageFilteredPiConfig({ source: alias, provider: "deepseek" }), /symlink/);
    await symlink(join(source, "auth.json"), join(source, "models.json"));
    assert.throws(() => stageFilteredPiConfig({ source, provider: "deepseek" }), /regular file/);
    assert.throws(
      () => stageFilteredPiConfig({ source: homedir(), provider: "deepseek" }),
      /HOME|unexpected entry|missing auth/,
    );
    assert.throws(() => stageFilteredPiConfig({ source, provider: "deep seek" }), /invalid provider name/);
  } finally {
    await cleanup();
  }
});
