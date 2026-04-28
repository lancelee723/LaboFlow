# RAGFlow 替换 LightRAG 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (推荐) or `superpowers:executing-plans` 按任务逐步执行。所有步骤使用 `- [ ]` checkbox 跟踪。

**Goal:** 将 LaboFlow 的知识库子系统从 LightRAG 切换为 RAGFlow——保留 Clawith 的用户体系作为唯一身份源，通过 JWT SSO 直接登录 RAGFlow；同时把端口冲突、前端入口、设置面板、Docker / dev.sh 编排全部对齐到 RAGFlow。

**Architecture:**
- **身份方向**：Clawith 是 SSO 颁发方（已有 `JWT_SECRET_KEY`/HS256，payload `{sub, role, exp}`）。在 RAGFlow 增加一个 SSO 落地路由：解析 Clawith JWT → 通过 `email`(由 Clawith 后端补充到 JWT claim) 找/建 RAGFlow 用户 → 调用 `login_user()` 写入 quart 会话 + 返回 RAGFlow 自身的 access_token JWT。前端跳转：`http://<host>:8880/sso?token=<clawith_jwt>` → RAGFlow 完成会话后重定向到 `/`。
- **多租户处理**：**不**关闭 RAGFlow 的多租户系统（`tenant_id` 在 RAGFlow 数据模型与 SQL 过滤中是承载性结构，关闭代价远大于收益）。每个 Clawith 用户 → 一个 RAGFlow 用户 + 自动建一个同 ID 的 RAGFlow tenant（沿用 RAGFlow `user_register` 默认行为）。MVP 上等价于"无多租户感知"，后续若要跨用户共享数据集再做映射。
- **端口冲突**：将 RAGFlow nginx 容器主机映射 `SVR_WEB_HTTP_PORT` 由 `80` → `8880`（容器内仍 listen 80）。Sidebar 直接跳新主机端口，不再走 LaboFlow nginx 的 `/kb/` 反代（去掉 `/kb/`、`/kb-api/` 两段反代）。
- **删除范围**：移除 `LightRAG/` 目录、`Clawith/backend/app/services/lightrag_adapter.py`、`tool_seeder.py` 中的 `LIGHTRAG_TOOLS`、`agent_tools.py` 中的 `lightrag.*` dispatcher、前端 `KbTab`+`fetchKbJson`+i18n `kbConfig` 段+lightrag tool category 字符串。**保留**：`/api/enterprise/knowledge-base/*` (`enterprise_kb_router`) 与 `EnterpriseKBBrowser`——它是 Clawith 自身的租户文件箱，与 LightRAG 无关。
- **dev.sh 模式**：RAGFlow 依赖 MySQL/ES/Redis/MinIO 重栈，不做本地 venv hot-reload。`dev.sh` 调 `docker compose -f ragflow/docker/docker-compose.yml --profile elasticsearch,cpu up -d`，`stop.sh` 反向 down。

**Tech Stack:** Python (Flask/Quart), TypeScript/React 19, Vite, FastAPI (Clawith), Docker Compose, nginx, PyJWT (Clawith) + itsdangerous URLSafeTimedSerializer (RAGFlow)

---

## Files Overview

**新建：**
- `ragflow/api/apps/auth/clawith_sso.py` — Clawith JWT 解析 + SSO 落地路由
- `Clawith/backend/tests/test_lightrag_removal.py` — 回归测试（确认 lightrag 工具已移除、agent loop 不再分发）

**修改：**
- `ragflow/docker/.env` — `SVR_WEB_HTTP_PORT` 80 → 8880
- `ragflow/api/apps/__init__.py` — 在 `_load_user` 之外注册 SSO blueprint（`auth/clawith_sso.py` 已经走 `*_app.py` 自动 register，但放 auth/ 下需手动 import）
- `ragflow/api/apps/restful_apis/user_api.py` — 新增 `/v1/user/auth/sso/clawith`（POST）+ 响应里复用 `construct_response`
- `Clawith/backend/app/services/tool_seeder.py` — 删除 `LIGHTRAG_TOOLS` 列表（行 2341-2510）和 `*LIGHTRAG_TOOLS` 解构（行 2510 附近）
- `Clawith/backend/app/services/agent_tools.py` — 删除 `lightrag.*` dispatcher 块（行 3591-3632）
- `Clawith/backend/app/services/auth_provider.py` — 新增 `mint_sso_jwt(user, extra_claims={"email"})` 帮助函数（用于跳转 RAGFlow 时下发带 email claim 的短 JWT）
- `Clawith/backend/app/api/enterprise.py` — 新增 `GET /api/enterprise/ragflow/sso-token`（返回 5 分钟有效的 JWT，包 `email`）
- `Clawith/frontend/src/pages/Layout.tsx` — Sidebar 知识库链接由 `/kb/?sso_token=...` → `${ragflowUrl}/sso?token=<sso_token>`，token 走新接口或本地缓存
- `Clawith/frontend/src/pages/EnterpriseSettings.tsx` — 删除 `KbTab` 函数、`fetchKbJson`、`kb` tab 入口、`activeTab === 'kb'` 渲染分支、lightrag tool category 字符串
- `Clawith/frontend/src/i18n/en.json` — 删除 `enterprise.kbConfig`、`enterprise.tabs.kb`、`agent.toolCategories.lightrag/rag/graph`，新增 `nav.knowledgeBase` 注释（链接外跳）
- `Clawith/frontend/src/i18n/zh.json` — 同上
- `docker-compose.yml` — 删除 `lightrag` 服务 + `rag_storage`/`lightrag_inputs` 卷 + nginx `depends_on` 条目；引入 `include: ./ragflow/docker/docker-compose.yml` 或顶层重声明
- `nginx.conf` — 删除 `/kb/`、`/kb-api/`、`upstream lightrag`、`location = /kb` 重定向块
- `.env.example` / `.env` — 移除 `LIGHTRAG_*` 段（行 19-36），新增 `RAGFLOW_PORT=8880`、`RAGFLOW_HOST=localhost`、`RAGFLOW_BASE_URL`
- `dev.sh` — 删除"3. LightRAG"段、`LIGHTRAG_PORT`、`wait_port` 调用；新增 RAGFlow docker compose 启停；更新 summary URL
- `stop.sh` — 删 `LIGHTRAG_PORT`；新增 `docker compose -f ragflow/docker/docker-compose.yml down`
- `setup-all.sh` — 删除"[4/5] LightRAG"段；改为 docker compose 可用性检查 + RAGFlow 镜像 pull 提示

**删除：**
- `Clawith/backend/app/services/lightrag_adapter.py`（整个文件）
- `LightRAG/`（整个目录）
- `Clawith/frontend/src/i18n/{en,zh}.json` 中的 `enterprise.kbConfig.*` 全部子键

