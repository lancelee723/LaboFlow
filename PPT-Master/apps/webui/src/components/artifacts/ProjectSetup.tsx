import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Upload, FileText, Link2, Trash2, Play } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface SourceArtifact {
  id: string
  kind: "source" | "source_url"
  filename: string
  size_bytes: number | null
  meta: { url?: string } | null
  created_at: string
}

const ACCEPT_TYPES = ".pdf,.docx,.xlsx,.xlsm,.pptx,.md,.txt"

interface ProjectSetupProps {
  projectId: string
  onSubmit: (userBrief: string) => void
  isStarting?: boolean
}

export function ProjectSetup({ projectId, onSubmit, isStarting }: ProjectSetupProps) {
  const { t } = useTranslation("editor")
  const queryClient = useQueryClient()
  const [brief, setBrief] = useState("")
  const [urlInput, setUrlInput] = useState("")
  const [showUrlInput, setShowUrlInput] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { data: sources } = useQuery({
    queryKey: ["sources", projectId],
    queryFn: () => apiFetch<SourceArtifact[]>(`/api/projects/${projectId}/sources`),
  })

  const handleFiles = async (files: FileList) => {
    setBusy(true)
    setUploadError(null)
    try {
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.append("file", file)
        const res = await fetch(`/api/projects/${projectId}/sources`, {
          method: "POST", credentials: "include", body: form,
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.detail || `Upload failed for ${file.name}`)
        }
      }
      queryClient.invalidateQueries({ queryKey: ["sources", projectId] })
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setBusy(false)
    }
  }

  const handleAddUrl = async () => {
    if (!urlInput.trim()) return
    setBusy(true)
    setUploadError(null)
    try {
      await apiFetch(`/api/projects/${projectId}/sources`, {
        method: "POST", body: JSON.stringify({ url: urlInput.trim() }),
      })
      setUrlInput("")
      setShowUrlInput(false)
      queryClient.invalidateQueries({ queryKey: ["sources", projectId] })
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Add URL failed")
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/api/projects/${projectId}/sources/${id}`, { method: "DELETE" })
      queryClient.invalidateQueries({ queryKey: ["sources", projectId] })
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Delete failed")
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">{t("projectSetup_title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("projectSetup_desc")}</p>
      </div>

      <div>
        <label className="text-sm font-medium">{t("projectSetup_briefLabel")}</label>
        <textarea
          className="mt-2 min-h-[160px] w-full resize-y rounded-md border bg-background p-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder={t("projectSetup_briefPlaceholder")}
          value={brief}
          onChange={e => setBrief(e.target.value)}
        />
      </div>

      <div>
        <label className="text-sm font-medium">{t("projectSetup_filesLabel")}</label>
        <div
          className={cn(
            "mt-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors",
            isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25",
            busy && "opacity-60 pointer-events-none"
          )}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault(); setIsDragging(false)
            if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files)
          }}
        >
          <Upload className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">{t("projectSetup_dropHint")}</p>
          <div className="mt-2 flex justify-center gap-2">
            <label className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90">
              {t("projectSetup_chooseFiles")}
              <input
                type="file" multiple accept={ACCEPT_TYPES} className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) { handleFiles(e.target.files); e.target.value = "" }
                }}
              />
            </label>
            <Button variant="outline" size="sm" onClick={() => setShowUrlInput(true)} disabled={busy}>
              <Link2 className="mr-1 h-3 w-3" /> {t("projectSetup_addUrl")}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("projectSetup_formatsHint")}</p>
        </div>

        {showUrlInput && (
          <div className="mt-2 flex gap-2">
            <Input autoFocus placeholder="https://example.com/article" value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAddUrl()}
              disabled={busy} />
            <Button size="sm" onClick={handleAddUrl} disabled={busy || !urlInput.trim()}>{t("projectSetup_add")}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowUrlInput(false); setUrlInput("") }}>{t("projectSetup_cancel")}</Button>
          </div>
        )}

        {uploadError && (
          <div className="mt-2 rounded-md bg-destructive/10 p-2 text-sm text-destructive">{uploadError}</div>
        )}

        {sources && sources.length > 0 && (
          <ul className="mt-2 space-y-1">
            {sources.map(s => (
              <li key={s.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  {s.kind === "source_url" ? <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" /> : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span className="truncate">{s.kind === "source_url" ? s.meta?.url : s.filename}</span>
                  {s.size_bytes != null && <span className="shrink-0 text-xs text-muted-foreground">{(s.size_bytes / 1024).toFixed(0)} KB</span>}
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleDelete(s.id)} title={t("projectSetup_remove")}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex justify-end">
        <Button size="lg" onClick={() => onSubmit(brief.trim())} disabled={isStarting}>
          <Play className="mr-2 h-5 w-5" />
          {isStarting ? t("projectSetup_starting") : brief.trim() ? t("projectSetup_submitPipeline") : t("projectSetup_submitDefaults")}
        </Button>
      </div>
    </div>
  )
}
