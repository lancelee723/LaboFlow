import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeBinaryStorage, encodeBinaryStorage } from "@pi-desktop/host-runtime";
import { ErrorCodes } from "@pi-desktop/shared";
import type { HostProcess } from "./host-process";

type MessageAppend = {
  key: string;
  sessionId: string;
  message: unknown;
  turnId?: string;
};

type OutboxLogger = (level: "warn" | "error", message: string, data?: unknown) => void;

const MAX_ENTRIES = 1024;

/**
 * Keeps transcript appends away from a dead host pipe. The file is an
 * application-owned outbox, while SQLite remains exclusively host-owned.
 * Message ids make replay idempotent after a host restart.
 */
export class PersistenceOutbox {
  private readonly path: string;
  private readonly tempPath: string;
  private readonly logger: OutboxLogger;
  private entries: MessageAppend[] = [];
  private flushing: Promise<void> | null = null;
  private readonly mutationDrains = new Map<string, number>();
  private persistChain = Promise.resolve();
  private readonly loaded: Promise<void>;

  constructor(dataDir: string, logger: OutboxLogger) {
    this.path = join(dataDir, "session-message-outbox.json");
    this.tempPath = `${this.path}.tmp`;
    this.logger = logger;
    this.loaded = this.load();
    // Observe startup failures immediately while preserving rejection for every caller.
    void this.loaded.catch((error: unknown) => {
      this.logger("error", "session persistence outbox recovery failed", String(error));
    });
  }

  async enqueue(
    entry: MessageAppend,
    getHost: () => HostProcess | null,
  ): Promise<void> {
    await this.loaded;
    const existing = this.entries.findIndex((item) => item.key === entry.key);
    if (existing >= 0) this.entries[existing] = entry;
    else {
      if (this.entries.length >= MAX_ENTRIES) await this.flush(getHost);
      if (this.entries.length >= MAX_ENTRIES) {
        this.logger("error", "session persistence outbox is full", {
          key: entry.key,
          sessionId: entry.sessionId,
          size: this.entries.length,
          max: MAX_ENTRIES,
        });
        throw new Error("session persistence outbox is full");
      }
      this.entries.push(entry);
    }
    await this.persist();
    void this.flush(getHost);
  }

