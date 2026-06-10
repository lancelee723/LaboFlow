import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface SearchConfig {
  id: string
  provider: string
  has_api_key: boolean
}

const PROVIDERS = ["pexels", "pixabay"] as const

export function ImageSearchSection() {
  const { t } = useTranslation("settings")
  const qc = useQueryClient()
  const { data: configs } = useQuery({
    queryKey: ["image-search"],
    queryFn: () => apiFetch<SearchConfig[]>("/api/settings/image-search"),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("image_search.title")}</CardTitle>
        <CardDescription>{t("image_search.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("image_search.zero_config_note")}</p>
        <p className="text-sm text-muted-foreground">{t("image_search.premium_note")}</p>

        {PROVIDERS.map(p => (
          <ProviderRow
            key={p}
            provider={p}
            existing={configs?.find(c => c.provider === p)}
            onChange={() => qc.invalidateQueries({ queryKey: ["image-search"] })}
          />
        ))}
      </CardContent>
    </Card>
  )
}

function ProviderRow({
  provider, existing, onChange,
}: { provider: string; existing?: SearchConfig; onChange: () => void }) {
  const { t } = useTranslation("settings")
  const [key, setKey] = useState("")
  const [editing, setEditing] = useState(false)

  const saveMut = useMutation({
    mutationFn: () => apiFetch("/api/settings/image-search", {
      method: "PUT",
      body: JSON.stringify({ provider, api_key: key }),
      headers: { "Content-Type": "application/json" },
    }),
    onSuccess: () => { onChange(); setKey(""); setEditing(false) },
  })

  const deleteMut = useMutation({
    mutationFn: () => apiFetch(`/api/settings/image-search/${provider}`, { method: "DELETE" }),
    onSuccess: onChange,
  })

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">{t(`image_search.providers.${provider}`)}</div>
          <div className="text-xs text-muted-foreground">
            {existing ? t("image_search.configured") : t("image_search.not_configured")}
          </div>
        </div>
        <div className="flex gap-2">
          {!editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {existing ? t("image_search.actions.update") : t("image_search.actions.configure")}
            </Button>
          )}
          {existing && (
            <Button size="sm" variant="ghost" onClick={() => deleteMut.mutate()}>
              {t("image_search.actions.remove")}
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-3 space-y-2">
          <Label>API Key</Label>
          <Input type="password" value={key} onChange={e => setKey(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => saveMut.mutate()} disabled={!key || saveMut.isPending}>
              {t("image_search.actions.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setKey("") }}>
              {t("image_search.actions.cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
