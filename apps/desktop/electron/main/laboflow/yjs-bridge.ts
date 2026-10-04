/**
 * T52.13 renderer↔yjs-hub bridge: the org access token never enters the
 * renderer, so the main process owns the authenticated websocket to the
 * server's CRDT endpoint and forwards raw y-protocol binary frames over
 * Electron IPC. Channels are explicit (main mints the id) so parallel
 * editors don't cross wires; frames stay ArrayBuffer end to end.
 */

import { randomUUID } from "node:crypto";
import { IPC } from "@pi-desktop/shared";
import type { OrgService } from "../org-service";

type IpcHandle = (channel: string, fn: (...args: any[]) => Promise<any>) => void;
type IpcHandleWithEvent = (
  channel: string,
  fn: (event: { sender: { id: number } }, ...args: any[]) => Promise<any>,
) => void;

type Channel = {
  socket: { send: (data: ArrayBuffer) => void; close: () => void };
};

export type YjsBridgeDeps = {
  orgService: OrgService;
  handle: IpcHandle;
  handleWithEvent: IpcHandleWithEvent;
  /** Push a binary frame (or close notice) to the owning renderer window. */
  forward: (channel: string, payload: { data?: ArrayBuffer; closed?: { code: number; reason: string } }) => void;
  assertMainWindowSender: (event: { sender: { id: number } }) => void;
  warn: (context: string, message: string) => void;
};

export function createYjsBridge(deps: YjsBridgeDeps): { dispose(): void } {
  const channels = new Map<string, Channel>();

  deps.handleWithEvent(IPC.invoke.spaceYjsAttach, async (event, input) => {
    deps.assertMainWindowSender(event);
    const spaceId = typeof input?.spaceId === "string" ? input.spaceId : "";
    const nodeId = typeof input?.nodeId === "string" ? input.nodeId : "";
    if (!spaceId || !nodeId) {
      throw Object.assign(new Error("invalid yjs attach input"), {
        errorCode: "INVALID_ARGUMENT",
      });
    }
    const channel = randomUUID();
    const socket = await deps.orgService.openOrgWebSocket(
      `/spaces/${encodeURIComponent(spaceId)}/yjs/${encodeURIComponent(nodeId)}`,
      {
        onOpen: () => deps.warn(channel, "open"),
        onMessage: (data) => deps.forward(channel, { data }),
        onClose: (code, reason) => {
          if (channels.delete(channel)) {
            deps.forward(channel, { closed: { code, reason } });
          }
        },
      },
    );
    channels.set(channel, { socket });
    return { channel };
  });

  deps.handle(IPC.invoke.spaceYjsDetach, async (input) => {
    const channel = typeof input?.channel === "string" ? input.channel : "";
    const entry = channels.get(channel);
    if (entry) {
      channels.delete(channel);
      entry.socket.close();
    }
    return { ok: true };
  });

  deps.handle(IPC.invoke.spaceYjsSend, async (input) => {
    const channel = typeof input?.channel === "string" ? input.channel : "";
    const entry = channels.get(channel);
    if (!entry) {
      throw Object.assign(new Error("yjs channel not attached"), { errorCode: "NOT_FOUND" });
    }
    const data = input?.data;
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      throw Object.assign(new Error("yjs frame must be binary"), {
        errorCode: "INVALID_ARGUMENT",
      });
    }
    const source =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array((data as ArrayBufferView).buffer as ArrayBuffer);
    const frame = new Uint8Array(source.byteLength);
    frame.set(source);
    entry.socket.send(frame.buffer as ArrayBuffer);
    return { ok: true };
  });

  return {
    dispose() {
      for (const entry of channels.values()) entry.socket.close();
      channels.clear();
    },
  };
}
