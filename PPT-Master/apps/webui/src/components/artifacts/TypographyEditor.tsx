import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { ArrowRight, Check, Type } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AIRecommendBadge } from "@/components/ui/AIRecommendBadge"
import { cn } from "@/lib/utils"

interface FontCombo {
  id: string
  name: string
  titleFamily: string
  bodyFamily: string
  emphasisFamily: string
  codeFamily: string
  note: string
}

const COMBOS: FontCombo[] = [
  { id: "serif_sans", name: "Serif x Sans (经典搭配)", titleFamily: "Georgia, KaiTi, serif", bodyFamily: `"Microsoft YaHei", "PingFang SC", sans-serif`, emphasisFamily: "Georgia, KaiTi, serif", codeFamily: `Consolas, "Courier New", monospace`, note: "Title serif, body sans — professional contrast" },
  { id: "kai_hei", name: "Kai x Hei (楷黑搭配)", titleFamily: "KaiTi, Georgia, serif", bodyFamily: `"Microsoft YaHei", "PingFang SC", sans-serif`, emphasisFamily: "KaiTi, Georgia, serif", codeFamily: `Consolas, "Courier New", monospace`, note: "Chinese calligraphic title + modern sans body" },
  { id: "fangsong_hei", name: "FangSong x Hei (仿宋黑体)", titleFamily: `FangSong, "Times New Roman", serif`, bodyFamily: `SimHei, "Microsoft YaHei", sans-serif`, emphasisFamily: `FangSong, "Times New Roman", serif`, codeFamily: `Consolas, "Courier New", monospace`, note: "Traditional FangSong title + bold Hei body" },
  { id: "government", name: "Government (政务风格)", titleFamily: `SimHei, "Microsoft YaHei", sans-serif`, bodyFamily: `SimSun, serif`, emphasisFamily: `SimHei, "Microsoft YaHei", sans-serif`, codeFamily: `Consolas, "Courier New", monospace`, note: "Authoritative Hei title + Song body — 政府公文" },
  { id: "tech", name: "Tech / Developer (技术风)", titleFamily: `Arial, "Microsoft YaHei", sans-serif`, bodyFamily: `Arial, "Microsoft YaHei", sans-serif`, emphasisFamily: `Arial, "Microsoft YaHei", sans-serif`, codeFamily: `Consolas, "Courier New", monospace`, note: "Clean sans throughout + monospace code" },
  { id: "display_neutral", name: "Display x Neutral (冲击力)", titleFamily: `Impact, "Arial Black", SimHei, sans-serif`, bodyFamily: `Arial, "Microsoft YaHei", sans-serif`, emphasisFamily: `Impact, "Arial Black", SimHei, sans-serif`, codeFamily: `Consolas, "Courier New", monospace`, note: "Heavy display title + clean neutral body" },
  { id: "concord", name: "Concord (统一字体)", titleFamily: `"Microsoft YaHei", "PingFang SC", sans-serif`, bodyFamily: `"Microsoft YaHei", "PingFang SC", sans-serif`, emphasisFamily: `"Microsoft YaHei", "PingFang SC", sans-serif`, codeFamily: `Consolas, "Courier New", monospace`, note: "One family throughout — safe, consistent" },
]

interface SizePreset {
  id: string
  name: string
  bodySize: number
  description: string
}

const SIZE_PRESETS: SizePreset[] = [
  { id: "relaxed", name: "Relaxed", bodySize: 24, description: "3-5 points per page. Keynote, training." },
  { id: "dense", name: "Dense", bodySize: 18, description: "6+ points per page. Consulting, data reports." },
  { id: "medium", name: "Medium", bodySize: 22, description: "Balanced. General business presentations." },
]

const FORMULA_POLICIES = [
  { id: "mixed", name: "Mixed (default)", description: "Complex formulas → PNG; simple inline math → editable text" },
  { id: "render-all", name: "Render All", description: "Every formula-worthy expression → PNG. For formula-heavy decks." },
  { id: "text-only", name: "Text Only", description: "Keep all formulas as editable Unicode text. No PNG rendering." },
]