---

## Pre-Flight

### Task 0: 准备工作树与基线

**Files:**
- 无文件创建/修改，仅 git 操作

- [ ] **Step 0.1: 用 worktree 隔离开发**

执行：
```bash
cd /Users/lance/LaboFlow
git worktree add -b ragflow-replace-lightrag .worktrees/ragflow-replace-lightrag
cd .worktrees/ragflow-replace-lightrag
```
预期：worktree 在 `.worktrees/ragflow-replace-lightrag/`，分支 `ragflow-replace-lightrag` 创建并 checkout。

- [ ] **Step 0.2: 验证基线 dev.sh 可启动 LightRAG（之后做对照）**

执行：
```bash
./setup-all.sh && ./dev.sh
```
预期：`http://localhost:3008/kb/` 能打开 LightRAG WebUI（确认基线正常，便于对照新栈）。验证后 `./stop.sh`。

- [ ] **Step 0.3: 记录 RAGFlow 镜像 tag 与启动 profile**

执行：
```bash
grep -n "^RAGFLOW_IMAGE\|^DOC_ENGINE\|^DEVICE\|^COMPOSE_PROFILES" ragflow/docker/.env
```
预期：识别 `RAGFLOW_IMAGE`（应为类似 `infiniflow/ragflow:nightly` 之类）、`DOC_ENGINE=elasticsearch`、`DEVICE=cpu`、`COMPOSE_PROFILES=elasticsearch,cpu`。记录这些值，后续 dev.sh 启动用同样的 profile。

---

## Phase 1 — RAGFlow 改造（端口 + SSO）

### Task 1: 切换 RAGFlow 主机端口 80 → 8880

**Files:**
- Modify: `ragflow/docker/.env`

- [ ] **Step 1.1: 修改 SVR_WEB_HTTP_PORT**

文件 `ragflow/docker/.env` 找到：
```
SVR_WEB_HTTP_PORT=80
```
替换为：
```
SVR_WEB_HTTP_PORT=8880
```

- [ ] **Step 1.2: 验证仅这一处生效**

执行：
```bash
grep -rn "SVR_WEB_HTTP_PORT\|:80\b" ragflow/docker/docker-compose.yml ragflow/docker/docker-compose-base.yml
```
预期：`docker-compose.yml` 中 `${SVR_WEB_HTTP_PORT}:80` 形式（容器端口仍 80，主机端口取自 env）。无须改 compose。

- [ ] **Step 1.3: 提交**

```bash
git add ragflow/docker/.env
git commit -m "feat(ragflow): change host nginx port 80 -> 8880 to free LaboFlow nginx"
```

---

### Task 2: RAGFlow 端 Clawith JWT SSO 落地路由

**Files:**
- Create: `ragflow/api/apps/auth/clawith_sso.py`
- Modify: `ragflow/api/apps/__init__.py:285` 附近（注册 blueprint，如果 `auth/` 不在自动扫描路径）
- Modify: `ragflow/api/apps/restful_apis/user_api.py`（新增一个 `/auth/sso/clawith` 路由）

> **设计决策**：放在 `restful_apis/user_api.py` 比新建 `auth/clawith_sso.py` 更省事——`restful_apis/*.py` 通过 `register_page` 自动挂到 `/api/v1/*`，不需手动注册。下面就用这个方案，把 auth 文件留作占位思路（**不创建** clawith_sso.py，方案落到 user_api.py 中）。修订 Files 清单：

**Files (修订):**
- Modify: `ragflow/api/apps/restful_apis/user_api.py` — 新增 SSO 路由
- Modify: `ragflow/conf/service_conf.yaml.template` — 新增 `clawith_jwt_secret` 配置项（环境变量读取）

- [ ] **Step 2.1: 写测试（先红）**

新建 `ragflow/test/test_clawith_sso.py`：
```python
import jwt
import pytest
from datetime import datetime, timedelta, timezone


SHARED_SECRET = "test-shared-secret-32chars-XXXXXXXXXX"


def make_clawith_jwt(email: str = "test@example.com", user_id: str = "u-1", role: str = "user"):
    payload = {
        "sub": user_id,
        "role": role,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    }
    return jwt.encode(payload, SHARED_SECRET, algorithm="HS256")


@pytest.mark.asyncio
async def test_sso_login_creates_user_when_missing(client, monkeypatch):
    monkeypatch.setenv("CLAWITH_JWT_SECRET_KEY", SHARED_SECRET)
    token = make_clawith_jwt(email="newuser@example.com")
    resp = await client.post("/v1/user/auth/sso/clawith", json={"token": token})
    assert resp.status_code == 200
    body = await resp.get_json()
    assert body["code"] == 0
    assert body["data"]["email"] == "newuser@example.com"
    assert "auth" in body or resp.headers.get("Authorization")  # construct_response 把 token 放 Authorization 头


@pytest.mark.asyncio
async def test_sso_login_existing_user_reuses_record(client, monkeypatch):
    monkeypatch.setenv("CLAWITH_JWT_SECRET_KEY", SHARED_SECRET)
    token = make_clawith_jwt(email="existing@example.com")
    r1 = await client.post("/v1/user/auth/sso/clawith", json={"token": token})
    r2 = await client.post("/v1/user/auth/sso/clawith", json={"token": token})
    body1 = await r1.get_json()
    body2 = await r2.get_json()
    assert body1["data"]["id"] == body2["data"]["id"]


@pytest.mark.asyncio
async def test_sso_login_rejects_bad_signature(client, monkeypatch):
    monkeypatch.setenv("CLAWITH_JWT_SECRET_KEY", SHARED_SECRET)
    bad = jwt.encode({"sub": "u-1", "email": "a@b.com",
                      "exp": datetime.now(timezone.utc) + timedelta(minutes=5)},
                     "wrong-secret", algorithm="HS256")
    resp = await client.post("/v1/user/auth/sso/clawith", json={"token": bad})
    body = await resp.get_json()
    assert body["code"] != 0
    assert "signature" in body["message"].lower() or "invalid" in body["message"].lower()


@pytest.mark.asyncio
async def test_sso_login_rejects_expired(client, monkeypatch):
    monkeypatch.setenv("CLAWITH_JWT_SECRET_KEY", SHARED_SECRET)
    expired = jwt.encode({"sub": "u-1", "email": "a@b.com",
                          "exp": datetime.now(timezone.utc) - timedelta(seconds=1)},
                         SHARED_SECRET, algorithm="HS256")
    resp = await client.post("/v1/user/auth/sso/clawith", json={"token": expired})
    body = await resp.get_json()
    assert body["code"] != 0


@pytest.mark.asyncio
async def test_sso_login_rejects_missing_email(client, monkeypatch):
    monkeypatch.setenv("CLAWITH_JWT_SECRET_KEY", SHARED_SECRET)
    no_email = jwt.encode({"sub": "u-1",
                           "exp": datetime.now(timezone.utc) + timedelta(minutes=5)},
                          SHARED_SECRET, algorithm="HS256")
    resp = await client.post("/v1/user/auth/sso/clawith", json={"token": no_email})
    body = await resp.get_json()
    assert body["code"] != 0
```

