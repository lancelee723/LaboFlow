import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { deliverables, deliverableVersions, orgSkills } from '../db/schema.js';

/**
 * T2.7 交付物库 (FR-S-10): upload/download with 20-version rolling history
 * and rollback; content on a local volume, metadata in PG.
 * T2.8 组织 Skill 库 (FR-S-11): publish (versioned) + catalog + download.
 */

const MAX_VERSIONS = 20;
export const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB（PRD 4.2.5-4）

export interface DeliverableDto {
  id: string;
  workspaceId: string;
  path: string;
  title: string;
  currentVersion: number;
  source: string;
  sessionId: string | null;
  versions: Array<{ versionNo: number; size: number; sha256: string; uploadedBy: string | null; createdAt: string }>;
}

export class DeliverableService {
  constructor(
    private readonly db: NodePgDatabase<Record<string, never>>,
    private readonly storageDir: string,
  ) {}

  private storageKey(deliverableId: string, versionNo: number): string {
    return path.join(this.storageDir, deliverableId, `v${versionNo}`);
  }

  async upload(input: {
    workspaceId: string;
    path: string;
    title?: string;
    content: Buffer;
    uploaderId: string;
    source?: 'upload' | 'session';
    sessionId?: string | null;
  }): Promise<DeliverableDto> {
    if (input.content.length > MAX_FILE_SIZE) {
      throw new DeliverableError(413, 'ETOOLARGE', `文件超过上限（${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB）`);
    }
    const sha = createHash('sha256').update(input.content).digest('hex');
    // find or create the deliverable row (unique per workspace+path)
    let [row] = await this.db
      .select()
      .from(deliverables)
      .where(and(eq(deliverables.workspaceId, input.workspaceId), eq(deliverables.path, input.path)))
      .limit(1);
    if (!row) {
      [row] = await this.db
        .insert(deliverables)
        .values({
          workspaceId: input.workspaceId,
          path: input.path,
          title: input.title ?? path.basename(input.path),
          source: input.source ?? 'upload',
          sessionId: input.sessionId ?? null,
          uploaderId: input.uploaderId,
          currentVersion: 0,
        })
        .returning();
    }
    const versionNo = row!.currentVersion + 1;
    const key = this.storageKey(row!.id, versionNo);
    fs.mkdirSync(path.dirname(key), { recursive: true });
    fs.writeFileSync(key, input.content);
    await this.db.insert(deliverableVersions).values({
      deliverableId: row!.id,
      versionNo,
      size: input.content.length,
      sha256: sha,
      storageKey: key,
      uploadedBy: input.uploaderId,
    });
    await this.db.update(deliverables).set({ currentVersion: versionNo }).where(eq(deliverables.id, row!.id));
    // 20-version rolling window: delete the oldest when over
    const stale = await this.db
      .select()
      .from(deliverableVersions)
      .where(and(eq(deliverableVersions.deliverableId, row!.id), lt(deliverableVersions.versionNo, versionNo - MAX_VERSIONS + 1)))
      .orderBy(asc(deliverableVersions.versionNo));
    for (const old of stale) {
      fs.rmSync(old.storageKey, { force: true });
      await this.db.delete(deliverableVersions).where(eq(deliverableVersions.id, old.id));
    }
    return this.get(row!.id) as Promise<DeliverableDto>;
  }

