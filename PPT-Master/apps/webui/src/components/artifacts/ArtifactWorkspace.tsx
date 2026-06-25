import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  FileImage,
  FileJson,
  FileText,
  Loader2,
  Presentation,
  Send,
  Sparkles,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { usePipelineStoreSSR } from "@/stores/pipeline"
import { AnnotationPanel, type Annotation } from "./AnnotationPanel"
import { SvgProgressHeader } from "./SvgProgressHeader"
import { WorkspaceStatus } from "./WorkspaceStatus"

export interface ArtifactEntry {
  path: string
  kind: string
  label: string
  content_type: "text" | "svg" | "image" | "download"
  size: number
  updated_at: string
  url: string
}

export interface ArtifactContent {
  path: string
  kind: string
  content_type: "text" | "svg"
  text: string
}

export interface SvgProgress {
  page: number
  total: number
}

interface ArtifactWorkspaceProps {
  artifacts: ArtifactEntry[]
  selectedArtifactPath: string | null
  selectedContent: ArtifactContent | null
  isLoading: boolean
  isContentLoading: boolean
  onSelect: (path: string) => void
  annotationMode?: boolean
  onExitAnnotation?: () => void
  projectId?: string
}

const kindLabels: Record<string, string> = {
  outline: "Strategy",
  design_spec: "Strategy",
  spec_lock: "Strategy",
  svg: "Slides",
  image: "Images",
  export: "Exports",
}

