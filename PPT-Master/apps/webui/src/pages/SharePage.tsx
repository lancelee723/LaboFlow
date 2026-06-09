import { useParams, Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { ArrowLeft, Download, FileText } from "lucide-react"

interface ShareData {
  project: {
    id: string
    name: string
    status: string
    ai_summary: string | null
    ai_tags: string[] | null
    created_at: string
  }
  share: {
    expires_at: string | null
    allowed_pages: number[] | null
  }
}

export function SharePage() {
  const { t } = useTranslation("common")
  const { token } = useParams<{ token: string }>()

  const { data, isLoading, error } = useQuery({
    queryKey: ["share", token],
    queryFn: async () => {
      const res = await fetch(`/share/${token}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || `Link ${res.status === 410 ? "expired" : "not found"}`)
      }
      return res.json() as Promise<ShareData>
    },
  })

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <div className="text-muted-foreground">{t("share.loading")}</div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-muted/30 p-4 text-center">
        <FileText className="mb-4 h-16 w-16 text-muted-foreground/50" />
        <h1 className="text-2xl font-bold mb-2">{t("share.unavailable_title")}</h1>
        <p className="text-muted-foreground mb-6">
          {error instanceof Error ? error.message : t("share.unavailable_desc")}
        </p>
        <Link to="/" className="text-primary hover:underline">
          {t("share.go_home")}
        </Link>
      </div>
    )
  }

  const expired = data.share.expires_at && new Date(data.share.expires_at) < new Date()

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="flex h-14 items-center border-b bg-background px-6">
        <Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t("appName")}
        </Link>
      </header>

      <main className="mx-auto max-w-5xl p-6">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <div className="flex aspect-video items-center justify-center rounded-lg bg-card border shadow-sm">
              <div className="text-center">
                <FileText className="mx-auto mb-3 h-16 w-16 text-muted-foreground/50" />
                <p className="text-lg font-semibold">{data.project.name}</p>
                <p className="text-sm text-muted-foreground">{t("share.shared_presentation")}</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-lg border bg-card p-4 shadow-sm">
              <h1 className="text-xl font-bold">{data.project.name}</h1>
              {data.project.ai_summary && (
                <p className="mt-2 text-sm text-muted-foreground">{data.project.ai_summary}</p>
              )}
              {data.project.ai_tags && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {data.project.ai_tags.map((tag) => (
                    <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs">
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {data.project.status === "completed" && (
              <a
                href={`/api/projects/${data.project.id}/export.pptx`}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
              >
                <Download className="h-4 w-4" />
                {t("share.download_pptx")}
              </a>
            )}

            <div className="rounded-lg border bg-card p-4 shadow-sm text-xs text-muted-foreground space-y-1">
              <p>{t("share.status")}: {data.project.status}</p>
              {data.share.expires_at && (
                <p>
                  {t("share.expires")}: {new Date(data.share.expires_at).toLocaleDateString()}
                  {expired && <span className="ml-1 text-destructive font-medium">{t("share.expired")}</span>}
                </p>
              )}
              {data.share.allowed_pages && (
                <p>{t("share.pages")}: {data.share.allowed_pages.join(", ")}</p>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
