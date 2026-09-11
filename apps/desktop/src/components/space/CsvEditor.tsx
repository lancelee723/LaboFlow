import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpaceDoc, SpaceNode } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button } from "../ui";
import { IconPlus, IconRefresh, IconTrash } from "../icons";

/**
 * RFC4180 CSV parse: quoted fields with doubled quotes, commas and newlines
 * inside quotes. Final newline is not a row terminator.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    // A trailing empty row (final newline) is not a record.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < input.length) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field.length === 0) {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (quoted || field.length > 0 || row.length > 0) pushRow();
  return rows;
}

function needsQuotes(value: string): boolean {
  return /[",\r\n]/.test(value);
}

/** RFC4180 serialize: quote only when required, CRLF row terminator. */
export function serializeCsv(rows: string[][]): string {
  return (
    rows
      .map((row) =>
        row
          .map((value) => (needsQuotes(value) ? `"${value.replace(/"/g, '""')}"` : value))
          .join(","),
      )
      .join("\r\n") + (rows.length > 0 ? "\r\n" : "")
  );
}

const MAX_CELL_CHARS = 20_000;

/**
 * CSV grid editor (T52.14 v1 slice): editable cells + row/column ops, saved
 * through the same versioned optimistic-lock pipeline as MD (UTF-8 round trip
 * is guaranteed by the RFC4180 parse/serialize pair above).
 */
export function CsvEditor(props: {
  spaceId: string;
  node: SpaceNode;
  doc: SpaceDoc | null;
  canEdit: boolean;
  onToast: (message: string, variant?: "info" | "error" | "success") => void;
  onDocLoaded: (doc: SpaceDoc) => void;
}) {
  const { spaceId, node, doc, canEdit, onToast, onDocLoaded } = props;
  const { t } = useTranslation();
  const [grid, setGrid] = useState<string[][]>([]);
  const [savedVersion, setSavedVersion] = useState(0);
  const [saving, setSaving] = useState(false);

  const content = doc?.content ?? "";

  const reload = useCallback(
    async (keepEdits: boolean) => {
      try {
        const fresh = await api.spaceDocGet({ spaceId, nodeId: node.id });
        onDocLoaded(fresh);
        if (!keepEdits) {
          setGrid(parseCsv(fresh.content));
          setSavedVersion(fresh.version);
        }
      } catch (error) {
        onToast(error instanceof Error ? error.message : String(error), "error");
      }
    },
    [spaceId, node.id, onDocLoaded, onToast],
  );

  useEffect(() => {
    setGrid([]);
    void reload(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const dirty = useMemo(
    () => serializeCsv(grid) !== content,
    [grid, content],
  );

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await api.spaceDocSave({
        spaceId,
        nodeId: node.id,
        content: serializeCsv(grid),
        baseVersion: savedVersion,
      });
      setSavedVersion(result.version);
      onDocLoaded({
        nodeId: node.id,
        version: result.version,
        content: serializeCsv(grid),
        sha256: result.sha256,
        authorId: null,
        source: (result.source ?? null) as SpaceDoc["source"],
        createdAt: doc?.createdAt ?? null,
        currentVersion: result.version,
      });
      onToast(t("space.doc.saved", { version: result.version }), "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };

  const setCell = (rowIndex: number, colIndex: number, value: string) => {
    setGrid((prev) =>
      prev.map((row, r) =>
        r === rowIndex
          ? row.map((cell, c) => (c === colIndex ? value.slice(0, MAX_CELL_CHARS) : cell))
          : row,
      ),
    );
  };

  const addRow = () => {
    setGrid((prev) => [...prev, new Array(Math.max(1, prev[0]?.length ?? 1)).fill("")]);
  };

  const addColumn = () => {
    setGrid((prev) => prev.map((row) => [...row, ""]));
  };

  const deleteRow = (rowIndex: number) => {
    setGrid((prev) => prev.filter((_, r) => r !== rowIndex));
  };

  const columnCount = Math.max(0, ...grid.map((row) => row.length));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {canEdit ? (
          <>
            <Button size="sm" variant="primary" disabled={saving || !dirty} onClick={() => void save()}>
              {saving ? t("space.doc.saving") : t("space.doc.save")}
              {dirty ? " •" : ""}
            </Button>
            <Button size="sm" variant="ghost" onClick={addRow}>
              <IconPlus size={13} />
              {t("space.csv.addRow")}
            </Button>
            <Button size="sm" variant="ghost" onClick={addColumn}>
              <IconPlus size={13} />
              {t("space.csv.addColumn")}
            </Button>
          </>
        ) : (
          <span className="text-xs opacity-60">{t("space.doc.viewerHint")}</span>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" title={t("space.doc.reload")} onClick={() => void reload(grid.length > 0)}>
          <IconRefresh size={13} />
          {t("space.refresh")}
        </Button>
        <span className="text-xs opacity-50">
          {t("space.doc.version", { version: doc?.version ?? 0 })}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border" style={{ borderColor: "var(--ds-border-subtle)" }}>
        {grid.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs opacity-60">{t("space.doc.empty")}</div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <tbody>
              {grid.map((row, rowIndex) => (
                <tr key={rowIndex} className="group">
                  {row.map((cell, colIndex) => (
                    <td
                      key={colIndex}
                      className="border p-0 align-top"
                      style={{
                        borderColor: "var(--ds-border-subtle)",
                        minWidth: colIndex === 0 ? 80 : undefined,
                      }}
                    >
                      <input
                        className="w-full bg-transparent px-2 py-1 text-sm outline-none focus:bg-[color:var(--ds-bg-hover)]"
                        value={cell}
                        readOnly={!canEdit}
                        spellCheck={false}
                        onChange={(event) => setCell(rowIndex, colIndex, event.target.value)}
                      />
                    </td>
                  ))}
                  {row.length < columnCount
                    ? Array.from({ length: columnCount - row.length }, (_, pad) => (
                        <td
                          key={`pad-${pad}`}
                          className="border p-0"
                          style={{ borderColor: "var(--ds-border-subtle)" }}
                        >
                          <input
                            className="w-full bg-transparent px-2 py-1 text-sm outline-none"
                            readOnly={!canEdit}
                            value=""
                            onChange={(event) => setCell(rowIndex, row.length + pad, event.target.value)}
                          />
                        </td>
                      ))
                    : null}
                  {canEdit ? (
                    <td className="w-8 border p-0 text-center opacity-0 group-hover:opacity-70" style={{ borderColor: "var(--ds-border-subtle)" }}>
                      <button
                        type="button"
                        title={t("space.csv.deleteRow")}
                        aria-label={t("space.csv.deleteRow")}
                        onClick={() => deleteRow(rowIndex)}
                      >
                        <IconTrash size={12} />
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
