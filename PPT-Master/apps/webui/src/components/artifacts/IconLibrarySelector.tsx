import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { ArrowRight, Check, Box, Circle, Minus, Layers } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AIRecommendBadge } from "@/components/ui/AIRecommendBadge"
import { cn } from "@/lib/utils"

interface IconLibrary {
  id: string
  name: string
  styleKey: string
  descKey: string
  icon: React.ReactNode
  previewSamples: string[]
}

const LIBRARIES: IconLibrary[] = [
  {
    id: "chunk-filled", name: "Chunk Filled",
    styleKey: "icons_chunkStyle", descKey: "icons_chunkDesc",
    icon: <Box className="h-4 w-4" />,
    previewSamples: ["target", "bolt", "shield", "users", "chart-bar", "lightbulb", "star", "globe"],
  },
  {
    id: "tabler-filled", name: "Tabler Filled",
    styleKey: "icons_tablerFilledStyle", descKey: "icons_tablerFilledDesc",
    icon: <Circle className="h-4 w-4" />,
    previewSamples: ["home", "chart-bar", "users", "settings", "search", "heart", "star", "world"],
  },
  {
    id: "tabler-outline", name: "Tabler Outline",
    styleKey: "icons_tablerOutlineStyle", descKey: "icons_tablerOutlineDesc",
    icon: <Minus className="h-4 w-4" />,
    previewSamples: ["home", "chart-bar", "users", "settings", "search", "heart", "star", "world"],
  },
  {
    id: "phosphor-duotone", name: "Phosphor Duotone",
    styleKey: "icons_phosphorDuotoneStyle", descKey: "icons_phosphorDuotoneDesc",
    icon: <Layers className="h-4 w-4" />,
    previewSamples: ["house", "chart-bar", "users", "gear", "magnifying-glass", "heart", "star", "globe"],
  },
]

// Map from backend rec.library (underscore form) → LIBRARIES id (hyphen form)
const REC_LIBRARY_MAP: Record<string, string> = {
  chunk_filled: "chunk-filled",
  tabler_filled: "tabler-filled",
  tabler_outline: "tabler-outline",
  phosphor_duotone: "phosphor-duotone",
  "chunk-filled": "chunk-filled",
  "tabler-filled": "tabler-filled",
  "tabler-outline": "tabler-outline",
  "phosphor-duotone": "phosphor-duotone",
}

interface IconLibrarySelectorProps {
  prompt: string
  recommendation?: Record<string, unknown> | null
  onSubmit: (data: { library: string; inventory: string; strokeWidth?: number }) => void
  disabled?: boolean
}

export function IconLibrarySelector({ prompt, recommendation, onSubmit, disabled }: IconLibrarySelectorProps) {
  const { t } = useTranslation("editor")
  const [library, setLibrary] = useState("chunk-filled")
  const [inventory, setInventory] = useState("")
  const [strokeWidth, setStrokeWidth] = useState(2)
  const [recLibraryId, setRecLibraryId] = useState<string | null>(null)

  useEffect(() => {
    if (!recommendation) { setRecLibraryId(null); return }
    const recLib = recommendation.library as string | undefined
    if (recLib) {
      const mapped = REC_LIBRARY_MAP[recLib]
      if (mapped) {
        setLibrary(mapped)
        setRecLibraryId(mapped)
      }
    }
    // Pre-fill approved_icons if present
    const approvedIcons = recommendation.approved_icons
    if (Array.isArray(approvedIcons) && approvedIcons.length > 0) {
      setInventory(approvedIcons.join(", "))
    }
  }, [recommendation])

  const active = LIBRARIES.find(l => l.id === library)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">{t("icons_title")}</h2>
        {prompt && (
          <div className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs leading-relaxed">
            {prompt}
          </div>
        )}
      </div>

      {/* Library selection */}
      <div>
        <label className="text-sm font-medium">{t("icons_libraryLabel")}</label>
        <p className="mb-2 text-xs text-muted-foreground">
          {t("icons_libraryHint")}
        </p>
        <div className="grid grid-cols-2 gap-3">
          {LIBRARIES.map(lib => (
            <button
              key={lib.id}
              type="button"
              disabled={disabled}
              onClick={() => setLibrary(lib.id)}
              className={cn(
                "flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors hover:border-primary",
                library === lib.id
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border"
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn(
                  "rounded-md p-1",
                  library === lib.id ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                )}>
                  {lib.icon}
                </span>
                <div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold">{lib.name}</span>
                    {library === lib.id && <Check className="h-3.5 w-3.5 text-primary" />}
                    {recLibraryId === lib.id && <AIRecommendBadge />}
                  </div>
                  <span className="text-xs text-muted-foreground">{t(lib.styleKey)}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t(lib.descKey)}</p>
              <div className="flex flex-wrap gap-1">
                {lib.previewSamples.map(s => (
                  <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                    {s}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Stroke width (only for tabler-outline) */}
      {library === "tabler-outline" && (
        <div>
          <label className="text-sm font-medium">{t("icons_strokeWidth")}</label>
          <div className="mt-2 flex gap-2">
            {[1.5, 2, 3].map(w => (
              <button
                key={w}
                type="button"
                disabled={disabled}
                onClick={() => setStrokeWidth(w)}
                className={cn(
                  "rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
                  strokeWidth === w
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-muted bg-background text-muted-foreground hover:border-input"
                )}
              >
                {w}px
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("icons_strokeHint")}
          </p>
        </div>
      )}

      {/* Icon inventory */}
      <div>
        <label className="text-sm font-medium">{t("icons_inventoryLabel")}</label>
        <p className="mb-2 text-xs text-muted-foreground">
          {t("icons_inventoryHint")}
        </p>
        <Input
          value={inventory}
          onChange={e => setInventory(e.target.value)}
          placeholder={t("icons_inventoryPlaceholder")}
          disabled={disabled}
        />
        {active && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            <code className="rounded bg-muted px-0.5">templates/icons/{active.id}/</code>
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <Button onClick={() => onSubmit({
          library,
          inventory: inventory.trim(),
          strokeWidth: library === "tabler-outline" ? strokeWidth : undefined,
        })} disabled={disabled}>
          {t("icons_confirm")}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
