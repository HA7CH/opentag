import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assembleClientRuntimeClosure,
  collectInstalledClosure,
  copyInstalledPackage,
  scanBarePackageImports,
} from "../runner/runtime-closure.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opentag-closure-"));
  return {
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("scanBarePackageImports collects bare, scoped, and dynamic imports only", async () => {
  const { root, cleanup } = await fixture();
  try {
    const dist = join(root, "dist");
    await mkdir(join(dist, "nested"), { recursive: true });
    await writeFile(
      join(dist, "index.mjs"),
      'import { z } from "zod";\nimport "@scope/side-effect";\nimport x from "./local.mjs";\nimport y from "node:fs";\nexport { z };\n',
    );
    await writeFile(join(dist, "nested", "chunk.mjs"), 'const p = import("pino");\nexport * from "@opentag/shared";\n');
    assert.deepEqual(scanBarePackageImports(dist), ["@opentag/shared", "@scope/side-effect", "pino", "zod"]);
  } finally {
    await cleanup();
  }
});

test("copyInstalledPackage honours literal files, skips missing entries, rejects symlinks", async () => {
  const { root, cleanup } = await fixture();
  try {
    const source = join(root, "pkg");
    await mkdir(join(source, "lib"), { recursive: true });
    await writeFile(join(source, "package.json"), '{"name":"pkg","version":"1.0.0"}');
    await writeFile(join(source, "index.js"), "module.exports = 1;\n");
    await writeFile(join(source, "lib", "util.js"), "module.exports = 2;\n");
    await writeFile(join(source, "secret.dev"), "nope\n");
    const dest = join(root, "out", "pkg");
    await copyInstalledPackage({
      root: source,
      manifest: { name: "pkg", version: "1.0.0", files: ["index.js", "lib", "missing-entry"] },
      destination: dest,
    });
    assert.equal((await readFile(join(dest, "index.js"), "utf8")).trim(), "module.exports = 1;");
    assert.equal((await readFile(join(dest, "lib", "util.js"), "utf8")).trim(), "module.exports = 2;");
    await assert.rejects(() => readFile(join(dest, "secret.dev"), "utf8"), { code: "ENOENT" });

    const globSource = join(root, "glob-pkg");
    await mkdir(join(globSource, "src"), { recursive: true });
    await writeFile(join(globSource, "package.json"), '{"name":"glob-pkg","version":"1.0.0"}');
    await writeFile(join(globSource, "index.js"), "module.exports = 3;\n");
    await writeFile(join(globSource, "src", "extra.js"), "module.exports = 4;\n");
    const globDest = join(root, "out", "glob-pkg");
    await copyInstalledPackage({
      root: globSource,
      manifest: { name: "glob-pkg", version: "1.0.0", files: ["**/*.js"] },
      destination: globDest,
    });
    // Glob allowlists fall back to a full copy so entry points such as zod's index.js cannot vanish.
    assert.equal((await readFile(join(globDest, "index.js"), "utf8")).trim(), "module.exports = 3;");

    await symlink(join(source, "index.js"), join(source, "linked.js"));
    assert.throws(
      () =>
        copyInstalledPackage({
          root: source,
          manifest: { name: "pkg", version: "1.0.0", files: ["linked.js"] },
          destination: join(root, "out", "pkg-linked"),
        }),
      /symlink/,
    );
  } finally {
    await cleanup();
  }
});

test("collectInstalledClosure walks the installed graph without the network", async () => {
  const { root, cleanup } = await fixture();
  try {
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(root, "package.json"), '{"name":"app","version":"1.0.0"}');
    const pkgA = join(root, "node_modules", "pkg-a");
    const pkgB = join(root, "node_modules", "pkg-b");
    await mkdir(pkgA, { recursive: true });
    await mkdir(pkgB, { recursive: true });
    await writeFile(join(pkgA, "package.json"), '{"name":"pkg-a","version":"1.0.0","dependencies":{"pkg-b":"^2.0.0"}}');
    await writeFile(join(pkgB, "package.json"), '{"name":"pkg-b","version":"2.0.0"}');
    const { packages, nestedPackages } = await collectInstalledClosure({
      fromManifestPath: join(root, "package.json"),
      roots: ["pkg-a"],
    });
    assert.deepEqual(
      packages.map((entry) => entry.name),
      ["pkg-a", "pkg-b"],
    );
    assert.deepEqual(nestedPackages, []);

    // The end-to-end assembler ships the closure next to the dist it scanned.
    const dist = join(root, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "index.mjs"), 'import "pkg-a";\n');
    const nodeModulesDir = join(root, "out", "client", "node_modules");
    await mkdir(nodeModulesDir, { recursive: true });
    await assembleClientRuntimeClosure({
      clientManifestPath: join(root, "package.json"),
      clientDistDir: dist,
      nodeModulesDir,
    });
    assert.ok(JSON.parse(await readFile(join(nodeModulesDir, "pkg-a", "package.json"), "utf8")));
    assert.ok(JSON.parse(await readFile(join(nodeModulesDir, "pkg-b", "package.json"), "utf8")));
    const record = JSON.parse(await readFile(join(root, "out", "client", "runtime-closure.json"), "utf8"));
    assert.deepEqual(record.scanned, ["pkg-a"]);
  } finally {
    await cleanup();
  }
});

