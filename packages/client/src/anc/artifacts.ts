import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertWithin } from "../storage/durable-file.js";
import type { AncArtifact } from "./schemas.js";

export function localArtifactVerifier(root: string): (artifact: AncArtifact) => Promise<void> {
  return async (artifact) => {
    const uri = new URL(artifact.uri);
    if (uri.protocol !== "file:" || uri.hostname) throw new Error("Artifact must be a local project file");
    const canonicalRoot = await realpath(root);
    const path = await realpath(fileURLToPath(uri));
    assertWithin(canonicalRoot, path);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > 128 * 1024 * 1024)
      throw new Error("Invalid artifact file");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest("hex") !== artifact.sha256) throw new Error("Artifact digest mismatch");
  };
}
