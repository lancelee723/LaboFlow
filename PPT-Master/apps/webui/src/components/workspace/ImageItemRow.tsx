import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle, XCircle, Clock, Loader2, AlertCircle, Image as ImageIcon, ChevronDown, ChevronUp, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"

export interface ImageItem {
  filename: string
  page?: string
  purpose?: string
  method?: "ai" | "web" | "user" | "formula" | "placeholder"
  status:
    | "Pending" | "Generating" | "Searching"
    | "Generated" | "Sourced" | "Existing"
    | "Placeholder" | "Failed" | "Needs-Manual"
  prompt?: string
  thumbnail_url?: string
  last_error?: string
  license_tier?: string
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  Pending: <Clock className="h-4 w-4 text-muted-foreground" />,
  Generating: <Loader2 className="h-4 w-4 animate-spin text-blue-500" />,
  Searching: <Loader2 className="h-4 w-4 animate-spin text-blue-500" />,
  Generated: <CheckCircle className="h-4 w-4 text-green-600" />,
  Sourced: <CheckCircle className="h-4 w-4 text-green-600" />,
  Existing: <CheckCircle className="h-4 w-4 text-gray-500" />,
  Placeholder: <AlertCircle className="h-4 w-4 text-yellow-600" />,
  Failed: <XCircle className="h-4 w-4 text-red-600" />,
  "Needs-Manual": <AlertCircle className="h-4 w-4 text-red-600" />,
}

export function ImageItemRow({ item, onThumbnailClick }: {
  item: ImageItem
  onThumbnailClick?: (item: ImageItem) => void
}) {
  const { t } = useTranslation("workspace")
  const [expanded, setExpanded] = useState(false)
  const canExpand = !!(item.prompt || item.last_error)
  const statusKey = item.status.toLowerCase().replace("-", "_")

  return (
    <div className="rounded border bg-card text-card-foreground">
      <div className="flex items-center gap-3 p-2">
        <div className="w-12 shrink-0 text-xs text-muted-foreground">
          {item.page || ""}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-mono truncate">{item.filename}</div>
          {item.purpose && (
            <div className="text-xs text-muted-foreground truncate">{item.purpose}</div>
          )}
        </div>
        <div className="w-16 text-xs text-muted-foreground">
          {item.method ? t(`image_panel.method.${item.method}`) : ""}
        </div>
        <div className="flex w-32 items-center gap-1.5 text-xs">
          {STATUS_ICON[item.status]}
          <span>{t(`image_panel.status.${statusKey}`)}</span>
        </div>
        <div className="flex w-20 items-center justify-end gap-1">
          {item.thumbnail_url && (
            <Button size="icon" variant="ghost" onClick={() => onThumbnailClick?.(item)} title={t("image_panel.actions.view_thumbnail")}>
              <ImageIcon className="h-4 w-4" />
            </Button>
          )}
          {canExpand && (
            <Button size="icon" variant="ghost" onClick={() => setExpanded(e => !e)}>
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t bg-muted/40 p-3 text-xs space-y-2">
          {item.last_error && (
            <div className="text-red-600">&#x26A0; {item.last_error}</div>
          )}
          {item.prompt && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-medium">{t("image_panel.actions.view_prompt")}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigator.clipboard.writeText(item.prompt!)}
                >
                  <Copy className="h-3 w-3 mr-1" />
                  {t("image_panel.actions.copy_prompt")}
                </Button>
              </div>
              <pre className="whitespace-pre-wrap font-mono text-[11px] bg-background p-2 rounded">
                {item.prompt}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
