import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2, Loader2, FlaskConical, Pencil } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { useAuth } from "@/hooks/useAuth"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface LLMConfig {
  id: string
  provider: string
  model: string
  endpoint: string | null
  role_preference: string | null
  is_default: boolean
  display_name: string | null
}

const providerOptions = [
  { value: "anthropic", label: "Anthropic (Claude)", model: "claude-sonnet-4-20250514" },
  { value: "openai", label: "OpenAI (GPT)", model: "gpt-4o" },
  { value: "gemini", label: "Google (Gemini)", model: "gemini-2.5-flash" },
  { value: "deepseek", label: "DeepSeek", model: "deepseek-chat" },
  { value: "qwen", label: "Qwen (DashScope)", model: "qwen-plus" },
  { value: "ollama", label: "Ollama (local)", model: "llama3" },
  { value: "vllm", label: "vLLM", model: "" },
  { value: "zhipu", label: "Zhipu (GLM)", model: "glm-4-flash" },
  { value: "kimi", label: "Kimi (Moonshot)", model: "moonshot-v1-8k" },
  { value: "minimax", label: "MiniMax", model: "abab6.5s-chat" },
  { value: "baidu", label: "Baidu (Qianfan)", model: "ernie-speed-128k" },
  { value: "openrouter", label: "OpenRouter", model: "openai/gpt-4o" },
]

const ROLE_VALUES = ["", "strategist", "image_generator", "executor", "template_picker"] as const

