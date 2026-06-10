import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface StorageUsage {
  used_bytes: number
  soft_deleted_bytes: number
  quota_bytes: number
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function StorageUsageCard() {
  const { t } = useTranslation("settings")
  const { data: storage } = useQuery({
    queryKey: ["storage-usage"],
    queryFn: () => apiFetch<StorageUsage>("/api/users/me/storage"),
    staleTime: 30_000,
  })

  if (!storage) return null

  const usedPct = Math.min(100, (storage.used_bytes / storage.quota_bytes) * 100)
  const softPct = Math.min(100 - usedPct, (storage.soft_deleted_bytes / storage.quota_bytes) * 100)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("storage.title")}</CardTitle>
        <CardDescription>
          {t("storage.subtitle", {
            used: formatBytes(storage.used_bytes),
            quota: formatBytes(storage.quota_bytes),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="flex h-full">
            <div className="h-full bg-primary transition-all" style={{ width: `${usedPct}%` }} />
            <div className="h-full bg-primary/30 transition-all" style={{ width: `${softPct}%` }} />
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-primary" />
            {t("storage.active", { size: formatBytes(storage.used_bytes) })}
          </span>
          {storage.soft_deleted_bytes > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-primary/30" />
              {t("storage.trash", { size: formatBytes(storage.soft_deleted_bytes) })}
            </span>
          )}
          <span className="flex items-center gap-1.5">
            {t("storage.quota", { size: formatBytes(storage.quota_bytes) })}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
