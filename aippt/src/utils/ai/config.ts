import { getModels, type ProviderKey } from './providers'

export interface AISettings {
  provider: ProviderKey
  model: string
  apiKey?: string
  baseUrl?: string
  temperature?: number
  apiKeys?: {
    deepseek?: string
    minimax?: string
    kimi?: string
    glm?: string
    qwen?: string
    doubao?: string
    openai?: string
    claude?: string
    gemini?: string
    grok?: string
  }
}

const STORAGE_KEY = 'pxdoc_ai_settings'
const SERVER_CACHE_KEY = 'pxdoc_ai_settings_server_cache'
const CACHE_TTL_MS = 5 * 60 * 1000

const DEFAULTS: AISettings = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  apiKey: '',
  temperature: 0.7,
  apiKeys: {},
}

let serverSettingsCache: AISettings | null = null
let serverSettingsTimestamp: number = 0
let fetchPromise: Promise<AISettings | null> | null = null

function resolveApiBaseUrl(): string {
  try {
    const g = globalThis as any
    const fromGlobal = g && g.__PX_BASE_API_URL__
    const fromLS = typeof localStorage !== 'undefined' ? localStorage.getItem('px_base_api_url') : null
    const apiUrl = fromGlobal || fromLS || process.env.BASE_API_URL
    if (apiUrl && apiUrl.includes('localhost')) {
      return ''
    }
    return apiUrl
  } catch {
    return process.env.BASE_API_URL || ''
  }
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    const token = localStorage.getItem('jwt_token')
    if (token) headers['Authorization'] = `Bearer ${token}`
  } catch {}
  return headers
}

export async function fetchServerAISettings(): Promise<AISettings | null> {
  try {
    const base = resolveApiBaseUrl()
    const url = (base || '').replace(/\/$/, '') + '/api/enterprise/aippt-llm-runtime'
    const res = await fetch(url, { headers: getAuthHeaders() })
    if (!res.ok) return null
    const data = await res.json()

    const apiKeys: AISettings['apiKeys'] = {}
    if (data.apiKeys) {
      for (const [k, v] of Object.entries(data.apiKeys)) {
        if (typeof v === 'string' && v.length > 0) {
          apiKeys[k as keyof AISettings['apiKeys']] = v
        }
      }
    }

    const settings: AISettings = {
      provider: (data.provider || 'deepseek') as ProviderKey,
      model: data.model || 'deepseek-chat',
      temperature: data.temperature ?? 0.7,
      baseUrl: data.baseUrl || '',
      apiKeys,
    }

    serverSettingsCache = settings
    serverSettingsTimestamp = Date.now()
    try {
      localStorage.setItem(SERVER_CACHE_KEY, JSON.stringify({ settings, ts: serverSettingsTimestamp }))
    } catch {}

    return settings
  } catch {
    return null
  }
}

export function refreshAISettings(): Promise<AISettings | null> {
  serverSettingsCache = null
  serverSettingsTimestamp = 0
  return fetchServerAISettings()
}

function loadCachedServerSettings(): AISettings | null {
  if (serverSettingsCache && (Date.now() - serverSettingsTimestamp) < CACHE_TTL_MS) {
    return serverSettingsCache
  }
  try {
    const raw = localStorage.getItem(SERVER_CACHE_KEY)
    if (raw) {
      const { settings, ts } = JSON.parse(raw)
      if (settings && (Date.now() - ts) < CACHE_TTL_MS) {
        serverSettingsCache = settings
        serverSettingsTimestamp = ts
        return settings
      }
    }
  } catch {}
  return null
}

export function ensureServerSettingsLoaded(): Promise<AISettings | null> {
  const cached = loadCachedServerSettings()
  if (cached) return Promise.resolve(cached)
  if (fetchPromise) return fetchPromise
  fetchPromise = fetchServerAISettings().finally(() => { fetchPromise = null })
  return fetchPromise
}

export function getProviderApiKey(provider: ProviderKey, settings: AISettings): string {
  if (settings.apiKeys?.[provider]) {
    return settings.apiKeys[provider];
  }

  if (typeof import.meta !== 'undefined' && import.meta.env) {
    const envKey = getEnvKeyForProvider(provider);
    if (envKey && import.meta.env[envKey]) {
      return import.meta.env[envKey];
    }
  }

  return settings.apiKey || '';
}

function getEnvKeyForProvider(provider: ProviderKey): string | null {
  const envMap: Record<ProviderKey, string> = {
    deepseek: 'VITE_DEEPSEEK_API_KEY',
    minimax: 'VITE_MINIMAX_API_KEY',
    kimi: 'VITE_KIMI_API_KEY',
    glm: 'VITE_GLM_API_KEY',
    qwen: 'VITE_QWEN_API_KEY',
    doubao: 'VITE_DOUBAO_API_KEY',
    openai: 'VITE_OPENAI_API_KEY',
    claude: 'VITE_CLAUDE_API_KEY',
    gemini: 'VITE_GEMINI_API_KEY',
    grok: 'VITE_GROK_API_KEY',
    custom: '',
  };
  return envMap[provider] || null;
}

export function getAISettings(): AISettings {
  const serverCached = loadCachedServerSettings()
  if (serverCached) {
    const merged: AISettings = {
      ...DEFAULTS,
      ...serverCached,
      apiKeys: {
        ...DEFAULTS.apiKeys,
        ..._getLocalApiKeys(),
        ...serverCached.apiKeys,
      },
    }
    return merged
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    let settings: AISettings;

    if (!raw) {
      settings = { ...DEFAULTS };
    } else {
      const parsed = JSON.parse(raw);
      settings = { ...DEFAULTS, ...parsed };
    }

    if (!settings.apiKeys) {
      settings.apiKeys = {};
    }

    if (settings.apiKey && !settings.apiKeys[settings.provider]) {
      settings.apiKeys[settings.provider] = settings.apiKey;
    }

    return settings;
  } catch {
    return { ...DEFAULTS, apiKeys: {} };
  }
}

function _getLocalApiKeys(): AISettings['apiKeys'] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed?.apiKeys || {}
  } catch {
    return {}
  }
}

export function setAISettings(next: Partial<AISettings>) {
  const merged = { ...getAISettings(), ...next }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
}

export function getAvailableModels(provider: ProviderKey): Array<{label: string; value: string}> {
  return getModels(provider)
}

export interface AvailableModel {
  provider: string
  model: string
  label: string
  available: boolean
}

const AVAILABLE_MODELS_CACHE_KEY = 'pxdoc_available_models_cache'

export async function fetchAvailableModels(): Promise<AvailableModel[]> {
  try {
    const base = resolveApiBaseUrl()
    const url = (base || '').replace(/\/$/, '') + '/api/enterprise/llm-models'
    const res = await fetch(url, { headers: getAuthHeaders() })
    if (!res.ok) return []
    const data = await res.json()
    const models = data?.data?.models || data?.models || []
    return models.map(m => ({
      provider: m.provider,
      model: m.model,
      label: m.label || `${m.provider}/${m.model}`,
      available: m.enabled !== false && !!m.api_key_masked,
    }))
  } catch {
    const cached = localStorage.getItem(AVAILABLE_MODELS_CACHE_KEY)
    if (cached) {
      try { return JSON.parse(cached) } catch {}
    }
    return []
  }
}

export function cacheAvailableModels(models: AvailableModel[]) {
  localStorage.setItem(AVAILABLE_MODELS_CACHE_KEY, JSON.stringify(models))
}
