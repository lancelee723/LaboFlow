import { useState } from "react"
import { useTranslation } from "react-i18next"
import { KindSelector, TemplateKind } from "./KindSelector"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

export interface ConfirmedFields {
  template_id: string
  kind: TemplateKind
  name: string
  summary: string
  canvas_format: string
  primary_color: string
  colors: Record<string, string>
  typography: { title_family?: string; body_family?: string; emphasis_family?: string; code_family?: string; body_size?: string }
  logo: { file: string; placement: string } | null
  page_count: number
  page_types: string[]
  image_strategy: string
  voice_tone: string
}

interface ExtractedField {
  value: unknown
  provenance: string
  auto_detected: boolean
}

export interface ExtractedFields {
  [key: string]: ExtractedField | undefined
}

interface Step2ConfirmFieldsProps {
  extracted: ExtractedFields
  autoDetectedKind: TemplateKind | null
  onConfirm: (fields: ConfirmedFields) => void
  onBack: () => void
  isSubmitting?: boolean
}

const CANVAS_OPTIONS = [
  { value: "ppt169", label: "16:9 (PowerPoint)" },
  { value: "ppt43", label: "4:3" },
  { value: "a4l", label: "A4 Landscape" },
]

const FONT_OPTIONS = [
  "Microsoft YaHei", "SimHei", "SimSun", "PingFang SC", "Heiti SC",
  "Arial", "Helvetica Neue", "Calibri", "Segoe UI", "Times New Roman",
  "Georgia", "Consolas", "Courier New",
]

function field<T>(extracted: ExtractedFields, key: string, fallback: T): T {
  const f = extracted[key]
  return (f?.value as T) ?? fallback
}