interface TypographyEditorProps {
  prompt: string
  recommendation?: Record<string, unknown> | null
  onSubmit: (data: any) => void
  disabled?: boolean
}

export function TypographyEditor({ prompt, recommendation, onSubmit, disabled }: TypographyEditorProps) {
  const { t } = useTranslation("editor")
  const [combo, setCombo] = useState(COMBOS[0])
  const [sizePreset, setSizePreset] = useState("dense")
  const [customBodySize, setCustomBodySize] = useState(18)
  const [useCustomSize, setUseCustomSize] = useState(false)
  const [formulaPolicy, setFormulaPolicy] = useState("mixed")
  const [customTitleFamily, setCustomTitleFamily] = useState("")
  const [customBodyFamily, setCustomBodyFamily] = useState("")
  const [customCodeFamily, setCustomCodeFamily] = useState("")
  const [recComboId, setRecComboId] = useState<string | null>(null)

  useEffect(() => {
    if (!recommendation) { setRecComboId(null); return }
    const recTitle = recommendation.title_family as string | undefined
    const recBody = recommendation.body_family as string | undefined
    const recCode = recommendation.code_family as string | undefined
    const recSize = recommendation.body_size as number | undefined

    // Try to match a COMBO by checking if title and body families overlap
    let matched: typeof COMBOS[0] | null = null
    if (recTitle || recBody) {
      matched = COMBOS.find((c) => {
        const titleMatch = recTitle ? c.titleFamily.toLowerCase().includes(recTitle.toLowerCase().split(",")[0].trim()) : true
        const bodyMatch = recBody ? c.bodyFamily.toLowerCase().includes(recBody.toLowerCase().split(",")[0].trim()) : true
        return titleMatch && bodyMatch
      }) ?? null
    }

    if (matched) {
      setCombo(matched)
      setRecComboId(matched.id)
    } else {
      // Pre-fill custom fields
      if (recTitle) setCustomTitleFamily(recTitle)
      if (recBody) setCustomBodyFamily(recBody)
      if (recCode) setCustomCodeFamily(recCode)
      setRecComboId(null)
    }

    // Pre-fill body size
    if (typeof recSize === "number" && recSize >= 12 && recSize <= 48) {
      const matchedSizePreset = SIZE_PRESETS.find((p) => p.bodySize === recSize)
      if (matchedSizePreset) {
        setSizePreset(matchedSizePreset.id)
        setUseCustomSize(false)
      } else {
        setCustomBodySize(recSize)
        setUseCustomSize(true)
      }
    }
  }, [recommendation])

  const bodySize = useCustomSize ? customBodySize : (SIZE_PRESETS.find(p => p.id === sizePreset)?.bodySize || 18)

  const derivedSizes = {
    body: bodySize,
    title: Math.round(bodySize * 1.8),
    subtitle: Math.round(bodySize * 1.3),
    annotation: Math.round(bodySize * 0.75),
    footnote: Math.round(bodySize * 0.55),
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6 overflow-y-auto">
      <div>
        <h2 className="text-lg font-semibold">{t("typography_title")}</h2>
        {prompt && (
          <div className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs leading-relaxed">
            {prompt}
          </div>
        )}
      </div>

      {/* Font Combination */}
      <div>
        <div className="mb-2 flex items-center gap-1.5">
          <Type className="h-3.5 w-3.5 text-primary" />
          <label className="text-sm font-medium">{t("typography_fontCombo")}</label>
        </div>
        <div className="grid grid-cols-1 gap-2 max-h-[280px] overflow-y-auto">
          {COMBOS.map(c => (
            <button
              key={c.id}
              type="button"
              disabled={disabled}
              onClick={() => setCombo(c)}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary",
                combo.id === c.id
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border"
              )}
            >
              <Check className={cn(
                "mt-0.5 h-4 w-4 shrink-0",
                combo.id === c.id ? "text-primary" : "text-transparent"
              )} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold">{c.name}</span>
                  {recComboId === c.id && <AIRecommendBadge />}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{c.note}</p>
                <div className="mt-1.5 space-y-0.5 text-[10px] text-muted-foreground font-mono">
                  <div>Title: <span className="text-foreground">{c.titleFamily}</span></div>
                  <div>Body: <span className="text-foreground">{c.bodyFamily}</span></div>
                  <div>Code: <span className="text-foreground">{c.codeFamily}</span></div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Font size */}
      <div>
        <label className="text-sm font-medium">{t("typography_bodySize")}</label>
        <div className="mt-2 flex gap-2 flex-wrap">
          {SIZE_PRESETS.map(p => (
            <button
              key={p.id}
              type="button"
              disabled={disabled || useCustomSize}
              onClick={() => { setSizePreset(p.id); setUseCustomSize(false) }}
              className={cn(
                "rounded-lg border px-4 py-2 text-left transition-colors hover:border-primary",
                !useCustomSize && sizePreset === p.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-muted bg-background text-muted-foreground"
              )}
            >
              <div className="text-lg font-bold">{p.bodySize}px</div>
              <div className="text-xs">{p.name}</div>
            </button>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setUseCustomSize(true)}
            className={cn(
              "flex items-center justify-center rounded-lg border px-4 py-2 transition-colors hover:border-primary",
              useCustomSize ? "border-primary bg-primary/10" : "border-muted bg-background"
            )}
          >
            <div className="text-center">
              <Input
                className="h-8 w-16 text-center text-lg font-bold"
                type="number"
                min={12} max={48}
                value={customBodySize}
                onChange={e => { const n = parseInt(e.target.value, 10); if (!isNaN(n)) setCustomBodySize(n) }}
                disabled={disabled}
                onClick={e => e.stopPropagation()}
              />
              <div className="text-xs text-muted-foreground">{t("typography_customSize")}</div>
            </div>
          </button>
        </div>
        {/* Derived sizes preview */}
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
          {Object.entries(derivedSizes).map(([role, size]) => (
            <span key={role} className="rounded bg-muted px-2 py-0.5">
              {role}: <strong className="text-foreground">{size}px</strong>
            </span>
          ))}
        </div>
      </div>

      {/* Formula Policy */}
      <div>
        <label className="text-sm font-medium">{t("typography_formulaPolicy")}</label>
        <div className="mt-2 space-y-2">
          {FORMULA_POLICIES.map(p => (
            <button
              key={p.id}
              type="button"
              disabled={disabled}
              onClick={() => setFormulaPolicy(p.id)}
              className={cn(
                "flex w-full items-start gap-2 rounded-lg border p-3 text-left transition-colors hover:border-primary",
                formulaPolicy === p.id
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border"
              )}
            >
              <Check className={cn(
                "mt-0.5 h-4 w-4 shrink-0",
                formulaPolicy === p.id ? "text-primary" : "text-transparent"
              )} />
              <div>
                <span className="text-sm font-semibold">{p.name}</span>
                <p className="text-xs text-muted-foreground">{p.description}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Custom overrides (collapsible) */}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          {t("typography_customOverrides")}
        </summary>
        <div className="mt-2 space-y-2">
          <div>
            <label className="text-[10px] text-muted-foreground">Title Family</label>
            <Input className="h-7 font-mono text-xs" value={customTitleFamily || combo.titleFamily}
              onChange={e => setCustomTitleFamily(e.target.value)} placeholder={combo.titleFamily} disabled={disabled} />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Body Family</label>
            <Input className="h-7 font-mono text-xs" value={customBodyFamily || combo.bodyFamily}
              onChange={e => setCustomBodyFamily(e.target.value)} placeholder={combo.bodyFamily} disabled={disabled} />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Code Family</label>
            <Input className="h-7 font-mono text-xs" value={customCodeFamily || combo.codeFamily}
              onChange={e => setCustomCodeFamily(e.target.value)} placeholder={combo.codeFamily} disabled={disabled} />
          </div>
        </div>
      </details>

      <div className="flex justify-end">
        <Button onClick={() => onSubmit({
          titleFamily: customTitleFamily || combo.titleFamily,
          bodyFamily: customBodyFamily || combo.bodyFamily,
          emphasisFamily: combo.emphasisFamily,
          codeFamily: customCodeFamily || combo.codeFamily,
          bodySize,
          formulaPolicy,
        })} disabled={disabled}>
          {t("typography_confirm")}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
