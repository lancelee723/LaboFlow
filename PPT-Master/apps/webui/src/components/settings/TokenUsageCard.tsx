import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface ProjectUsage {
  project_id: string | null
  project_name: string | null
  tokens_in: number
  tokens_out: number
  tokens_total: number
  last_used: string | null
}

interface UsageResponse {
  lifetime: {
    tokens_in: number
    tokens_out: number
    tokens_total: number
  }
  projects: ProjectUsage[]
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString()
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString(locale)
  } catch {
    return iso
  }
}

export function TokenUsageCard() {
  const { t, i18n } = useTranslation("settings")
  const { data } = useQuery({
    queryKey: ["token-usage"],
    queryFn: () => apiFetch<UsageResponse>("/api/users/me/usage"),
    staleTime: 30_000,
  })

  if (!data) return null

  const { lifetime, projects } = data

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("usageTitle")}</CardTitle>
        <CardDescription>{t("usageSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3 rounded-lg border bg-muted/30 p-3">
          <div>
            <div className="text-xs text-muted-foreground">{t("usageTokensIn")}</div>
            <div className="mt-1 text-lg font-semibold">{formatTokens(lifetime.tokens_in)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{t("usageTokensOut")}</div>
            <div className="mt-1 text-lg font-semibold">{formatTokens(lifetime.tokens_out)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{t("usageLifetime")}</div>
            <div className="mt-1 text-lg font-semibold">{formatTokens(lifetime.tokens_total)}</div>
          </div>
        </div>

        {projects.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            {t("usageEmpty")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-3 font-medium">{t("usageProjectName")}</th>
                  <th className="pb-2 px-3 font-medium text-right">{t("usageTokensIn")}</th>
                  <th className="pb-2 px-3 font-medium text-right">{t("usageTokensOut")}</th>
                  <th className="pb-2 px-3 font-medium text-right">{t("usageTokensTotal")}</th>
                  <th className="pb-2 pl-3 font-medium">{t("usageLastUsed")}</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p, idx) => (
                  <tr key={p.project_id ?? `null-${idx}`} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      {p.project_name ?? <span className="text-muted-foreground italic">{t("usageDeletedProject")}</span>}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatTokens(p.tokens_in)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatTokens(p.tokens_out)}</td>
                    <td className="py-2 px-3 text-right tabular-nums font-medium">{formatTokens(p.tokens_total)}</td>
                    <td className="py-2 pl-3 text-xs text-muted-foreground">{formatDate(p.last_used, i18n.language)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
