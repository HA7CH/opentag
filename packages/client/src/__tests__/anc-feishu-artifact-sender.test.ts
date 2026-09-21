import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AncSafeRetry } from "../anc/effect-runner.js";
import { AncFeishuArtifactSender } from "../anc/feishu-artifact-sender.js";
import type { AncArtifact } from "../anc/schemas.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const scope = {
  appId: "cli_fixture",
  tenantKey: "tenant_fixture",
  brand: "feishu" as const,
  chatIds: ["oc_fixture"],
  humanIds: ["ou_fixture"],
};
const target = { type: "chat_id" as const, id: "oc_fixture" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const uploaded = () => json({ code: 0, data: { file_key: "file_fixture" } });
const sent = () => json({ code: 0, data: { message_id: "om_file", chat_id: "oc_fixture" } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anc-file-send-"));
  directories.push(root);
  const path = join(root, "review.pdf");
  const bytes = Buffer.from("%PDF-1.7\nReviewed fixture, not a real deliverable.");
  await writeFile(path, bytes, { mode: 0o600 });
  const artifact: AncArtifact = {
    uri: pathToFileURL(path).href,
    title: "Reviewed poster",
    revision: "v1",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    evidence: ["fixture byte check"],
  };
  const fetcher = vi.fn<typeof fetch>(async (url) => (String(url).endsWith("/files") ? uploaded() : sent()));
  const credential = vi.fn(async () => ({ appId: scope.appId, brand: scope.brand, token: "fixture-not-a-secret" }));
  const options = { directory: join(root, "outbox"), artifactRoot: root, scope, credential, fetch: fetcher };
  return { root, path, bytes, artifact, fetcher, credential, options, sender: new AncFeishuArtifactSender(options) };
}
async function uploadRecord(directory: string) {
  const name = (await readdir(directory)).find((name) => name.endsWith(".json"));
  if (!name) throw new Error("Missing upload record");
  const path = join(directory, name);
  return { path, record: JSON.parse(await readFile(path, "utf8")) };
}

describe("verified Feishu artifact delivery", () => {
  it("recovers dead upload and message locks without removing a live writer", async () => {
    const f = await fixture();
    const deadPid = 99_999_999;
    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === deadPid) throw Object.assign(new Error("Fixture process is dead"), { code: "ESRCH" });
      return originalKill(pid, signal);
    });
    try {
      for (const directory of [
        join(f.options.directory, "upload-locks"),
        join(f.options.directory, "messages", "locks"),
      ]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, "a".repeat(64) + ".lock"), JSON.stringify({ pid: deadPid, token: "dead" }), {
          mode: 0o600,
        });
        await writeFile(
          join(directory, "b".repeat(64) + ".lock"),
          JSON.stringify({ pid: process.pid, token: "live" }),
          { mode: 0o600 },
        );
      }
      expect(await f.sender.recoverDeadLocks()).toBe(2);
      expect(await f.sender.recoverDeadLocks()).toBe(0);
      for (const directory of [
        join(f.options.directory, "upload-locks"),
        join(f.options.directory, "messages", "locks"),
      ])
        expect(await readdir(directory)).toEqual(["b".repeat(64) + ".lock"]);
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("uploads the reviewed bytes and records delivery only after the file message is receipted", async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/files")) {
        expect((await uploadRecord(f.options.directory)).record.status).toBe("uploading");
        expect(await f.sender.lookup("artifact")).toBeUndefined();
        const form = init?.body as FormData;
        expect(form.get("file_type")).toBe("pdf");
        expect(form.get("file_name")).toBe("Reviewed poster-v1.pdf");
        const blob = form.get("file") as Blob;
        expect(Buffer.from(await blob.arrayBuffer())).toEqual(f.bytes);
        expect(init?.headers).not.toHaveProperty("Content-Type");
        expect(init?.redirect).toBe("error");
        return uploaded();
      }
      expect((await uploadRecord(f.options.directory)).record.status).toBe("uploaded");
      expect(await f.sender.lookup("artifact")).toBeUndefined();
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ receive_id: target.id, msg_type: "file" });
      expect(JSON.parse(body.content)).toEqual({ file_key: "file_fixture" });
      return sent();
    });
    expect(await f.sender.send("artifact", target, f.artifact)).toBe("om_file");
    expect(await f.sender.lookup("artifact")).toBe("om_file");
    const saved = await uploadRecord(f.options.directory);
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(saved.record)).not.toContain("fixture-not-a-secret");
    expect(JSON.stringify(saved.record)).not.toContain(f.path);
    expect(JSON.stringify(saved.record)).not.toContain("Reviewed poster");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("reuses both upload and message receipts across restart", async () => {
    const f = await fixture();
    await f.sender.send("artifact", target, f.artifact);
    const restored = new AncFeishuArtifactSender(f.options);
    expect(await restored.send("artifact", target, f.artifact)).toBe("om_file");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    await expect(restored.send("artifact", target, { ...f.artifact, revision: "v2" })).rejects.toThrow("identity");
    await expect(restored.send("artifact", { type: "open_id", id: "ou_fixture" }, f.artifact)).rejects.toThrow(
      "identity",
    );
  });

  it.each(["foreign_target", "changed_bytes", "foreign_path", "oversized"] as const)(
    "rejects %s before requesting any credential or making a network call",
    async (variant) => {
      const f = await fixture();
      let to = target;
      let artifact = f.artifact;
      if (variant === "foreign_target") to = { type: "chat_id", id: "oc_other" };
      if (variant === "changed_bytes") await writeFile(f.path, "Unreviewed");
      if (variant === "foreign_path") {
        const foreign = await fixture();
        artifact = foreign.artifact;
      }
      if (variant === "oversized") {
        const bytes = Buffer.alloc(30_000_001, 1);
        await writeFile(f.path, bytes);
        artifact = { ...artifact, sha256: createHash("sha256").update(bytes).digest("hex") };
      }
      await expect(f.sender.send("artifact", to, artifact)).rejects.toThrow();
      expect(f.credential).not.toHaveBeenCalled();
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(["app", "brand", "empty"] as const)("rejects a %s credential mismatch", async (variant) => {
    const f = await fixture();
    const grant = { appId: scope.appId, brand: scope.brand, token: "fixture-not-a-secret" };
    if (variant === "app") grant.appId = "other";
    if (variant === "brand") Object.assign(grant, { brand: "lark" });
    if (variant === "empty") grant.token = "";
    f.credential.mockResolvedValue(grant);
    await expect(f.sender.send("artifact", target, f.artifact)).rejects.toThrow("scope mismatch");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("does not upload again or claim delivery after a lost upload response", async () => {
    const f = await fixture();
    f.fetcher.mockRejectedValue(new Error("Response lost"));
    await expect(f.sender.send("artifact", target, f.artifact)).rejects.toThrow("lost");
    const restored = new AncFeishuArtifactSender(f.options);
    await expect(restored.send("artifact", target, f.artifact)).rejects.toThrow("unknown");
    expect(await restored.lookup("artifact")).toBeUndefined();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains upload success without resending an uncertain message", async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(uploaded()).mockRejectedValueOnce(new Error("Lost send response"));
    await expect(f.sender.send("artifact", target, f.artifact)).rejects.toThrow("Lost");
    expect((await uploadRecord(f.options.directory)).record.status).toBe("uploaded");
    await expect(new AncFeishuArtifactSender(f.options).send("artifact", target, f.artifact)).rejects.toThrow();
    expect(await f.sender.lookup("artifact")).toBeUndefined();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries only the documented no-write rejection, with a three-attempt bound", async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async () => json({ code: 232096 }, 400));
    for (let i = 0; i < 3; i++)
      await expect(f.sender.send("artifact", target, f.artifact)).rejects.toBeInstanceOf(AncSafeRetry);
    await expect(f.sender.send("artifact", target, f.artifact)).rejects.toThrow("blocked");
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(["denied", "server_error", "malformed"] as const)("does not retry %s as a safe upload", async (variant) => {
    const f = await fixture();
    f.fetcher.mockImplementation(async () =>
      variant === "denied"
        ? json({ code: 234002 }, 401)
        : variant === "server_error"
          ? json({ code: 234044 }, 500)
          : json({ code: 0, data: { file_key: "../invalid" } }),
    );
    await expect(f.sender.send("artifact", target, f.artifact)).rejects.toThrow();
    await expect(new AncFeishuArtifactSender(f.options).send("artifact", target, f.artifact)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(await f.sender.lookup("artifact")).toBeUndefined();
  });

  it("uploads arbitrary reviewed formats as stream without interpreting their contents", async () => {
    const f = await fixture();
    const path = join(f.root, "slides.html");
    await writeFile(path, f.bytes);
    await f.sender.send("artifact", target, {
      ...f.artifact,
      uri: pathToFileURL(path).href,
      title: "../../Review\n<at>",
    });
    const form = f.fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get("file_type")).toBe("stream");
    expect(String(form.get("file_name"))).not.toMatch(/[/<>\r\n]/);
  });
});
