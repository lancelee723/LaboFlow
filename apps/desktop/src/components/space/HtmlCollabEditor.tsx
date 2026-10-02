import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import type { SpaceNode } from "@pi-desktop/shared";
import { connectYjsOverIpc, type YjsIpcConnection } from "../../lib/yjs-ipc-connector";
import { IconCode } from "../icons";

/**
 * T52.12/13: HTML doc editor — a block CRDT over Yjs. Blocks live in
 * `doc.getMap("html").get("blocks", Y.Array)` as Y.Maps ({type, text: Y.Text,
 * level?, src?}); concurrent edits to different blocks always merge, and same
 * block typing degrades to block-level last-write-wins exactly as SPEC §3.4
 * documents. Presence (who is on which block) rides yjs awareness.
 *
 * The connection runs over the main-process frame bridge (yjs-ipc-connector):
 * the org token stays main-side. Snapshots persist server-side on the hub.
 */

type BlockType = "h1" | "h2" | "paragraph" | "bullet" | "numbered" | "image" | "chart";

const BLOCK_TYPES: BlockType[] = ["h1", "h2", "paragraph", "bullet", "numbered", "image", "chart"];

const PRESENCE_COLORS = ["#4f8ef7", "#e8a33d", "#57b884", "#c678dd", "#e06c75", "#56b6c2"];

type Peer = { name: string; color: string; blockId: string | null };

type BlockVm = {
  id: string;
  type: BlockType;
  text: string;
  src: string;
};

function blockTypeOf(map: Y.Map<unknown>): BlockType {
  const value = map.get("type");
  return BLOCK_TYPES.includes(value as BlockType) ? (value as BlockType) : "paragraph";
}

function blockVm(id: string, map: Y.Map<unknown>): BlockVm {
  return {
    id,
    type: blockTypeOf(map),
    text: (map.get("text") as Y.Text | undefined)?.toString() ?? "",
    src: typeof map.get("src") === "string" ? (map.get("src") as string) : "",
  };
}

/** Minimal HTML serializer (FR-TC-14 export): stable, no deps. */
export function blocksToHtml(blocks: BlockVm[]): string {
  const escaped = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = blocks
    .map((block) => {
      switch (block.type) {
        case "h1":
          return `<h1>${escaped(block.text)}</h1>`;
        case "h2":
          return `<h2>${escaped(block.text)}</h2>`;
        case "bullet":
          return `<ul><li>${escaped(block.text)}</li></ul>`;
        case "numbered":
          return `<ol><li>${escaped(block.text)}</li></ol>`;
        case "image":
          return block.src ? `<figure><img src="${escaped(block.src)}" alt="" /></figure>` : "";
        case "chart":
          return `<figure class="chart" data-series="${escaped(block.text)}"></figure>`;
        default:
          return `<p>${escaped(block.text)}</p>`;
      }
    })
    .join("\n");
  return `<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n${body}\n</body>\n</html>\n`;
}

