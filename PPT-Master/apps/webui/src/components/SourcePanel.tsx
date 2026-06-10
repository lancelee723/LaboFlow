import { useState } from "react"
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

interface SourcePanelProps {
  projectId: string
  onStart?: () => void
  isStarting?: boolean
}

export function SourcePanel({ projectId, onStart, isStarting }: SourcePanelProps) {
  const queryClient = useQueryClient()
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
          method: "POST",
          credentials: "include",
          body: form,
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
        method: "POST",
        body: JSON.stringify({ url: urlInput.trim() }),
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
    <div className="mx-auto w-full max-w-2xl p-6">
      <h2 className="mb-1 text-lg font-semibold">Source Materials</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Upload documents or paste URLs to seed the presentation. You can add as many as you like
        before starting the pipeline.
      </p>

      <div
        className={cn(
          "rounded-lg border-2 border-dashed p-8 text-center transition-colors",
          isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25",
          busy && "opacity-60 pointer-events-none"
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragging(false)
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFiles(e.dataTransfer.files)
          }
        }}
      >
        <Upload className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm">Drag files here, or</p>
        <div className="mt-3 flex justify-center gap-2">
          <label className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90">
            Choose Files
            <input
              type="file"
              multiple
              accept={ACCEPT_TYPES}
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  handleFiles(e.target.files)
                  e.target.value = ""
                }
              }}
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowUrlInput(true)}
            disabled={busy}
          >
            <Link2 className="mr-1 h-3 w-3" /> Add URL
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          PDF, DOCX, XLSX, PPTX, MD, TXT, or any HTTP(S) URL · 200MB max per file
        </p>
      </div>

      {showUrlInput && (
        <div className="mt-3 flex gap-2">
          <Input
            autoFocus
            placeholder="https://example.com/article"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddUrl()}
            disabled={busy}
          />
          <Button size="sm" onClick={handleAddUrl} disabled={busy || !urlInput.trim()}>
            Add
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setShowUrlInput(false)
              setUrlInput("")
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {uploadError && (
        <div className="mt-3 rounded-md bg-destructive/10 p-2 text-sm text-destructive">
          {uploadError}
        </div>
      )}

      {onStart && (
        <div className="mt-6 flex justify-center border-t pt-6">
          <Button
            size="lg"
            onClick={onStart}
            disabled={isStarting}
            className="gap-2"
          >
            <Play className="h-5 w-5" />
            {isStarting ? "Submitting…" : "Submit"}
          </Button>
        </div>
      )}

      {sources && sources.length > 0 && (
        <ul className="mt-6 space-y-2">
          {sources.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between rounded-md border p-2 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                {s.kind === "source_url" ? (
                  <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">
                  {s.kind === "source_url" ? s.meta?.url : s.filename}
                </span>
                {s.size_bytes != null && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {(s.size_bytes / 1024).toFixed(0)} KB
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => handleDelete(s.id)}
                title="Remove"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}

    </div>
  )
}
