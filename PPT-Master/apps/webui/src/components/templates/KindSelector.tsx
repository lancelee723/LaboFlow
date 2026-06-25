import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

export type TemplateKind = "deck" | "layout" | "brand"

interface KindSelectorProps {
  selected: TemplateKind
  onSelect: (kind: TemplateKind) => void
  autoDetected?: TemplateKind | null
}

export function KindSelector({ selected, onSelect, autoDetected }: KindSelectorProps) {
  const { t } = useTranslation("common")

  const KIND_CARDS: { kind: TemplateKind; label: string; desc: string }[] = [
    {
      kind: "deck",
      label: t("wizard.kind_deck_label"),
      desc: t("wizard.kind_deck_desc"),
    },
    {
      kind: "layout",
      label: t("wizard.kind_layout_label"),
      desc: t("wizard.kind_layout_desc"),
    },
    {
      kind: "brand",
      label: t("wizard.kind_brand_label"),
      desc: t("wizard.kind_brand_desc"),
    },
  ]

  const kindDisplayName = (kind: TemplateKind) => {
    if (kind === "deck") return t("wizard.kind_deck_label")
    if (kind === "layout") return t("wizard.kind_layout_label")
    return t("wizard.kind_brand_label")
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{t("wizard.kind_selector_title")}</h3>
        {autoDetected && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900 dark:text-blue-300">
            {t("wizard.kind_auto_detected", { kind: kindDisplayName(autoDetected) })}
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {KIND_CARDS.map((card) => (
          <button
            key={card.kind}
            type="button"
            onClick={() => onSelect(card.kind)}
            className={cn(
              "rounded-lg border-2 p-3 text-left transition-colors",
              selected === card.kind
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-muted/50"
            )}
          >
            <div className="text-sm font-semibold">{card.label}</div>
            <div className="mt-1 text-xs text-muted-foreground">{card.desc}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