- [ ] **Step 2.2: 运行测试，确认失败**

```bash
cd ragflow && uv run pytest test/test_clawith_sso.py -v
```
预期：FAIL（路由不存在）。

- [ ] **Step 2.3: 实现 SSO 路由**

打开 `ragflow/api/apps/restful_apis/user_api.py`，在 `oauth_callback` 函数之后（约行 270 附近，紧贴 `@manager.route("/auth/login/<channel>", ...)` 系列之后）插入：

```python
import os
import jwt as pyjwt  # 显式区分 itsdangerous JWT 与 PyJWT
from datetime import datetime, timezone


@manager.route("/auth/sso/clawith", methods=["POST"])  # noqa: F821
async def clawith_sso_login():
    """
    Accept a Clawith-minted HS256 JWT, validate against shared secret,
    map email -> RAGFlow user (auto-register on first login),
    return a RAGFlow login session + access_token JWT in Authorization header.

    Expected request body: {"token": "<clawith_jwt>"}
    JWT must contain: sub, email, exp.  Optional: role.
    """
    json_body = await request.get_json()
    token_str = (json_body or {}).get("token")
    if not token_str:
        return get_json_result(data=False, code=RetCode.ARGUMENT_ERROR, message="token is required")

    shared_secret = os.getenv("CLAWITH_JWT_SECRET_KEY", "")
    if not shared_secret:
        logging.error("CLAWITH_JWT_SECRET_KEY not configured")
        return get_json_result(data=False, code=RetCode.SERVER_ERROR, message="SSO not configured")

    try:
        payload = pyjwt.decode(token_str, shared_secret, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        return get_json_result(data=False, code=RetCode.AUTHENTICATION_ERROR, message="Token expired")
    except pyjwt.InvalidSignatureError:
        return get_json_result(data=False, code=RetCode.AUTHENTICATION_ERROR, message="Invalid signature")
    except pyjwt.InvalidTokenError as e:
        return get_json_result(data=False, code=RetCode.AUTHENTICATION_ERROR, message=f"Invalid token: {e}")

    email = payload.get("email")
    if not email:
        return get_json_result(data=False, code=RetCode.ARGUMENT_ERROR, message="email claim required")

    users = UserService.query(email=email)
    if not users:
        # Auto-register; reuse oauth_callback's user_register pattern
        new_user_id = get_uuid()
        users = user_register(
            new_user_id,
            {
                "access_token": get_uuid(),
                "email": email,
                "nickname": payload.get("sub", email.split("@")[0]),
                "avatar": "",
                "login_channel": "clawith_sso",
                "last_login_time": get_format_time(),
                "is_superuser": False,
            },
        )
        if not users:
            return get_json_result(data=False, code=RetCode.SERVER_ERROR, message="Failed to provision user")

    user = users[0]
    if hasattr(user, "is_active") and user.is_active == "0":
        return get_json_result(data=False, code=RetCode.FORBIDDEN, message="Account disabled")

    # Mint a fresh access_token (matches /auth/login behavior) and persist
    user.access_token = get_uuid()
    login_user(user)
    user.update_time = current_timestamp()
    user.update_date = datetime_format(datetime.now())
    user.save()

    response_data = user.to_json()
    return await construct_response(data=response_data, auth=user.get_id(), message="SSO login OK")
```

- [ ] **Step 2.4: 验证测试通过**

```bash
cd ragflow && uv run pytest test/test_clawith_sso.py -v
```
预期：5 个用例全 PASS。

- [ ] **Step 2.5: 在 RAGFlow service_conf 模板里登记环境变量**

`ragflow/docker/service_conf.yaml.template` 在 `oauth:` 段或文件末尾追加注释引导：
```yaml
# Clawith SSO (LaboFlow integration). Shared HS256 secret with Clawith backend.
clawith_sso:
  enabled: ${CLAWITH_SSO_ENABLED:-true}
  jwt_secret: ${CLAWITH_JWT_SECRET_KEY:-}
```
（实际读取仍走 `os.getenv("CLAWITH_JWT_SECRET_KEY")`，写在配置只做文档化）

`ragflow/docker/.env` 末尾追加：
```bash
# ─── Clawith SSO ─────────────────────────────────────
# Shared with LaboFlow top-level .env JWT_SECRET_KEY
CLAWITH_JWT_SECRET_KEY=${CLAWITH_JWT_SECRET_KEY:-}
CLAWITH_SSO_ENABLED=${CLAWITH_SSO_ENABLED:-true}
```

并在 `ragflow/docker/docker-compose.yml` ragflow-cpu 服务中确保 `env_file: .env` 已存在（默认已是），无需改动。

- [ ] **Step 2.6: 提交**

```bash
git add ragflow/api/apps/restful_apis/user_api.py ragflow/test/test_clawith_sso.py \
        ragflow/docker/service_conf.yaml.template ragflow/docker/.env
git commit -m "feat(ragflow): add /v1/user/auth/sso/clawith endpoint for Clawith JWT SSO"
```

---

### Task 3: RAGFlow 前端 SSO 落地中转页

**Files:**
- Create: `ragflow/web/src/pages/sso/index.tsx`
- Modify: `ragflow/web/src/routes.ts`（或等价路由声明文件，按 RAGFlow 实际框架）

> **背景**：RAGFlow 前端是 Vite + React。需要一个 `/sso?token=<jwt>` 路由：从 query 取 token → POST `/v1/user/auth/sso/clawith` → 把后端返回的 access_token 写入 `localStorage` 的相同 key（RAGFlow 用 `Authorization` cookie/header）→ 跳转 `/`。

- [ ] **Step 3.1: 找 RAGFlow 前端登录后 token 存储位置**

```bash
grep -rn "localStorage.setItem\|access_token\|Authorization" ragflow/web/src --include="*.ts" --include="*.tsx" | grep -i "login\|auth\|token" | head -20
```
预期：定位到 RAGFlow 前端的 token 持久化点（如 `web/src/utils/authorization-util.ts` 中 `Authorization` cookie 或 localStorage key）。**记录该 key 名称**。

- [ ] **Step 3.2: 写 SSO 中转页**

