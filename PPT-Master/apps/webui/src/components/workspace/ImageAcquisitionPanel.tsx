import { useEffect, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { apiFetch } from "@/lib/api"
import { useWebSocket, type WSEvent } from "@/hooks/useWebSocket"
import { ImageItemRow, type ImageItem } from "./ImageItemRow"
import { ImageThumbnailGrid } from "./ImageThumbnailGrid"

interface PhaseSummary {
  ai: { generated: number; failed: number; placeholder: number }
  web: { sourced: number; placeholder: number }
  total: number
}

interface Props {
  projectId: string
  sessionId: string | null
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "Generated",
  "Sourced",
  "Existing",
  "Placeholder",
  "Failed",
  "Needs-Manual",
])

export function ImageAcquisitionPanel({ projectId, sessionId }: Props) {
  const { t } = useTranslation("workspace")
  const [items, setItems] = useState<Record<string, ImageItem>>({})
  const [summary, setSummary] = useState<PhaseSummary | null>(null)

  const { data: initial } = useQuery({
    queryKey: ["image-manifest", projectId],
    queryFn: () => apiFetch<{ items: ImageItem[] }>(`/api/projects/${projectId}/images/manifest`),
    enabled: !!projectId,
  })

  useEffect(() => {
    if (!initial) return
    const next: Record<string, ImageItem> = {}
    for (const i of initial.items) next[i.filename] = i
    setItems(next)
  }, [initial])

  const handleWsEvent = useCallback((event: WSEvent) => {
    if (event.type === "image_status_update" && event.item) {
      const incoming = event.item as ImageItem
      setItems((prev) => ({
        ...prev,
        [incoming.filename]: { ...prev[incoming.filename], ...incoming },
      }))
    } else if (event.type === "image_phase_complete" && event.summary) {
      setSummary(event.summary as PhaseSummary)
    }
  }, [])

  useWebSocket({
    sessionId,
    onEvent: handleWsEvent,
    enabled: sessionId !== null,
  })

  const itemList = Object.values(items)
  const done = itemList.filter((i) => TERMINAL_STATUSES.has(i.status)).length
  const total = itemList.length

  if (total === 0) return null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{t("image_panel.title")}</CardTitle>
          <div className="text-sm text-muted-foreground">
            {t("image_panel.progress", { done, total })}
          </div>
        </div>
        {summary && (
          <div className="text-xs text-muted-foreground">
            {t("image_panel.advanced.summary", {
              generated: summary.ai.generated,
              failed: summary.ai.failed,
              placeholder: summary.ai.placeholder,
              sourced: summary.web.sourced,
            })}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          {itemList.map((item) => (
            <ImageItemRow key={item.filename} item={item} />
          ))}
        </div>
        <ImageThumbnailGrid items={itemList} />
      </CardContent>
    </Card>
  )
}