export function ArtifactWorkspace({
  artifacts,
  selectedArtifactPath,
  selectedContent,
  isLoading,
  isContentLoading,
  onSelect,
  annotationMode = false,
  onExitAnnotation,
  projectId,
}: ArtifactWorkspaceProps) {
  const { t } = useTranslation("editor")
  const queryClient = useQueryClient()
  const pipelineStep = usePipelineStoreSSR((s) => s.pipelineStep)
  const isRunning = usePipelineStoreSSR((s) => s.isRunning)
  const svgProgress = usePipelineStoreSSR((s) => s.svgProgress)

  // ── Annotation state ──────────────────────────────────────────────────
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null)
  const [selectedElementText, setSelectedElementText] = useState("")
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [annotationsByPage, setAnnotationsByPage] = useState<Record<string, Annotation[]>>({})
  const [submitting, setSubmitting] = useState(false)
  const [editSeq, setEditSeq] = useState(0)
  const [svgContentCache, setSvgContentCache] = useState<Record<string, string>>({})
  const [svgRefreshKey, setSvgRefreshKey] = useState(0)
  const svgContainerRef = useRef<HTMLDivElement>(null)
  const hoveredElementRef = useRef<Element | null>(null)

  const selectedArtifact = artifacts.find((artifact) => artifact.path === selectedArtifactPath) ?? artifacts[0]
  const groupedArtifacts = groupArtifacts(artifacts)
  const svgArtifacts = artifacts.filter((a) => a.kind === "svg")

  // ── Fetch annotations when page changes in annotation mode ────────────
  useEffect(() => {
    if (!annotationMode || !projectId) return
    fetch(`/api/projects/${projectId}/annotations`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        const all = data.annotations as Annotation[]
        setAnnotations(all)
        const byPage: Record<string, Annotation[]> = {}
        for (const a of all) {
          byPage[a.pageFile] = [...(byPage[a.pageFile] || []), a]
        }
        setAnnotationsByPage(byPage)
      })
      .catch(console.error)
  }, [annotationMode, projectId, selectedArtifactPath])

  // ── SVG inline content fetching ───────────────────────────────────────
  useEffect(() => {
    if (!annotationMode || !selectedArtifact) return
    if (selectedArtifact.content_type !== "svg") return
    const url = selectedArtifact.url
    if (svgContentCache[url]) return
    let cancelled = false
    fetch(url, { credentials: "include" })
      .then((r) => r.text())
      .then((text) => {
        if (!cancelled) setSvgContentCache((prev) => ({ ...prev, [url]: text }))
      })
      .catch(console.error)
    return () => { cancelled = true }
  }, [annotationMode, selectedArtifact?.url, selectedArtifact?.content_type, svgRefreshKey])

  // ── SVG hover highlight + click select ────────────────────────────────

  const handleSvgMouseOver = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!annotationMode) return
      const target = e.target as Element
      if (target === e.currentTarget) return
      const svg = target.closest("svg")
      if (!svg || target === svg) return
      if (target === selectedElementIdRef.current) return
      // Remove highlight from previous hovered element
      if (hoveredElementRef.current && hoveredElementRef.current !== selectedElementIdRef.current) {
        ;(hoveredElementRef.current as HTMLElement).style.outline = ""
        ;(hoveredElementRef.current as HTMLElement).style.outlineOffset = ""
      }
      hoveredElementRef.current = target
      ;(target as HTMLElement).style.outline = "2px solid #60a5fa"
      ;(target as HTMLElement).style.outlineOffset = "1px"
    },
    [annotationMode],
  )

  const handleSvgMouseOut = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!annotationMode) return
      const target = e.target as Element
      if (target === e.currentTarget) return
      const svg = target.closest("svg")
      if (!svg || target === svg) return
      if (hoveredElementRef.current === target) {
        if (hoveredElementRef.current !== selectedElementIdRef.current) {
          ;(hoveredElementRef.current as HTMLElement).style.outline = ""
          ;(hoveredElementRef.current as HTMLElement).style.outlineOffset = ""
        }
        hoveredElementRef.current = null
      }
    },
    [annotationMode],
  )

  // Ref to track selected element for hover highlight skip
  const selectedElementIdRef = useRef<Element | null>(null)

  const handleSvgClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!annotationMode) return
      const target = e.target as Element
      if (target === e.currentTarget) return
      const svg = target.closest("svg")
      if (!svg || target === svg) return

      // Remove highlight from previously selected element
      if (selectedElementIdRef.current) {
        ;(selectedElementIdRef.current as HTMLElement).style.outline = ""
        ;(selectedElementIdRef.current as HTMLElement).style.outlineOffset = ""
      }

      let id = target.getAttribute("id")
      if (!id) {
        id = `_edit_${editSeq}`
        target.setAttribute("id", id)
        setEditSeq((s) => s + 1)
      }
      // Mark the selected element with a persistent highlight
      ;(target as HTMLElement).style.outline = "2px solid #f59e0b"
      ;(target as HTMLElement).style.outlineOffset = "2px"
      selectedElementIdRef.current = target
      // Clear any hover reference
      if (hoveredElementRef.current && hoveredElementRef.current !== target) {
        ;(hoveredElementRef.current as HTMLElement).style.outline = ""
        ;(hoveredElementRef.current as HTMLElement).style.outlineOffset = ""
        hoveredElementRef.current = null
      }

      setSelectedElementId(id)
      setSelectedElementText(target.textContent ?? "")
    },
    [annotationMode, editSeq],
  )

  // ── Keyboard nav ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!annotationMode) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Suppress when focus is in input/textarea
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return

      const svgsOnly = svgArtifacts
      const idx = svgsOnly.findIndex((a) => a.path === selectedArtifactPath)

      if (e.key === "ArrowLeft" && idx > 0) {
        e.preventDefault()
        onSelect(svgsOnly[idx - 1].path)
      } else if (e.key === "ArrowRight" && idx < svgsOnly.length - 1) {
        e.preventDefault()
        onSelect(svgsOnly[idx + 1].path)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [annotationMode, selectedArtifactPath, artifacts])

  // ── Submit all annotations ────────────────────────────────────────────
  const handleSubmitAll = useCallback(async () => {
    if (!projectId || submitting) return
    if (annotations.length === 0) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/annotations/submit`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${res.status}`)
      }
      const result = await res.json()
      // Refresh annotations (they were cleared server-side)
      setAnnotations([])
      setAnnotationsByPage({})
      // Clear selected element
      setSelectedElementId(null)
      setSelectedElementText("")
      if (selectedElementIdRef.current) {
        ;(selectedElementIdRef.current as HTMLElement).style.outline = ""
        ;(selectedElementIdRef.current as HTMLElement).style.outlineOffset = ""
        selectedElementIdRef.current = null
      }
      // Clear SVG cache so regenerated SVGs are refetched.
      setSvgContentCache({})
      setSvgRefreshKey((k) => k + 1)
      // Invalidate the artifact list so URLs pick up the new updated_at
      // cache-bust query param; the SVG content effect then re-fetches
      // on the new URL.
      queryClient.invalidateQueries({ queryKey: ["project-artifacts", projectId] })
      if (result.errors?.length) {
        console.warn("Annotation submit had errors:", result.errors)
      }
    } catch (err) {
      console.error("Submit annotations failed:", err)
    } finally {
      setSubmitting(false)
    }
  }, [projectId, submitting, annotations.length, queryClient])

  // ── Add single annotation ─────────────────────────────────────────────
  const handleAddAnnotation = useCallback(
    async (elementId: string, elementText: string, annotation: string) => {
      if (!projectId || !selectedArtifact) return
      const pageFile = selectedArtifact.path.startsWith("svg_output/")
        ? selectedArtifact.path.slice("svg_output/".length)
        : selectedArtifact.path
      const res = await fetch(`/api/projects/${projectId}/annotations`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageFile,
          elementId,
          elementText,
          annotation,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${res.status}`)
      }
      const created: Annotation = await res.json()
      setAnnotations((prev) => [...prev, created])
    },
    [projectId, selectedArtifact],
  )

  // ── Delete single annotation ──────────────────────────────────────────
  const handleDeleteAnnotation = useCallback(
    async (annotationId: string) => {
      if (!projectId) return
      const res = await fetch(`/api/projects/${projectId}/annotations/${annotationId}`, {
        method: "DELETE",
        credentials: "include",
      })
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${res.status}`)
      }
      setAnnotations((prev) => prev.filter((a) => a.id !== annotationId))
    },
    [projectId],
  )

  // ── Loading state ─────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex w-full items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t("artifacts_loadingPreview")}</span>
      </div>
    )
  }

  if (artifacts.length === 0) {
    if (isRunning && pipelineStep > 0) {
      return <WorkspaceStatus pipelineStep={pipelineStep} isRunning={isRunning} />
    }
    return (
      <div className="flex w-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <div className="rounded-full border border-dashed p-3">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <p className="font-medium text-foreground">{t("workspace_title")}</p>
          <p className="text-sm">{t("workspace_emptyHint")}</p>
        </div>
      </div>
    )
  }

  // ── Annotation Mode Layout (3 columns) ────────────────────────────────
  const showAnnotationUI =
    annotationMode && !isRunning && selectedArtifact.content_type === "svg"

  if (showAnnotationUI) {
    const currentPageFile = selectedArtifact.path.startsWith("svg_output/")
      ? selectedArtifact.path.slice("svg_output/".length)
      : selectedArtifact.path
    const svgHtml = svgContentCache[selectedArtifact.url] ?? null
    const svgIndex = svgArtifacts.findIndex((a) => a.path === selectedArtifact.path)

    return (
      <div className="flex w-full min-h-0 bg-muted/10">
        {/* ── Column 1: Page list (SVGs only) ─────────────────── */}
        <aside className="flex w-56 shrink-0 flex-col border-r bg-background/80">
          <div className="border-b px-3 py-2.5">
            <p className="text-sm font-semibold">{t("annotation_slidesTitle")}</p>
            <p className="text-xs text-muted-foreground">
              {svgArtifacts.length} {t("annotation_pagesSuffix")}
            </p>
          </div>

          {/* Submit All + Export buttons */}
          <div className="border-b px-3 py-2 space-y-1.5">
            <button
              type="button"
              disabled={annotations.length === 0 || submitting}
              onClick={handleSubmitAll}
              className={cn(
                "flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors",
                annotations.length > 0 && !submitting
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "cursor-not-allowed bg-muted text-muted-foreground",
              )}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("annotation_submitting")}
                </>
              ) : (
                <>
                  <Send className="h-3 w-3" />
                  {t("annotation_submitAll", { count: annotations.length })}
                </>
              )}
            </button>
            {onExitAnnotation && (
              <button
                type="button"
                onClick={onExitAnnotation}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ArrowLeft className="h-3 w-3" />
                {t("annotation_backToWorkspace")}
              </button>
            )}
          </div>

          {/* Page list (scrollable) */}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="space-y-0.5">
              {svgArtifacts.map((artifact, idx) => {
                const pageFile = artifact.path.startsWith("svg_output/")
                  ? artifact.path.slice("svg_output/".length)
                  : artifact.path
                const pageAnns = annotationsByPage[pageFile] ?? []
                return (
                  <button
                    key={artifact.path}
                    type="button"
                    onClick={() => onSelect(artifact.path)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      artifact.path === selectedArtifact.path
                        ? "bg-primary/10 text-foreground font-medium border border-primary/30"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent",
                    )}
                  >
                    <span className="text-xs font-mono text-muted-foreground/60 w-5 shrink-0">
                      {idx + 1}
                    </span>
                    <span className="truncate flex-1">{artifact.label}</span>
                    {pageAnns.length > 0 && (
                      <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                        {pageAnns.length}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Keyboard nav hints */}
          <div className="border-t px-3 py-2">
            <p className="text-[10px] text-muted-foreground">
              <kbd className="rounded border bg-muted px-1 text-[10px]">&larr;</kbd>{" "}
              <kbd className="rounded border bg-muted px-1 text-[10px]">&rarr;</kbd>{" "}
              {t("annotation_keyboardHint")}
            </p>
          </div>
        </aside>

        {/* ── Column 2: SVG preview (inline) ───────────────────── */}
        <section className="min-w-0 flex-1 flex flex-col overflow-hidden">
          <header className="flex items-center justify-between border-b bg-background/60 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={svgIndex <= 0}
                onClick={() => onSelect(svgArtifacts[svgIndex - 1].path)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold">{selectedArtifact.label}</h2>
                <p className="truncate text-xs text-muted-foreground">
                  {t("annotation_pageOf", { current: svgIndex + 1, total: svgArtifacts.length })}
                </p>
              </div>
              <button
                type="button"
                disabled={svgIndex >= svgArtifacts.length - 1}
                onClick={() => onSelect(svgArtifacts[svgIndex + 1].path)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <a
              href={selectedArtifact.url}
              className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Download className="h-3.5 w-3.5" />
              {t("annotation_download")}
            </a>
          </header>

          <div className="min-h-0 flex-1 overflow-auto bg-white p-4">
            {svgHtml ? (
              <div
                ref={svgContainerRef}
                className="svg-preview [&_svg]:max-w-full [&_svg]:h-auto [&_svg_text]:cursor-pointer [&_svg_tspan]:cursor-pointer [&_svg_rect]:cursor-pointer [&_svg_path]:cursor-pointer [&_svg_circle]:cursor-pointer [&_svg_ellipse]:cursor-pointer"
                dangerouslySetInnerHTML={{ __html: svgHtml }}
                onClick={handleSvgClick}
                onMouseOver={handleSvgMouseOver}
                onMouseOut={handleSvgMouseOut}
              />
            ) : (
              <div className="flex min-h-[240px] items-center justify-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t("annotation_loadingSvg")}</span>
              </div>
            )}
          </div>
        </section>

        {/* ── Column 3: AnnotationPanel ────────────────────────── */}
        <AnnotationPanel
          pageFile={currentPageFile}
          annotations={annotations}
          selectedElementId={selectedElementId}
          selectedElementText={selectedElementText}
          onAdd={handleAddAnnotation}
          onDelete={handleDeleteAnnotation}
        />
      </div>
    )
  }

  // ── Default Layout (2 columns) ────────────────────────────────────────
  return (
    <div className="flex w-full min-h-0 bg-muted/10">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-background/80">
        {pipelineStep === 5 && isRunning && svgProgress && svgProgress.total > 0 ? (
          <SvgProgressHeader page={svgProgress.page} total={svgProgress.total} />
        ) : (
          <div className="border-b px-4 py-3">
            <p className="text-sm font-semibold">{t("artifacts_sidebarTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("artifacts_sidebarDesc")}</p>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="space-y-4">
            {groupedArtifacts.map(([groupName, groupArtifacts]) => (
              <section key={groupName} className="space-y-2">
                <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  {groupName}
                </p>
                <div className="space-y-1">
                  {groupArtifacts.map((artifact) => (
                    <button
                      key={artifact.path}
                      type="button"
                      onClick={() => onSelect(artifact.path)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-xl border px-3 py-2 text-left transition-colors",
                        artifact.path === selectedArtifact.path
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-transparent bg-background hover:border-border hover:bg-muted/60",
                      )}
                    >
                      <span className="mt-0.5 text-muted-foreground">{artifactIcon(artifact)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{artifact.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">{artifact.path}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto">
        <header className="flex items-center justify-between border-b bg-background/60 px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{selectedArtifact.label}</h2>
            <p className="truncate text-xs text-muted-foreground">{selectedArtifact.path}</p>
          </div>
          <a
            href={selectedArtifact.url}
            className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
            {t("artifacts_download")}
          </a>
        </header>

        <div className="p-5">
          {isContentLoading && needsTextContent(selectedArtifact) ? (
            <div className="flex min-h-[240px] items-center justify-center gap-3 rounded-2xl border border-dashed bg-background/80 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{t("artifacts_loadingPreview")}</span>
            </div>
          ) : (
            renderArtifactPreview(t, selectedArtifact, selectedContent)
          )}
        </div>
      </section>
    </div>
  )
}

function groupArtifacts(artifacts: ArtifactEntry[]) {
  const groups = new Map<string, ArtifactEntry[]>()

  for (const artifact of artifacts) {
    const groupName = kindLabels[artifact.kind] ?? "Other"
    const entries = groups.get(groupName) ?? []
    entries.push(artifact)
    groups.set(groupName, entries)
  }

  return Array.from(groups.entries())
}

function artifactIcon(artifact: ArtifactEntry) {
  switch (artifact.content_type) {
    case "svg":
      return <Presentation className="h-4 w-4" />
    case "image":
      return <FileImage className="h-4 w-4" />
    case "download":
      return <Download className="h-4 w-4" />
    default:
      return artifact.path.endsWith(".json") ? <FileJson className="h-4 w-4" /> : <FileText className="h-4 w-4" />
  }
}

function needsTextContent(artifact: ArtifactEntry) {
  return artifact.content_type === "text"
}

function renderArtifactPreview(t: (key: string) => string, artifact: ArtifactEntry, selectedContent: ArtifactContent | null) {
  if (artifact.content_type === "svg") {
    return (
      <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
        <img src={artifact.url} alt={artifact.label} className="h-auto max-h-[70vh] w-full object-contain" />
      </div>
    )
  }

  if (artifact.content_type === "image") {
    return (
      <div className="overflow-hidden rounded-2xl border bg-background shadow-sm">
        <img src={artifact.url} alt={artifact.label} className="h-auto max-h-[70vh] w-full object-contain" />
      </div>
    )
  }

  if (artifact.content_type === "download") {
    return (
      <div className="flex min-h-[240px] flex-col items-center justify-center gap-4 rounded-2xl border border-dashed bg-background/80 px-6 text-center">
        <div className="rounded-full bg-muted p-3 text-muted-foreground">
          <Download className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <p className="font-medium">{t("artifacts_downloadReady")}</p>
          <p className="text-sm text-muted-foreground">{t("artifacts_downloadReadyDesc")}</p>
        </div>
        <a
          href={artifact.url}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          <Download className="h-4 w-4" />
          {t("artifacts_downloadFile")}
        </a>
      </div>
    )
  }

  if (!selectedContent) {
    return (
      <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-dashed bg-background/80 text-sm text-muted-foreground">
        {t("artifacts_selectHint")}
      </div>
    )
  }

  return (
    <pre className="min-h-[240px] overflow-x-auto rounded-2xl border bg-background p-4 text-sm leading-6 text-foreground shadow-sm whitespace-pre-wrap">
      {selectedContent.text}
    </pre>
  )
}
