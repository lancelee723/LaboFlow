import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Play, FileText, Palette, Type, Image, Layout, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface PreflightReviewProps {
  projectBrief: string
  templateId: string | null
  canvasFormat: string
  pageCount: number
  pageCountReasoning?: string
  pageCountMode?: "explicit" | "ai_decide"
  colors: Array<{ name: string; hex: string }>
  typography: { font_family: string; title_family: string; body_family: string; body_size: number }
  iconLibrary: string
  imageStrategy: string
  pages: Array<{ title: string; type: string }>
  onStart: () => void
  onPageCountChange?: (newCount: number) => void
  disabled?: boolean
}

export function PreflightReview(props: PreflightReviewProps) {
  const {
    projectBrief, templateId, canvasFormat, pageCount,
    pageCountReasoning, pageCountMode,
    colors, typography, iconLibrary, imageStrategy, pages,
    onStart, onPageCountChange, disabled,
  } = props

  const { t } = useTranslation("editor")

  const [confirmed, setConfirmed] = useState(false)
  const [localPageCount, setLocalPageCount] = useState<number>(pageCount || pages.length || 0)
  const [reasoningOpen, setReasoningOpen] = useState<boolean>(pageCountMode === "ai_decide")

  const isDirty = localPageCount !== pageCount

  const handlePrimary = () => {
    if (isDirty && onPageCountChange) onPageCountChange(localPageCount)
    else onStart()
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">{t("preflight_title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("preflight_subtitle")}</p>
      </div>

      <div className="space-y-3">
        {projectBrief && (
          <Section icon={<FileText className="h-4 w-4" />} title={t("preflight_projectBrief")}>
            <p className="text-sm whitespace-pre-wrap">{projectBrief}</p>
          </Section>
        )}

        <Section icon={<Layout className="h-4 w-4" />} title={t("preflight_template")}>
          <span className="text-sm">{templateId || t("preflight_freeDesign")}</span>
        </Section>

        <Section icon={<Layout className="h-4 w-4" />} title={t("preflight_canvas")}>
          <span className="text-sm">{canvasFormat}</span>
        </Section>

        <Section icon={<FileText className="h-4 w-4" />} title={t("preflight_pageCount")}>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={3}
              max={100}
              value={localPageCount}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                if (!isNaN(n)) setLocalPageCount(n)
              }}
              disabled={disabled}
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">{t("preflight_pages")}</span>
            {isDirty && (
              <span className="text-xs text-amber-600">
                {t("preflight_changedFrom", { from: pageCount })}
              </span>
            )}
          </div>
          {pageCountReasoning && (
            <div className="mt-2">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                onClick={() => setReasoningOpen((o) => !o)}
              >
                <Sparkles className="h-3 w-3" />
                {reasoningOpen ? t("preflight_hideRationale") : t("preflight_showRationale")} {t("preflight_aiRationale")}
              </button>
              {reasoningOpen && (
                <p className="mt-1 rounded bg-muted/50 p-2 text-xs leading-relaxed">
                  {pageCountReasoning}
                </p>
              )}
            </div>
          )}
        </Section>

        <Section icon={<Palette className="h-4 w-4" />} title={t("preflight_colorScheme")}>
          <div className="flex flex-wrap gap-2">
            {colors.map((c) => (
              <div key={c.name} className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
                <span className="h-3.5 w-3.5 rounded-full border" style={{ backgroundColor: c.hex }} />
                {c.name}: {c.hex}
              </div>
            ))}
          </div>
        </Section>

        <Section icon={<Type className="h-4 w-4" />} title={t("preflight_typography")}>
          <span className="text-sm">
            {typography.title_family} / {typography.body_family} — body {typography.body_size}px
          </span>
        </Section>

        <Section icon={<Image className="h-4 w-4" />} title={t("preflight_icons")}>
          <span className="text-sm">{t("preflight_library")}: {iconLibrary || t("preflight_notSelected")}</span>
        </Section>

        <Section icon={<Image className="h-4 w-4" />} title={t("preflight_imageStrategy")}>
          <span className="text-sm">{imageStrategy || t("preflight_userProvided")}</span>
        </Section>

        <Section icon={<FileText className="h-4 w-4" />} title={t("preflight_pageOutline")}>
          <div className="space-y-1">
            {pages.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className="text-xs font-mono text-muted-foreground">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">{p.type}</span>
                <span>{p.title}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="h-4 w-4 rounded border-muted-foreground"
        />
        {t("preflight_confirmCheckbox")}
      </label>

      <div className="flex justify-end">
        <Button onClick={handlePrimary} disabled={disabled || !confirmed} size="lg">
          <Play className="mr-2 h-5 w-5" />
          {isDirty ? t("preflight_reFinalize") : t("preflight_startGenerating")}
        </Button>
      </div>
    </div>
  )
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
        {icon}
        {title}
      </div>
      {children}
    </div>
  )
}