  async flush(getHost: () => HostProcess | null): Promise<void> {
    await this.loaded;
    if (this.flushing) return this.flushing;
    this.flushing = this.flushLoop(getHost).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /**
   * Drop queued appends for a session that the user deleted so a later
   * host-side stub recreate cannot resurrect it (D318).
   */
  async dropSession(sessionId: string): Promise<void> {
    await this.loaded;
    const next = this.entries.filter((entry) => entry.sessionId !== sessionId);
    if (next.length === this.entries.length) return;
    this.entries = next;
    await this.persist();
  }

  /** ID-based mutations require every earlier target-session append to be durable. */
  async prepareSessionMutation(
    sessionId: string,
    getHost: () => HostProcess | null,
  ): Promise<void> {
    // Register before awaiting an existing flush so its in-flight failure cannot
    // discard a target append while this caller waits for a durable acknowledgement.
    this.mutationDrains.set(sessionId, (this.mutationDrains.get(sessionId) ?? 0) + 1);
    try {
      await this.flush(getHost);
      if (this.entries.some((entry) => entry.sessionId === sessionId)) {
        throw Object.assign(new Error("Session mutation requires pending transcript appends to reach the host"), {
          errorCode: ErrorCodes.HOST_UNAVAILABLE,
        });
      }
    } finally {
      const remaining = (this.mutationDrains.get(sessionId) ?? 1) - 1;
      if (remaining) this.mutationDrains.set(sessionId, remaining);
      else this.mutationDrains.delete(sessionId);
    }
  }

  size(): number {
    return this.entries.length;
  }

  private async flushLoop(getHost: () => HostProcess | null): Promise<void> {
    while (this.entries.length > 0) {
      const current = this.entries[0];
      const currentHost = getHost();
      if (!currentHost || !currentHost.isAvailable()) return;
      try {
        await currentHost.call("session.appendMessage", {
          sessionId: current.sessionId,
          message: current.message,
          turnId: current.turnId,
        });
      } catch (error) {
        if (this.mutationDrains.has(current.sessionId) && !isDuplicateMessageIdError(error)) {
          this.logger("warn", "session persistence mutation drain paused", {
            key: current.key,
            sessionId: current.sessionId,
            data: String(error),
          });
          return;
        }
        // A duplicate message id means the host already has the row; drop it
        // and keep draining (D318/#560).
        if (isDuplicateMessageIdError(error)) {
          this.logger("warn", "session persistence flush skipped duplicate message id", {
            key: current.key,
            data: String(error),
          });
        } else if (isPoisonMessageError(error)) {
          // The host will reject this row forever (provenance / permission
          // on this message). Drop only this entry and keep draining so one
          // poisoned head cannot starve later transcript rows (D597).
          this.logger("warn", "session persistence flush dropped poisoned message", {
            key: current.key,
            data: String(error),
          });
        } else if (isForeignKeyError(error)) {
          // The parent row (session or turn) was lost — typically after a
          // sidecar crash that restarted before the outbox could drain.
          // The host will never accept a child row whose parent is gone,
          // so drop it and keep draining (#996).
          this.logger("warn", "session persistence flush dropped orphaned message", {
            key: current.key,
            data: String(error),
          });
        } else {
          // Transient failure (host busy/overloaded/pipe dead). Keep the head
          // and retry on the next enqueue.
          this.logger("warn", "session persistence flush paused", {
            key: current.key,
            data: String(error),
          });
          return;
        }
      }
      // A newer snapshot may have replaced this key while the host wrote it.
      // Only remove the exact entry acknowledged by that write.
      if (this.entries[0] === current) this.entries.shift();
      await this.persist();
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
<<<<<<< ours
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter((entry): entry is MessageAppend => {
          return (
            entry &&
            typeof entry.key === "string" &&
            typeof entry.sessionId === "string" &&
            "message" in entry
          );
        });
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
=======
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("Invalid session persistence outbox: expected an array");
      this.entries = parsed.map(decodeAppend);
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
>>>>>>> upstream
        this.logger("warn", "session persistence outbox load failed", String(error));
        throw error;
      }
    }
  }

<<<<<<< ours
=======
  private async loadDeadLetters(): Promise<void> {
    try {
      const raw = await readFile(this.deadLetterPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("Invalid session persistence dead letters: expected an array");
      this.deadLetters = parsed.map((value) => {
        const entry = decodeAppend(value);
        if (!("quarantinedAt" in entry) || typeof entry.quarantinedAt !== "string" ||
            !("reason" in entry) || typeof entry.reason !== "string") {
          throw new Error("Invalid session persistence dead letter entry");
        }
        return entry as QuarantinedAppend;
      });
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
        this.logger("warn", "session persistence outbox dead letter load failed", String(error));
        throw error;
      }
    }
  }

>>>>>>> upstream
  private async persist(): Promise<void> {
    const write = this.persistChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      if (this.entries.length === 0) {
        try {
          await writeFile(this.path, "[]\n", "utf8");
        } catch (error) {
          this.logger("warn", "session persistence outbox clear failed", String(error));
        }
        return;
      }
      await writeFile(this.tempPath, `${JSON.stringify(this.entries.map(encodeBinaryStorage))}\n`, "utf8");
      await rename(this.tempPath, this.path);
    });
    this.persistChain = write.catch(() => undefined);
    await write;
  }
<<<<<<< ours
=======

  private async persistDeadLetters(): Promise<void> {
    const write = this.persistChain.then(async () => {
      await mkdir(dirname(this.deadLetterPath), { recursive: true });
      if (this.deadLetters.length === 0) {
        try {
          await writeFile(this.deadLetterPath, "[]\n", "utf8");
        } catch (error) {
          this.logger("warn", "session persistence outbox dead letter clear failed", String(error));
        }
        return;
      }
      await writeFile(this.tempDeadLetterPath, `${JSON.stringify(this.deadLetters.map(encodeBinaryStorage))}\n`, "utf8");
      await rename(this.tempDeadLetterPath, this.deadLetterPath);
    });
    this.persistChain = write.catch(() => undefined);
    await write;
  }
>>>>>>> upstream
}

function isDuplicateMessageIdError(error: unknown): boolean {
  return /UNIQUE constraint failed: messages\.id/i.test(String(error));
}

/**
 * The host will reject this message on every retry. Match the host-core
 * provenance prefix in the JSON-RPC message body (append maps those failures
 * as INTERNAL). Do not treat PLUGIN_PERMISSION_DENIED or schema
 * INVALID_PARAMS as poison — those are a different surface, and serde
 * failures do not even put INVALID_PARAMS in the message text.
 */
function isPoisonMessageError(error: unknown): boolean {
  return /(?<![A-Z_])PERMISSION_DENIED:/i.test(String(error));
}

/**
 * The parent row (session or turn) no longer exists. This happens after a
 * sidecar or host-core crash where the parent was deleted or never committed.
 * Retrying is pointless — the FK will never be satisfied.
 */
function isForeignKeyError(error: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(String(error));
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function decodeAppend(value: unknown): MessageAppend {
  const entry = decodeBinaryStorage(value);
  if (!entry || typeof entry !== "object" ||
      !("key" in entry) || typeof entry.key !== "string" ||
      !("sessionId" in entry) || typeof entry.sessionId !== "string" ||
      !("message" in entry || ("usage" in entry && "turnId" in entry && typeof entry.turnId === "string"))) {
    throw new Error("Invalid session persistence outbox entry");
  }
  return entry as MessageAppend;
}