  async get(id: string): Promise<DeliverableDto | null> {
    const [row] = await this.db.select().from(deliverables).where(eq(deliverables.id, id)).limit(1);
    if (!row) return null;
    const versions = await this.db
      .select()
      .from(deliverableVersions)
      .where(eq(deliverableVersions.deliverableId, id))
      .orderBy(asc(deliverableVersions.versionNo));
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      path: row.path,
      title: row.title,
      currentVersion: row.currentVersion,
      source: row.source,
      sessionId: row.sessionId,
      versions: versions.map((v) => ({
        versionNo: v.versionNo, size: v.size, sha256: v.sha256,
        uploadedBy: v.uploadedBy, createdAt: v.createdAt.toISOString(),
      })),
    };
  }

  async list(workspaceId: string): Promise<DeliverableDto[]> {
    const rows = await this.db.select().from(deliverables).where(eq(deliverables.workspaceId, workspaceId));
    const out: DeliverableDto[] = [];
    for (const r of rows) {
      const d = await this.get(r.id);
      if (d) out.push(d);
    }
    return out;
  }

  /** Read a specific version (current when versionNo omitted). */
  async download(id: string, versionNo?: number): Promise<{ content: Buffer; sha256: string; versionNo: number } | null> {
    const d = await this.get(id);
    if (!d) return null;
    const target = versionNo ?? d.currentVersion;
    const v = d.versions.find((x) => x.versionNo === target);
    if (!v) return null;
    const content = fs.readFileSync(path.join(this.storageDir, id, `v${target}`));
    return { content, sha256: v.sha256, versionNo: target };
  }

  /** 回滚：把旧版本内容复制为新版本（不丢历史，append-only）。 */
  async rollback(id: string, toVersion: number, actorId: string): Promise<DeliverableDto> {
    const old = await this.download(id, toVersion);
    if (!old) throw new DeliverableError(404, 'ENOENT', '目标版本不存在（或已滚动清除）');
    const d = (await this.get(id))!;
    return this.upload({
      workspaceId: d.workspaceId,
      path: d.path,
      title: d.title,
      content: old.content,
      uploaderId: actorId,
      source: d.source as 'upload' | 'session',
      sessionId: d.sessionId,
    });
  }
}

export class DeliverableError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'DeliverableError';
  }
}

// ---------------------------------------------------------------------------
// T2.8 组织 Skill 库
// ---------------------------------------------------------------------------

export interface OrgSkillDto {
  id: string;
  name: string;
  version: string;
  manifest: Record<string, unknown>;
  publishedBy: string | null;
  publishedAt: string;
}

export class OrgLibraryService {
  constructor(
    private readonly db: NodePgDatabase<Record<string, never>>,
    private readonly storageDir: string,
  ) {}

  async publish(input: { name: string; version: string; manifest: Record<string, unknown>; packageContent: Buffer; publisherId: string }): Promise<OrgSkillDto> {
    const storageKey = path.join(this.storageDir, 'org-skills', `${randomUUID()}.zip`);
    fs.mkdirSync(path.dirname(storageKey), { recursive: true });
    fs.writeFileSync(storageKey, input.packageContent);
    const [row] = await this.db
      .insert(orgSkills)
      .values({ name: input.name, version: input.version, manifest: input.manifest, storageKey, publishedBy: input.publisherId })
      .onConflictDoUpdate({
        target: [orgSkills.name, orgSkills.version],
        set: { manifest: input.manifest, storageKey, publishedBy: input.publisherId, publishedAt: new Date() },
      })
      .returning();
    return this.map(row!);
  }

  /** 下发清单：每个 name 的最新版本（客户端按清单拉取）。 */
  async catalog(): Promise<Array<{ name: string; latestVersion: string; versions: string[]; manifest: Record<string, unknown> }>> {
    const rows = await this.db.select().from(orgSkills).orderBy(asc(orgSkills.publishedAt));
    const byName = new Map<string, OrgSkillDto[]>();
    for (const r of rows) {
      const dto = this.map(r);
      byName.set(dto.name, [...(byName.get(dto.name) ?? []), dto]);
    }
    return [...byName.values()].map((list) => {
      const sorted = [...list].sort((a, b) => compareVersions(b.version, a.version));
      return { name: sorted[0]!.name, latestVersion: sorted[0]!.version, versions: sorted.map((s) => s.version), manifest: sorted[0]!.manifest };
    });
  }

  async download(name: string, version?: string): Promise<{ content: Buffer; version: string } | null> {
    const rows = await this.db.select().from(orgSkills).where(eq(orgSkills.name, name));
    if (rows.length === 0) return null;
    const chosen = version ? rows.find((r) => r.version === version) : rows.sort((a, b) => compareVersions(b.version, a.version))[0];
    if (!chosen) return null;
    return { content: fs.readFileSync(chosen.storageKey), version: chosen.version };
  }

  private map(r: typeof orgSkills.$inferSelect): OrgSkillDto {
    return {
      id: r.id, name: r.name, version: r.version,
      manifest: r.manifest as Record<string, unknown>,
      publishedBy: r.publishedBy, publishedAt: r.publishedAt.toISOString(),
    };
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
