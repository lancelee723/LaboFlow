import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { ArrowRight, Plus, Sparkles, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AIRecommendBadge } from "@/components/ui/AIRecommendBadge"
import { cn } from "@/lib/utils"

interface ColorEntry {
  role: string
  hex: string
}

interface Preset {
  name: string
  colors: ColorEntry[]
}

const PRESETS: Preset[] = [
  { name: "Corporate Blue", colors: [
    { role: "Background", hex: "#FFFFFF" }, { role: "Secondary BG", hex: "#F0F4F8" },
    { role: "Primary", hex: "#1A365D" }, { role: "Accent", hex: "#E53E3E" },
    { role: "Body Text", hex: "#2D3748" }, { role: "Secondary Text", hex: "#718096" },
    { role: "Border", hex: "#E2E8F0" },
  ]},
  { name: "Dark Tech", colors: [
    { role: "Background", hex: "#0E1116" }, { role: "Secondary BG", hex: "#1A1F26" },
    { role: "Primary", hex: "#E8E6E1" }, { role: "Accent", hex: "#E63946" },
    { role: "Secondary Accent", hex: "#F4A261" }, { role: "Body Text", hex: "#C9C5BE" },
    { role: "Secondary Text", hex: "#8A857E" }, { role: "Border", hex: "#2A2F36" },
    { role: "Success", hex: "#52B788" },
  ]},
  { name: "Warm Professional", colors: [
    { role: "Background", hex: "#FAF9F7" }, { role: "Secondary BG", hex: "#F0EDE8" },
    { role: "Primary", hex: "#8B4513" }, { role: "Accent", hex: "#D4A574" },
    { role: "Body Text", hex: "#3D3027" }, { role: "Secondary Text", hex: "#8C7A6B" },
    { role: "Border", hex: "#D4C5B9" },
  ]},
  { name: "Government Blue", colors: [
    { role: "Background", hex: "#FFFFFF" }, { role: "Secondary BG", hex: "#F5F7FA" },
    { role: "Primary", hex: "#003D7A" }, { role: "Accent", hex: "#C00000" },
    { role: "Body Text", hex: "#1A1A1A" }, { role: "Secondary Text", hex: "#666666" },
    { role: "Border", hex: "#D1D5DB" },
  ]},
  { name: "MBB Consulting", colors: [
    { role: "Background", hex: "#FFFFFF" }, { role: "Secondary BG", hex: "#F8FAFC" },
    { role: "Primary", hex: "#003A70" }, { role: "Accent", hex: "#0077C8" },
    { role: "Secondary Accent", hex: "#6CACE4" }, { role: "Body Text", hex: "#1E293B" },
    { role: "Secondary Text", hex: "#64748B" }, { role: "Border", hex: "#CBD5E1" },
    { role: "Success", hex: "#16A34A" }, { role: "Warning", hex: "#D97706" },
  ]},
  { name: "Minimal Mono", colors: [
    { role: "Background", hex: "#FFFFFF" }, { role: "Secondary BG", hex: "#F5F5F5" },
    { role: "Primary", hex: "#111111" }, { role: "Accent", hex: "#555555" },
    { role: "Body Text", hex: "#333333" }, { role: "Secondary Text", hex: "#777777" },
    { role: "Border", hex: "#DDDDDD" },
  ]},
  { name: "Medical Clean", colors: [
    { role: "Background", hex: "#FFFFFF" }, { role: "Secondary BG", hex: "#F0F7F4" },
    { role: "Primary", hex: "#00695C" }, { role: "Accent", hex: "#26A69A" },
    { role: "Body Text", hex: "#263238" }, { role: "Secondary Text", hex: "#607D8B" },
    { role: "Border", hex: "#B2DFDB" }, { role: "Success", hex: "#43A047" },
  ]},
  { name: "Vibrant Creative", colors: [
    { role: "Background", hex: "#FFFFFF" }, { role: "Secondary BG", hex: "#F3E5F5" },
    { role: "Primary", hex: "#7B1FA2" }, { role: "Accent", hex: "#FF5722" },
    { role: "Secondary Accent", hex: "#FFC107" }, { role: "Body Text", hex: "#212121" },
    { role: "Secondary Text", hex: "#757575" }, { role: "Border", hex: "#E1BEE7" },
  ]},
]

