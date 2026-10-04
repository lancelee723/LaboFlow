/**
 * HTML CRDT hub (T52.13, SPEC §3.4): a per-node Y.Doc room served over the
 * existing fastify-websocket surface. The wire protocol is y-protocols sync +
 * awareness, so the standard `y-websocket` client provider connects directly.
 *
 * Persistence: the Y update state is snapshotted (base64) into the node's
 * space_docs/space_doc_versions chain — the same 20-version rolling window as
 * MD/CSV. Snapshots fire on a dirty interval and on the last disconnect, so a
 * reopened doc resumes exactly where the last editor left off.
 *
 * Access: every connection re-verifies the JWT and the node's effective perm
 * (none stays a 404-style close), matching the REST face of the space module.
 */

import { encodeStateAsUpdate, encodeStateVector, Doc as YDoc, applyUpdate as applyUpdateToDoc } from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { spaceDocs, spaceDocVersions, spaceNodes } from '../db/schema.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SNAPSHOT_INTERVAL_MS = 10_000;
const SNAPSHOT_MIN_DIRTY_BYTES = 1;

export type YjsAccess = {
  /** Resolves when `userId` may open this html doc; rejects otherwise (none 404-style). */
  assertHtmlDocAccess(spaceId: string, nodeId: string, userId: string): Promise<void>;
};

type Room = {
  doc: YDoc;
  /** Node this room serves (docId === nodeId). */
  nodeId: string;
  spaceId: string;
  conns: Set<{
    send(data: Buffer | string): void;
    ready: boolean;
    has: (key: number) => boolean;
    track: Map<number, number>;
  }>;
  dirty: boolean;
  loaded: boolean;
  snapshotTimer?: ReturnType<typeof setInterval>;
  closing?: boolean;
};

/** Message type byte + lib0-encoded y-protocols frame, as y-websocket speaks it. */
function encodeFrame(messageType: number, write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageType);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

export class YjsHub {
  private readonly rooms = new Map<string, Room>();
  constructor(
    private readonly db: NodePgDatabase<Record<string, never>>,
    private readonly access: YjsAccess,
    private readonly log?: (message: string) => void,
  ) {}

  /** Load-or-create the room; the initial state comes from the last snapshot. */
  private async room(spaceId: string, nodeId: string): Promise<Room> {
    const key = `${spaceId}:${nodeId}`;
    let room = this.rooms.get(key);
    if (room) return room;
    const doc = new YDoc({ gc: true });
    let loaded = false;
    try {
      const [snap] = await this.db
        .select({ content: spaceDocVersions.content })
        .from(spaceDocVersions)
        .innerJoin(spaceDocs, and(eq(spaceDocs.nodeId, spaceDocVersions.nodeId), eq(spaceDocs.currentVersion, spaceDocVersions.version)))
        .where(eq(spaceDocVersions.nodeId, nodeId))
        .orderBy(desc(spaceDocVersions.version))
        .limit(1);
      if (snap?.content) {
        applyUpdateToDoc(doc, new Uint8Array(Buffer.from(snap.content, 'base64')));
        loaded = true;
      }
    } catch (error) {
      this.log?.(`yjs hub snapshot load failed for ${key}: ${String(error)}`);
    }
    room = {
      doc, nodeId, spaceId,
      conns: new Set(),
      dirty: false,
      loaded,
      snapshotTimer: setInterval(() => {
        void this.snapshot(key).catch((error) => this.log?.(`yjs snapshot failed: ${String(error)}`));
      }, SNAPSHOT_INTERVAL_MS),
    };
    doc.on('update', () => {
      room!.dirty = true;
      room!.loaded = true;
    });
    this.rooms.set(key, room);
    return room;
  }

  /** Write the current update state into the version chain (20-version roll). */
  async snapshot(key?: string): Promise<void> {
    const targets = key ? [this.rooms.get(key)] : [...this.rooms.values()];
    for (const room of targets) {
      if (!room || room.closing) continue;
      if (!room.dirty || !room.loaded) continue;
      const state = encodeStateAsUpdate(room.doc);
      if (state.byteLength < SNAPSHOT_MIN_DIRTY_BYTES) continue;
      const [current] = await this.db
        .select({ currentVersion: spaceDocs.currentVersion })
        .from(spaceDocs)
        .where(eq(spaceDocs.nodeId, room.nodeId))
        .limit(1);
      const versionNo = (current?.currentVersion ?? 0) + 1;
      if (versionNo === 1) {
        await this.db.insert(spaceDocs).values({ nodeId: room.nodeId, currentVersion: 1 });
      } else {
        await this.db.update(spaceDocs).set({ currentVersion: versionNo, updatedAt: new Date() })
          .where(eq(spaceDocs.nodeId, room.nodeId));
      }
      await this.db.insert(spaceDocVersions).values({
        nodeId: room.nodeId,
        version: versionNo,
        content: Buffer.from(state).toString('base64'),
        sha256: 'crdt:' + Buffer.from(state.slice(0, 32)).toString('hex'),
        authorId: null,
        source: 'human',
      });
      room.dirty = false;
    }
  }

