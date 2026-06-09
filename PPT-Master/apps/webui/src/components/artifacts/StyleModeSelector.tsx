import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { ArrowRight, Check, Palette, BarChart3, TrendingUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AIRecommendBadge } from "@/components/ui/AIRecommendBadge"
import { cn } from "@/lib/utils"

interface Mode {
  id: string
  labelKey: string
  icon: React.ReactNode
  descKey: string
}

const MODES: Mode[] = [
  { id: "A", labelKey: "style_versatile", icon: <Palette className="h-5 w-5" />, descKey: "style_versatile" },
  { id: "B", labelKey: "style_consulting", icon: <BarChart3 className="h-5 w-5" />, descKey: "style_consulting" },
  { id: "C", labelKey: "style_topConsulting", icon: <TrendingUp className="h-5 w-5" />, descKey: "style_topConsulting" },
]

const MODE_DESCRIPTIONS: Record<string, string> = {
  A: "Visual impact first — catch the eye at a glance. Best for public/clients/trainees.",
  B: "Data clarity first — let data speak. Best for teams/management.",
  C: "Logical persuasion first — lead with conclusions. Best for executives/board/investors.",
}

const REC_MODE_MAP: Record<string, string> = {
  versatile: "A", consulting: "B", top_consulting: "C", A: "A", B: "B", C: "C",
}

interface StyleModeSelectorProps {
  prompt: string
  recommendation?: Record<string, unknown> | null
  onSubmit: (data: { mode: string; descriptor: string }) => void
  disabled?: boolean
}

export function StyleModeSelector({ prompt, recommendation, onSubmit, disabled }: StyleModeSelectorProps) {
  const { t } = useTranslation("editor")
  const [mode, setMode] = useState<string>("B")
  const [descriptor, setDescriptor] = useState("")
  const [recModeId, setRecModeId] = useState<string | null>(null)

  useEffect(() => {
    if (!recommendation) { setRecModeId(null); return }
    const recMode = recommendation.mode as string | undefined
    if (recMode) {
      const mapped = REC_MODE_MAP[recMode]
      if (mapped) { setMode(mapped); setRecModeId(mapped) }
    }
    if (typeof recommendation.descriptor === "string" && recommendation.descriptor) {
      setDescriptor(recommendation.descriptor)
    }
  }, [recommendation])

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">{t("style_title")}</h2>
        {prompt && (
          <div className="mt-3 whitespace-pre-wrap rounded-md bg-muted/50 p-4 text-sm leading-relaxed">
            {prompt}
          </div>
        )}
      </div>

      <div>
        <label className="text-sm font-medium">{t("style_modeLabel")}</label>
        <p className="text-xs text-muted-foreground">{t("style_subtitle")}</p>
        <div className="mt-2 grid grid-cols-1 gap-3">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={disabled}
              onClick={() => setMode(m.id)}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:border-primary",
                mode === m.id
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border"
              )}
            >
              <div className={cn(
                "mt-0.5 rounded-full p-1.5",
                mode === m.id ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              )}>
                {m.icon}
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono font-bold">{m.id}</span>
                  <span className="text-sm font-semibold">{t(m.labelKey)}</span>
                  {recModeId === m.id && <AIRecommendBadge />}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{MODE_DESCRIPTIONS[m.id]}</p>
              </div>
              {mode === m.id && <Check className="mt-1 h-4 w-4 shrink-0 text-primary" />}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-sm font-medium">{t("style_descriptorLabel")}</label>
        <p className="mb-2 text-xs text-muted-foreground">{t("style_descriptorHint")}</p>
        <Input
          value={descriptor}
          onChange={e => setDescriptor(e.target.value)}
          placeholder={t("style_descriptorPlaceholder")}
          disabled={disabled}
        />
      </div>

      <div className="flex justify-end">
        <Button onClick={() => onSubmit({ mode, descriptor: descriptor.trim() })} disabled={disabled}>
          {t("style_confirm")}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
