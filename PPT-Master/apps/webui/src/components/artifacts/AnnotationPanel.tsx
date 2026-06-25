import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Trash2 } from "lucide-react"

import { cn } from "@/lib/utils"

// ── Types ──────────────────────────────────────────────────────────────────

export interface Annotation {
  id: string
  pageFile: string
  elementId: string
  elementText: string
  annotation: string
}

export interface AnnotationPanelProps {
  pageFile: string
  annotations: Annotation[]
  selectedElementId: string | null
  selectedElementText: string
  onAdd: (elementId: string, elementText: string, annotation: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

// ── Component ──────────────────────────────────────────────────────────────

export function AnnotationPanel({
  pageFile,
  annotations,
  selectedElementId,
  selectedElementText,
  onAdd,
  onDelete,
}: AnnotationPanelProps) {
  const { t } = useTranslation("editor")
  const pageAnnotations = annotations.filter((a) => a.pageFile === pageFile)

  const [annotationText, setAnnotationText] = useState("")
  const [adding, setAdding] = useState(false)

  const handleAdd = async () => {
    if (!selectedElementId || !annotationText.trim()) return
    setAdding(true)
    try {
      await onAdd(selectedElementId, selectedElementText || selectedElementId, annotationText.trim())
      setAnnotationText("")
    } finally {
      setAdding(false)
    }
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-background/80">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="border-b px-4 py-3">
        <p className="text-sm font-semibold">
          {t("annotation_headerCount", { count: pageAnnotations.length })}
        </p>
      </div>

      {/* ── Annotation list ───────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {pageAnnotations.length === 0 ? (
          <div className="flex min-h-[120px] items-center justify-center px-4 text-center">
            <p className="text-xs text-muted-foreground">
              {t("annotation_emptyHint")}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {pageAnnotations.map((ann) => (
              <div
                key={ann.id}
                className={cn(
                  "rounded-xl border px-3 py-2.5 text-sm transition-colors",
                  ann.elementId === selectedElementId
                    ? "border-primary bg-primary/5"
                    : "border-border bg-background",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-muted-foreground">
                      {truncate(ann.elementText, 40)}
                    </p>
                    <p className="mt-1 text-sm leading-snug">{ann.annotation}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDelete(ann.id)}
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    title={t("annotation_deleteTitle")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mt-1 block truncate text-[11px] text-muted-foreground/60">
                  id: {ann.elementId}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Add form (sticky bottom) ───────────────────────── */}
      <div className="border-t bg-background/95 p-3">
        <div className="mb-2 min-h-[1.25rem]">
          {selectedElementId ? (
            <p className="text-xs text-muted-foreground">
              {t("annotation_elementPrefix")}:{" "}
              <span className="font-medium text-foreground">
                {truncate(selectedElementText, 30, t("annotation_emptyElement"))}
              </span>{" "}
              <span className="text-muted-foreground/60">[{selectedElementId}]</span>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              {t("annotation_clickHint")}
            </p>
          )}
        </div>

        <textarea
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          rows={3}
          placeholder={t("annotation_placeholder")}
          value={annotationText}
          onChange={(e) => setAnnotationText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              handleAdd()
            }
          }}
        />

        <button
          type="button"
          disabled={!selectedElementId || !annotationText.trim() || adding}
          onClick={handleAdd}
          className={cn(
            "mt-2 w-full rounded-lg px-4 py-2 text-sm font-medium transition-colors",
            selectedElementId && annotationText.trim() && !adding
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "cursor-not-allowed bg-muted text-muted-foreground",
          )}
        >
          {adding ? t("annotation_addingButton") : t("annotation_addButton")}
        </button>
      </div>
    </aside>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function truncate(text: string, max: number, emptyFallback = "(empty)"): string {
  if (!text) return emptyFallback
  return text.length > max ? text.slice(0, max) + "..." : text
}