  /** Latest snapshot state vector, so late joiners get a diff instead of all. */
  private async loadInitial(room: Room): Promise<Uint8Array> {
    if (!room.loaded) {
      const [snap] = await this.db
        .select({ content: spaceDocVersions.content })
        .from(spaceDocVersions)
        .innerJoin(spaceDocs, and(eq(spaceDocs.nodeId, spaceDocVersions.nodeId), eq(spaceDocs.currentVersion, spaceDocVersions.version)))
        .where(eq(spaceDocVersions.nodeId, room.nodeId))
        .orderBy(desc(spaceDocVersions.version))
        .limit(1);
      if (snap?.content) {
        applyUpdateToDoc(room.doc, new Uint8Array(Buffer.from(snap.content, 'base64')));
        room.loaded = true;
      }
    }
    return encodeStateVector(room.doc);
  }

  /**
   * Attach one verified websocket. `socket` is the fastify-websocket connection
   * (duck-typed: send/on/close). Frames are binary y-protocols messages.
   */
  async connect(
    spaceId: string,
    nodeId: string,
    userId: string,
    socket: {
      send(data: Buffer | string): void;
      on(event: string, cb: (raw?: Buffer) => void): void;
      close(code: number, reason: string): void;
    },
  ): Promise<void> {
    try {
      const [node] = await this.db
        .select({ type: spaceNodes.type })
        .from(spaceNodes)
        .where(and(eq(spaceNodes.id, nodeId), eq(spaceNodes.spaceId, spaceId)))
        .limit(1);
      if (!node || node.type !== 'html') throw new Error('not an html node');
      await this.access.assertHtmlDocAccess(spaceId, nodeId, userId);
    } catch {
      socket.close(4003, 'no access');
      return;
    }
    const room = await this.room(spaceId, nodeId);
    const awareness = new awarenessProtocol.Awareness(room.doc);
    // Re-broadcast local awareness states to every connection.
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = added.concat(updated, removed);
      const frame = encodeFrame(MESSAGE_AWARENESS, (encoder) =>
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed)),
      );
      for (const conn of room.conns) {
        if (conn.ready) conn.send(Buffer.from(frame));
      }
    });
    const conn = {
      send: (data: Buffer | string) => socket.send(data),
      ready: true,
      has: (key: number) => conn.track.has(key),
      track: new Map<number, number>(),
    };
    room.conns.add(conn);
    try {
      // Lazy-load the persisted snapshot before the first sync exchange.
      await this.loadInitial(room);
      // Step 1: server state vector → client replies with the missing diff.
      socket.send(Buffer.from(encodeFrame(MESSAGE_SYNC, (encoder) =>
        syncProtocol.writeSyncStep1(encoder, room.doc),
      )));
    } catch (error) {
      this.log?.(`yjs initial load failed: ${String(error)}`);
    }

    socket.on('data', (raw?: Buffer) => {
      void (async () => {
        if (!raw) return;
        try {
          const decoder = decoding.createDecoder(new Uint8Array(raw));
          const messageType = decoding.readVarUint(decoder);
          if (messageType === MESSAGE_SYNC) {
            // y-websocket wire format: the sync message follows the type byte
            // INLINE; replies go straight into the response frame's encoder.
            const replyEncoder = encoding.createEncoder();
            encoding.writeVarUint(replyEncoder, MESSAGE_SYNC);
            const syncType = syncProtocol.readSyncMessage(decoder, replyEncoder, room.doc, null);
            if (syncType !== syncProtocol.messageYjsSyncStep2) {
              socket.send(Buffer.from(encoding.toUint8Array(replyEncoder)));
            }
          } else if (messageType === MESSAGE_AWARENESS) {
            awarenessProtocol.applyAwarenessUpdate(
              awareness, decoding.readVarUint8Array(decoder), null,
            );
          }
        } catch (error) {
          this.log?.(`yjs frame error: ${String(error)}`);
        }
      })();
    });

    const close = () => {
      room.conns.delete(conn);
      if (room.conns.size === 0) {
        void this.snapshot(`${spaceId}:${nodeId}`)
          .catch(() => undefined)
          .finally(() => {
            if (room.snapshotTimer) clearInterval(room.snapshotTimer);
            awareness.destroy();
            room.doc.destroy();
            this.rooms.delete(`${spaceId}:${nodeId}`);
          });
      }
    };
    socket.on('close', close);
    socket.on('error', close);
  }

  roomCount(): number {
    return this.rooms.size;
  }
}