export function Step2ConfirmFields({ extracted, autoDetectedKind, onConfirm, onBack, isSubmitting }: Step2ConfirmFieldsProps) {
  const { t } = useTranslation("common")

  const PROVENANCE_BADGES: Record<string, { label: string; className: string }> = {
    "事实": { label: t("wizard.provenance_fact"), className: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" },
    "推测": { label: t("wizard.provenance_inferred"), className: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300" },
    "需决定": { label: t("wizard.provenance_tbd"), className: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300" },
  }

  const COLOR_ROLES = [
    { key: "dark1", label: "Dark 1" },
    { key: "light1", label: "Light 1" },
    { key: "dark2", label: "Dark 2" },
    { key: "light2", label: "Light 2" },
    { key: "accent1", label: "Accent 1" },
    { key: "accent2", label: "Accent 2" },
  ]

  const TYPOGRAPHY_FIELDS = [
    { key: "title_family" as const, label: "Title" },
    { key: "body_family" as const, label: "Body" },
    { key: "emphasis_family" as const, label: "Emphasis" },
    { key: "code_family" as const, label: "Code" },
    { key: "body_size" as const, label: "Body Size" },
  ]

  const [kind, setKind] = useState<TemplateKind>(autoDetectedKind || "deck")

  const [templateId, setTemplateId] = useState(field(extracted, "template_id", ""))
  const [name, setName] = useState(field(extracted, "name", ""))
  const [summary, setSummary] = useState(field(extracted, "summary", ""))
  const [canvasFormat, setCanvasFormat] = useState(field(extracted, "canvas_format", "ppt169"))
  const [primaryColor, setPrimaryColor] = useState(field(extracted, "primary_color", ""))
  const [colors, setColors] = useState<Record<string, string>>(field(extracted, "colors", {}))
  const [typography, setTypography] = useState<Record<string, string>>(field(extracted, "typography", {}) as Record<string, string>)
  const logoField = field(extracted, "logo", null) as { file: string; placement: string } | null
  const [logoFile, setLogoFile] = useState(logoField?.file || "")
  const [logoPlacement, setLogoPlacement] = useState(logoField?.placement || "")
  const [pageCount, setPageCount] = useState(field(extracted, "page_count", 4))
  const [pageTypes, setPageTypes] = useState<string[]>(field(extracted, "page_types", []))
  const [pageTypeInput, setPageTypeInput] = useState("")
  const [imageStrategy, setImageStrategy] = useState(field(extracted, "image_strategy", ""))
  const [voiceTone, setVoiceTone] = useState(field(extracted, "voice_tone", ""))

  const isDeck = kind === "deck"
  const isLayout = kind === "layout"
  const isBrand = kind === "brand"
  const hasIdentity = isDeck || isBrand
  const hasStructure = isDeck || isLayout

  function provenanceBadge(key: string) {
    const prov = extracted[key]?.provenance || "需决定"
    const badge = PROVENANCE_BADGES[prov]
    if (!badge) return null
    return (
      <span className={cn("ml-2 rounded-full px-1.5 py-0.5 text-[10px]", badge.className)}>
        {badge.label}
      </span>
    )
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!templateId || !name) return

    onConfirm({
      template_id: templateId,
      kind,
      name,
      summary,
      canvas_format: canvasFormat,
      primary_color: hasIdentity ? primaryColor : "",
      colors: hasIdentity ? colors : {},
      typography: hasIdentity ? (typography as ConfirmedFields["typography"]) : {},
      logo: hasIdentity && logoFile ? { file: logoFile, placement: logoPlacement || t("wizard.field_placement") } : null,
      page_count: hasStructure ? pageCount : 0,
      page_types: hasStructure ? pageTypes : [],
      image_strategy: isDeck ? imageStrategy : "",
      voice_tone: hasIdentity ? voiceTone : "",
    })
  }

  const updateColor = (role: string, hex: string) => {
    setColors((prev) => ({ ...prev, [role]: hex }))
  }

  const addPageType = () => {
    const trimmed = pageTypeInput.trim()
    if (trimmed && !pageTypes.includes(trimmed)) {
      setPageTypes([...pageTypes, trimmed])
    }
    setPageTypeInput("")
  }

  const removePageType = (pt: string) => {
    setPageTypes(pageTypes.filter((p) => p !== pt))
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <KindSelector
        selected={kind}
        onSelect={setKind}
        autoDetected={autoDetectedKind}
      />

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label className="flex items-center text-xs">
            {t("wizard.field_template_id")} {provenanceBadge("template_id")}
          </Label>
          <Input
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value.replace(/[^a-z0-9_]/g, "_").toLowerCase())}
            placeholder="my_custom_deck"
            required
          />
          <span className="text-[10px] text-muted-foreground">snake_case</span>
        </div>
        <div className="space-y-1">
          <Label className="flex items-center text-xs">
            {t("wizard.field_name")} {provenanceBadge("name")}
          </Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Template" required />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="flex items-center text-xs">
          {t("wizard.field_summary")} {provenanceBadge("summary")}
        </Label>
        <Input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={t("wizard.field_summary_placeholder")} />
      </div>

      {hasStructure && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="flex items-center text-xs">
              {t("wizard.field_canvas_format")} {provenanceBadge("canvas_format")}
            </Label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={canvasFormat}
              onChange={(e) => setCanvasFormat(e.target.value)}
            >
              {CANVAS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="flex items-center text-xs">
              {t("wizard.field_page_count")} {provenanceBadge("page_count")}
            </Label>
            <Input
              type="number" min={1} max={100}
              value={pageCount}
              onChange={(e) => setPageCount(Number(e.target.value))}
            />
          </div>
        </div>
      )}

      {hasStructure && (
        <div className="space-y-1">
          <Label className="flex items-center text-xs">
            {t("wizard.field_page_types")} {provenanceBadge("page_types")}
          </Label>
          <div className="flex flex-wrap items-center gap-1">
            {pageTypes.map((pt) => (
              <span key={pt} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                {pt}
                <button type="button" onClick={() => removePageType(pt)} className="text-muted-foreground hover:text-destructive">&times;</button>
              </span>
            ))}
            <div className="flex items-center gap-1">
              <Input
                className="h-7 w-32 text-xs"
                value={pageTypeInput}
                onChange={(e) => setPageTypeInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPageType() } }}
                placeholder={t("wizard.page_type_placeholder")}
              />
              <button type="button" onClick={addPageType} className="text-xs text-primary hover:underline">{t("wizard.add_page_type")}</button>
            </div>
          </div>
        </div>
      )}

      {hasIdentity && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="flex items-center text-xs">
                {t("wizard.field_primary_color")} {provenanceBadge("primary_color")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  placeholder="#4472C4"
                  className="font-mono"
                />
                <div
                  className="h-8 w-8 shrink-0 rounded border"
                  style={{ backgroundColor: primaryColor || "#ccc" }}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="flex items-center text-xs">
                {t("wizard.field_voice_tone")} {provenanceBadge("voice_tone")}
              </Label>
              <Input value={voiceTone} onChange={(e) => setVoiceTone(e.target.value)} placeholder="专业、正式" />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t("wizard.field_color_scheme")} {provenanceBadge("colors")}</Label>
            <div className="grid grid-cols-3 gap-2">
              {COLOR_ROLES.map((role) => {
                const hex = colors[role.key] || ""
                return (
                  <div key={role.key} className="flex items-center gap-1.5">
                    <div className="flex h-6 w-6 items-center justify-center rounded border">
                      <input
                        type="color"
                        value={hex || "#ffffff"}
                        onChange={(e) => updateColor(role.key, e.target.value)}
                        className="h-5 w-5 cursor-pointer border-0 bg-transparent p-0"
                      />
                    </div>
                    <Input
                      className="h-7 flex-1 font-mono text-xs"
                      value={hex}
                      onChange={(e) => updateColor(role.key, e.target.value)}
                      placeholder="#RRGGBB"
                    />
                    <span className="text-[10px] text-muted-foreground w-12">{role.label}</span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t("wizard.field_typography")} {provenanceBadge("typography")}</Label>
            <div className="grid grid-cols-5 gap-2">
              {TYPOGRAPHY_FIELDS.map(({ key, label }) => (
                <div key={key} className="space-y-1">
                  <span className="text-[10px] text-muted-foreground">{label}</span>
                  {key === "body_size" ? (
                    <Input
                      className="h-7 text-xs"
                      value={typography[key] || ""}
                      onChange={(e) => setTypography((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder="18pt"
                    />
                  ) : (
                    <input
                      list={`font-${key}`}
                      className="flex h-7 w-full rounded-md border border-input bg-background px-2 text-xs"
                      value={typography[key] || ""}
                      onChange={(e) => setTypography((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder="Arial"
                    />
                  )}
                  <datalist id={`font-${key}`}>
                    {FONT_OPTIONS.map((f) => <option key={f} value={f} />)}
                  </datalist>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="flex items-center text-xs">
                {t("wizard.field_logo_file")} {provenanceBadge("logo")}
              </Label>
              <Input value={logoFile} onChange={(e) => setLogoFile(e.target.value)} placeholder="logo.png" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("wizard.field_placement")}</Label>
              <Input value={logoPlacement} onChange={(e) => setLogoPlacement(e.target.value)} placeholder="左上角" />
            </div>
          </div>
        </>
      )}

      {isDeck && (
        <div className="space-y-1">
          <Label className="flex items-center text-xs">
            {t("wizard.field_image_strategy")} {provenanceBadge("image_strategy")}
          </Label>
          <Input
            value={imageStrategy}
            onChange={(e) => setImageStrategy(e.target.value)}
            placeholder={t("wizard.field_image_strategy_placeholder")}
          />
        </div>
      )}

      <div className="flex justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
        >
          {t("wizard.back_to_file")}
        </button>
        <button
          type="submit"
          disabled={isSubmitting || !templateId || !name}
          className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isSubmitting ? t("wizard.submitting") : t("wizard.confirm_generate")}
        </button>
      </div>
    </form>
  )
}
