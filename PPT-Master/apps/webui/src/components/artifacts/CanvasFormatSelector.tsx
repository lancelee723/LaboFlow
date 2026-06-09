import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { ArrowRight, Check, Monitor, Smartphone, Square, Image } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AIRecommendBadge } from "@/components/ui/AIRecommendBadge"
import { cn } from "@/lib/utils"

interface CanvasFormat {
  id: string
  name: string
  width: number
  height: number
  ratio: string
  useCaseKey: string
  icon: "monitor" | "square" | "smartphone" | "image"
}

const FORMATS: CanvasFormat[] = [
  { id: "ppt169", name: "PPT 16:9", width: 1280, height: 720, ratio: "16:9", useCaseKey: "canvas_business", icon: "monitor" },
  { id: "ppt43", name: "PPT 4:3", width: 1024, height: 768, ratio: "4:3", useCaseKey: "canvas_projector", icon: "monitor" },
  { id: "xhs", name: "Xiaohongshu (RED)", width: 1242, height: 1660, ratio: "3:4", useCaseKey: "canvas_sharing", icon: "smartphone" },
  { id: "moments", name: "WeChat Moments / IG", width: 1080, height: 1080, ratio: "1:1", useCaseKey: "canvas_square", icon: "square" },
  { id: "story", name: "Story / TikTok", width: 1080, height: 1920, ratio: "9:16", useCaseKey: "canvas_vertical", icon: "smartphone" },
  { id: "wechat_header", name: "WeChat Article Header", width: 900, height: 383, ratio: "2.35:1", useCaseKey: "canvas_wechat", icon: "image" },
  { id: "banner", name: "Landscape Banner", width: 1920, height: 1080, ratio: "16:9", useCaseKey: "canvas_banner", icon: "monitor" },
  { id: "portrait", name: "Portrait Poster", width: 1080, height: 1920, ratio: "9:16", useCaseKey: "canvas_poster", icon: "smartphone" },
  { id: "a4", name: "A4 Print", width: 1240, height: 1754, ratio: "1:1.4", useCaseKey: "canvas_print", icon: "image" },
]

const iconMap: Record<string, React.ReactNode> = {
  monitor: <Monitor className="h-5 w-5" />,
  square: <Square className="h-5 w-5" />,
  smartphone: <Smartphone className="h-5 w-5" />,
  image: <Image className="h-5 w-5" />,
}

const REC_FORMAT_MAP: Record<string, string> = {
  ppt169: "ppt169", ppt43: "ppt43", a4l: "a4", xhs: "xhs",
  xiaohongshu: "xhs", instagram_square: "moments", moments: "moments",
  story_tiktok: "story", story: "story", landscape_banner: "banner",
  portrait_poster: "portrait", a4_print: "a4", wechat_header: "wechat_header",
}

interface CanvasFormatSelectorProps {
  prompt: string
  recommendation?: Record<string, unknown> | null
  onSubmit: (formatId: string) => void
  disabled?: boolean
}

export function CanvasFormatSelector({ prompt, recommendation, onSubmit, disabled }: CanvasFormatSelectorProps) {
  const { t } = useTranslation("editor")
  const [selected, setSelected] = useState<string>("ppt169")
  const [recFormatId, setRecFormatId] = useState<string | null>(null)

  useEffect(() => {
    if (!recommendation) { setRecFormatId(null); return }
    const fmt = recommendation.format as string | undefined
    if (!fmt) { setRecFormatId(null); return }
    const mapped = REC_FORMAT_MAP[fmt] ?? (FORMATS.some(f => f.id === fmt) ? fmt : null)
    if (mapped) {
      setSelected(mapped)
      setRecFormatId(mapped)
    }
  }, [recommendation])

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">{t("canvas_title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("canvas_subtitle")}</p>
        {prompt && (
          <div className="mt-3 whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm leading-relaxed">
            {prompt}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {FORMATS.map((fmt) => (
          <button
            key={fmt.id}
            type="button"
            disabled={disabled}
            onClick={() => setSelected(fmt.id)}
            className={cn(
              "flex flex-col rounded-lg border p-3 text-left transition-colors hover:border-primary",
              selected === fmt.id
                ? "border-primary bg-primary/5 ring-1 ring-primary"
                : "border-border"
            )}
          >
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              {iconMap[fmt.icon]}
              {fmt.name}
              {recFormatId === fmt.id && <AIRecommendBadge />}
            </div>

            <div className="mb-2 flex items-center justify-center">
              <div
                className="rounded border-2 border-muted-foreground/20 bg-muted"
                style={{
                  width: fmt.width > fmt.height ? 80 : (80 * fmt.width / fmt.height),
                  height: fmt.height > fmt.width ? 48 : (48 * fmt.height / fmt.width),
                  maxWidth: 80,
                  maxHeight: 48,
                }}
              />
            </div>

            <div className="space-y-0.5 text-xs text-muted-foreground">
              <span className="font-mono">{fmt.width} x {fmt.height}</span>
              <span className="ml-2 rounded bg-muted px-1 py-0.5">{fmt.ratio}</span>
            </div>
            <span className="mt-1 text-xs text-muted-foreground">{t(fmt.useCaseKey)}</span>

            {selected === fmt.id && (
              <Check className="mt-1 h-4 w-4 self-end text-primary" />
            )}
          </button>
        ))}
      </div>

      <div className="flex justify-end">
        <Button onClick={() => onSubmit(selected)} disabled={disabled}>
          {t("canvas_confirm")}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
