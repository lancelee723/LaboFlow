import { useState } from "react"
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { useLocale } from "@/hooks/LocaleContext"
import { Plus, FileText, Trash2, RotateCcw } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

interface Project {
  id: string
  name: string
  format: string
  status: string
  current_step: number
  ai_summary: string | null
  ai_tags: string[] | null
  soft_deleted_at: string | null
  created_at: string
  updated_at: string
}

interface ArtifactEntry {
  path: string
  kind: string
  label: string
  content_type: string
  url: string
}

type Tab = "all" | "trash"

function daysUntilPermanentDeletion(softDeletedAt: string): number {
  const deletedMs = new Date(softDeletedAt).getTime()
  const nowMs = Date.now()
  const elapsedDays = (nowMs - deletedMs) / (1000 * 60 * 60 * 24)
  return Math.max(0, Math.ceil(30 - elapsedDays))
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

export function ProjectsListPage() {
  useLocale() // re-renders on locale change via React context
  const { t } = useTranslation("projects")
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [activeTab, setActiveTab] = useState<Tab>("all")
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  // Trash multi-select for permanent deletion
  const [selectMode, setSelectMode] = useState(false)
  const [selectedTrash, setSelectedTrash] = useState<Set<string>>(new Set())
  const [permaTarget, setPermaTarget] = useState<Project[] | null>(null)
  const [isPermaDeleting, setIsPermaDeleting] = useState(false)

  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiFetch<Project[]>("/api/projects"),
    enabled: activeTab === "all",
  })

  const { data: trashProjects, isLoading: isTrashLoading } = useQuery({
    queryKey: ["projects-trash"],
    queryFn: () => apiFetch<Project[]>("/api/projects/_trash"),
    enabled: activeTab === "trash",
  })

  // Fetch first SVG thumbnail for each active project
  const artifactQueries = useQueries({
    queries: (activeTab === "all" ? projects ?? [] : []).map((project) => ({
      queryKey: ["project-artifacts", project.id],
      queryFn: () => apiFetch<ArtifactEntry[]>(`/api/projects/${project.id}/artifacts`),
      enabled: !!projects,
      staleTime: 60_000,
    })),
  })

  const thumbnailsByProject = new Map<string, string | null>()
  if (activeTab === "all") {
    artifactQueries.forEach((query, i) => {
      const projectId = projects?.[i]?.id
      if (!projectId) return
      const firstSvg = query.data?.find((a) => a.kind === "svg")
      thumbnailsByProject.set(projectId, firstSvg?.url ?? null)
    })
  }

  const statusLabel = (status: string) => {
    if (status === "completed") return t("statusDone")
    if (status === "generating") return t("statusRunning")
    if (status === "aborted") return t("statusStopped")
    return t("statusDraft")
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      await apiFetch(`/api/projects/${deleteTarget.id}`, { method: "DELETE" })
      queryClient.invalidateQueries({ queryKey: ["projects"] })
      queryClient.invalidateQueries({ queryKey: ["projects-trash"] })
      setDeleteTarget(null)
    } catch (err) {
      alert(err instanceof Error ? err.message : t("deleteProject") + " failed")
    } finally {
      setIsDeleting(false)
    }
  }

  const handleRestore = async (project: Project) => {
    setRestoringId(project.id)
    try {
      await apiFetch(`/api/projects/${project.id}/restore`, { method: "POST" })
      queryClient.invalidateQueries({ queryKey: ["projects"] })
      queryClient.invalidateQueries({ queryKey: ["projects-trash"] })
    } catch (err) {
      alert(err instanceof Error ? err.message : t("restore") + " failed")
    } finally {
      setRestoringId(null)
    }
  }

  const handlePermaDelete = async () => {
    if (!permaTarget || permaTarget.length === 0) return
    setIsPermaDeleting(true)
    const errors: string[] = []
    for (const project of permaTarget) {
      try {
        await apiFetch(`/api/projects/${project.id}/permanent`, { method: "DELETE" })
      } catch (err) {
        errors.push(project.name)
      }
    }
    setIsPermaDeleting(false)
    setPermaTarget(null)
    setSelectedTrash(new Set())
    setSelectMode(false)
    queryClient.invalidateQueries({ queryKey: ["projects-trash"] })
    if (errors.length > 0) {
      alert("Failed to delete: " + errors.join(", "))
    }
  }

  const toggleTrashSelect = (id: string) => {
    setSelectedTrash(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (!trashProjects) return
    if (selectedTrash.size === trashProjects.length) {
      setSelectedTrash(new Set())
    } else {
      setSelectedTrash(new Set(trashProjects.map(p => p.id)))
    }
  }

  const loading = activeTab === "all" ? isLoading : isTrashLoading

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {activeTab === "all" && (
          <Button onClick={() => navigate("/projects/new")}>
            <Plus className="mr-2 h-4 w-4" />
            {t("newProject")}
          </Button>
        )}
      </div>

      {/* Tab strip */}
      <div className="mb-5 flex gap-1 border-b">
        <button
          type="button"
          onClick={() => setActiveTab("all")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "all"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("allTab")}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("trash")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "trash"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("trashTab")}
        </button>
      </div>

      {loading && <div className="text-muted-foreground">{t("loading")}</div>}

      {/* ── All tab ─────────────────────────────────────────────────── */}
      {activeTab === "all" && (
        <>
          {projects && projects.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <FileText className="mb-4 h-12 w-12 text-muted-foreground/50" />
                <p className="text-lg font-medium">{t("noProjects")}</p>
                <p className="text-sm text-muted-foreground">{t("noProjectsHint")}</p>
                <Button className="mt-4" onClick={() => navigate("/projects/new")}>
                  <Plus className="mr-2 h-4 w-4" />
                  {t("newProject")}
                </Button>
              </CardContent>
            </Card>
          )}

          {projects && projects.length > 0 && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {projects.map((project) => {
                const thumb = thumbnailsByProject.get(project.id) ?? null
                return (
                  <Card
                    key={project.id}
                    className="group relative cursor-pointer transition-shadow hover:shadow-md"
                    onClick={() => navigate(`/projects/${project.id}`)}
                  >
                    <button
                      type="button"
                      className="absolute right-2 top-2 z-10 hidden h-7 w-7 items-center justify-center rounded-md bg-white/90 hover:bg-destructive hover:text-destructive-foreground group-hover:flex"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteTarget(project)
                      }}
                      title={t("deleteProject")}
                      aria-label={`${t("deleteProject")} ${project.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    <CardContent className="p-4">
                      <div className="mb-3 flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted">
                        {thumb ? (
                          <img src={thumb} alt={project.name} className="h-full w-full object-cover bg-white" />
                        ) : (
                          <FileText className="h-8 w-8 text-muted-foreground/50" />
                        )}
                      </div>
                      <h3 className="font-semibold truncate">{project.name}</h3>
                      {project.ai_summary && (
                        <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{project.ai_summary}</p>
                      )}
                      <div className="mt-3 flex items-center gap-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            project.status === "completed"
                              ? "bg-green-100 text-green-700"
                              : project.status === "generating"
                                ? "bg-blue-100 text-blue-700 relative overflow-hidden after:absolute after:inset-0 after:bg-gradient-to-r after:from-transparent after:via-white/40 after:to-transparent after:animate-shimmer"
                                : project.status === "aborted"
                                  ? "bg-red-100 text-red-700"
                                  : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {statusLabel(project.status)}
                        </span>
                        {project.ai_tags?.map((tag) => (
                          <span key={tag} className="text-xs text-muted-foreground">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* ── Trash tab ────────────────────────────────────────────────── */}
      {activeTab === "trash" && (
        <>
          {trashProjects && trashProjects.length > 0 && (
            <div className="mb-3 flex items-center gap-2">
              {selectMode ? (
                <>
                  <Button variant="ghost" size="sm" onClick={toggleSelectAll}>
                    {selectedTrash.size === trashProjects.length ? t("deselectAll") : t("selectAll")}
                  </Button>
                  <div className="flex-1" />
                  <Button variant="outline" size="sm" onClick={() => { setSelectMode(false); setSelectedTrash(new Set()) }}>
                    {t("cancel")}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={selectedTrash.size === 0}
                    onClick={() => {
                      const targets = trashProjects.filter(p => selectedTrash.has(p.id))
                      setPermaTarget(targets)
                    }}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                    {t("confirmDelete")} ({selectedTrash.size})
                  </Button>
                </>
              ) : (
                <div className="flex-1" />
              )}
              {!selectMode && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="bg-muted/60 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
                  onClick={() => setSelectMode(true)}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  {t("permanentDelete")}
                </Button>
              )}
            </div>
          )}
          {trashProjects && trashProjects.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Trash2 className="mb-4 h-12 w-12 text-muted-foreground/50" />
                <p className="text-lg font-medium">{t("trashEmpty")}</p>
                <p className="text-sm text-muted-foreground">{t("trashEmptyHint")}</p>
              </CardContent>
            </Card>
          )}

          {trashProjects && trashProjects.length > 0 && (
            <div className="space-y-2">
              {trashProjects.map((project) => {
                const daysLeft = project.soft_deleted_at
                  ? daysUntilPermanentDeletion(project.soft_deleted_at)
                  : 0
                const deletedOn = project.soft_deleted_at ? formatDate(project.soft_deleted_at) : ""
                return (
                  <Card key={project.id}>
                    <CardContent className="flex items-center justify-between p-4">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        {selectMode && (
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-muted-foreground shrink-0"
                            checked={selectedTrash.has(project.id)}
                            onChange={() => toggleTrashSelect(project.id)}
                          />
                        )}
                        <div className="min-w-0">
                          <p className="font-medium truncate">{project.name}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {t("deletedOn", { date: deletedOn })} &bull;{" "}
                            <span className={daysLeft <= 3 ? "text-destructive font-medium" : ""}>
                              {daysLeft === 1
                                ? t("daysUntilPermanent", { days: daysLeft })
                                : t("daysUntilPermanent_plural", { days: daysLeft })}
                            </span>
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-4 shrink-0"
                        onClick={() => handleRestore(project)}
                        disabled={restoringId === project.id}
                      >
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                        {restoringId === project.id ? t("restoring") : t("restore")}
                      </Button>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="mb-2 text-lg font-semibold">{t("moveToTrashTitle")}</h2>
            <p className="mb-6 text-sm text-muted-foreground">
              {t("moveToTrashDesc", { name: deleteTarget.name })}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setDeleteTarget(null)}
                disabled={isDeleting}
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
              >
                {isDeleting ? t("moving") : t("moveToTrash")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Permanent delete confirmation modal */}
      {permaTarget && permaTarget.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="mb-2 text-lg font-semibold">{t("permanentDeleteTitle")}</h2>
            <p className="mb-2 text-sm text-muted-foreground">
              {t("permanentDeleteDesc", { count: permaTarget.length })}
            </p>
            <ul className="mb-4 max-h-32 overflow-y-auto text-sm">
              {permaTarget.map(p => (
                <li key={p.id} className="truncate text-destructive">{p.name}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setPermaTarget(null)}
                disabled={isPermaDeleting}
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={handlePermaDelete}
                disabled={isPermaDeleting}
              >
                {isPermaDeleting ? t("permanentlyDeleting") : t("permanentDelete")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
