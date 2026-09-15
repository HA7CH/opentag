import { lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyIsolatedPiConfig, PI_CONFIG_WHITELIST, removeIsolatedPiConfig } from "../runner/config.js";

const directories: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}
describe("isolated Pi config copy", () => {
  it("copies only the whitelist and can filter a provider", async () => {
    const source = await temp("opentag-pi-cfg-src-");
    const destination = join(await temp("opentag-pi-cfg-dst-"), "pi");
    await writeFile(
      join(source, "auth.json"),
      `${JSON.stringify({ deepseek: { type: "api_key", key: "secret" }, openai: { type: "api_key", key: "other" } })}\n`,
    );
    await writeFile(
      join(source, "models.json"),
      `${JSON.stringify({
        models: [
          { id: "a", provider: "deepseek" },
          { id: "b", provider: "openai" },
        ],
      })}\n`,
    );
    await writeFile(join(source, "sessions.jsonl"), "nope\n");
    await writeFile(
      join(source, "settings.json"),
      `${JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-v4.1-flash-expires-on-0910", defaultThinkingLevel: "max", theme: "dark" })}\n`,
    );
    await copyIsolatedPiConfig({ destination, source, providers: ["deepseek"] });
    expect(PI_CONFIG_WHITELIST).toEqual(["auth.json", "models.json", "settings.json"]);
    const auth = JSON.parse(await readFile(join(destination, "auth.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(auth)).toEqual(["deepseek"]);
    const models = JSON.parse(await readFile(join(destination, "models.json"), "utf8")) as {
      models: Array<{ provider: string }>;
    };
    expect(models.models).toEqual([{ id: "a", provider: "deepseek" }]);
    expect(JSON.parse(await readFile(join(destination, "settings.json"), "utf8"))).toEqual({
      defaultProvider: "deepseek",
      defaultModel: "deepseek-v4.1-flash-expires-on-0910",
      defaultThinkingLevel: "max",
    });
    await expect(lstat(join(destination, "sessions.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink source and relative paths", async () => {
    const root = await temp("opentag-pi-cfg-link-");
    const real = join(root, "real");
    await mkdir(real);
    await symlink(real, join(root, "link"));
    await expect(
      copyIsolatedPiConfig({ source: join(root, "link"), destination: join(root, "dst"), providers: ["deepseek"] }),
    ).rejects.toThrow(/real directory/);
    await expect(
      copyIsolatedPiConfig({ source: "relative", destination: "/tmp/x", providers: ["deepseek"] }),
    ).rejects.toThrow(/absolute/);
    await expect(copyIsolatedPiConfig({ source: real, destination: join(root, "dst"), providers: [] })).rejects.toThrow(
      /provider filter/,
    );
  });

  it("rejects a preexisting destination, a planted destination symlink, and ancestor symlinks", async () => {
    const root = await temp("opentag-pi-cfg-pre-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "auth.json"), `${JSON.stringify({ deepseek: { type: "api_key", key: "x" } })}\n`);
    const outside = join(root, "outside.json");
    await writeFile(outside, "untouched\n");

    // Preexisting destination directory is rejected outright.
    const existing = join(root, "existing");
    await mkdir(existing);
    await expect(copyIsolatedPiConfig({ destination: existing, source, providers: ["deepseek"] })).rejects.toThrow(
      /fresh/,
    );

    // A planted destination symlink can never redirect writes outside.
    const planted = join(root, "planted");
    await symlink(outside, planted);
    await expect(copyIsolatedPiConfig({ destination: planted, source, providers: ["deepseek"] })).rejects.toThrow(
      /fresh/,
    );
    expect(await readFile(outside, "utf8")).toBe("untouched\n");

    // A symlinked destination parent is rejected even when the leaf is fresh.
    const realParent = join(root, "real-parent");
    await mkdir(realParent);
    const aliasParent = join(root, "alias-parent");
    await symlink(realParent, aliasParent);
    await expect(
      copyIsolatedPiConfig({ destination: join(aliasParent, "pi"), source, providers: ["deepseek"] }),
    ).rejects.toThrow(/real directory/);
  });

  it("rejects physical overlap with the source and shell-command indirections, cleaning partial copies", async () => {
    const root = await temp("opentag-pi-cfg-over-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "auth.json"), `${JSON.stringify({ deepseek: { type: "api_key", key: "x" } })}\n`);
    await expect(
      copyIsolatedPiConfig({ destination: join(source, "nested"), source, providers: ["deepseek"] }),
    ).rejects.toThrow(/overlaps/);

    const evil = join(root, "evil");
    await mkdir(evil);
    await writeFile(
      join(evil, "auth.json"),
      `${JSON.stringify({ deepseek: { type: "api_key", key: "!security find-generic-password" } })}\n`,
    );
    const destination = join(root, "dst");
    await expect(copyIsolatedPiConfig({ destination, source: evil, providers: ["deepseek"] })).rejects.toThrow(
      /shell-command credential indirection/,
    );
    // The rejected copy must not leave a partial destination behind.
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips whitelisted documents that are absent and removes copies on demand", async () => {
    const root = await temp("opentag-pi-cfg-sparse-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "auth.json"), `${JSON.stringify({ deepseek: { type: "api_key", key: "x" } })}\n`);
    const destination = join(root, "dst");
    await copyIsolatedPiConfig({ destination, source, providers: ["deepseek"] });
    // Only auth.json existed; the other whitelisted names are skipped, not invented.
    await expect(readdir(destination)).resolves.toEqual(["auth.json"]);
    await removeIsolatedPiConfig(destination);
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a destination whose parent does not exist", async () => {
    const root = await temp("opentag-pi-cfg-noparent-");
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "auth.json"), `${JSON.stringify({ deepseek: { type: "api_key", key: "x" } })}\n`);
    await expect(
      copyIsolatedPiConfig({ destination: join(root, "missing", "dst"), source, providers: ["deepseek"] }),
    ).rejects.toThrow(/existing real directory/);
  });
});