function parseColorsFromPrompt(prompt: string): ColorEntry[] {
  const result: ColorEntry[] = []
  // Try multiple patterns
  // Pattern 1: "- **Primary**: #1A365D" or "- primary: #1A365D"
  let m
  const rolePatterns = [
    /[-*]\s*(?:\*\*)?([A-Za-z][\w\s]*?)(?:\*\*)?\s*:\s*(#[0-9A-Fa-f]{6})\b/gm,
    /([A-Za-z][\w\s]+?)\s*[:：]\s*(#[0-9A-Fa-f]{6})\b/gm,
    /\|\s*(?:[^|]+\|)?\s*(#[0-9A-Fa-f]{6})\b/gm,
  ]
  for (const re of rolePatterns) {
    while ((m = re.exec(prompt)) !== null) {
      const hex = (m[2] || m[1]).toUpperCase()
      const rawRole = m[2] ? m[1].toLowerCase().trim() : `Color ${result.length + 1}`
      const name = ROLE_LABELS[rawRole.replace(/\s+/g, "_")] || rawRole.replace(/\s+/g, " ")
      if (!result.find(e => e.role === name)) {
        result.push({ role: name, hex })
      }
    }
  }
  // Fallback: extract any #HEX from prompt
  if (result.length === 0) {
    const HEX_RE = /#([0-9A-Fa-f]{6})\b/g
    const seen = new Set<string>()
    let hm
    while ((hm = HEX_RE.exec(prompt)) !== null) {
      const h = hm[0].toUpperCase()
      if (!seen.has(h)) {
        seen.add(h)
        result.push({ role: `Color ${result.length + 1}`, hex: h })
      }
    }
  }
  return result
}

const ROLE_LABELS: Record<string, string> = {
  bg: "Background", background: "Background", secondary_bg: "Secondary BG",
  primary: "Primary", accent: "Accent",
  secondary_accent: "Secondary Accent", text: "Body Text", body: "Body Text",
  text_secondary: "Secondary Text", secondary: "Secondary Text",
  border: "Border", divider: "Divider",
  success: "Success", warning: "Warning",
}

interface ColorSchemeEditorProps {
  prompt: string
  recommendation?: Record<string, unknown> | null
  onSubmit: (colors: ColorEntry[]) => void
  disabled?: boolean
}

export function ColorSchemeEditor({ prompt, recommendation, onSubmit, disabled }: ColorSchemeEditorProps) {
  const { t } = useTranslation("editor")
  const [colors, setColors] = useState<ColorEntry[]>([])
  const [activePreset, setActivePreset] = useState<string | null>(null)
  const [recApplied, setRecApplied] = useState(false)

  useEffect(() => {
    const parsed = parseColorsFromPrompt(prompt)
    setColors(parsed.length > 0 ? parsed : PRESETS[0].colors)
  }, [prompt])

  useEffect(() => {
    if (!recommendation) { setRecApplied(false); return }
    // Build color entries from rec keys (backend: primary, accent, background, body_text, secondary_text, border)
    const recEntries: ColorEntry[] = []
    const keyRoleMap: Record<string, string> = {
      background: "Background", primary: "Primary", accent: "Accent",
      body_text: "Body Text", secondary_text: "Secondary Text", border: "Border",
    }
    for (const [k, label] of Object.entries(keyRoleMap)) {
      const hex = recommendation[k] as string | undefined
      if (hex && /^#[0-9A-Fa-f]{6}$/.test(hex)) {
        recEntries.push({ role: label, hex: hex.toUpperCase() })
      }
    }
    if (recEntries.length === 0) { setRecApplied(false); return }
    setColors(recEntries)
    setRecApplied(true)
    setActivePreset(null)
  }, [recommendation])

  const applyPreset = (preset: Preset) => {
    setActivePreset(preset.name)
    setColors(preset.colors.map(c => ({ ...c })))
  }

  const updateColor = (index: number, hex: string) => {
    const clean = hex.startsWith("#") ? hex : `#${hex}`
    setColors(prev => { const next = [...prev]; next[index] = { ...next[index], hex: clean.toUpperCase() }; return next })
  }

  const updateRole = (index: number, role: string) => {
    setColors(prev => { const next = [...prev]; next[index] = { ...next[index], role }; return next })
  }

  const addColor = () => setColors(prev => [...prev, { role: "New Color", hex: "#CCCCCC" }])
  const removeColor = (index: number) => setColors(prev => prev.filter((_, i) => i !== index))

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">{t("colors_title")}</h2>
        {prompt && (
          <div className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs leading-relaxed">
            {prompt}
          </div>
        )}
      </div>

      {recApplied && (
        <div className="flex items-center gap-1.5 rounded-md bg-purple-50 px-3 py-2 text-xs text-purple-700">
          <AIRecommendBadge /> {t("colors_recPrefilled")}
        </div>
      )}

      {/* Preset quick-select */}
      <div>
        <div className="mb-2 flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          <label className="text-xs font-medium text-muted-foreground">{t("colors_presets")}</label>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map(p => (
            <button
              key={p.name}
              type="button"
              disabled={disabled}
              onClick={() => applyPreset(p)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                activePreset === p.name
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-muted bg-background text-muted-foreground hover:border-input"
              )}
            >
              {p.colors.slice(0, 3).map(c => (
                <span key={c.hex} className="h-2.5 w-2.5 rounded-full border" style={{ backgroundColor: c.hex }} />
              ))}
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* Editable colors */}
      {colors.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("colors_empty")}</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {colors.map((c, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border p-2">
              <div
                className="h-9 w-9 shrink-0 rounded-lg border shadow-sm"
                style={{ backgroundColor: c.hex }}
              />
              <div className="min-w-0 flex-1 space-y-0.5">
                <Input
                  className="h-6 text-xs"
                  value={c.role}
                  onChange={e => updateRole(i, e.target.value)}
                  disabled={disabled}
                />
                <div className="flex items-center gap-1">
                  <Input
                    className="h-6 font-mono text-xs"
                    value={c.hex}
                    onChange={e => updateColor(i, e.target.value)}
                    disabled={disabled}
                  />
                  <button
                    type="button"
                    onClick={() => removeColor(i)}
                    disabled={disabled}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addColor}
        disabled={disabled}
        className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
      >
        <Plus className="h-3 w-3" /> {t("colors_addColor")}
      </button>

      <div className="flex justify-end">
        <Button onClick={() => onSubmit(colors)} disabled={disabled}>
          {t("colors_confirm")}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