export function HtmlCollabEditor(props: { node: SpaceNode; spaceId: string }) {
  const { node, spaceId } = props;
  const { t } = useTranslation();

  const [status, setStatus] = useState<"connecting" | "connected" | "closed">("connecting");
  const [blocks, setBlocks] = useState<BlockVm[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [preview, setPreview] = useState(false);

  const docRef = useRef<Y.Doc | null>(null);
  const awarenessRef = useRef<awarenessProtocol.Awareness | null>(null);
  const connectionRef = useRef<YjsIpcConnection | null>(null);
  const blocksRef = useRef<Y.Array<Y.Map<unknown>> | null>(null);
  const myColor = useMemo(
    () => PRESENCE_COLORS[Math.floor(Math.random() * PRESENCE_COLORS.length)],
    [],
  );

  const refreshBlocks = useCallback(() => {
    const blocks = blocksRef.current;
    if (!blocks) return;
    const next: BlockVm[] = [];
    blocks.forEach((map) => {
      if (map instanceof Y.Map) next.push(blockVm(map.get("id") as string, map));
    });
    setBlocks(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    docRef.current = doc;
    awarenessRef.current = awareness;
    awareness.setLocalState({ name: "me", color: myColor, blockId: null });

    const root = doc.getMap("html");
    const blocks = (root.get("blocks") ?? root.set("blocks", new Y.Array())) as Y.Array<Y.Map<unknown>>;
    blocksRef.current = blocks;

    const onDeep = () => refreshBlocks();
    blocks.observeDeep(onDeep);
    refreshBlocks();

    void connectYjsOverIpc({ spaceId, nodeId: node.id, doc, awareness, onStatus: setStatus }).then(
      (connection) => {
        if (cancelled) {
          void connection.detach();
          return;
        }
        connectionRef.current = connection;
      },
    );

    const onAwarenessChange = () => {
      const next: Peer[] = [];
      awareness.getStates().forEach((state) => {
        if (typeof state.name === "string" && typeof state.color === "string") {
          next.push({
            name: state.name,
            color: state.color,
            blockId: typeof state.blockId === "string" ? state.blockId : null,
          });
        }
      });
      setPeers(next);
    };
    awareness.on("change", onAwarenessChange);

    return () => {
      cancelled = true;
      blocks.unobserveDeep(onDeep);
      awareness.off("change", onAwarenessChange);
      void connectionRef.current?.detach();
      awareness.destroy();
      doc.destroy();
      docRef.current = null;
      awarenessRef.current = null;
    };
  }, [spaceId, node.id, myColor, refreshBlocks]);

  const mutateBlock = (id: string, mutate: (map: Y.Map<unknown>) => void) => {
    docRef.current?.transact(() => {
      const blocks = blocksRef.current;
      if (!blocks) return;
      blocks.forEach((map) => {
        if (map instanceof Y.Map && map.get("id") === id) mutate(map);
      });
    });
  };

  const setText = (id: string, text: string) => {
    mutateBlock(id, (map) => {
      const ytext = map.get("text") as Y.Text | undefined;
      if (!ytext) {
        map.set("text", new Y.Text(text));
        return;
      }
      const previous = ytext.toString();
      // Minimal delta so concurrent edits to the same block keep their common
      // context; the residue is block-level LWW per SPEC §3.4.
      let start = 0;
      while (start < previous.length && start < text.length && previous[start] === text[start]) start++;
      let endPrev = previous.length;
      let endNext = text.length;
      while (endPrev > start && endNext > start && previous[endPrev - 1] === text[endNext - 1]) {
        endPrev--;
        endNext--;
      }
      if (endPrev > start) ytext.delete(start, endPrev - start);
      if (endNext > start) ytext.insert(start, text.slice(start, endNext));
    });
  };

  const setType = (id: string, type: BlockType) => mutateBlock(id, (map) => map.set("type", type));
  const setSrc = (id: string, src: string) => mutateBlock(id, (map) => map.set("src", src));

  const addBlock = (afterId?: string, type: BlockType = "paragraph") => {
    const doc = docRef.current;
    const blocks = blocksRef.current;
    if (!doc || !blocks) return;
    const map = new Y.Map();
    doc.transact(() => {
      map.set("id", crypto.randomUUID());
      map.set("type", type);
      map.set("text", new Y.Text(""));
      let index = blocks.length;
      if (afterId) {
        blocks.forEach((entry, i) => {
          if (entry instanceof Y.Map && entry.get("id") === afterId) index = i + 1;
        });
      }
      blocks.insert(index, [map]);
    });
  };

  const removeBlock = (id: string) => {
    const doc = docRef.current;
    const blocks = blocksRef.current;
    if (!doc || !blocks) return;
    doc.transact(() => {
      blocks.forEach((entry, i) => {
        if (entry instanceof Y.Map && entry.get("id") === id) blocks.delete(i, 1);
      });
    });
  };

  const setFocusedBlock = (id: string | null) => {
    awarenessRef.current?.setLocalStateField("blockId", id);
  };

  const exportHtml = () => {
    const html = blocksToHtml(blocks);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${node.name.replace(/\.html$/i, "")}.html`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-html-collab={node.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{
            background:
              status === "connected" ? "#57b884" : status === "connecting" ? "#e8a33d" : "#b0b4bb",
          }}
          aria-hidden
        />
        <span className="text-xs opacity-60">
          {t(
            status === "connected"
              ? "space.html.connected"
              : status === "connecting"
                ? "space.html.connecting"
                : "space.html.closed",
          )}
        </span>
        {peers.map((peer, index) => (
          <span
            key={`${peer.name}-${index}`}
            className="rounded-full px-2 py-0.5 text-[10px]"
            style={{ background: `${peer.color}22`, color: peer.color }}
          >
            {peer.name}
          </span>
        ))}
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            className="rounded-md border px-2 py-1 text-xs"
            style={{ borderColor: "var(--ds-border)" }}
            onClick={() => setPreview((value) => !value)}
          >
            {t(preview ? "space.html.edit" : "space.html.preview")}
          </button>
          <button
            type="button"
            className="rounded-md border px-2 py-1 text-xs"
            style={{ borderColor: "var(--ds-border)" }}
            onClick={exportHtml}
          >
            {t("space.html.export")}
          </button>
        </span>
      </div>

      {preview ? (
        <div className="min-h-0 flex-1 overflow-auto" data-testid="space-html-preview">
          {blocks.map((block) => (
            <div key={block.id}>
              {block.type === "h1" ? <h1>{block.text}</h1> : null}
              {block.type === "h2" ? <h2>{block.text}</h2> : null}
              {block.type === "bullet" ? <ul><li>{block.text}</li></ul> : null}
              {block.type === "numbered" ? <ol><li>{block.text}</li></ol> : null}
              {block.type === "image" && block.src ? <img src={block.src} alt="" className="max-w-full" /> : null}
              {block.type === "chart" ? <figure className="chart">{block.text}</figure> : null}
              {block.type === "paragraph" ? <p>{block.text}</p> : null}
            </div>
          ))}
        </div>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto rounded-md border p-3"
          style={{ borderColor: "var(--ds-border)" }}
        >
          {blocks.map((block) => {
            const peersHere = peers.filter((peer) => peer.blockId === block.id);
            return (
              <div key={block.id} className="group mb-2" data-block-type={block.type}>
                <div className="flex items-center gap-1">
                  <select
                    className="rounded border px-1 py-0.5 text-[10px]"
                    style={{ borderColor: "var(--ds-border)" }}
                    value={block.type}
                    onChange={(event) => setType(block.id, event.target.value as BlockType)}
                  >
                    {BLOCK_TYPES.map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                  {peersHere.map((peer) => (
                    <span
                      key={peer.name}
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: peer.color }}
                      title={peer.name}
                    />
                  ))}
                  <button
                    type="button"
                    className="ml-auto rounded px-1 text-[10px] opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                    onClick={() => removeBlock(block.id)}
                  >
                    {t("space.html.removeBlock")}
                  </button>
                </div>
                {block.type === "image" ? (
                  <input
                    className="mt-1 w-full rounded border px-2 py-1 text-sm"
                    style={{ borderColor: "var(--ds-border)" }}
                    placeholder={t("space.html.imageSrc")}
                    value={block.src}
                    onChange={(event) => setSrc(block.id, event.target.value)}
                    onFocus={() => setFocusedBlock(block.id)}
                    onBlur={() => setFocusedBlock(null)}
                  />
                ) : (
                  <div
                    className="mt-1 w-full rounded px-2 py-1 text-sm outline-none focus:ring-1"
                    contentEditable
                    suppressContentEditableWarning
                    data-block-id={block.id}
                    onFocus={() => setFocusedBlock(block.id)}
                    onBlur={() => setFocusedBlock(null)}
                    onInput={(event) => setText(block.id, event.currentTarget.textContent ?? "")}
                    onPaste={(event) => {
                      event.preventDefault();
                      const text = event.clipboardData.getData("text/plain");
                      setText(block.id, block.text + text);
                    }}
                  >
                    {block.text}
                  </div>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="w-full rounded-md border border-dashed px-2 py-1.5 text-xs opacity-60 hover:opacity-100"
            style={{ borderColor: "var(--ds-border)" }}
            onClick={() => addBlock(blocks.at(-1)?.id)}
          >
            {t("space.html.addBlock")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Guard for callers rendering without a live org connection. */
export function HtmlCollabEditorUnavailable() {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6 text-center"
      style={{ borderColor: "var(--ds-border-strong)" }}
    >
      <IconCode size={22} />
      <span className="text-sm opacity-60">{t("space.html.placeholder")}</span>
    </div>
  );
}
