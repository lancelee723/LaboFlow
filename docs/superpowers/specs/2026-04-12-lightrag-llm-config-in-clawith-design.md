# LightRAG LLM Config — Clawith-Side Admin UI Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Supersedes:** `2026-04-11-lightrag-llm-provider-settings-design.md` (LightRAG-side approach abandoned due to SSO role-propagation complexity)

---

## 1. Problem & Decision

The earlier design placed the LLM Provider settings UI inside LightRAG WebUI, gated by an SSO-forwarded `platform_admin` role.
That approach had a structural problem: `combined_auth` in LightRAG rejects any non-guest token when `AUTH_ACCOUNTS` is not configured, making SSO role forwarding unreliable. After analysis, moving the admin UI to Clawith is cleaner:

- Clawith already owns auth and has a proven `platform_admin` gate.
- The LightRAG backend `/llm-config` routes are already implemented and work correctly — only the entry point moves.
- No SSO role propagation needed; Clawith JWT is sent directly to LightRAG (secrets are shared via `TOKEN_SECRET = JWT_SECRET_KEY` in `dev.sh`).

---

## 2. Architecture

```
Clawith EnterpriseSettings (/enterprise → "kb" tab)
  └── fetchKbJson(GET/POST '/kb-api/llm-config')
        └── Authorization: Bearer <clawith_jwt>
              └── NGINX /kb-api/ → LightRAG:9621
                    └── require_platform_admin
                          └── validate_token(clawith_jwt) → role="platform_admin" ✓
```

The Clawith JWT already contains `role: "platform_admin"` for admin users.
LightRAG's `require_platform_admin` calls `auth_handler.validate_token`, which decodes using the shared secret — no additional backend endpoint needed.

---

## 3. Clawith Frontend Changes

### 3.1 New `fetchKbJson` helper (top of `EnterpriseSettings.tsx`)

```ts
async function fetchKbJson<T>(url: string, options?: RequestInit): Promise<T> {
    const token = localStorage.getItem('token');
    const res = await fetch(`/kb-api${url}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const detail = body.detail;
        const msg = typeof detail === 'string' ? detail
            : Array.isArray(detail) ? detail.map((e: any) => e.msg || JSON.stringify(e)).join('; ')
            : 'Error';
        throw new Error(msg);
    }
    if (res.status === 204) return undefined as T;
    return res.json();
}
```

### 3.2 Tab registration

- Add `'kb'` to the `activeTab` state union type.
- Add "Knowledge Base" tab button in the tabs row, rendered only when `currentUser.role === 'platform_admin'`.
- Add `{activeTab === 'kb' && <KbTab />}` in the tab content section.

### 3.3 `KbTab` component

Inline function component in `EnterpriseSettings.tsx`. Three card sections:

**LLM card**
- Fields: `binding` (select, options from response `providers.llm_bindings`), `host`, `model`, `api_key` (type=password), `max_async`, `timeout`, `temperature`, `max_tokens`
- When `binding === 'openai'`: show a "Preset" select using `providers.openai_compatible_presets`; selecting a preset auto-fills `host` and `max_tokens`

**Embedding card**
- Fields: `binding`, `host`, `model`, `api_key`, `dim`, `token_limit`, `send_dim` (checkbox), `timeout`
- If the user changes `binding`, `model`, or `dim` and `has_indexed_data` is true: show inline warning banner  
  "修改 Embedding 模型将清除所有已索引数据，此操作不可撤销。"
- Save button stays enabled but triggers destructive confirm flow (see §5)

**Rerank card**
- `enabled` toggle; when disabled, remaining fields are grayed out
- Fields: `binding` (select, options from `providers.rerank_bindings`), `host`, `model`, `api_key`

**Footer**
- "Save" button (primary). Disabled while loading or saving.
- Source badges: each section header shows `overlay` or `env` badge (from GET response `source` field).

### 3.4 State management

Local `useState` per section (no new state library). Dirty tracking via a `isDirty` boolean derived by comparing form values to the last loaded config. `generation` is tracked to send in POST.

---

## 4. LightRAG Cleanup

### 4.1 Frontend files to delete

| File | Reason |
|---|---|
| `src/components/LLMConfigButton.tsx` | Entry point moves to Clawith |
| `src/components/LLMConfigDialog/index.tsx` | Dialog removed |
| `src/components/LLMConfigDialog/LLMSection.tsx` | Dialog removed |
| `src/components/LLMConfigDialog/EmbeddingSection.tsx` | Dialog removed |
| `src/components/LLMConfigDialog/RerankSection.tsx` | Dialog removed |
| `src/components/LLMConfigDialog/DestructiveConfirm.tsx` | Dialog removed |
| `src/api/llmConfig.ts` | No longer called from LightRAG WebUI |
| `src/lib/llmProviderPresets.ts` | Presets served by LightRAG backend; not needed in WebUI |

### 4.2 Frontend files to edit

**`src/features/SiteHeader.tsx`**
- Remove `import LLMConfigButton from '@/components/LLMConfigButton'`
- Remove `role` from `useAuthStore()` destructuring
- Remove `{role === 'platform_admin' && <LLMConfigButton />}` render line

**`src/stores/state.ts`**
- Remove `role` field from `AuthState` interface
- Remove `getRoleFromToken` helper function
- Remove `isGuestToken` helper function (no longer needed)
- Remove `role` from `initAuthState`, `login`, `logout`, and `useAuthStore` state

### 4.3 Backend files to edit

**`lightrag/api/lightrag_server.py` — `/sso-login` handler**

Revert role forwarding. Replace:
```python
clawith_role = payload.get("role") or "user"
lightrag_token = auth_handler.create_token(
    username=username,
    role=clawith_role,
    metadata={"sso": True, "clawith_user_id": user_id, "clawith_role": clawith_role},
)
```
With:
```python
lightrag_token = auth_handler.create_token(
    username=username,
    role="user",
    metadata={"sso": True, "clawith_user_id": user_id},
)
```

### 4.4 Backend files to keep unchanged

The entire LightRAG backend implementation for LLM config stays as-is:
- `lightrag/api/runtime_config.py`
- `lightrag/api/llm_config_apply.py`
- `lightrag/api/routers/llm_config_routes.py`

These are the execution layer. Only the UI entry point changed.

---

## 5. Data Flow

### 5.1 Tab load (GET)

1. `KbTab` mounts → `fetchKbJson('GET /llm-config')`
2. Response populates form; `api_key` fields show masked value (`sk-xx••••xx`)
3. `generation` stored for later POST
4. Network error → inline error banner: "无法连接到 LightRAG，请确认服务正在运行"

### 5.2 Save (POST)

```
POST /kb-api/llm-config
  { generation, force_clear: false, llm: {...}, embedding: {...}, rerank: {...} }