新建 `ragflow/web/src/pages/sso/index.tsx`：
```tsx
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'umi';   // RAGFlow 用 umi（如果不是请改 import）

const ClawithSSOLanding = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      navigate('/login?error=missing_sso_token');
      return;
    }
    (async () => {
      const res = await fetch('/v1/user/auth/sso/clawith', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const auth = res.headers.get('Authorization');
      if (auth) {
        // RAGFlow 通常用 Cookie+Authorization 双写, 这里用 RAGFlow 自身的 auth util
        // (实际 key 来自 Step 3.1, 替换 SET_AUTH_KEY)
        const { default: authUtil } = await import('@/utils/authorization-util');
        authUtil.setAuthorization(auth);
      }
      navigate('/');
    })().catch((e) => {
      navigate(`/login?error=sso_failed&detail=${encodeURIComponent(String(e))}`);
    });
  }, [params, navigate]);

  return <div style={{padding:'40px',textAlign:'center'}}>Signing you in via Clawith…</div>;
};

export default ClawithSSOLanding;
```

> 实际 import `authUtil` 路径在 Step 3.1 锁定后填回。

- [ ] **Step 3.3: 在路由表注册 `/sso`**

按 Step 3.1 找到的路由声明文件（umi 通常是 `web/.umirc.ts` 或 `web/config/routes.ts`），新增条目：
```ts
{ path: '/sso', component: '@/pages/sso/index' },
```

- [ ] **Step 3.4: 重新构建 RAGFlow 镜像（或 web/dist）**

```bash
cd ragflow/web
npm install
npm run build   # 产物到 ragflow/web/dist, 容器内 nginx 会读它
cd ../..
```

- [ ] **Step 3.5: 容器内验证**

```bash
cd ragflow/docker
docker compose --profile elasticsearch,cpu up -d
sleep 30
curl -s -o /dev/null -w "%{http_code}" "http://localhost:8880/sso?token=fake"
```
预期：返回 200（SPA 入口），浏览器侧打开会触发 SSO 落地（fake token 应被服务端 401，然后页面 navigate 回 `/login?error=...`）。

- [ ] **Step 3.6: 提交**

```bash
git add ragflow/web
git commit -m "feat(ragflow-web): add /sso landing page for Clawith JWT SSO"
```

---

## Phase 2 — Clawith 后端：移除 LightRAG + 增加 SSO Token 接口

### Task 4: Clawith 后端去 LightRAG (services 层)

**Files:**
- Delete: `Clawith/backend/app/services/lightrag_adapter.py`
- Modify: `Clawith/backend/app/services/tool_seeder.py`
- Modify: `Clawith/backend/app/services/agent_tools.py`

- [ ] **Step 4.1: 写回归测试（先红）**

新建 `Clawith/backend/tests/test_lightrag_removal.py`：
```python
import importlib
import pytest


def test_lightrag_adapter_module_gone():
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("app.services.lightrag_adapter")


def test_tool_seeder_has_no_lightrag_tools():
    from app.services import tool_seeder
    assert not any(t["name"].startswith("lightrag.") for t in tool_seeder.BUILTIN_TOOLS)
    assert not hasattr(tool_seeder, "LIGHTRAG_TOOLS")


def test_agent_tools_does_not_dispatch_lightrag():
    from app.services import agent_tools
    src = open(agent_tools.__file__).read()
    assert "lightrag." not in src.lower(), "agent_tools.py still references lightrag"
```

- [ ] **Step 4.2: 运行测试，确认失败**

```bash
cd Clawith/backend && .venv/bin/pytest tests/test_lightrag_removal.py -v
```
预期：3 个用例全 FAIL。

- [ ] **Step 4.3: 删除 lightrag_adapter.py**

```bash
git rm Clawith/backend/app/services/lightrag_adapter.py
```

- [ ] **Step 4.4: 删除 tool_seeder.py 中的 LIGHTRAG_TOOLS**

打开 `Clawith/backend/app/services/tool_seeder.py`：
- 删除从 `# LightRAG native tool declarations` 注释（约行 2341）到 `LIGHTRAG_TOOLS = [` 列表收尾的 `]` 整段
- 在 `BUILTIN_TOOLS = [` 大列表中，删除 `# ── LightRAG native tools ──` 注释行 + `*LIGHTRAG_TOOLS,` 解构行（约行 2509-2510）

用 grep 确认无残留：
```bash
grep -n "lightrag\|LightRAG\|LIGHTRAG" Clawith/backend/app/services/tool_seeder.py
```
预期：无输出。

- [ ] **Step 4.5: 删除 agent_tools.py 中的 lightrag dispatcher**

打开 `Clawith/backend/app/services/agent_tools.py`，删除从行 3591（注释 `# ── LightRAG native tool support`）到 3632（`return f"❌ LightRAG tool execution error..."` 后的 except 块结尾）整段（约 42 行）。

用 grep 确认：
```bash
grep -n "lightrag\|LightRAG" Clawith/backend/app/services/agent_tools.py
```
预期：无输出。

- [ ] **Step 4.6: 运行测试，确认通过**

```bash
cd Clawith/backend && .venv/bin/pytest tests/test_lightrag_removal.py -v
```
预期：3 PASS。同时跑现有冒烟测试：
```bash
.venv/bin/pytest tests/ -x -k "not test_lightrag_removal" --co -q | head -30
```
确保 import 不报错（如 `tool_seeder` import 仍 OK）。

- [ ] **Step 4.7: 提交**

```bash
git add -A Clawith/backend/app/services Clawith/backend/tests/test_lightrag_removal.py
git commit -m "refactor(clawith-be): remove LightRAG adapter, tools, and agent dispatcher"
```

---

### Task 5: Clawith 后端：新增 RAGFlow SSO Token 接口

**Files:**
- Modify: `Clawith/backend/app/core/security.py` — 新增 `create_sso_token(user, audience: str, extra_claims: dict)` 函数
- Modify: `Clawith/backend/app/api/enterprise.py` — 新增 `GET /api/enterprise/ragflow/sso-token`

- [ ] **Step 5.1: 写测试（先红）**

新建 `Clawith/backend/tests/test_ragflow_sso_token.py`：
```python
import pytest
import jwt
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_get_ragflow_sso_token_includes_email_and_short_exp(client: AsyncClient, auth_headers, current_user):
    resp = await client.get("/api/enterprise/ragflow/sso-token", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()
    token = body["token"]
    decoded = jwt.decode(token, options={"verify_signature": False})
    assert decoded["email"] == current_user.email
    assert decoded["sub"] == str(current_user.id)
    # 5 分钟内
    import time
    assert decoded["exp"] - time.time() <= 5 * 60 + 5
    assert decoded["aud"] == "ragflow"


@pytest.mark.asyncio
async def test_sso_token_requires_auth(client: AsyncClient):
    resp = await client.get("/api/enterprise/ragflow/sso-token")
    assert resp.status_code == 401
```

