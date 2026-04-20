# Clawith 内置无头浏览器（Playwright）设计规格

- **日期**：2026-04-20
- **阶段**：LaboFlow Phase 1.2
- **状态**：草案，待用户审阅

## 1. 目的与边界

在 Clawith 后端容器内置一套基于 Playwright 的无头浏览器能力，供 Agent 作为工具调用，用于网页访问、信息搜集、文件下载与文档解析。与现有 AgentBay 商业 SaaS 浏览器**并列共存**，两套工具互不替代。

**不在本规格范围**：
- Live Preview（VNC / 实时截图流）——Agent 自主工作，用户不需要观察过程
- 凭证 cookies 自动注入（沿用 AgentBay 那套 `agent_credentials` 是后续增量）
- 横向扩展（当前单实例部署够用）
- 前端 UI 改动（工具调用走已有对话 UI）

## 2. 关键决策摘要

| 维度 | 决策 |
|---|---|
| 接入形态 | 原生 Python 工具（非 MCP Server） |
| Chromium 位置 | 装进现有 `clawith-backend` 容器 |
| Agent 控制方式 | 混合：Accessibility ref 主路径 + 截图坐标兜底 |
| 用户可见界面 | 无（不做 Live Preview、不向对话塞观察截图） |
| 会话隔离粒度 | 每 ChatSession 独立 BrowserContext，5 分钟空闲回收 |
| URL 安全策略 | 严格黑名单（阻断 file://、私有 IP、内部服务主机名） |
| 文档处理命名空间 | 独立 `doc_*`（与 `playwright_browser_*` 分离） |
| PDF 表格抽取库 | `pdfplumber`（纯 Python，许可宽松） |
| Chromium crash 恢复 | 自动重试 1 次 |
| 下载单文件上限 | 100MB，超限返回原始 URL 供用户手动下载 |

## 3. 架构

```
┌──────────────────── clawith-backend 容器 ────────────────────┐
│                                                                │
│  agent_tools.py                                                │
│    ├─ agentbay_browser_*   (现有, 调 AgentBay SaaS)            │
│    ├─ playwright_browser_* (新增, 调本地 Chromium) × 16        │
│    └─ doc_*               (新增, 文档解析)       × 2           │
│                                                                │
│  services/playwright_client.py          (新增)                 │
│    ├─ PlaywrightClient                                         │
│    ├─ _playwright_sessions: dict[(agent_id, session_id), ...]  │
│    ├─ _browser / _playwright 模块级单例                        │
│    └─ URL 黑名单 gate                                          │
│                                                                │
│  services/doc_parser.py                 (新增)                 │
│    └─ 统一读取 pdf/docx/xlsx/pptx/md/txt/csv                   │
│                                                                │
│  Python deps: playwright>=1.47, pypdf, pdfplumber,             │
│               python-docx, openpyxl (python-pptx 已有)         │
│  System deps: chromium（由 playwright install --with-deps 拉入）│
└────────────────────────────────────────────────────────────────┘
```

### 3.1 进程模型

- **单 Chromium、多 Context**：`p.chromium.launch(headless=True)` 一次，随后每个 ChatSession 调 `browser.new_context()`。Chromium 冷启 ~1.5s 只付一次；每个 Context 独立 cookies/localStorage。
- Playwright / browser 生命周期跟随 backend 进程；backend 重启时所有活跃 context 丢失（可接受）。
- docker-compose.yml **无改动**，符合"内置"语义。

### 3.2 会话缓存

```python
_playwright_sessions: dict[
    tuple[uuid.UUID, str],            # (agent_id, chat_session_id)
    tuple[PlaywrightClient, datetime] # (client, last_used)
] = {}
_PLAYWRIGHT_SESSION_TIMEOUT = timedelta(minutes=5)
```

清理由 `scheduler.py` **每 60 秒** 调一次 `cleanup_playwright_sessions()`，触发：
1. `context.close()`
2. 清空本 client 的 `_ref_registry`
3. 删除 `/data/agents/<agent_id>/downloads/<session_id>/`

## 4. 模块与接口

### 4.1 `services/playwright_client.py`

