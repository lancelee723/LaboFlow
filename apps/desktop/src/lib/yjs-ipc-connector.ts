/**
 * T52.13: run the y-protocols client loop over the main-process frame bridge.
 * Functionally the client half of y-websocket — sync step 1/2 + updates +
 * awareness — with the transport swapped for Electron IPC so the org access
 * token never enters the renderer (the bridge owns the websocket).
 */

import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { api } from "./api";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

function frame(messageType: number, write: (encoder: encoding.Encoder) => void): ArrayBuffer {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageType);
  write(encoder);
  const bytes = encoding.toUint8Array(encoder);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

export type YjsIpcConnection = {
  detach(): Promise<void>;
};

export type YjsIpcConnectInput = {
  spaceId: string;
  nodeId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  onStatus?: (status: "connecting" | "connected" | "closed") => void;
};

/** Attach a doc+awareness pair to the server CRDT room. Idempotent teardown. */
export async function connectYjsOverIpc(
  input: YjsIpcConnectInput,
): Promise<YjsIpcConnection> {
  const { spaceId, nodeId, doc, awareness } = input;
  const attach = await api.spaceYjsAttach({ spaceId, nodeId });
  const channel = attach.channel;
  let detached = false;

  const offFrame = api.onSpaceYjsFrame((msg) => {
    if (msg.channel !== channel) return;
    if (msg.closed) {
      input.onStatus?.("closed");
      return;
    }
    if (!(msg.data instanceof ArrayBuffer)) return;
    try {
      const decoder = decoding.createDecoder(new Uint8Array(msg.data));
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        // y-websocket wire format: sync payload inline after the type byte.
        const replyEncoder = encoding.createEncoder();
        encoding.writeVarUint(replyEncoder, MESSAGE_SYNC);
        const syncType = syncProtocol.readSyncMessage(decoder, replyEncoder, doc, null);
        if (syncType !== syncProtocol.messageYjsSyncStep2) {
          void api.spaceYjsSend({
            channel,
            data: encoding.toUint8Array(replyEncoder).slice().buffer as ArrayBuffer,
          });
        }
      } else if (messageType === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          decoding.readVarUint8Array(decoder),
          null,
        );
      }
    } catch {
      // Malformed frame: ignore — the next sync converges us.
    }
  });

  // Local doc changes stream to the room as updates.
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    void api
      .spaceYjsSend({
        channel,
        data: frame(MESSAGE_SYNC, (encoder) => syncProtocol.writeUpdate(encoder, update)),
      })
      .catch(() => undefined);
  };
  doc.on("update", onUpdate);

  // Presence: broadcast local awareness; forward changes so peers see us.
  const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    const changed = added.concat(updated, removed);
    void api
      .spaceYjsSend({
        channel,
        data: frame(MESSAGE_AWARENESS, (encoder) =>
          encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed)),
        ),
      })
      .catch(() => undefined);
  };
  awareness.on("update", onAwareness);
  onAwareness({ added: [doc.clientID], updated: [], removed: [] });

  // Kick the exchange: our state vector → server replies with the diff.
  await api
    .spaceYjsSend({
      channel,
      data: frame(MESSAGE_SYNC, (encoder) => syncProtocol.writeSyncStep1(encoder, doc)),
    })
    .catch(() => undefined);

  return {
    async detach() {
      if (detached) return;
      detached = true;
      doc.off("update", onUpdate);
      awareness.off("update", onAwareness);
      offFrame();
      await api.spaceYjsDetach({ channel }).catch(() => undefined);
    },
  };
}