- [ ] **Step 5.2: 运行测试，确认失败**

```bash
cd Clawith/backend && .venv/bin/pytest tests/test_ragflow_sso_token.py -v
```
预期：FAIL（404）。

- [ ] **Step 5.3: 实现 create_sso_token**

打开 `Clawith/backend/app/core/security.py`，在 `create_access_token` 之后新增：
```python
def create_sso_token(user_id: str, email: str, audience: str, role: str = "user",
                     ttl_minutes: int = 5) -> str:
    """Mint a short-lived JWT for cross-system SSO (e.g. RAGFlow).

    Includes `email` and `aud` claims that the receiving service uses to
    locate or auto-provision a user.  TTL deliberately short — token is
    consumed immediately on landing.
    """
    expire = datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes)
    to_encode = {
        "sub": user_id,
        "email": email,
        "role": role,
        "aud": audience,
        "exp": expire,
    }
    return jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
```

- [ ] **Step 5.4: 实现 enterprise.py 路由**

打开 `Clawith/backend/app/api/enterprise.py`，在文件末尾或与其他 enterprise 路由相邻处新增：
```python
from app.core.security import create_sso_token, get_current_user
from app.models.user import User
from fastapi import Depends


@router.get("/enterprise/ragflow/sso-token")
async def get_ragflow_sso_token(
    current_user: User = Depends(get_current_user),
):
    """Mint a short-lived JWT for the user to land on RAGFlow's /sso route."""
    token = create_sso_token(
        user_id=str(current_user.id),
        email=current_user.email,
        audience="ragflow",
        role=current_user.role,
        ttl_minutes=5,
    )
    return {"token": token}
```

> 注：路由前缀是否已有 `/enterprise/` 决定。检查 `enterprise.py` 顶部 `router = APIRouter(prefix=...)`，按实际调整 path。

- [ ] **Step 5.5: 运行测试通过**

```bash
.venv/bin/pytest tests/test_ragflow_sso_token.py -v
```
预期：2 PASS。

- [ ] **Step 5.6: 提交**

```bash
git add Clawith/backend/app/core/security.py Clawith/backend/app/api/enterprise.py \
        Clawith/backend/tests/test_ragflow_sso_token.py
git commit -m "feat(clawith-be): add /enterprise/ragflow/sso-token short-lived JWT minter"
```

---

## Phase 3 — Clawith 前端：去 LightRAG + Sidebar 跳 RAGFlow

### Task 6: Sidebar 知识库链接跳 RAGFlow

**Files:**
- Modify: `Clawith/frontend/src/pages/Layout.tsx`
- Modify: `Clawith/frontend/src/services/api.ts` — 新增 `getRagflowSsoToken()`

- [ ] **Step 6.1: api.ts 新增方法**

打开 `Clawith/frontend/src/services/api.ts`，在 `enterpriseApi` 对象内（与 `kbFiles` 等同级处）新增：
```ts
ragflowSsoToken: () =>
    fetchJson<{token: string}>('/enterprise/ragflow/sso-token'),
```

- [ ] **Step 6.2: Layout.tsx 替换知识库链接为 onClick**

打开 `Clawith/frontend/src/pages/Layout.tsx`，定位行 564-575 的 `<a href={`/kb/?sso_token=${...}`}>` 块，整段替换为：
```tsx
<button
    type="button"
    className="sidebar-item"
    onClick={async () => {
        try {
            const { token } = await enterpriseApi.ragflowSsoToken();
            const ragflowBase = (import.meta as any).env.VITE_RAGFLOW_URL || 'http://localhost:8880';
            window.open(`${ragflowBase}/sso?token=${encodeURIComponent(token)}`, '_blank', 'noopener');
        } catch (e) {
            console.error('Failed to open knowledge base:', e);
        }
    }}
    style={{ background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', width: '100%' }}
>
    <span className="sidebar-item-icon" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <IconBook2 size={14} stroke={1.5} />
    </span>
    <span className="sidebar-item-text">{t('nav.knowledgeBase', 'Knowledge Base')}</span>
    <IconArrowUpRight size={10} stroke={1.5} style={{ marginLeft: 'auto', opacity: 0.4 }} />
</button>
```

并确保顶部 import 中已包含 `enterpriseApi`（如缺失：`import { enterpriseApi } from '../services/api';`）。

- [ ] **Step 6.3: 在 frontend 里加环境变量**

打开 `Clawith/frontend/.env.example`（如不存在则创建）写入：
```bash
VITE_RAGFLOW_URL=http://localhost:8880
```

`Clawith/frontend/.env`（如存在）同步写入。

- [ ] **Step 6.4: 启动 Clawith frontend dev 验证**

```bash
cd Clawith/frontend && pnpm dev
```
打开 `http://localhost:3080`，登录后点击侧栏 Knowledge Base，应弹新标签页跳到 `http://localhost:8880/sso?token=...`。RAGFlow 此时未启动也没关系——验证 Clawith 侧拼链接正确即可。

- [ ] **Step 6.5: 提交**

```bash
git add Clawith/frontend/src/pages/Layout.tsx Clawith/frontend/src/services/api.ts \
        Clawith/frontend/.env.example
git commit -m "feat(clawith-fe): sidebar Knowledge Base now opens RAGFlow via SSO token"
```

---

### Task 7: 删除 EnterpriseSettings 中的 KbTab（LightRAG LLM 配置面板）

**Files:**
- Modify: `Clawith/frontend/src/pages/EnterpriseSettings.tsx`
- Modify: `Clawith/frontend/src/i18n/en.json`
- Modify: `Clawith/frontend/src/i18n/zh.json`

> **重要**：本任务**只删** `kb` 设置选项卡（LightRAG LLM 配置）。`EnterpriseInfoTab` 内的 `EnterpriseKBBrowser` (`/api/enterprise/knowledge-base/*` 文件箱) **保留** —— 它是 Clawith 自身的租户文件存储，不属于 LightRAG。
>
> 如果用户后续确认要一并删除"公司信息文件箱"，单开 follow-up plan，**勿在本任务扩大范围**。

- [ ] **Step 7.1: 删除 KbTab 函数与 fetchKbJson**