```python
class PlaywrightClient:
    # 生命周期
    async def start() -> None
    async def ensure_context() -> None
    async def close() -> None

    # Accessibility-ref 主路径
    async def browser_snapshot() -> dict
    async def browser_navigate(url: str, wait_until: str = "load") -> dict
    async def browser_click(ref: str) -> dict
    async def browser_type(ref: str, text: str, submit: bool = False) -> dict
    async def browser_select(ref: str, values: list[str]) -> dict
    async def browser_hover(ref: str) -> dict

    # 截图坐标兜底路径
    async def browser_screenshot(full_page: bool = False) -> bytes
    async def browser_click_xy(x: int, y: int) -> dict
    async def browser_type_xy(x: int, y: int, text: str) -> dict

    # 辅助
    async def browser_wait_for(selector: str = "", text: str = "", timeout_ms: int = 10000) -> dict
    async def browser_eval(expression: str) -> dict
    async def browser_get_text(ref: str = "") -> dict
    async def browser_back() -> dict
    async def browser_close_tab() -> dict

    # 下载
    async def browser_download(ref: str, timeout_ms: int = 30000) -> dict
    async def browser_list_downloads() -> dict

# 模块级 API（给 agent_tools.py 调用）
async def get_playwright_client_for_session(
    agent_id: uuid.UUID, session_id: str
) -> PlaywrightClient

async def cleanup_playwright_sessions() -> None
```

**ref 寄存器**：每次 `browser_snapshot()` 重建一次 `ref -> ElementHandle` 映射。ref 在下次 snapshot 前一直有效；过期时抛 `RefExpiredError` 并引导 LLM 重拍 snapshot。

### 4.2 `services/doc_parser.py`

```python
async def doc_read(
    file_id_or_path: str,
    page_range: str = "",
    max_chars: int = 50000,
) -> dict:
    """返回 {text, truncated, format, page_count}。
    支持 pdf / docx / xlsx / pptx / md / txt / csv。
    max_chars 硬上限 200000。"""

async def doc_extract_tables(
    file_id_or_path: str,
    page_range: str = "",
) -> dict:
    """返回 {tables: [[[row_cells], ...], ...]}。
    PDF 用 pdfplumber，xlsx 用 openpyxl。"""
```

`file_id` 是由 `playwright_browser_download` 返回的不透明字符串，内部映射到文件绝对路径；也接受直接的绝对路径（未来覆盖 Clawith chat 上传的文件场景）。

### 4.3 `agent_tools.py` 注册的工具（共 18）

**playwright_browser_\***（16）：
snapshot, navigate, click, type, select, hover, screenshot, click_xy, type_xy, wait_for, eval, get_text, back, close_tab, download, list_downloads

**doc_\***（2）：
read, extract_tables

每个工具的 `description` 必须明确写入：
- 先调 snapshot 取 ref，再用 ref 点击/输入
- 不要在点击/输入后再 navigate（会刷新丢状态）
- `_xy` 系列仅在 ref 找不到目标时用
- `doc_read` 优先于 `browser_get_text`（后者只返回可见文本）

## 5. 安全：URL 黑名单

### 5.1 被拒 Scheme

```
file://          chrome://        chrome-extension://
devtools://      view-source:     javascript:
data:text/html   data:text/*      (允许 data:image/*)
```

### 5.2 被拒主机/IP（SSRF 防护）

- 回环：`127.0.0.0/8`、`::1`
- 私有 IPv4：`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`
- 链路本地：`169.254.0.0/16`、`fe80::/10`
- Docker 内部服务主机名：`postgres`、`redis`、`lightrag`、`aippt`、`clawith-backend`、`clawith-frontend`、`nginx`
- 通过 DNS 解析后的 IP 也要校验（防止 `http://my-rebind.example` 解析到内网）

### 5.3 生效点

**仅在 `browser_navigate` 执行前**过 `_check_url_safe(url)` gate。命中黑名单抛 `URLBlockedError`，返回给 LLM 形如 `"URL blocked by security policy: <reason>"`。

