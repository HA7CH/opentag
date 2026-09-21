import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readDurableJson, writeDurableJson } from "../storage/durable-file.js";
import { readVerifiedAncArtifact } from "./artifacts.js";
import { AncSafeRetry } from "./effect-runner.js";
import {
  AncFeishuGateway,
  type AncFeishuGatewayOptions,
  AncFeishuScopeSchema,
  type AncFeishuTarget,
} from "./feishu-gateway.js";
import { type AncArtifact, AncArtifactSchema, AncId } from "./schemas.js";
import { AncFileStore } from "./store.js";

const Upload = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["uploading", "uploaded", "retryable", "rejected"]),
  attempts: z.number().int().positive(),
  fileKey: z
    .string()
    .regex(/^file_[A-Za-z0-9_-]{1,240}$/)
    .optional(),
});
type UploadRecord = z.infer<typeof Upload>;
const Envelope = z.object({ code: z.number().int(), data: z.unknown().optional() });
const MAX_UPLOAD_BYTES = 30_000_000;

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function filename(artifact: AncArtifact): string {
  const ext = extname(fileURLToPath(artifact.uri)).toLowerCase();
  const suffix = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ".bin";
  const title =
    artifact.title
      .replace(/[^\p{L}\p{N} _-]/gu, "_")
      .trim()
      .slice(0, 60) || "artifact";
  return `${title}-${artifact.revision}${suffix}`;
}
function fileType(name: string): string {
  switch (extname(name)) {
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}

/**
 * Uploads the exact retained review bytes, then sends a receipted file message.
 * Upload success is never delivery. Unknown upload/send outcomes stay unresolved;
 * they are not converted into permission to upload or notify again.
 */
export class AncFeishuArtifactSender {
  readonly #scope;
  readonly #locks: AncFileStore;
  readonly #gateway: AncFeishuGateway;
  readonly #fetch: typeof fetch;
  constructor(readonly options: AncFeishuGatewayOptions & { readonly artifactRoot: string }) {
    this.#scope = AncFeishuScopeSchema.parse(options.scope);
    this.#locks = new AncFileStore(join(options.directory, "upload-locks"));
    this.#gateway = new AncFeishuGateway({ ...options, directory: join(options.directory, "messages") });
    this.#fetch = options.fetch ?? fetch;
  }

  private path(id: string): string {
    return join(
      this.options.directory,
      `${sha([this.#scope.appId, this.#scope.tenantKey, this.#scope.brand, id])}.json`,
    );
  }

  async recoverDeadLocks(): Promise<number> {
    const uploads = await this.#locks.recoverDeadLocks();
    return uploads + (await this.#gateway.recoverDeadLocks());
  }

  async lookup(id: string): Promise<string | undefined> {
    AncId.parse(id);
    return this.#gateway.lookup(id);
  }

  async send(id: string, input: AncFeishuTarget, artifactInput: AncArtifact, signal?: AbortSignal): Promise<string> {
    AncId.parse(id);
    const target = z
      .object({
        type: z.enum(["chat_id", "open_id"]),
        id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      })
      .parse(input);
    const allowed = target.type === "chat_id" ? this.#scope.chatIds : this.#scope.humanIds;
    if (!allowed.includes(target.id)) throw new Error("Artifact destination is outside the ANC pilot");
    const artifact = AncArtifactSchema.parse(artifactInput);
    const name = filename(artifact);
    const digest = sha([target, artifact.sha256, artifact.revision, name]);
    const bytes = await readVerifiedAncArtifact(this.options.artifactRoot, artifact);
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("Artifact exceeds the Feishu upload limit");
    signal?.throwIfAborted();
    await this.#locks.initialize();
    const fileKey = await this.#locks.lock(sha(id), () => this.upload(id, digest, name, bytes, signal));
    return this.#gateway.sendUploadedFile(id, target, fileKey, signal);
  }

  private async upload(id: string, digest: string, name: string, bytes: Buffer, signal?: AbortSignal): Promise<string> {
    const path = this.path(id);
    const prior = await readDurableJson(path, (value) => Upload.parse(value));
    if (prior && prior.digest !== digest) throw new Error("Artifact delivery identity conflict");
    if (prior?.status === "uploaded" && prior.fileKey) return prior.fileKey;
    if (prior?.status === "uploading") throw new Error("Reconcile the unknown artifact upload before retrying");
    if (prior?.status === "rejected" || (prior?.attempts ?? 0) >= 3) throw new Error("Artifact upload is blocked");
    const grant = await this.options.credential();
    if (grant.appId !== this.#scope.appId || grant.brand !== this.#scope.brand || !grant.token)
      throw new Error("Artifact credential scope mismatch");
    signal?.throwIfAborted();
    const record: UploadRecord = { digest, status: "uploading", attempts: (prior?.attempts ?? 0) + 1 };
    await writeDurableJson(path, record);
    const body = new FormData();
    body.set("file_type", fileType(name));
    body.set("file_name", name);
    body.set("file", new Blob([Uint8Array.from(bytes)], { type: "application/octet-stream" }), name);
    const host = this.#scope.brand === "feishu" ? "open.feishu.cn" : "open.larksuite.com";
    const response = await this.#fetch(`https://${host}/open-apis/im/v1/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${grant.token}` },
      body,
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]),
    });
    return this.recordUpload(path, record, response);
  }

  private async recordUpload(path: string, record: UploadRecord, response: Response): Promise<string> {
    const result = Envelope.parse(await response.json());
    if (response.ok && result.code === 0) {
      const data = z.object({ file_key: z.string().regex(/^file_[A-Za-z0-9_-]{1,240}$/) }).parse(result.data);
      record.status = "uploaded";
      record.fileKey = data.file_key;
      await writeDurableJson(path, record);
      return data.file_key;
    }
    // Documented rejection before metadata writing; retry the same bytes at most three times.
    if (response.status === 400 && result.code === 232096) {
      record.status = "retryable";
      await writeDurableJson(path, record);
      throw new AncSafeRetry("Feishu metadata writing is temporarily stopped");
    }
    if ([234001, 234002, 234006, 234007, 234010, 234041].includes(result.code) && response.status < 500) {
      record.status = "rejected";
      await writeDurableJson(path, record);
    }
    throw new Error("Artifact upload failed or its outcome is unknown");
  }
}