export function LLMProvidersSection() {
  const { t } = useTranslation("settings")
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const isAdmin = user?.role === "admin"

  const [showAddForm, setShowAddForm] = useState(false)
  const [provider, setProvider] = useState("anthropic")
  const [model, setModel] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [endpoint, setEndpoint] = useState("")
  const [rolePreference, setRolePreference] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [editingConfig, setEditingConfig] = useState<LLMConfig | null>(null)
  const [editProvider, setEditProvider] = useState("")
  const [editModel, setEditModel] = useState("")
  const [editApiKey, setEditApiKey] = useState("")
  const [editEndpoint, setEditEndpoint] = useState("")
  const [editRolePref, setEditRolePref] = useState("")
  const [testStates, setTestStates] = useState<
    Record<string, { status: "running" | "ok" | "err"; message?: string; latency?: number }>
  >({})

  type TestState = { status: "idle" | "running" | "ok" | "err"; message?: string; latency?: number }
  const [formTestState, setFormTestState] = useState<TestState>({ status: "idle" })

  const { data: configs, isLoading } = useQuery({
    queryKey: ["llm-configs"],
    queryFn: () => apiFetch<LLMConfig[]>("/api/settings/llm"),
    enabled: isAdmin,
  })

  const roleLabel = (value: string | null | undefined): string => {
    if (!value) return t("llm_providers.all_roles")
    const key = `llm_providers.roles.${value}`
    return t(key, { defaultValue: value })
  }

  const handleAddConfig = async () => {
    if (!model.trim() || !apiKey.trim()) return
    setIsSaving(true)
    try {
      await apiFetch("/api/settings/llm", {
        method: "PUT",
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: apiKey.trim(),
          endpoint: endpoint.trim() || null,
          role_preference: rolePreference || null,
          display_name: `${provider}/${model}`,
        }),
      })
      queryClient.invalidateQueries({ queryKey: ["llm-configs"] })
      setShowAddForm(false)
      setModel("")
      setApiKey("")
    } catch (err) {
      alert(err instanceof Error ? err.message : t("llm_providers.errors.save_failed"))
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (configId: string) => {
    if (!confirm(t("llm_providers.confirm_delete"))) return
    try {
      await apiFetch(`/api/settings/llm/${configId}`, { method: "DELETE" })
      queryClient.invalidateQueries({ queryKey: ["llm-configs"] })
    } catch (err) {
      alert(err instanceof Error ? err.message : t("llm_providers.errors.delete_failed"))
    }
  }

  const handleTest = async (configId: string) => {
    setTestStates((prev) => ({ ...prev, [configId]: { status: "running" } }))
    try {
      const res = await apiFetch<{
        success: boolean
        response: string | null
        error: string | null
        latency_ms: number
      }>(`/api/settings/llm/${configId}/test`, { method: "POST" })

      setTestStates((prev) => ({
        ...prev,
        [configId]: {
          status: res.success ? "ok" : "err",
          message: res.success ? res.response ?? "OK" : res.error ?? t("llm_providers.errors.test_failed"),
          latency: res.latency_ms,
        },
      }))

      setTimeout(() => {
        setTestStates((prev) => {
          const next = { ...prev }
          delete next[configId]
          return next
        })
      }, 5000)
    } catch (err) {
      setTestStates((prev) => ({
        ...prev,
        [configId]: {
          status: "err",
          message: err instanceof Error ? err.message : t("llm_providers.errors.test_failed"),
        },
      }))
    }
  }

  const handleFormTest = async () => {
    if (!model.trim() || !apiKey.trim()) return
    setFormTestState({ status: "running" })
    try {
      const res = await apiFetch<{
        success: boolean
        response: string | null
        error: string | null
        latency_ms: number
      }>("/api/settings/llm/test", {
        method: "POST",
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: apiKey.trim(),
          endpoint: endpoint.trim() || null,
        }),
      })
      setFormTestState({
        status: res.success ? "ok" : "err",
        message: res.error ?? undefined,
        latency: res.latency_ms,
      })
      setTimeout(() => setFormTestState({ status: "idle" }), 5000)
    } catch (err) {
      setFormTestState({
        status: "err",
        message: err instanceof Error ? err.message : t("llm_providers.errors.test_failed"),
      })
    }
  }

  const handleStartEdit = (cfg: LLMConfig) => {
    setEditingConfig(cfg)
    setEditProvider(cfg.provider)
    setEditModel(cfg.model)
    setEditApiKey("")
    setEditEndpoint(cfg.endpoint ?? "")
    setEditRolePref(cfg.role_preference ?? "")
  }

  const handleSaveEdit = async () => {
    if (!editingConfig || !editModel.trim()) return
    try {
      await apiFetch(`/api/settings/llm/${editingConfig.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          provider: editProvider || undefined,
          model: editModel.trim(),
          api_key: editApiKey.trim() || undefined,
          endpoint: editEndpoint.trim() || null,
          role_preference: editRolePref || null,
        }),
      })
      queryClient.invalidateQueries({ queryKey: ["llm-configs"] })
      setEditingConfig(null)
    } catch (err) {
      alert(err instanceof Error ? err.message : t("llm_providers.errors.save_failed"))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("llm_providers.title")}</CardTitle>
        <CardDescription>{t("llm_providers.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!isAdmin && (
          <p className="text-sm text-muted-foreground">{t("llm_providers.admin_only")}</p>
        )}

        {isAdmin && isLoading && (
          <p className="text-sm text-muted-foreground">{t("llm_providers.loading")}</p>
        )}

        {isAdmin && configs && configs.length === 0 && !showAddForm && (
          <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-8">
            <p className="text-sm text-muted-foreground mb-4">{t("llm_providers.no_providers")}</p>
            <Button onClick={() => setShowAddForm(true)}>
              <Plus className="mr-2 h-4 w-4" /> {t("llm_providers.add_provider")}
            </Button>
          </div>
        )}

        {isAdmin && configs && configs.length > 0 && (
          <div className="space-y-3">
            {configs
              .filter((cfg) => cfg.id !== editingConfig?.id)
              .map((cfg) => (
                <div
                  key={cfg.id}
                  className="rounded-md border p-3 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">
                        {cfg.display_name || `${cfg.provider}/${cfg.model}`}
                      </span>
                      {cfg.is_default && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          {t("llm_providers.default_badge")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 truncate">
                      {roleLabel(cfg.role_preference)}
                      {cfg.endpoint && ` • ${cfg.endpoint}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {testStates[cfg.id]?.status === "running" && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> {t("llm_providers.test_state.running")}
                      </span>
                    )}
                    {testStates[cfg.id]?.status === "ok" && (
                      <span className="text-xs text-green-600">
                        {t("llm_providers.test_state.ok_latency", { latency: testStates[cfg.id]?.latency })}
                      </span>
                    )}
                    {testStates[cfg.id]?.status === "err" && (
                      <span
                        className="max-w-[200px] truncate text-xs text-destructive"
                        title={testStates[cfg.id]?.message}
                      >
                        ✗ {testStates[cfg.id]?.message}
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleTest(cfg.id)}
                      disabled={testStates[cfg.id]?.status === "running"}
                      title={t("llm_providers.actions.test")}
                    >
                      <FlaskConical className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleStartEdit(cfg)}
                      title={t("llm_providers.actions.edit")}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(cfg.id)}
                      title={t("llm_providers.actions.delete")}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        )}

        {isAdmin && showAddForm ? (
          <div className="rounded-md border p-4 space-y-4">
            <div>
              <h3 className="font-medium">{t("llm_providers.add_card.title")}</h3>
              <p className="text-sm text-muted-foreground">{t("llm_providers.add_card.description")}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("llm_providers.fields.provider")}</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value)
                    const opt = providerOptions.find((p) => p.value === e.target.value)
                    if (opt) setModel(opt.model)
                  }}
                >
                  {providerOptions.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>{t("llm_providers.fields.role_preference")}</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={rolePreference}
                  onChange={(e) => setRolePreference(e.target.value)}
                >
                  {ROLE_VALUES.map((value) => (
                    <option key={value || "all"} value={value}>
                      {value
                        ? t(`llm_providers.roles.${value}`, { defaultValue: value })
                        : t("llm_providers.roles.all_default")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("llm_providers.fields.model")}</Label>
              <Input
                placeholder="claude-sonnet-4-20250514"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("llm_providers.fields.api_key")}</Label>
              <Input
                type="password"
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("llm_providers.fields.endpoint")}</Label>
              <Input
                placeholder="https://your-ollama:11434"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 pt-2">
              <Button onClick={handleAddConfig} disabled={!model.trim() || !apiKey.trim() || isSaving}>
                {isSaving ? t("llm_providers.actions.saving") : t("llm_providers.actions.save")}
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-10 w-10"
                onClick={handleFormTest}
                disabled={!model.trim() || !apiKey.trim() || formTestState.status === "running"}
                title={t("llm_providers.actions.test")}
              >
                {formTestState.status === "running" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FlaskConical className="h-4 w-4" />
                )}
              </Button>
              {formTestState.status === "ok" && (
                <span className="text-xs text-green-600">
                  {t("llm_providers.test_state.ok_latency", { latency: formTestState.latency })}
                </span>
              )}
              {formTestState.status === "err" && (
                <span
                  className="max-w-[160px] truncate text-xs text-destructive"
                  title={formTestState.message}
                >
                  ✗ {formTestState.message}
                </span>
              )}
              <div className="flex-1" />
              <Button variant="outline" onClick={() => setShowAddForm(false)}>
                {t("llm_providers.actions.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          isAdmin &&
          configs &&
          configs.length > 0 && (
            <Button onClick={() => setShowAddForm(true)} variant="outline">
              <Plus className="mr-2 h-4 w-4" /> {t("llm_providers.add_provider")}
            </Button>
          )
        )}

        {isAdmin && editingConfig && (
          <div className="rounded-md border p-4 space-y-4">
            <div>
              <h3 className="font-medium">{t("llm_providers.edit_card.title")}</h3>
              <p className="text-sm text-muted-foreground">
                {t("llm_providers.edit_card.description", {
                  name: editingConfig.display_name || `${editingConfig.provider}/${editingConfig.model}`,
                })}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("llm_providers.fields.provider")}</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={editProvider}
                  onChange={(e) => {
                    setEditProvider(e.target.value)
                    const opt = providerOptions.find((p) => p.value === e.target.value)
                    if (opt) setEditModel(opt.model)
                  }}
                >
                  {providerOptions.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>{t("llm_providers.fields.role_preference")}</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={editRolePref}
                  onChange={(e) => setEditRolePref(e.target.value)}
                >
                  {ROLE_VALUES.map((value) => (
                    <option key={value || "all"} value={value}>
                      {value
                        ? t(`llm_providers.roles.${value}`, { defaultValue: value })
                        : t("llm_providers.roles.all_default")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("llm_providers.fields.model")}</Label>
              <Input value={editModel} onChange={(e) => setEditModel(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{t("llm_providers.fields.api_key_edit_hint")}</Label>
              <Input
                type="password"
                placeholder={t("llm_providers.fields.api_key_unchanged_placeholder")}
                value={editApiKey}
                onChange={(e) => setEditApiKey(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("llm_providers.fields.endpoint_short")}</Label>
              <Input
                placeholder="https://your-ollama:11434"
                value={editEndpoint}
                onChange={(e) => setEditEndpoint(e.target.value)}
              />
            </div>
            <div className="flex gap-2 pt-2">
              <Button onClick={handleSaveEdit} disabled={!editModel.trim()}>
                {t("llm_providers.actions.save_changes")}
              </Button>
              <Button variant="outline" onClick={() => setEditingConfig(null)}>
                {t("llm_providers.actions.cancel")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