`browser_eval` **不做静态分析**——JS 表达式中的 `fetch()` / `location.href=...` 不前置拦截。理由：脚本运行在浏览器沙箱，无法触达 backend 进程的文件系统或 socket；结果回到 LLM 后也不构成特权问题。代价是 Agent 理论上可通过 eval 绕过 URL 黑名单去 fetch 内网服务读响应体——评估后认为可接受，因为：
1. 内部服务（postgres/redis 等）不通过 HTTP 暴露，fetch 拿不到；
2. lightrag/aippt HTTP 端点的内容不含高敏数据，且本来就计划由 Agent 访问（只是应走 MCP 工具而非浏览器）；
3. 真正的数据窃取需要 Agent 作者恶意编写 prompt，这超出本 spec 的威胁模型。

接受这一边界。

## 6. 错误处理

| 错误类 | 触发 | 返回给 LLM 的消息 | 服务端动作 |
|---|---|---|---|
| `URLBlockedError` | 命中 §5 黑名单 | `"URL blocked by security policy: {reason}"` | 无重试 |
| `RefExpiredError` | ref 在当前 snapshot 失效 | `"Element ref '{ref}' is stale. Call playwright_browser_snapshot again."` | 无重试 |
| `NavigationTimeoutError` | 页面 load > 30s | `"Navigation timed out. Try screenshot to check state, or retry."` | 无重试 |
| `DownloadTimeoutError` | 点击后 30s 无 download 事件 | `"No download started. The link may open inline instead."` | 无重试 |
| `DownloadTooLargeError` | Content-Length 或实际大小 > 100MB | `{success: false, error: "File exceeds 100MB limit", download_url, size_mb}` | 取消下载、删已写入部分文件 |
| `DocParseError` | 文件损坏/加密 | `"Cannot parse {filename}: {reason}"` | 无重试 |
| `PlaywrightCrashError` | Chromium 崩溃（`TargetClosedError` 等） | 第 1 次对 LLM 透明，重试成功则正常返回；二次失败返 `"Browser crashed, please try again."` | **自动重建 browser + context，重试 1 次** |

### 6.1 资源保护

- 同 Context 内 tool 调用串行化（`asyncio.Lock()`，防止 ref_registry 竞态）
- 下载单文件硬上限 **100MB**
- `doc_read.max_chars` 默认 **50,000**，硬上限 **200,000**
- Chromium 进程 OOM 监控：靠 `scheduler.py` 定期检查 `psutil.Process(browser.pid).memory_info()`，超过 **1.5GB** 自动重启 browser

## 7. 测试策略

### 7.1 单元测试：`tests/test_playwright_client.py`

使用 `aiohttp.web` fixture 启本地 HTTP server 作固定素材（不访问外网）。

| 测试 | 验证 |
|---|---|
| `test_navigate_and_snapshot` | 打开 fixture 页、返回 YAML 树 |
| `test_click_by_ref` | snapshot → click → 页面跳转 |
| `test_type_and_submit` | 填表单、submit、读结果 |
| `test_ref_expired` | snapshot → 改 DOM → 旧 ref 抛 `RefExpiredError` |
| `test_xy_fallback` | 截图 + 坐标点击 |
| `test_url_blocked_scheme` | `file://`、`chrome://`、`javascript:` 均被拒 |
| `test_url_blocked_private_ip` | `http://127.0.0.1:9621`、`http://10.0.0.1`、`http://postgres` 均被拒 |
| `test_url_blocked_dns_rebind` | 解析到内网 IP 的公网域名被拒 |
| `test_download_under_limit` | 1MB 文件下载成功、返回 file_id |
| `test_download_over_limit` | 150MB mock 文件 → 返回 `download_url` |
| `test_session_isolation` | 两个 session 各自 set cookie，互不污染 |
| `test_idle_cleanup` | timeout=1s，cleanup 后 context 关、downloads 目录删 |
| `test_chromium_crash_retry` | mock `TargetClosedError` → 自动重建 context 后成功 |
| `test_chromium_crash_twice` | mock 两次连续崩溃 → 第 2 次向 LLM 报错 |

### 7.2 单元测试：`tests/test_doc_tools.py`

