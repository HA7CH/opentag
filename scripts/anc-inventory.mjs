import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const excluded = new Set([
  ".git",
  "node_modules",
  ".npm",
  ".cache",
  ".ssh",
  ".secrets",
  "secrets",
  "__pycache__",
  ".wrangler",
  ".supabase",
]);
const secretName = /(^\.env($|\.)|auth\.json$|credentials|token|private[-_]?key|\.pem$|\.key$|company\.env$)/i;
function categoryFor(root, source) {
  if (source.endsWith("SKILL.md") || root.includes("skills")) return "skill";
  if (root.includes("context")) return "durable-context";
  if (root.includes("projects") || root.includes("kanban")) return "project-state";
  if (root.includes("session") || root.includes("distill")) return "historical-evidence";
  return /\.(png|jpe?g|pdf|pptx|docx|mp[34]|wav|zip)$/i.test(source) ? "artifact" : "source-material";
}
function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/");
}
async function readFileHash(path, canonical) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("not_regular_file");
    // Resolve the opened descriptor on Linux, not the mutable path checked earlier.
    const actual = await realpath(process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path);
    if (!inside(canonical, actual)) throw new Error("source_escaped_root");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    const stable = before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
    return { metadata: after, sha256: stable ? hash.digest("hex") : null };
  } finally {
    await handle.close();
  }
}
async function hashFile(path, source, root, canonical) {
  const { metadata, sha256 } = await readFileHash(path, canonical);
  return {
    root,
    source,
    size: metadata.size,
    modifiedAt: metadata.mtime.toISOString(),
    sha256,
    category: categoryFor(root, source),
    visibility: "private-source-boundary",
    ownerUid: metadata.uid,
    mode: metadata.mode & 0o777,
    disposition: "pending-review",
    reason: sha256 ? "indexed_not_migrated" : "changed_during_scan",
  };
}

async function walkInventory(folder, canonical, record, result) {
  if (!inside(canonical, await realpath(folder))) throw new Error("directory_escaped_root");
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, item.name);
    const source = relative(canonical, path);
    if (excluded.has(item.name) || secretName.test(item.name) || item.isSymbolicLink()) {
      result.entries.push({
        root: record.id,
        source,
        disposition: "excluded",
        reason: item.isSymbolicLink() ? "symlink_not_followed" : "credentials_or_runtime_cache",
      });
      continue;
    }
    if (item.isDirectory()) {
      await walkInventory(path, canonical, record, result);
      continue;
    }
    if (!item.isFile()) continue;
    const entry = await hashFile(path, source, record.id, canonical);
    result.entries.push(entry);
    record.files++;
    record.bytes += entry.size;
  }
}
export async function inventory(roots) {
  const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), roots: [], entries: [] };
  for (const root of roots) {
    const record = { id: root.id, path: resolve(root.path), status: "pending", files: 0, bytes: 0 };
    result.roots.push(record);
    try {
      const metadata = await lstat(record.path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("root_not_regular_directory");
      const canonical = await realpath(record.path);
      await walkInventory(canonical, canonical, record, result);
      record.status = "indexed";
    } catch (error) {
      record.status = "incomplete";
      record.error = error.code ?? error.message;
    }
  }
  return result;
}
async function main() {
  const args = process.argv.slice(2);
  const roots = [];
  let output;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") {
      const value = args[++i] ?? "";
      const separator = value.indexOf("=");
      if (separator < 1) throw new Error("Expected --root label=/absolute/path");
      roots.push({ id: value.slice(0, separator), path: value.slice(separator + 1) });
    } else if (args[i] === "--output") output = resolve(args[++i]);
    else throw new Error("Unknown inventory argument");
  }
  if (!output || roots.length === 0) throw new Error("Provide --root and --output");
  const result = await inventory(roots);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.pending-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, output);
  console.log(
    JSON.stringify({
      roots: result.roots.map(({ id, status, files, bytes }) => ({ id, status, files, bytes })),
      entries: result.entries.length,
      output,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