打开 `EnterpriseSettings.tsx`：
1. 删除 `fetchKbJson` 函数（行 38-57）
2. 删除从 `// ─── Knowledge Base (LightRAG) LLM Config Tab ───` 注释到 `KbTab` 函数体结尾的整段（约 1776-1808 注释 + 1809-末尾函数体；通过结构性大括号匹配定位结束）
3. 删除相关接口类型 `KbProviders`、`KbLlmSection`、`KbEmbeddingSection`、`KbRerankSection`、`KbConfigOut`、`EMBEDDING_REBUILD_FIELDS`、`isEmbeddingDestructive`（紧邻 KbTab 上方约 1776-1807）
4. 在主组件中：
   - 删除行 2575-2579 `{user?.role === 'platform_admin' && (` 渲染 `kb` tab 的整块
   - 删除行 3995-3996 `{/* ── Knowledge Base (LightRAG) Tab ── */}` + `{activeTab === 'kb' && <KbTab />}`
   - 在 lightrag tool category mapping 中删除 `lightrag/rag/graph` 三行（约 2394-2396 + 2410 的判断 `if (tool?.name?.startsWith('lightrag.'))`）

用 grep 确认：
```bash
grep -n "lightrag\|LightRAG\|fetchKbJson\|KbTab\|KbProviders\|KbLlmSection\|KbEmbeddingSection\|KbRerankSection" Clawith/frontend/src/pages/EnterpriseSettings.tsx
```
预期：仅剩 `kbAdapter`、`enterpriseApi.kb*`（`EnterpriseKBBrowser`相关）等保留项，**无**任何 lightrag/Lightrag/LightRAG/KbTab。

- [ ] **Step 7.2: 删除 i18n kbConfig 段**

`Clawith/frontend/src/i18n/en.json`：
- 删除 `enterprise.kbConfig` 整个对象（行 ~958 起的 `"kbConfig": { ... }`）
- 删除 `enterprise.tabs.kb` 条目
- 删除 `agent.toolCategories.lightrag/rag/graph` 三个条目（如存在）
- **保留** `nav.knowledgeBase`（仍是 Sidebar 显示文案）
- **保留** `enterprise.kb.title` / `enterprise.kb.description`（属于 EnterpriseKBBrowser，未删）

`Clawith/frontend/src/i18n/zh.json`：同上。

- [ ] **Step 7.3: 类型检查**

```bash
cd Clawith/frontend && pnpm tsc --noEmit
```
预期：0 errors。如有 unused import 报错（如 `IconBook2` 等）按提示清理。

- [ ] **Step 7.4: 浏览器手测（启动 dev）**

```bash
cd Clawith/frontend && pnpm dev
```
登录 platform_admin → 进入 `/enterprise` → 顶部 tab 列表里**不应该**再看到"知识库"tab。Info tab 里的"Company Knowledge Base"文件浏览器依然存在。

- [ ] **Step 7.5: 提交**

```bash
git add Clawith/frontend/src/pages/EnterpriseSettings.tsx Clawith/frontend/src/i18n/en.json Clawith/frontend/src/i18n/zh.json
git commit -m "refactor(clawith-fe): drop LightRAG KB tab from EnterpriseSettings"
```

---

## Phase 4 — 编排：Docker / nginx / dev.sh / setup-all.sh / .env

### Task 8: docker-compose.yml — 移除 lightrag，编排 RAGFlow

**Files:**
- Modify: `docker-compose.yml`
- Create: `docker-compose.override.yml`（仅当需保留单一入口时；本计划用顶层文件直接整合）

> **设计**：RAGFlow 自带完整 docker-compose（带 mysql/es/redis/minio/ragflow-server/nginx），强行合并到顶层 `docker-compose.yml` 会爆炸式增加耦合。**做法**：顶层 `docker-compose.yml` 只删除 `lightrag` 服务；RAGFlow 仍由 `ragflow/docker/docker-compose.yml` 独立管理。`dev.sh`/`stop.sh` 分别对两个文件 up/down。

- [ ] **Step 8.1: 修改 docker-compose.yml**

打开 `docker-compose.yml`：
1. 删除 `lightrag:` 服务（行 64-85）
2. 删除 `volumes:` 段中的 `rag_storage:` 和 `lightrag_inputs:`（行 110-111）
3. 在 `nginx:` 服务的 `depends_on` 列表中删除 `- lightrag`
4. （不增加 ragflow 服务 — 由 ragflow/docker/docker-compose.yml 独立管理）

确认：
```bash
grep -n "lightrag\|LightRAG\|LIGHTRAG\|rag_storage" docker-compose.yml
```
预期：无输出。

- [ ] **Step 8.2: 验证 yaml 语法**

```bash
docker compose config -q
```
预期：无报错。

- [ ] **Step 8.3: 提交**

```bash
git add docker-compose.yml
git commit -m "refactor(compose): remove lightrag service; ragflow lives in own compose"
```

---

### Task 9: nginx.conf — 删除 /kb/ /kb-api/ 反代

**Files:**
- Modify: `nginx.conf`

- [ ] **Step 9.1: 删除 LightRAG 反代块**

打开 `nginx.conf`：
1. 删除 `upstream lightrag { server 127.0.0.1:9621; }`（行 48）
2. 删除 `# ── LightRAG API` 段：从 `location /kb-api/ {` 到 `}` （含注释，行 77-95）
3. 删除 `# ── LightRAG WebUI assets` 段：从 `location /kb/ {` 到 `}`（行 97-112）
4. 删除 `location = /kb { return 301 /kb/; }`（行 113-115）
5. 更新顶部注释把 `/kb/` 那行删掉

确认：
```bash
grep -n "lightrag\|kb-api\|/kb/" nginx.conf
```
预期：无输出。

- [ ] **Step 9.2: 测试 nginx 配置语法**

```bash
nginx -t -p $PWD -c $PWD/nginx.conf 2>&1 | tee /tmp/nginx-test.log
```
预期：`syntax is ok`。

- [ ] **Step 9.3: 提交**

```bash
git add nginx.conf
git commit -m "refactor(nginx): drop /kb/ and /kb-api/ proxy blocks (RAGFlow on host:8880)"
```

---

### Task 10: dev.sh / stop.sh — 替换 LightRAG 启停为 RAGFlow docker compose

**Files:**
- Modify: `dev.sh`
- Modify: `stop.sh`

- [ ] **Step 10.1: dev.sh 修改**

打开 `dev.sh`：