`tests/fixtures/` 下放：`sample.pdf`, `sample.docx`, `sample.xlsx`, `sample.pptx`, `sample.md`, `sample.csv`, `corrupt.pdf`。

| 测试 | 验证 |
|---|---|
| `test_doc_read_pdf` / `docx` / `xlsx` / `pptx` / `md` / `csv` | 每种格式文本正确提取 |
| `test_doc_read_page_range` | PDF `page_range="1-2"` 只返前两页 |
| `test_doc_read_truncation` | 超 50k 截断、返回 `truncated: true` |
| `test_doc_extract_tables_pdf` | pdfplumber 从 fixture 抽表格、行列正确 |
| `test_doc_extract_tables_xlsx` | openpyxl 抽多 sheet 表格 |
| `test_doc_parse_error` | `corrupt.pdf` 抛 `DocParseError` |

### 7.3 集成测试：`tests/test_playwright_agent_integration.py`

| 测试 | 验证 |
|---|---|
| `test_tool_registered` | `agent_tools.py` 工具注册表包含 18 个新工具 |
| `test_llm_tool_call_roundtrip` | mock LLM 发 tool_call → `_execute_tool` 分派正确 → 响应格式合法 |

### 7.4 不做

- 真网站抓取（不稳定、CI 慢）
- 并发负载测试（单实例场景）
- 前端 E2E（无 UI 改动）

### 7.5 手动验收清单

实施完成后交付前跑：
1. 建一个"调研助手"Agent，启用 `playwright_browser_navigate + snapshot + click + doc_read`
2. 让它访问公开新闻站点、读取正文、总结
3. 让它搜索并下载一份 PDF 行研报告、`doc_read` 提要点
4. 让它尝试 `navigate("http://postgres")`，确认被拒
5. 5 分钟后观察：session 清理生效、downloads 目录已空
6. 下一个 >100MB 文件：返回 `download_url`，用户可据此手动下载

## 8. 构建与部署变更

### 8.1 `Clawith/backend/Dockerfile`

追加（放在 `pip install -r requirements.txt` 之后）：

```dockerfile
RUN pip install --no-cache-dir playwright pypdf pdfplumber python-docx openpyxl \
 && playwright install --with-deps chromium
```

镜像体积：当前 ~800MB → 预计 ~1.3GB。

### 8.2 `Clawith/backend/requirements.txt`

新增行：`playwright>=1.47`、`pypdf>=4.0`、`pdfplumber>=0.11`、`python-docx>=1.1`、`openpyxl>=3.1`。

### 8.3 `docker-compose.yml`

**无改动**。

### 8.4 数据目录

`/data/agents/<agent_id>/downloads/<session_id>/` 挂在现有 `agent_data` volume 下（已有的 `AGENT_DATA_DIR=/data/agents` 环境变量覆盖）。

## 9. 文件清单

**新增**：
- `Clawith/backend/app/services/playwright_client.py`
- `Clawith/backend/app/services/doc_parser.py`
- `Clawith/backend/tests/test_playwright_client.py`
- `Clawith/backend/tests/test_doc_tools.py`
- `Clawith/backend/tests/test_playwright_agent_integration.py`
- `Clawith/backend/tests/fixtures/sample.{pdf,docx,xlsx,pptx,md,csv}`
- `Clawith/backend/tests/fixtures/corrupt.pdf`

**修改**：
- `Clawith/backend/app/services/agent_tools.py`（注册 18 个新工具 + dispatch）
- `Clawith/backend/app/services/scheduler.py`（挂 `cleanup_playwright_sessions` 周期任务）
- `Clawith/backend/Dockerfile`（安装 Playwright + Chromium）
- `Clawith/backend/requirements.txt`（新依赖）

## 10. 开放项（本 spec 范围外，后续增量）

- 凭证自动注入（接 `agent_credentials` 表，走 Playwright 原生 `context.add_cookies()`）
- LightRAG MCP Server（Phase 1.1，并行推进）
- 5 个咨询预设 Agent 的工具编排（Phase 1.3）
- 浏览器并发 quota（按租户限制）
