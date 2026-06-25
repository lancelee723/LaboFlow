import { useTranslation } from "react-i18next"
import { AlertTriangle, RefreshCw, Clipboard } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ApiError } from "@/lib/errors"
import { translateError } from "@/lib/errors"

interface ErrorBannerProps {
  error: string | ApiError
  onRetry?: () => void
  onReport?: () => void
}

function parseError(err: string | ApiError): string {
  if (typeof err === "string") return err
  return translateError(err)
}

export function ErrorBanner({ error, onRetry, onReport }: ErrorBannerProps) {
  const { t } = useTranslation("common")
  const message = parseError(error)

  const handleCopyReport = () => {
    if (onReport) {
      onReport()
      return
    }
    const report = [
      `Time: ${new Date().toISOString()}`,
      `Error: ${message}`,
      typeof error === "object" ? `Code: ${(error as ApiError).code}` : `Raw: ${error}`,
    ].join("\n")
    navigator.clipboard.writeText(report).catch(() => {})
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
        <span className="flex-1">{message}</span>
      </div>
      <div className="flex gap-2">
        {onRetry && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 border-red-200 text-xs text-red-700 hover:bg-red-100"
            onClick={onRetry}
          >
            <RefreshCw className="h-3 w-3" />
            {t("retry")}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 border-red-200 text-xs text-red-700 hover:bg-red-100"
          onClick={handleCopyReport}
        >
          <Clipboard className="h-3 w-3" />
          {t("report")}
        </Button>
      </div>
    </div>
  )
}