1. **顶部注释**（行 6-10）：将 `3. LightRAG server` 行改为 `3. RAGFlow docker stack (mysql/es/redis/minio/ragflow-server, host:8880)`
2. 删除 `: "${LIGHTRAG_PORT:=9621}"`（行 90），新增 `: "${RAGFLOW_PORT:=8880}"`
3. 在"Pre-flight cleanup"循环（行 127）的端口列表中：把 `$LIGHTRAG_PORT` 替换成 `$RAGFLOW_PORT`
4. 删除 `# ── 3. LightRAG ──` 整段（行 162-184）
5. 在原位置新增 RAGFlow 启动段：
   ```bash
   # ── 3. RAGFlow ───────────────────────────────────────────────
   log "Starting RAGFlow docker stack (host port :$RAGFLOW_PORT) ..."
   if ! command -v docker &>/dev/null; then
       err "docker not found. Install Docker Desktop or 'apt install docker-ce' first."
       err "Skipping RAGFlow; other services will continue."
   else
       (
           cd "$ROOT/ragflow/docker" \
           && CLAWITH_JWT_SECRET_KEY="$JWT_SECRET_KEY" \
              SVR_WEB_HTTP_PORT="$RAGFLOW_PORT" \
              docker compose --profile elasticsearch,cpu up -d
       ) > "$LOG_DIR/ragflow.log" 2>&1 \
           && ok "RAGFlow stack starting (logs: $LOG_DIR/ragflow.log)" \
           || err "RAGFlow docker compose up failed. See $LOG_DIR/ragflow.log"
   fi
   # NOTE: PID file not used — docker manages container lifecycle.
   ```
6. 在 `wait_port` 调用段（行 207-212）：删 `wait_port "$LIGHTRAG_PORT" ...`，新增 `wait_port "$RAGFLOW_PORT" "RAGFlow" 90 || true`（RAGFlow 冷启动慢，给 90s）。
7. 在 summary 段（行 230-247）：把 `Knowledge Base: http://localhost:$NGINX_PORT/kb/` 改为 `Knowledge Base: http://localhost:$RAGFLOW_PORT (or via Sidebar SSO)`；把 `LightRAG http://localhost:$LIGHTRAG_PORT` 改为 `RAGFlow http://localhost:$RAGFLOW_PORT`。

确认：
```bash
grep -n "LIGHTRAG\|lightrag\|LightRAG" dev.sh
```
预期：无输出。

- [ ] **Step 10.2: stop.sh 修改**

打开 `stop.sh`：
1. 把 `: "${LIGHTRAG_PORT:=9621}"` → `: "${RAGFLOW_PORT:=8880}"`
2. 在端口扫描循环中把 `$LIGHTRAG_PORT` 替换成 `$RAGFLOW_PORT`
3. 在 nginx 停止之后、PID 循环之前新增 RAGFlow 停止：
   ```bash
   # Stop RAGFlow docker stack
   if command -v docker &>/dev/null && [ -f "$ROOT/ragflow/docker/docker-compose.yml" ]; then
       ( cd "$ROOT/ragflow/docker" && docker compose --profile elasticsearch,cpu down 2>/dev/null ) || true
       echo -e "  ${GREEN}✓${NC} RAGFlow stack stopped"
   fi
   ```

- [ ] **Step 10.3: 验证 shell 语法**

```bash
bash -n dev.sh && bash -n stop.sh
```
预期：无输出（语法 OK）。

- [ ] **Step 10.4: 提交**

```bash
git add dev.sh stop.sh
git commit -m "feat(devsh): replace LightRAG launcher with RAGFlow docker compose orchestration"
```

---

### Task 11: setup-all.sh — 移除 LightRAG 步骤

**Files:**
- Modify: `setup-all.sh`

- [ ] **Step 11.1: 删除 LightRAG 段，改为 RAGFlow 检查**

打开 `setup-all.sh`：
1. 顶部注释（行 8-13）把 `3. LightRAG: ...` 改为 `3. RAGFlow: docker compose pull (镜像可达性检查)`
2. 删除 `# ── 4. LightRAG ──` 段（行 126-146）
3. 在原位置新增：
   ```bash
   # ── 4. RAGFlow (Docker stack) ────────────────────────────────
   step "[4/5] RAGFlow"
   if ! have docker; then
       warn "docker not found — RAGFlow needs Docker Desktop. Install before ./dev.sh."
   else
       ok "docker present"
       if [ ! -f "$ROOT/ragflow/docker/.env" ]; then
           warn "ragflow/docker/.env missing — re-clone ragflow submodule"
       else
           ok "ragflow/docker/.env present (port: $(grep '^SVR_WEB_HTTP_PORT' "$ROOT/ragflow/docker/.env" | head -1))"
       fi
       warn "Run 'docker compose -f ragflow/docker/docker-compose.yml --profile elasticsearch,cpu pull' to pre-fetch images (~3GB)."
   fi
   ```
4. 在步骤数从 [4/5] / [5/5] 调整：保持 5 步（aippt 仍是 [5/5]）

- [ ] **Step 11.2: bash 语法检查**

```bash
bash -n setup-all.sh
```
预期：无输出。

- [ ] **Step 11.3: 提交**

```bash
git add setup-all.sh
git commit -m "feat(setup): replace LightRAG setup step with RAGFlow docker check"
```

---

### Task 12: .env / .env.example — 改 LIGHTRAG_* 为 RAGFLOW_*

**Files:**
- Modify: `.env.example`
- Modify: `.env`

- [ ] **Step 12.1: 修改 .env.example**

打开 `.env.example`：
1. 删除整个 `# ══ LightRAG (knowledge base) ══` 段（行 19-36，共 ~18 行）
2. 在原位置新增：
   ```bash
   # ══ RAGFlow (knowledge base) ══
   # RAGFlow runs as its own docker compose stack (ragflow/docker/).
   # Host port for RAGFlow's nginx (its container internal port stays 80).
   # Frontend Sidebar opens http://localhost:$RAGFLOW_PORT/sso?token=<jwt>.
   RAGFLOW_PORT=8880
   RAGFLOW_HOST=localhost
   # Shared HS256 secret used by Clawith to sign SSO JWTs that RAGFlow validates.
   # MUST equal JWT_SECRET_KEY above. Set the same value in ragflow/docker/.env
   # under CLAWITH_JWT_SECRET_KEY.
   ```
3. 在数据库段注释里把 `(shared by Clawith; LightRAG can use file-based NanoVectorDB)` 改为 `(shared by Clawith; RAGFlow uses its own MySQL+ES bundled in ragflow/docker/)`

- [ ] **Step 12.2: 同步修改 .env**

把 `.env` 里对应的 `LIGHTRAG_*` 行删除，添加 `RAGFLOW_PORT=8880` 等同步项。

- [ ] **Step 12.3: 校验**

```bash
grep -n "LIGHTRAG\|lightrag" .env .env.example
```
预期：无输出。

- [ ] **Step 12.4: 提交**

```bash
git add .env.example .env
git commit -m "feat(env): switch LIGHTRAG_* env vars to RAGFLOW_*"
```

---

### Task 13: 删除 LightRAG/ 源码目录

**Files:**
- Delete: `LightRAG/`（整个）

