import { useState, useEffect } from "react"
import { ArrowRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AIRecommendBadge } from "@/components/ui/AIRecommendBadge"

interface NumberInputGateProps {
  title: string
  prompt: string
  recommendation?: Record<string, unknown> | null
  min?: number
  max?: number
  unit?: string
  onSubmit: (result: { mode: "explicit"; value: number } | { mode: "ai_decide" }) => void
  disabled?: boolean
}

export function NumberInputGate({
  title,
  prompt,
  recommendation,
  min = 3,
  max = 100,
  unit = "pages",
  onSubmit,
  disabled,
}: NumberInputGateProps) {
  const { t } = useTranslation("editor")
  const [mode, setMode] = useState<"explicit" | "ai_decide">("ai_decide")
  const [value, setValue] = useState<number>(Math.round((min + max) / 2))
  const [recApplied, setRecApplied] = useState(false)

  useEffect(() => {
    if (!recommendation) { setRecApplied(false); return }
    const recMode = recommendation.mode as string | undefined
    const recCount = recommendation.count as number | undefined
    if (recMode === "ai_decide") {
      setMode("ai_decide")
      setRecApplied(true)
    } else if (recMode === "explicit" && typeof recCount === "number" && recCount >= min && recCount <= max) {
      setMode("explicit")
      setValue(recCount)
      setRecApplied(true)
    }
  }, [recommendation, min, max])

  const handleSubmit = () => {
    if (mode === "explicit") onSubmit({ mode, value })
    else onSubmit({ mode })
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
      <header>
        <h2 className="text-lg font-semibold">{title}</h2>
        {prompt && (
          <div className="mt-3 whitespace-pre-wrap rounded-md bg-muted/50 p-4 text-sm leading-relaxed">
            {prompt}
          </div>
        )}
      </header>

      {recApplied && (
        <div className="flex items-center gap-1.5 rounded-md bg-purple-50 px-3 py-2 text-xs text-purple-700">
          {t("number_gate_rec_applied")}
        </div>
      )}

      <fieldset className="space-y-3">
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
          <input
            type="radio"
            name="page-count-mode"
            checked={mode === "explicit"}
            onChange={() => setMode("explicit")}
            className="mt-1"
          />
          <div className="flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              {t("number_gate_specify")}
              {recApplied && mode === "explicit" && <AIRecommendBadge />}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Input
                type="number"
                min={min}
                max={max}
                value={value}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10)
                  if (!isNaN(n)) setValue(n)
                }}
                disabled={mode !== "explicit" || disabled}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">{unit}</span>
            </div>
          </div>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
          <input
            type="radio"
            name="page-count-mode"
            checked={mode === "ai_decide"}
            onChange={() => setMode("ai_decide")}
            className="mt-1"
          />
          <div className="flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              {t("number_gate_ai_decide")}
              {recApplied && mode === "ai_decide" && <AIRecommendBadge />}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("number_gate_ai_decide_hint")}
            </div>
          </div>
        </label>
      </fieldset>

      <div className="flex justify-end">
        <Button onClick={handleSubmit} disabled={disabled}>
          {t("number_gate_confirm")}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
