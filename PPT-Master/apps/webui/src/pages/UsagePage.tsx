import { useTranslation } from "react-i18next"
import { useLocale } from "@/hooks/LocaleContext"
import { StorageUsageCard } from "@/components/settings/StorageUsageCard"
import { TokenUsageCard } from "@/components/settings/TokenUsageCard"

export function UsagePage() {
  useLocale()
  const { t } = useTranslation("settings")

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">{t("usage")}</h1>
      <StorageUsageCard />
      <TokenUsageCard />
    </div>
  )
}
