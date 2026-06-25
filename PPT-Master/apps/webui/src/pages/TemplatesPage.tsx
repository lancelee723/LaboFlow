import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { useLocale } from "@/hooks/LocaleContext"
import { FileText, Plus } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"

interface Template {
  id: string
  template_id: string
  kind: string
  name: string
  summary: string
  canvas_format: string
  primary_color: string | null
  page_count: number | null
  is_builtin: boolean
  preview_url: string | null
}

export function TemplatesPage() {
  useLocale() // re-renders on locale change via React context
  const { t } = useTranslation("common")
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [kindFilter, setKindFilter] = useState<"all" | "layout" | "brand" | "deck">("all")

  const kindLabels: Record<string, string> = {
    deck: t("kindDeck"),
    layout: t("kindLayout"),
    brand: t("kindBrand"),
  }

  const { data: templates, isLoading } = useQuery({
    queryKey: ["templates"],
    queryFn: () => apiFetch<Template[]>("/api/templates"),
  })

  const filteredTemplates = templates?.filter(
    (t) => kindFilter === "all" || t.kind === kindFilter
  )

  const handleDelete = async (templateId: string) => {
    if (!confirm(t("deleteConfirm"))) return
    await apiFetch(`/api/templates/${templateId}`, { method: "DELETE" })
    queryClient.invalidateQueries({ queryKey: ["templates"] })
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("templatesTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("templatesSubtitle")}</p>
        </div>
        <button
          onClick={() => navigate("/templates/new")}
          className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t("uploadPPTX")}
        </button>
      </div>

      <div className="mb-4 flex gap-1 border-b">
        {([
          { value: "all", label: t("filterAll") },
          { value: "layout", label: t("filterLayouts") },
          { value: "brand", label: t("filterBrands") },
          { value: "deck", label: t("filterDecks") },
        ] as const).map((tab) => (
          <button
            key={tab.value}
            onClick={() => setKindFilter(tab.value)}
            className={cn(
              "px-3 py-1.5 text-sm border-b-2 -mb-px transition-colors",
              kindFilter === tab.value
                ? "border-primary text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Templates grid */}
      {isLoading && <p className="text-muted-foreground">{t("loading")}</p>}

      {filteredTemplates && filteredTemplates.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <FileText className="mb-4 h-12 w-12 opacity-50" />
            <p className="text-lg font-medium">{t("noTemplates")}</p>
            <p className="text-sm">{t("noTemplatesHint")}</p>
          </CardContent>
        </Card>
      )}

      {filteredTemplates && filteredTemplates.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredTemplates.map((tmpl) => (
            <Card key={tmpl.id}>
              <CardContent className="p-4">
                <div className="mb-3 flex aspect-video items-center justify-center overflow-hidden rounded-md bg-white">
                  {tmpl.preview_url ? (
                    <img
                      src={tmpl.preview_url}
                      alt={tmpl.name}
                      className="h-full w-full object-contain"
                      loading="lazy"
                    />
                  ) : (
                    <FileText className="h-8 w-8 text-muted-foreground/50" />
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-sm truncate">{tmpl.name}</h3>
                    <p className="text-xs text-muted-foreground line-clamp-1">{tmpl.summary}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                      {kindLabels[tmpl.kind] || tmpl.kind}
                    </span>
                    {tmpl.is_builtin && (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
                        {t("builtIn")}
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{tmpl.canvas_format}</span>
                  {tmpl.page_count && <span>· {t("pageCount", { count: tmpl.page_count })}</span>}
                  {!tmpl.is_builtin && (
                    <button
                      className="ml-auto text-destructive hover:underline"
                      onClick={() => handleDelete(tmpl.id)}
                    >
                      {t("delete")}
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
