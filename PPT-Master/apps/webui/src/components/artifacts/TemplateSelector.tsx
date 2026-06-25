import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Check, Image as ImageIcon } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { apiFetch } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface TemplateInfo {
  id: string
  kind: string
  name: string
  summary: string
  canvas_format: string
  page_count: number | null
  page_types: string[]
  primary_color: string | null
  preview_data_uri: string | null
}

interface TemplateSelectorProps {
  onSubmit: (templateId: string | null) => void
  onSkip: () => void
  disabled?: boolean
}

export function TemplateSelector({ onSubmit, onSkip, disabled }: TemplateSelectorProps) {
  const { t } = useTranslation("editor")
  const [selected, setSelected] = useState<string | null>(null)

  const { data: templates, isLoading } = useQuery({
    queryKey: ["templates", "built-in"],
    queryFn: () => apiFetch<TemplateInfo[]>("/api/templates/built-in"),
  })

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("template_loading")}
      </div>
    )
  }

  const layouts = (templates || []).filter(tpl => tpl.kind === "layout")
  const decks = (templates || []).filter(tpl => tpl.kind === "deck")

  const renderCard = (tpl: TemplateInfo, fallbackLabel: string) => (
    <button
      key={tpl.id}
      type="button"
      disabled={disabled}
      onClick={() => setSelected(tpl.id)}
      className={cn(
        "flex flex-col rounded-xl border p-4 text-left transition-colors hover:border-primary",
        selected === tpl.id
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border",
      )}
    >
      <div className="mb-3 flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-muted">
        {tpl.preview_data_uri ? (
          <img src={tpl.preview_data_uri} alt={tpl.id} className="h-full w-full object-cover" />
        ) : (
          <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
            <ImageIcon className="h-6 w-6" />
            <span>{t("template_coverPreview")}</span>
            <span className="text-[10px]">
              {tpl.page_count
                ? `${tpl.page_count} ${t("template_pagesUnit")}`
                : fallbackLabel}
            </span>
          </div>
        )}
      </div>
      <span className="truncate text-sm font-medium">{tpl.name || tpl.id}</span>
      {tpl.summary && (
        <span className="mt-1 line-clamp-2 text-xs text-muted-foreground">{tpl.summary}</span>
      )}
      <div className="mt-2 flex items-center justify-between">
        {tpl.primary_color && (
          <span
            className="h-3 w-3 rounded-full border"
            style={{ backgroundColor: tpl.primary_color }}
            title={tpl.primary_color}
          />
        )}
        {selected === tpl.id && <Check className="h-4 w-4 text-primary" />}
      </div>
    </button>
  )

  return (
    <div className="relative flex w-full flex-col overflow-y-auto">
      <div className="flex flex-col gap-6 p-6 pb-4">
        <div>
          <h2 className="text-lg font-semibold">{t("template_title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("template_subtitle")}</p>
        </div>

        {layouts.length > 0 && (
          <section>
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              {t("template_layoutSection")}
            </h3>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {layouts.map(tpl => renderCard(tpl, t("template_layoutFallback")))}
            </div>
          </section>
        )}

        {decks.length > 0 && (
          <section>
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              {t("template_deckSection")}
            </h3>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {decks.map(tpl => renderCard(tpl, t("template_deckFallback")))}
            </div>
          </section>
        )}
      </div>

      {/* Sticky action bar — always visible; right padding clears the floating ChatBubble. */}
      <div className="sticky bottom-0 mt-auto flex justify-between border-t bg-background/95 px-6 py-4 pr-24 backdrop-blur-sm">
        <Button variant="outline" onClick={onSkip} disabled={disabled}>
          {t("template_skipFreeDesign")}
        </Button>
        <Button onClick={() => onSubmit(selected)} disabled={disabled || !selected}>
          {t("template_confirmContinue")}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
