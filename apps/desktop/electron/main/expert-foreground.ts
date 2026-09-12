import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Foreground expert sessions (module 01 polish): expert/team dispatch creates
 * a REAL conversation session, so later user turns in that session must keep
 * the expert persona. Pi-Desktop sessions carry no persona field, so the
 * binding lives here — a small main-process registry persisted to the app
 * data dir and consulted by the agentPrompt handler when resolving the
 * runtime launch (the only approved touchpoint on the Pi-Desktop file).
 */

export interface ForegroundSessionRecord {
  kind: "expert" | "team";
  /** Expert/team id (expert name or team id, matching the registries). */
  id: string;
  name: string;
  personaPrompt: string;
}

export class ForegroundSessionRegistry {
  private readonly filePath: string;
  // Never share one object across instances (or with a module constant):
  // register() mutates the loaded map in place.
  private records: Record<string, ForegroundSessionRecord> = {};
  private loaded = false;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "expert-sessions.json");
  }

  private load(): Record<string, ForegroundSessionRecord> {
    if (this.loaded) return this.records;
    this.loaded = true;
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<
          string,
          ForegroundSessionRecord
        >;
        if (parsed && typeof parsed === "object") this.records = parsed;
      }
    } catch {
      // Corrupt registry: start empty; expert sessions degrade to plain chats.
      this.records = {};
    }
    return this.records;
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.records, null, 2), "utf8");
    } catch {
      // Persistence is best-effort; the in-memory binding still covers this run.
    }
  }

  register(sessionId: string, record: ForegroundSessionRecord): void {
    const records = this.load();
    records[sessionId] = record;
    this.persist();
  }

  /** Persona prompt for later turns, or undefined for non-expert sessions. */
  lookup(sessionId: string): string | undefined {
    return this.load()[sessionId]?.personaPrompt;
  }

  forget(sessionId: string): void {
    const records = this.load();
    if (!records[sessionId]) return;
    delete records[sessionId];
    this.persist();
  }
}
