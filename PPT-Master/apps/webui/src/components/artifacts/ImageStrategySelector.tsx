import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { ArrowRight, Sparkles, Globe, Upload, ImageOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AIRecommendBadge } from "@/components/ui/AIRecommendBadge"
import { cn } from "@/lib/utils"

interface Strategy {
  id: string
  nameKey: string
  icon: React.ReactNode
  descKey: string
  exampleKey: string
}

const STRATEGIES: Strategy[] = [
  { id: "ai", nameKey: "images_aiName", icon: <Sparkles className="h-4 w-4" />, descKey: "images_aiDesc", exampleKey: "images_aiExample" },
  { id: "web", nameKey: "images_webName", icon: <Globe className="h-4 w-4" />, descKey: "images_webDesc", exampleKey: "images_webExample" },
  { id: "user", nameKey: "images_userName", icon: <Upload className="h-4 w-4" />, descKey: "images_userDesc", exampleKey: "images_userExample" },
  { id: "placeholder", nameKey: "images_placeholderName", icon: <ImageOff className="h-4 w-4" />, descKey: "images_placeholderDesc", exampleKey: "images_placeholderExample" },
]

// Map from backend rec.strategy (backend names) → STRATEGIES id
const REC_STRATEGY_MAP: Record<string, string> = {
  ai_generated: "ai",
  user_provided: "user",
  placeholder: "placeholder",
  web_sourced: "web",
  ai: "ai",
  web: "web",
  user: "user",
}

interface ImageStrategySelectorProps {
  prompt: string
  recommendation?: Record<string, unknown> | null
  onSubmit: (data: { defaultStrategy: string; notes: string }) => void
  disabled?: boolean
}

export function ImageStrategySelector({ prompt, recommendation, onSubmit, disabled }: ImageStrategySelectorProps) {
  const { t } = useTranslation("editor")
  const [defaultStrategy, setDefaultStrategy] = useState("placeholder")
  const [notes, setNotes] = useState("")
  const [recStrategyId, setRecStrategyId] = useState<string | null>(null)

  useEffect(() => {
    if (!recommendation) { setRecStrategyId(null); return }
    const recStrategy = recommendation.strategy as string | undefined
    if (recStrategy) {
      const mapped = REC_STRATEGY_MAP[recStrategy]
      if (mapped) {
        setDefaultStrategy(mapped)
        setRecStrategyId(mapped)
      }
    }
    // Pre-fill style as a note hint
    if (typeof recommendation.style === "string" && recommendation.style) {
      setNotes((prev) => prev || `Style: ${recommendation.style}`)
    }
  }, [recommendation])

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">{t("images_title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("images_subtitle")}
        </p>
        {prompt && (
          <div className="mt-3 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs leading-relaxed">
            {prompt}
          </div>
        )}
      </div>

      {/* Strategy cards */}
      <div>
        <label className="text-sm font-medium">{t("images_defaultLabel")}</label>
        <p className="mb-2 text-xs text-muted-foreground">
          {t("images_defaultHint")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {STRATEGIES.map(s => (
            <button
              key={s.id}
              type="button"
              disabled={disabled}
              onClick={() => setDefaultStrategy(s.id)}
              className={cn(
                "flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors hover:border-primary",
                defaultStrategy === s.id
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border"
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn(
                  "rounded-md p-1",
                  defaultStrategy === s.id ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                )}>
                  {s.icon}
                </span>
                <span className="text-sm font-semibold">{t(s.nameKey)}</span>
                {recStrategyId === s.id && <AIRecommendBadge />}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t(s.descKey)}</p>
              <p className="text-[10px] text-muted-foreground/70">{t("images_exampleLabel")}: {t(s.exampleKey)}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Per-page override notes */}
      <div>
        <label className="text-sm font-medium">{t("images_perPageLabel")}</label>
        <p className="mb-2 text-xs text-muted-foreground">
          {t("images_perPageHint")} <code className="rounded bg-muted px-1 text-[10px]">Page N: ai — ...</code>
        </p>
        <textarea
          className="min-h-[80px] w-full resize-y rounded-md border bg-background p-3 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder={t("images_perPagePlaceholder")}
          value={notes}
          onChange={e => setNotes(e.target.value)}
          disabled={disabled}
        />
      </div>

      <div className="flex justify-end">
        <Button onClick={() => onSubmit({ defaultStrategy, notes: notes.trim() })} disabled={disabled}>
          {t("images_confirm")}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
