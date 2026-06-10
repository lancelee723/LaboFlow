import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { ArrowRight, Briefcase, Users, Building2, TrendingUp, GraduationCap, Globe, Landmark, Wrench, Megaphone } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AIRecommendBadge } from "@/components/ui/AIRecommendBadge"
import { cn } from "@/lib/utils"

interface AudienceOption {
  id: string
  labelKey: string
  matchTerms: string[]
  icon: React.ReactNode
}

const AUDIENCES: AudienceOption[] = [
  { id: "executives", labelKey: "audience_executives", matchTerms: ["executive", "board", "c-suite", "高管", "董事"], icon: <Briefcase className="h-4 w-4" /> },
  { id: "management", labelKey: "audience_management", matchTerms: ["management", "manager", "team lead", "管理"], icon: <Users className="h-4 w-4" /> },
  { id: "clients", labelKey: "audience_clients", matchTerms: ["client", "customer", "客户"], icon: <Building2 className="h-4 w-4" /> },
  { id: "investors", labelKey: "audience_investors", matchTerms: ["investor", "shareholder", "投资", "股东"], icon: <TrendingUp className="h-4 w-4" /> },
  { id: "public", labelKey: "audience_public", matchTerms: ["public", "media", "公众", "媒体"], icon: <Globe className="h-4 w-4" /> },
  { id: "academic", labelKey: "audience_academic", matchTerms: ["academic", "researcher", "scholar", "学术", "研究"], icon: <GraduationCap className="h-4 w-4" /> },
  { id: "technical", labelKey: "audience_technical", matchTerms: ["technical", "engineer", "技术", "工程"], icon: <Wrench className="h-4 w-4" /> },
  { id: "government", labelKey: "audience_government", matchTerms: ["government", "policy", "政府", "政策"], icon: <Landmark className="h-4 w-4" /> },
  { id: "internal", labelKey: "audience_internal", matchTerms: ["internal", "colleague", "team", "内部"], icon: <Megaphone className="h-4 w-4" /> },
]

interface AudienceEditorProps {
  prompt: string
  recommendation?: Record<string, unknown> | null
  onSubmit: (data: { audiences: string[]; occasion: string; coreMessage: string }) => void
  disabled?: boolean
}

export function AudienceEditor({ prompt, recommendation, onSubmit, disabled }: AudienceEditorProps) {
  const { t } = useTranslation("editor")
  const [selected, setSelected] = useState<string[]>([])
  const [occasion, setOccasion] = useState("")
  const [coreMessage, setCoreMessage] = useState("")
  const [recChipId, setRecChipId] = useState<string | null>(null)

  useEffect(() => {
    if (!recommendation) { setRecChipId(null); return }
    if (typeof recommendation.audience === "string" && recommendation.audience) {
      setOccasion(recommendation.occasion as string || "")
      setCoreMessage(recommendation.core_message as string || "")

      // Fuzzy-match recommendation.audience string against AUDIENCES chips.
      // Match against language-agnostic match terms instead of localized labels.
      const audienceText = String(recommendation.audience).toLowerCase()
      const matched = AUDIENCES.find(a =>
        a.matchTerms.some(term => audienceText.includes(term.toLowerCase()))
      )
      if (matched) {
        setSelected(prev => prev.includes(matched.id) ? prev : [...prev, matched.id])
        setRecChipId(matched.id)
      }
    }
  }, [recommendation])

  const toggleAudience = (id: string) => {
    setSelected(prev =>
      prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">{t("audience_title")}</h2>
        {prompt && (
          <div className="mt-3 whitespace-pre-wrap rounded-md bg-muted/50 p-4 text-sm leading-relaxed">
            {prompt}
          </div>
        )}
      </div>

      {recommendation && (
        <div className="flex items-center gap-1.5 rounded-md bg-purple-50 px-3 py-2 text-xs text-purple-700">
          {t("audience_recPrefilled")}
        </div>
      )}

      <div>
        <label className="text-sm font-medium">{t("audience_whoLabel")}</label>
        <div className="mt-2 flex flex-wrap gap-2">
          {AUDIENCES.map(a => (
            <button
              key={a.id}
              type="button"
              disabled={disabled}
              onClick={() => toggleAudience(a.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-sm transition-colors",
                selected.includes(a.id)
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-muted bg-background text-muted-foreground hover:border-input hover:text-foreground"
              )}
            >
              {a.icon}
              {t(a.labelKey)}
              {recChipId === a.id && <AIRecommendBadge />}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-sm font-medium">{t("audience_occasionLabel")}</label>
        <p className="mb-2 text-xs text-muted-foreground">
          {t("audience_occasionHint")}
        </p>
        <Input
          value={occasion}
          onChange={e => setOccasion(e.target.value)}
          placeholder={t("audience_occasionPlaceholder")}
          disabled={disabled}
        />
      </div>

      <div>
        <label className="text-sm font-medium">{t("audience_coreMessageLabel")}</label>
        <p className="mb-2 text-xs text-muted-foreground">
          {t("audience_coreMessageHint")}
        </p>
        <Input
          value={coreMessage}
          onChange={e => setCoreMessage(e.target.value)}
          placeholder={t("audience_coreMessagePlaceholder")}
          disabled={disabled}
        />
      </div>

      <div className="flex justify-end">
        <Button
          onClick={() => onSubmit({
            audiences: selected.map(s => {
              const opt = AUDIENCES.find(a => a.id === s)
              return opt ? t(opt.labelKey) : s
            }),
            occasion: occasion.trim(),
            coreMessage: coreMessage.trim(),
          })}
          disabled={disabled}
        >
          {t("audience_confirm")}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
