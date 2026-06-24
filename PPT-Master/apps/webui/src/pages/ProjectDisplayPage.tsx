import { useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { ArrowLeft, Copy, Download, Edit, Share2, Trash2 } from "lucide-react"
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

export function ProjectDisplayPage() {
  const { t } = useTranslation("common")
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [shareUrl, setShareUrl] = useState("")
  const [shareCopied, setShareCopied] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const { data: project, isLoading } = useQuery({
    queryKey: ["project", id],
    queryFn: () => apiFetch<Project>(`/api/projects/${id}`),
    enabled: !!id,
  })

  const { data: artifacts = [] } = useQuery({
    queryKey: ["project-artifacts", id],
    queryFn: () => apiFetch<ArtifactEntry[]>(`/api/projects/${id}/artifacts`),
    enabled: !!id,
  })

  const svgPages = artifacts.filter((a) => a.kind === "svg")
  const coverSvg = svgPages[0]
  const previewPages = svgPages.slice(0, 6)

  const handleConfirmDelete = async () => {
    if (!project) return
    setIsDeleting(true)
    try {
      await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" })
      queryClient.invalidateQueries({ queryKey: ["projects"] })
      navigate("/projects")
    } catch (err) {
      alert(err instanceof Error ? err.message : t("display.delete_failed"))
      setIsDeleting(false)
      setShowDeleteConfirm(false)
    }
  }

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">{t("display.loading")}</div>
  }

  if (!project) {
    return <div className="p-6 text-muted-foreground">{t("display.not_found")}</div>
  }

  return (
    <div className="p-6">
      <button
        className="mb-4 flex items-center text-sm text-muted-foreground hover:text-foreground"
        onClick={() => navigate("/projects")}
      >
        <ArrowLeft className="mr-1 h-4 w-4" />
        {t("display.back_to_projects")}
      </button>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardContent className="flex aspect-video items-center justify-center overflow-hidden p-0">
              {coverSvg ? (
                <img src={coverSvg.url} alt={coverSvg.label} className="h-full w-full object-contain bg-white" />
              ) : (
                <div className="flex flex-col items-center text-muted-foreground">
                  <span className="text-6xl font-bold">{project.name.charAt(0)}</span>
                  <span className="mt-2 text-sm">{t("display.no_slides")}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {previewPages.length > 0 && (
            <div className="mt-6">
              <h2 className="mb-3 text-lg font-semibold">{t("display.slide_previews")}</h2>
              <div className="grid grid-cols-6 gap-2">
                {previewPages.map((page) => (
                  <div
                    key={page.path}
                    className="aspect-video overflow-hidden rounded bg-muted"
                  >
                    <img src={page.url} alt={page.label} className="h-full w-full object-cover bg-white" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <h1 className="text-xl font-bold">{project.name}</h1>
              {project.ai_summary && (
                <p className="mt-2 text-sm text-muted-foreground">{project.ai_summary}</p>
              )}
              {project.ai_tags && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {project.ai_tags.map((tag) => (
                    <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs">
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-col gap-2">
            {project.status === "completed" && (
              <a href={`${import.meta.env.BASE_URL}api/projects/${id}/export.pptx`} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground">
                <Download className="h-4 w-4" />
                {t("display.download_pptx")}
              </a>
            )}
            <Button className="w-full" onClick={() => navigate(`/projects/${id}/edit`)}>
              <Edit className="mr-2 h-4 w-4" />
              {project.status === "draft" ? t("display.continue") : t("display.edit")}
            </Button>
            <Button className="w-full" variant="outline" onClick={async () => {
              if (shareUrl) {
                await navigator.clipboard.writeText(shareUrl)
                setShareCopied(true)
                setTimeout(() => setShareCopied(false), 2000)
                return
              }
              try {
                const result = await apiFetch<{ url: string }>(`/api/projects/${id}/share`, {
                  method: "POST",
                  body: JSON.stringify({ project_id: id, expires_in_days: 7 }),
                })
                setShareUrl(result.url)
                await navigator.clipboard.writeText(result.url)
                setShareCopied(true)
                setTimeout(() => setShareCopied(false), 2000)
              } catch (err) {
                alert(err instanceof Error ? err.message : t("display.share_failed"))
              }
            }}>
              {shareCopied ? <Copy className="mr-2 h-4 w-4" /> : <Share2 className="mr-2 h-4 w-4" />}
              {shareCopied ? t("display.copied") : shareUrl ? t("display.copy_link") : t("display.share")}
            </Button>
            <Button
              className="w-full"
              variant="destructive"
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("display.delete")}
            </Button>
          </div>

          <Card>
            <CardContent className="p-4 text-xs text-muted-foreground space-y-1">
              <p>{t("display.format")}: {project.format}</p>
              <p>{t("display.pages")}: {svgPages.length}</p>
              <p>{t("display.status")}: {project.status}</p>
              <p>{t("display.created")}: {new Date(project.created_at).toLocaleDateString()}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="mb-2 text-lg font-semibold">{t("display.delete_title")}</h2>
            <p className="mb-6 text-sm text-muted-foreground"
              dangerouslySetInnerHTML={{
                __html: t("display.delete_desc", { name: project.name })
                  .replace(/"([^"]+)"/, '"<span class="font-medium text-foreground">$1</span>"')
              }}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
              >
                {isDeleting ? t("display.deleting") : t("display.delete")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