- [ ] **Step 13.1: 确认 LightRAG/ 不被任何脚本/代码引用**

```bash
grep -rn "LightRAG/\|/LightRAG\|\"LightRAG\"" --include="*.sh" --include="*.py" --include="*.ts" --include="*.tsx" --include="*.yml" --include="*.json" --include="*.md" /Users/lance/LaboFlow 2>/dev/null \
    | grep -v "^Binary\|/LightRAG/\|.git/\|node_modules\|.venv" | head -30
```
预期：仅剩文档/计划（`docs/superpowers/...`、`README.md`、`User-Manual.md` 等）的引用。检查这些文档不会被代码 import。

- [ ] **Step 13.2: 确认 LightRAG 不是 git submodule**

```bash
cat .gitmodules 2>/dev/null; ls LightRAG/.git 2>/dev/null
```
预期：`.gitmodules` 不存在或不含 LightRAG；`LightRAG/.git` 是普通目录（已确认）。

- [ ] **Step 13.3: 删除目录**

```bash
git rm -rf LightRAG/
```

- [ ] **Step 13.4: 更新文档（可选）**

`README.md` / `User-Manual.md` 中如有 LightRAG 章节，删除或改写为 RAGFlow 引导。如不在本任务范围，**保留 TODO 注释**到下一 PR 处理。

- [ ] **Step 13.5: 提交**

```bash
git add -A
git commit -m "chore: remove LightRAG/ source tree (replaced by ragflow/)"
```

---

## Phase 5 — End-to-End 验证

### Task 14: 全栈联调

**Files:**
- 无；纯验证

- [ ] **Step 14.1: 干净启动**

```bash
./stop.sh || true
./setup-all.sh
./dev.sh
```
预期：summary 中显示 `RAGFlow http://localhost:8880`，无 LightRAG。

- [ ] **Step 14.2: RAGFlow 容器健康**

```bash
sleep 60
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8880/
docker compose -f ragflow/docker/docker-compose.yml ps
```
预期：HTTP 200；`ragflow-server` 状态 `healthy`/`running`。

- [ ] **Step 14.3: Clawith 登录**

打开 `http://localhost:3008` → 登录任意 Clawith 用户。

- [ ] **Step 14.4: SSO 跳转**

点击侧栏 Knowledge Base → 应弹新标签页跳到 `http://localhost:8880/sso?token=...` → 自动落地到 RAGFlow `/`，**已登录状态**（右上角应显示用户邮箱）。

- [ ] **Step 14.5: 二次跳转身份一致**

刷新 RAGFlow 主页，应保持登录。在 RAGFlow 创建一个测试数据集 → 退回 Clawith → 重新点 Knowledge Base → 同一用户应能看到刚创建的数据集。

- [ ] **Step 14.6: 已删 tab 验证**

进入 `http://localhost:3008/enterprise`（platform_admin）→ tab 栏**无**"知识库"项。Info tab 内"Company Knowledge Base"文件浏览器依然可用（保留项）。

- [ ] **Step 14.7: lightrag.* 工具不再可被 Agent 调用**

进 Clawith → 创建一个 Agent → 工具列表搜索 `lightrag` → 应**无**结果。

- [ ] **Step 14.8: 关闭服务并验证清理**

```bash
./stop.sh
docker compose -f ragflow/docker/docker-compose.yml ps
lsof -i :8880 -i :3008 -i :9621
```
预期：所有容器 down，端口 8880/3008/9621 全闲（特别是 9621 应永远不再被监听）。

- [ ] **Step 14.9: 把绿色验证截图/日志贴到 PR 描述里**

在 git 提交 message 之外，准备一段 markdown 验证报告供 PR review 使用：
```
## 验证记录
- [x] RAGFlow 健康: 200 OK on :8880
- [x] Clawith 登录 → SSO 跳 RAGFlow，自动登录
- [x] kb tab 已消失
- [x] lightrag.* 工具列表为空
- [x] stop.sh 后端口 9621 不再监听
```

- [ ] **Step 14.10: 合并到 main**

```bash
git checkout main
git merge --no-ff ragflow-replace-lightrag
git push origin main   # 经用户授权后
```

> ⚠️ push 需用户明确授权；`--no-ff` 保留分支拓扑利于事后追溯。

---

## Self-Review Checklist

**Spec coverage:**
- 用户要求 1.(1) RAGFlow ↔ Clawith SSO → Task 2 / 3 / 5 / 6
- 用户要求 1.(2) RAGFlow 80→8880 → Task 1
- 用户要求 2.(1) Sidebar 知识库链接指向 RAGFlow → Task 6
- 用户要求 2.(2) 删除"公司知识库"设置选项卡 + 后端组件 → Task 7（前端 KbTab 删除；后端无 Clawith 组件——LightRAG 容器即将整体下线）
- 用户要求 3 移除 LightRAG → Task 4 (后端代码) / Task 7 (前端代码) / Task 13 (目录删除)
- 用户要求 4 修改 dev.sh + Docker → Task 8 (compose) / Task 9 (nginx) / Task 10 (dev/stop) / Task 11 (setup) / Task 12 (env)

**Placeholder scan:**
- 已避免 "TODO/TBD/适当处理"
- 每段代码都给出实际可粘贴内容
- Step 3.1/3.2 显式标注"实际 import 路径在 Step 3.1 锁定后填回"——这是真实未知（RAGFlow 前端结构需现场探索），保留侦察步骤而非凭空写。

**Type consistency:**
- `create_sso_token(user_id, email, audience, role, ttl_minutes)` — 一处定义，Task 5 / Task 6 调用一致
- RAGFlow 路由 `/v1/user/auth/sso/clawith` — Task 2 定义，Task 3 / Task 14 调用一致
- 前端 `enterpriseApi.ragflowSsoToken()` — Task 6.1 定义，Task 6.2 调用一致

**已知歧义（已在文中标注）：**
- "公司知识库选项卡"是否包含 `EnterpriseKBBrowser`（Info tab 内的文件浏览器）？默认理解为**不包含**（仅删 LightRAG LLM 配置 tab）。如用户后续确认要扩大范围，开 follow-up 计划。

---

## Execution Handoff

**Plan saved to** `docs/superpowers/plans/2026-04-28-ragflow-replace-lightrag.md`. **Two execution options:**

1. **Subagent-Driven（推荐）** — 每个 Task 派单独 subagent 执行 + 中间审查，迭代快。RAGFlow Web 改造（Task 3）和后端 SSO（Task 2）需要现场探索 RAGFlow 前端代码结构，subagent 模式更稳。
2. **Inline Execution** — 当前会话顺序执行，每完成一 Phase 暂停让你审查。

**选哪个？**
