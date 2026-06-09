import { useTranslation } from "react-i18next"
import { CheckCircle2 } from "lucide-react"

interface SvgProgressHeaderProps {
  page: number
  total: number
}

export function SvgProgressHeader({ page, total }: SvgProgressHeaderProps) {
  const { t } = useTranslation("editor")
  const pct = Math.round((page / total) * 100)
  const remaining = total - page

  return (
    <div className="border-b px-4 py-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100">
          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
        </div>
        <p className="text-sm font-semibold text-emerald-800">
          {t("generatingSlides")}
        </p>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-emerald-100">
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      <p className="text-xs font-medium text-emerald-700">
        {page} / {total} {t("pagesRendered")}
        {remaining > 0 && (
          <> &middot; {t("renderingPage")} {page + 1} &middot; {remaining} {t("remainingLabel")}</>
        )}
      </p>
    </div>
  )
}