```

| Response | Handling |
|---|---|
| `200 {status: "applied"}` | Toast success, update `generation` |
| `200 {status: "restart_required"}` | Inline banner: "配置已保存，索引数据已清除。请重启 LightRAG 使新 Embedding 配置生效。" |
| `409 embedding_rebuild_requires_clear` | Show destructive confirm: list `will_clear` files, require typing `CLEAR`, re-submit with `force_clear: true` |
| `409 stale_config` | Auto re-GET, refresh `generation`, re-submit once |
| `403` | Toast error: "当前账号无管理员权限" |
| `5xx` | Toast error with `detail` message |

### 5.3 Secret re-use sentinel

When the user doesn't touch an `api_key` field, the masked value (`sk-xx••••xx`) is sent as-is. LightRAG's `unmask_or_keep` detects the sentinel and preserves the real key. No key leakage.

---

## 6. Auth Boundaries

| Layer | Mechanism |
|---|---|
| Tab visibility | Clawith frontend: tab button only rendered for `platform_admin` users |
| API execution | LightRAG `require_platform_admin`: validates Clawith JWT, checks `role == "platform_admin"` |

Frontend visibility is UX; backend check is the real security boundary.

---

## 7. Files Changed — Summary

**Create:** none

**Modify:**
- `Clawith/frontend/src/pages/EnterpriseSettings.tsx` — add `fetchKbJson`, `KbTab`, `'kb'` tab

**Delete (LightRAG WebUI):**
- `src/components/LLMConfigButton.tsx`
- `src/components/LLMConfigDialog/` (6 files)
- `src/api/llmConfig.ts`
- `src/lib/llmProviderPresets.ts`

**Modify (LightRAG WebUI):**
- `src/features/SiteHeader.tsx`
- `src/stores/state.ts`

**Modify (LightRAG backend):**
- `lightrag/api/lightrag_server.py` — `/sso-login` role revert

---

## 8. Out of Scope

- LightRAG backend test updates (existing tests for `llm_config_routes.py` still pass; SSO role test `test_sso_role_forwarding.py` will need updating — deferred to implementation plan)
- i18n for new Clawith tab (English strings inline for now, matching existing enterprise settings pattern)
- "Test connection" button for LightRAG providers (nice-to-have, v2)
