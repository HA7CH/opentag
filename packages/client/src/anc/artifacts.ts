import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, realpath, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertWithin, ensurePrivateDirectory, syncDurableDirectory } from "../storage/durable-file.js";
import type { AncArtifact } from "./schemas.js";

const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
type FileHandle = Awaited<ReturnType<typeof open>>;

async function openArtifact(root: string, artifact: AncArtifact): Promise<FileHandle> {
  const uri = new URL(artifact.uri);
  if (uri.protocol !== "file:" || uri.hostname || uri.search || uri.hash)
    throw new Error("Artifact must be a local project file");
  const canonicalRoot = await realpath(root);
  const path = await realpath(fileURLToPath(uri));
  assertWithin(canonicalRoot, path);
  // NONBLOCK avoids hanging on a file replaced with a FIFO before open.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size === 0 || opened.size > MAX_ARTIFACT_BYTES)
      throw new Error("Invalid artifact file");
    const actual = await realpath(process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path);
    assertWithin(canonicalRoot, actual);
    const current = await stat(actual);
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("Artifact changed during open");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readArtifact(root: string, artifact: AncArtifact, collect: boolean): Promise<Buffer> {
  const handle = await openArtifact(root, artifact);
  try {
    const before = await handle.stat();
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds size limit");
      hash.update(chunk);
      if (collect) chunks.push(chunk);
    }
    const after = await handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error("Artifact changed during verification");
    if (hash.digest("hex") !== artifact.sha256) throw new Error("Artifact digest mismatch");
    return collect ? Buffer.concat(chunks, size) : Buffer.alloc(0);
  } finally {
    await handle.close();
  }
}

/** Upload these exact bytes; do not verify one path and later reopen a mutable file. */
export async function readVerifiedAncArtifact(root: string, artifact: AncArtifact): Promise<Buffer> {
  return readArtifact(root, artifact, true);
}

export function localArtifactVerifier(root: string): (artifact: AncArtifact) => Promise<void> {
  return async (artifact) => {
    await readArtifact(root, artifact, false);
  };
}

/** Content-addressed, append-only review copies outside the agent's writable workspace. */
export function localArtifactRetainer(
  sourceRoot: string,
  archiveRoot: string,
): (artifact: AncArtifact) => Promise<AncArtifact> {
  return async (artifact) => {
    const bytes = await readVerifiedAncArtifact(sourceRoot, artifact);
    const directory = await ensurePrivateDirectory(archiveRoot, archiveRoot);
    const extension = extname(fileURLToPath(artifact.uri));
    const suffix = /^\.[a-zA-Z0-9]{1,10}$/.test(extension) ? extension.toLowerCase() : ".bin";
    const destination = join(directory, `${artifact.sha256}${suffix}`);
    const retained = { ...artifact, uri: pathToFileURL(destination).href };
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      try {
        // Exclusive publication: never replace an existing review copy, including a corrupt one.
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await localArtifactVerifier(directory)(retained);
      await syncDurableDirectory(directory);
      return retained;
    } finally {
      await handle.close();
      await rm(temporary, { force: true });
    }
  };
}
