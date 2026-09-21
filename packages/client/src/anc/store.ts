import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory, readDurableJson, readSecureFile, writeDurableJson } from "../storage/durable-file.js";
import { AncId, type AncSnapshot, AncSnapshotSchema } from "./schemas.js";

const writers = new Map<string, Promise<unknown>>();
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/**
 * One fsynced document owns state, event dedupe, and pending side effects together.
 * Markdown/board files are projections, never a competing transaction log.
 * Cross-process locks fail closed; recovery only removes a proven-dead PID lock.
 */
export class AncFileStore {
  constructor(readonly directory: string) {}

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.directory, this.directory);
  }

  async ids(): Promise<string[]> {
    await this.initialize();
    return (await readdir(this.directory))
      .filter((name) => name.endsWith(".json"))
      .map((name) => AncId.parse(name.slice(0, -5)));
  }

  async read(id: string): Promise<AncSnapshot | undefined> {
    AncId.parse(id);
    return readDurableJson(join(this.directory, `${id}.json`), (value) => AncSnapshotSchema.parse(value));
  }

  async transact<T>(
    id: string,
    change: (previous: AncSnapshot | undefined) => Promise<{ snapshot: AncSnapshot; result: T }>,
  ): Promise<T> {
    AncId.parse(id);
    await this.initialize();
    const identity = join(this.directory, id);
    const previous = writers.get(identity) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() =>
        this.lock(`project-${id}`, async () => {
          const { snapshot, result } = await change(await this.read(id));
          await writeDurableJson(join(this.directory, `${id}.json`), AncSnapshotSchema.parse(snapshot));
          return result;
        }),
      );
    writers.set(identity, write);
    try {
      return await write;
    } finally {
      if (writers.get(identity) === write) writers.delete(identity);
    }
  }

  async lock<T>(name: string, action: () => Promise<T>): Promise<T> {
    const path = join(this.directory, `${createHash("sha256").update(name).digest("hex")}.lock`);
    const token = randomUUID();
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.sync();
      return await action();
    } finally {
      await handle.close();
      const current = await readSecureFile(path);
      if (current && JSON.parse(current).token === token) await unlink(path);
    }
  }

  async recoverDeadLocks(): Promise<number> {
    await this.initialize();
    let removed = 0;
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.lock$/.test(name)) continue;
      const path = join(this.directory, name);
      const raw = await readSecureFile(path);
      if (!raw) continue;
      const record = JSON.parse(raw) as { pid: number; token: string };
      if (!Number.isInteger(record.pid) || record.pid <= 0 || typeof record.token !== "string") {
        throw new Error("Invalid ANC lock; manual inspection required");
      }
      if (!isAlive(record.pid) && (await readSecureFile(path)) === raw) {
        await unlink(path);
        removed++;
      }
    }
    return removed;
  }
}
