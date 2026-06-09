import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2, FlaskConical, Loader2 } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface BackendInfo {
  name: string
  label: string
  tier: string
  default_model: string
  key_hint: string
}

interface ImageBackendConfig {
  id: string
  backend: string
  model: string | null
  base_url: string | null
  is_default: boolean
  display_name: string | null
  has_api_key: boolean
}

type TestState = { status: "idle" | "running" | "ok" | "err"; message?: string; latency?: number }

export function ImageBackendsSection() {
  const { t } = useTranslation("settings")
  const qc = useQueryClient()

  const [showForm, setShowForm] = useState(false)
  const [backend, setBackend] = useState("")
  const [model, setModel] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [isDefault, setIsDefault] = useState(false)
  const [testStates, setTestStates] = useState<Record<string, TestState>>({})

  const { data: available } = useQuery({
    queryKey: ["image-backends-available"],
    queryFn: () => apiFetch<BackendInfo[]>("/api/settings/image-backends/available"),
  })

  const { data: configs } = useQuery({
    queryKey: ["image-backends"],
    queryFn: () => apiFetch<ImageBackendConfig[]>("/api/settings/image-backends"),
  })

  const createMut = useMutation({
    mutationFn: () => apiFetch("/api/settings/image-backends", {
      method: "PUT",
      body: JSON.stringify({
        backend, model: model || null, api_key: apiKey,
        base_url: baseUrl || null, display_name: displayName || null,
        is_default: isDefault,
      }),
      headers: { "Content-Type": "application/json" },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["image-backends"] })
      setShowForm(false)
      setBackend(""); setModel(""); setApiKey(""); setBaseUrl(""); setDisplayName(""); setIsDefault(false)
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/settings/image-backends/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["image-backends"] }),
  })

  const setDefaultMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/settings/image-backends/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_default: true }),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["image-backends"] }),
  })

  const handleTest = async (id: string) => {
    setTestStates(s => ({ ...s, [id]: { status: "running" } }))
    try {
      const r = await apiFetch<{ success: boolean; error: string | null; latency_ms: number }>(
        `/api/settings/image-backends/${id}/test`, { method: "POST" }
      )
      setTestStates(s => ({
        ...s,
        [id]: r.success
          ? { status: "ok", latency: r.latency_ms }
          : { status: "err", message: r.error || "Failed" },
      }))
    } catch (e: unknown) {
      setTestStates(s => ({ ...s, [id]: { status: "err", message: e instanceof Error ? e.message : "Test failed" } }))
    }
  }

  const selectedBackendInfo = available?.find(b => b.name === backend)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("image_generation.title")}</CardTitle>
        <CardDescription>{t("image_generation.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {configs && configs.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("image_generation.no_backends")}</p>
        )}

        {configs?.map(c => {
          const ts = testStates[c.id] || { status: "idle" }
          return (
            <div key={c.id} className="rounded-md border p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.display_name || c.backend}</span>
                  {c.is_default && (
                    <span className="text-xs rounded bg-primary/10 px-1.5 py-0.5">
                      {t("image_generation.default_badge")}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {c.backend} {c.model ? `· ${c.model}` : ""}
                </div>
                {ts.status === "ok" && (
                  <div className="text-xs text-green-600">{t("image_generation.test_state.ok", { latency: ts.latency })}</div>
                )}
                {ts.status === "err" && (
                  <div className="text-xs text-red-600">{t("image_generation.test_state.error", { message: ts.message })}</div>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => handleTest(c.id)} disabled={ts.status === "running"}>
                  {ts.status === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
                </Button>
                {!c.is_default && (
                  <Button size="sm" variant="ghost" onClick={() => setDefaultMut.mutate(c.id)}>
                    {t("image_generation.actions.set_default")}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => deleteMut.mutate(c.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )
        })}

        {!showForm ? (
          <Button variant="outline" onClick={() => setShowForm(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t("image_generation.add_backend")}
          </Button>
        ) : (
          <div className="space-y-3 rounded-md border p-4">
            <div>
              <Label>{t("image_generation.fields.backend")}</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={backend}
                onChange={e => setBackend(e.target.value)}
              >
                <option value="">—</option>
                {available?.map(b => (
                  <option key={b.name} value={b.name}>
                    {b.label} ({b.tier})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>{t("image_generation.fields.model")}</Label>
              <Input value={model} onChange={e => setModel(e.target.value)}
                placeholder={selectedBackendInfo?.default_model || ""} />
            </div>
            <div>
              <Label>{t("image_generation.fields.api_key")}</Label>
              <Input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} />
              {selectedBackendInfo && (
                <p className="text-xs text-muted-foreground mt-1">{selectedBackendInfo.key_hint}</p>
              )}
            </div>
            <div>
              <Label>{t("image_generation.fields.base_url")}</Label>
              <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
            </div>
            <div>
              <Label>{t("image_generation.fields.display_name")}</Label>
              <Input value={displayName} onChange={e => setDisplayName(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
              {t("image_generation.fields.is_default")}
            </label>
            <div className="flex gap-2">
              <Button onClick={() => createMut.mutate()} disabled={!backend || !apiKey || createMut.isPending}>
                {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : t("image_generation.actions.save")}
              </Button>
              <Button variant="ghost" onClick={() => setShowForm(false)}>
                {t("image_generation.actions.cancel")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