test("conflicting resolutions nest under the referrer instead of silently collapsing", async () => {
  const { root, cleanup } = await fixture();
  try {
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(root, "package.json"), '{"name":"app","version":"1.0.0"}');
    const pkgA = join(root, "node_modules", "pkg-a");
    const pkgC = join(root, "node_modules", "pkg-c");
    const nestedB = join(pkgA, "node_modules", "pkg-b");
    const rootB = join(root, "node_modules", "pkg-b");
    await mkdir(nestedB, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await mkdir(pkgC, { recursive: true });
    await writeFile(join(pkgA, "package.json"), '{"name":"pkg-a","version":"1.0.0","dependencies":{"pkg-b":"1.0.0"}}');
    await writeFile(join(nestedB, "package.json"), '{"name":"pkg-b","version":"1.0.0"}');
    await writeFile(join(pkgC, "package.json"), '{"name":"pkg-c","version":"1.0.0","dependencies":{"pkg-b":"2.0.0"}}');
    await writeFile(join(rootB, "package.json"), '{"name":"pkg-b","version":"2.0.0"}');
    const { packages, nestedPackages } = await collectInstalledClosure({
      fromManifestPath: join(root, "package.json"),
      roots: ["pkg-a", "pkg-c"],
    });
    assert.deepEqual(
      packages.map((entry) => `${entry.name}@${entry.manifest.version}`),
      ["pkg-a@1.0.0", "pkg-b@1.0.0", "pkg-c@1.0.0"],
    );
    assert.deepEqual(
      nestedPackages.map((entry) => `${entry.parent}/${entry.name}@${entry.manifest.version}`),
      ["pkg-c/pkg-b@2.0.0"],
    );

    // The assembled layout places the nested copy under the referrer, like pnpm does.
    const dist = join(root, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "index.mjs"), 'import "pkg-a"; import "pkg-c";\n');
    const nodeModulesDir = join(root, "out", "client", "node_modules");
    await mkdir(nodeModulesDir, { recursive: true });
    await assembleClientRuntimeClosure({
      clientManifestPath: join(root, "package.json"),
      clientDistDir: dist,
      nodeModulesDir,
    });
    const topB = JSON.parse(await readFile(join(nodeModulesDir, "pkg-b", "package.json"), "utf8"));
    const nestedCopy = JSON.parse(
      await readFile(join(nodeModulesDir, "pkg-c", "node_modules", "pkg-b", "package.json"), "utf8"),
    );
    assert.equal(topB.version, "1.0.0");
    assert.equal(nestedCopy.version, "2.0.0");
  } finally {
    await cleanup();
  }
});

test("a nested slot under a nested referrer fails closed instead of misplacing", async () => {
  // app -> b@1, c, d@1; c -> b@2; b@2 -> d@2. The d@2 slot belongs to the nested b@2, not to
  // top-level b@1; the old name-keyed placement would have hidden d@2 under b@1 while the real
  // referrer silently resolved top-level d@1.
  const { root, cleanup } = await fixture();
  try {
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(
      join(root, "package.json"),
      '{"name":"app","version":"1.0.0","dependencies":{"b":"1.0.0","c":"1.0.0","d":"1.0.0"}}',
    );
    const topB = join(root, "node_modules", "b");
    const pkgC = join(root, "node_modules", "c");
    const topD = join(root, "node_modules", "d");
    const nestedB = join(pkgC, "node_modules", "b");
    const nestedD = join(pkgC, "node_modules", "d");
    await mkdir(topB, { recursive: true });
    await mkdir(topD, { recursive: true });
    await mkdir(nestedB, { recursive: true });
    await mkdir(nestedD, { recursive: true });
    await writeFile(join(topB, "package.json"), '{"name":"b","version":"1.0.0"}');
    await writeFile(join(topD, "package.json"), '{"name":"d","version":"1.0.0"}');
    await writeFile(join(pkgC, "package.json"), '{"name":"c","version":"1.0.0","dependencies":{"b":"2.0.0"}}');
    await writeFile(join(nestedB, "package.json"), '{"name":"b","version":"2.0.0","dependencies":{"d":"2.0.0"}}');
    await writeFile(join(nestedD, "package.json"), '{"name":"d","version":"2.0.0"}');
    assert.throws(
      () => collectInstalledClosure({ fromManifestPath: join(root, "package.json"), roots: ["b", "c", "d"] }),
      /nested referrer/,
    );
  } finally {
    await cleanup();
  }
});

test("unsafe publish files entries are rejected and npm-always entries ship", async () => {
  const { root, cleanup } = await fixture();
  try {
    const source = join(root, "pkg");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "package.json"), '{"name":"pkg","version":"1.0.0"}');
    await writeFile(join(source, "index.js"), "module.exports = 1;\n");
    for (const entry of ["../escape.js", "/absolute.js"]) {
      assert.throws(
        () =>
          copyInstalledPackage({
            root: source,
            manifest: { name: "pkg", version: "1.0.0", files: ["index.js", entry] },
            destination: join(root, "out", `pkg-${entry.length}`),
          }),
        /unsafe publish files entry/,
      );
    }
    await writeFile(join(source, "LICENSE"), "Apache-2.0\n");
    const dest = join(root, "out", "pkg-with-license");
    await copyInstalledPackage({
      root: source,
      manifest: { name: "pkg", version: "1.0.0", files: [] },
      destination: dest,
    });
    assert.equal((await readFile(join(dest, "LICENSE"), "utf8")).trim(), "Apache-2.0");
    assert.equal((await readFile(join(dest, "index.js"), "utf8")).trim(), "module.exports = 1;");
  } finally {
    await cleanup();
  }
});
