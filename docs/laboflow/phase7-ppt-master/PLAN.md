# PPT-Master 独立插件化与工作台中心化交互 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 PPT-Master 从 LaboFlow 捆绑代码抽为独立插件仓库 `laboflow.ppt-master`，交互重构为"工作台中心化"（技能激活自动开工作台、Stage 确认唯一入口在工作台、daemon 禁令）。

**Architecture:** 三仓库协同：新插件仓库（独立开发/版本/测试）；LaboFlow 宿主仓库（openView API + 构建期 pinned 拉取 + 耦合降级）；分发链（plugins.bundle.json + fetch 脚本 → extraResources）。四阶段交付：抽仓 → 宿主 → 插件 UX → 验收。

**Tech Stack:** Node.js（插件 ESM + node:test）、Electron 主进程 TS（plugin-runtime/plugin-view-host/plugin-sdk）、uv + CPython 3.12 wheelhouse、git subtree split（历史保留）。

**Spec:** `docs/laboflow/phase7-ppt-master/DESIGN.md`（本计划从 spec 推导；执行者须同时阅读两者）

## Global Constraints

- 插件 ID 逐字为 `laboflow.ppt-master`；技能全名 `/laboflow.ppt-master/ppt-master`；工具运行时全名派生规则 `pluginToolName`：id 中 `[^a-zA-Z0-9_]`→`_`，故 `ppt_master_status` 全名 = `plugin_laboflow_ppt_master_ppt_master_status`。
- 插件版本 4.0.0（major：ID 变更）。
- 新仓库路径 `/Users/lance/laboflow-ppt-master`；LaboFlow 改动在专用 worktree 分支 `feat/ppt-master-plugin-extraction`（AGENTS.md §5：不在主 checkout/main 开发；本仓库 remote 仅指向本地 PI-Desktop，从本地 main 切分支即可）。
- wheelhouse 目标 CPython 3.12（对齐 `uv venv --python 3.12` 钉值），`--only-binary=:all:`。
- 提交信息英文 + 语义前缀（`feat(scope):` / `fix(scope):` / `chore(scope):`），逐路径 `git add`（禁 `git add .`）。
- 插件仓库测试命令：`node --test test/*.test.mjs`（真 Python 套件需 `PPT_IT=1`）；LaboFlow 侧：`pnpm --filter @pi-desktop/desktop test`、`pnpm --filter @pi-desktop/desktop typecheck`。
- E2E 环境复用宿主已装的 node_modules/venv（AGENTS.md §5）；worktree 内禁止 `pnpm install`。
- 保留并行会话安全：LaboFlow worktree 操作不触碰主 checkout 未提交文件。

---

## 阶段 0：新仓库建立（Task 1–3）

### Task 1: 新仓库与历史抽取

**Files:**
- Create: `/Users/lance/laboflow-ppt-master/`（git 仓库，根即插件内容）
- Create: `/Users/lance/laboflow-ppt-master/PROVENANCE.md`
- Create: `/Users/lance/laboflow-ppt-master/.gitignore`

**Interfaces:**
- Produces: 仓库骨架，根目录含 `manifest.json`、`main.js`、`lib/`、`skills/`、`renderer/`、`vendored/`（历史完整，含 AGPL 审计链）

- [ ] **Step 1: subtree split 抽取历史（无外部依赖，替代 filter-repo）**

```bash
cd "/Users/lance/LaboFlow Desktop"
git subtree split -P apps/desktop/resources/plugins/laboflow.slides -b ppt-plugin-extract
mkdir -p /Users/lance/laboflow-ppt-master
cd /Users/lance/laboflow-ppt-master
git init -b main
git pull "/Users/lance/LaboFlow Desktop" ppt-plugin-extract --allow-unrelated-histories
```

Expected: `git log --oneline | wc -l` 显示历史提交数 > 30（vendored 语料演进完整）。

- [ ] **Step 2: 写 .gitignore**

```gitignore
wheelhouse/
__pycache__/
*.pyc
node_modules/
```

- [ ] **Step 3: 写 PROVENANCE.md**

```markdown
# Provenance

Extracted from the LaboFlow monorepo (fork of PI-Desktop) at
`apps/desktop/resources/plugins/laboflow.slides` via `git subtree split`
(preserving full history of the vendored ppt-master corpus for the AGPL
audit trail).

- Source repo: /Users/lance/LaboFlow Desktop (remote `upstream` -> PI-Desktop)
- Split branch: ppt-plugin-extract (created from LaboFlow main)
- Plugin tests and the S10 protocol-replay e2e were copied (no subtree
  history) from `apps/desktop/test/ppt-*.test.mjs` and
  `scripts/e2e-slides-session.mjs`; their history remains in the LaboFlow
  repository.
- Design doc: LaboFlow repo `docs/laboflow/phase7-ppt-master/DESIGN.md`
```

- [ ] **Step 4: 验证内容完整并提交**

```bash
cd /Users/lance/laboflow-ppt-master
ls   # 期望: PROVENANCE.md manifest.json main.js lib renderer skills vendored scripts(如无则后续任务补)
test -f vendored/ppt-master/SKILL.md && test -f vendored/ppt-master/scripts/svg_to_pptx.py
git add PROVENANCE.md .gitignore
git commit -m "chore: extract plugin from LaboFlow monorepo (subtree split, history preserved)"
```

### Task 2: ID 重命名 + 测试迁移（新仓库全绿）

**Files:**
- Modify: `manifest.json`（id/version/description/名称字符串）
- Modify: `main.js`（toast 指引中的技能路径）
- Modify: `skills/ppt-master.md:10`（工具全名）
- Create: `test/`（12 个套件自 LaboFlow `apps/desktop/test/` 复制并适配）
- Create: `scripts/e2e-ppt-master-session.mjs`（自 `scripts/e2e-slides-session.mjs`）

**Interfaces:**
- Produces: 插件目录根 = 仓库根；测试以 `resolve("..")` 定位插件；`node --test test/*.test.mjs` 全绿

- [ ] **Step 1: 复制测试与 e2e**

```bash
cd "/Users/lance/LaboFlow Desktop"
mkdir -p /Users/lance/laboflow-ppt-master/test
for f in ppt-budget-estimate ppt-budget ppt-jobs ppt-master-e2e-python \
         ppt-master-longtask ppt-master-runtime ppt-panel-bridge \
         ppt-pipeline-state ppt-read-doc ppt-script-whitelist ppt-state; do
  cp apps/desktop/test/$f.test.mjs /Users/lance/laboflow-ppt-master/test/
done
cp scripts/e2e-slides-session.mjs /Users/lance/laboflow-ppt-master/scripts/e2e-ppt-master-session.mjs 2>/dev/null || \
  { mkdir -p /Users/lance/laboflow-ppt-master/scripts && cp scripts/e2e-slides-session.mjs /Users/lance/laboflow-ppt-master/scripts/e2e-ppt-master-session.mjs; }
```

注意：`slides-artifact-chain.test.mjs`、`ppt-plugin-host.test.mjs`、`bundled-plugins.test.mjs` **不迁移**（宿主侧契约，留在 LaboFlow，见 Task 11/12）。

- [ ] **Step 2: 批量适配路径（原 `../resources/plugins/laboflow.slides/` → 仓库根）**

对 `test/*.test.mjs` 与 `scripts/e2e-ppt-master-session.mjs` 执行同构替换（以 ppt-master-runtime.test.mjs 为例，其余逐一同法）：

```js
// 旧
const REAL_PLUGIN_DIR = fileURLToPath(new URL("../resources/plugins/laboflow.slides/", import.meta.url));
// 新
const REAL_PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url));
```

ppt-panel-bridge.test.mjs 同理：`PLUGIN_DIR = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "")`。
ppt-budget-estimate.test.mjs 的 `createRequire("../resources/plugins/.../ppt-estimate.js")` → `createRequire("../lib/ppt-estimate.js")`。

- [ ] **Step 3: 重命名 ID**

```bash
cd /Users/lance/laboflow-ppt-master
python3 - <<'EOF'
import json, pathlib
p = pathlib.Path("manifest.json"); m = json.loads(p.read_text())
m["id"] = "laboflow.ppt-master"
m["version"] = "4.0.0"
m["description"] = "PPT assistant on the vendored PPT-Master pipeline (native DrawingML, consulting-grade), isolated guarded Python runtime pre-provisioned at startup. Standalone plugin, bundled into LaboFlow releases via plugins.bundle.json."
p.write_text(json.dumps(m, indent=2, ensure_ascii=False) + "\n")

s = pathlib.Path("skills/ppt-master.md"); t = s.read_text(encoding="utf-8")
t = t.replace("plugin_laboflow_slides_ppt_master_status", "plugin_laboflow_ppt_master_ppt_master_status")
s.write_text(t, encoding="utf-8")

j = pathlib.Path("main.js"); u = j.read_text(encoding="utf-8")
u = u.replace("/laboflow.slides/ppt-master", "/laboflow.ppt-master/ppt-master")
u = u.replace("[laboflow.slides]", "[laboflow.ppt-master]")
j.write_text(u, encoding="utf-8")
EOF
grep -rn "laboflow.slides\|laboflow_slides" --include="*.js" --include="*.json" --include="*.md" . | grep -v PROVENANCE || echo "clean"
```

- [ ] **Step 4: 全绿验证（含真 Python）**

```bash
cd /Users/lance/laboflow-ppt-master
node --test test/*.test.mjs 2>&1 | tail -5      # expect pass>0 fail=0（PPT_IT 套件此时 skip）
PPT_IT=1 node --test test/ppt-master-e2e-python.test.mjs test/ppt-master-longtask.test.mjs 2>&1 | tail -5
node scripts/e2e-ppt-master-session.mjs          # expect: 全部断言通过, exit 0
```

若 PPT_IT 因 venv 路径变化失败：数据目录按插件 ID 隔离，属预期——测试内 venv 探测使用临时 dataDir 的套件不受影响；仅真机预置路径变化，重跑 `ensureRuntime` 即自愈。

- [ ] **Step 5: Commit**

```bash
git add manifest.json main.js skills/ppt-master.md test/ scripts/
git commit -m "feat: rename plugin to laboflow.ppt-master v4.0.0, migrate test suite"
```

### Task 3: 新仓库工程化

**Files:**
- Create: `package.json`、`README.md`、`AGENTS.md`
- Move: `make-ppt-wheelhouse.mjs`（自 LaboFlow `scripts/`，路径改仓库内相对）

**Interfaces:**
- Produces: `npm test`（全量）、`PPT_IT=1 npm run test:it`、`npm run build:wheelhouse`

- [ ] **Step 1: package.json**

```json
{
  "name": "laboflow-ppt-master",
  "private": true,
  "version": "4.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "test:it": "PPT_IT=1 node --test test/ppt-master-e2e-python.test.mjs test/ppt-master-longtask.test.mjs",
    "build:wheelhouse": "node scripts/make-ppt-wheelhouse.mjs --bundled",
    "e2e:s10": "node scripts/e2e-ppt-master-session.mjs"
  }
}
```

- [ ] **Step 2: 迁移 wheelhouse 脚本并适配路径**

```bash
cd "/Users/lance/LaboFlow Desktop"
cp scripts/make-ppt-wheelhouse.mjs /Users/lance/laboflow-ppt-master/scripts/
```

将脚本内两处路径常量改为仓库内相对（`root` = 仓库根；`requirements = join(root, "vendored/ppt-master/requirements-laboflow.txt")`；`--bundled` 输出 `join(root, "wheelhouse", platform-arch)`）。 LaboFlow 原脚本在 Task 12 删除。

- [ ] **Step 3: README.md（开发/安装/发布三节，要点）**

- 开发：LaboFlow Dev 中经插件设置从本仓库路径安装（`market.install` local source），development 标志启用热重载；改代码 → 宿主 DevPluginWatcher 自动 reload。
- 构建 wheelhouse：`npm run build:wheelhouse`（CPython 3.12，见脚本头注）。
- 发布：打 tag → 归档 `zip`（排除 `test/`、`node_modules/`）→ LaboFlow 经 `plugins.bundle.json` 拉取（见宿主 Task 12）。

- [ ] **Step 4: AGENTS.md（精简版，指向 LaboFlow 仓库根 AGENTS.md 的通用纪律 + 本仓库特有：vendored 语料禁改、AGPL 黑名单、wheelhouse 3.12 钉值、提交逐路径 add）**

- [ ] **Step 5: 验证 + Commit**

```bash
cd /Users/lance/laboflow-ppt-master
npm test 2>&1 | tail -3
npm run build:wheelhouse 2>&1 | tail -2   # expect: wheels: 21 (≈20.8 MiB, CPython 3.12)
git add package.json README.md AGENTS.md scripts/make-ppt-wheelhouse.mjs
git commit -m "chore: standalone repo tooling (test scripts, wheelhouse builder)"
```

---

## 阶段 1：LaboFlow 宿主（Task 4–7，全部在 worktree 分支上）

**准备（一次性）：**

```bash
cd "/Users/lance/LaboFlow Desktop"
git worktree add -b feat/ppt-master-plugin-extraction ../laboflow-wt-ppt main
cd ../laboflow-wt-ppt
```

后续所有 LaboFlow 路径均指 `/Users/lance/laboflow-wt-ppt`。

### Task 4: `resolveOwnPluginView` 纯函数（TDD）

**Files:**
- Create: `apps/desktop/electron/main/plugin-view-request.ts`
- Test: `apps/desktop/test/plugin-view-request.test.mjs`

**Interfaces:**
- Produces: `resolveOwnPluginView(input): { ok: true; viewId: string; htmlPath: string } | { ok: false; error: string; code: "PERMISSION" | "UNKNOWN_VIEW" | "ENTRY_MISSING" }`（Task 5 消费）

- [ ] **Step 1: 写失败测试**（仿 `slides-artifact-chain.test.mjs` 的 ts-import-hooks 模式）

```js
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { resolveOwnPluginView } = await import("../electron/main/plugin-view-request.ts");

const views = [{ id: "workbench", entry: "renderer/workbench.html" }];
const perms = (p) => new Set(p);

test("resolves a declared view with an existing entry", () => {
  const dir = mkdtmp(); writeFileSync(join(dir, "renderer/workbench.html"), "<html/>");
  const r = resolveOwnPluginView({ permissions: perms(["ui.view"]), views, pluginPath: dir, viewId: "workbench" });
  assert.equal(r.ok, true);
  assert.equal(r.htmlPath, join(dir, "renderer/workbench.html"));
  rm(dir);
});
test("denies without ui.view permission", () => {
  const r = resolveOwnPluginView({ permissions: perms([]), views, pluginPath: "/x", viewId: "workbench" });
  assert.equal(r.ok, false); assert.equal(r.code, "PERMISSION");
});
test("rejects an undeclared view id", () => {
  const r = resolveOwnPluginView({ permissions: perms(["ui.view"]), views, pluginPath: "/x", viewId: "other" });
  assert.equal(r.ok, false); assert.equal(r.code, "UNKNOWN_VIEW");
});
test("rejects a declared view whose entry file is missing", () => {
  const r = resolveOwnPluginView({ permissions: perms(["ui.view"]), views, pluginPath: "/x", viewId: "workbench" });
  assert.equal(r.ok, false); assert.equal(r.code, "ENTRY_MISSING");
});
function mkdtmp() { const d = join(tmpdir(), `pvr-${Date.now()}-${Math.random()}`); mkdirSync(join(d, "renderer"), { recursive: true }); return d; }
function rm(d) { rmSync(d, { recursive: true, force: true }); }
```

- [ ] **Step 2: 运行确认失败**：`cd apps/desktop && node --test test/plugin-view-request.test.mjs` → ERR_MODULE_NOT_FOUND。

- [ ] **Step 3: 实现**（校验语义逐字对齐 `ipc/plugin-ui-ipc.ts:186-205` 的既有 handler）

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Permission + declaration + entry check for a plugin opening its OWN
 * contributed view (mirrors the pluginViewOpen IPC handler semantics). */
export type OwnViewResolution =
  | { ok: true; viewId: string; htmlPath: string }
  | { ok: false; error: string; code: "PERMISSION" | "UNKNOWN_VIEW" | "ENTRY_MISSING" };

export function resolveOwnPluginView(input: {
  permissions: ReadonlySet<string>;
  views: ReadonlyArray<{ id?: unknown; entry?: unknown }>;
  pluginPath: string;
  viewId: string;
}): OwnViewResolution {
  if (!input.permissions.has("ui.view")) {
    return { ok: false, error: "PERMISSION_DENIED: ui.view", code: "PERMISSION" };
  }
  const view = input.views.find((candidate) => candidate?.id === input.viewId);
  if (!view || typeof view.entry !== "string") {
    return { ok: false, error: "plugin has no such view", code: "UNKNOWN_VIEW" };
  }
  const htmlPath = join(input.pluginPath, view.entry);
  if (!existsSync(htmlPath)) {
    return { ok: false, error: "view entry missing", code: "ENTRY_MISSING" };
  }
  return { ok: true, viewId: input.viewId, htmlPath };
}
```

- [ ] **Step 4: 测试通过 → Commit**

```bash
node --test test/plugin-view-request.test.mjs   # 4 pass
cd ../.. && git add apps/desktop/electron/main/plugin-view-request.ts apps/desktop/test/plugin-view-request.test.mjs
git commit -m "feat(plugins): pure resolver for a plugin opening its own view"
```

### Task 5: `pi.ui.openView` 宿主实现

**Files:**
- Modify: `packages/plugin-sdk/src/index.ts`（ui 命名空间类型，紧随 `closePanel` 之后，约 :4937）
- Modify: `apps/desktop/electron/main/plugin-runtime.ts`（ui hostApi，`closePanel` 实现之后，约 :4938）
- Modify: `apps/desktop/electron/main/services/plugin-services.ts`（服务工厂，仿 `openPanel` 钩子 :255-261）
- Modify: `apps/desktop/electron/main/ipc/plugin-ui-ipc.ts`（可选：handler 内改用 Task 4 纯函数——**跳过**，保持 IPC 行为零变化）

**Interfaces:**
- Consumes: Task 4 `resolveOwnPluginView`
- Produces: `pi.ui.openView({ view })`；服务钩子 `services.openPluginView(request: { pluginId; viewId; htmlPath; netDomains?; netAnyHost? })`

- [ ] **Step 1: SDK 类型**

```ts
    openPanel: (options?: { title?: string }) => Promise<void>;
    /** Open one of THIS plugin's contributed views in the work panel. */
    openView: (input: { view: string }) => Promise<void>;
```

- [ ] **Step 2: services 钩子**（`services/plugin-services.ts`，紧随 openPanel；该文件已持有 `getUpdaterLocale`/`getPluginPanelTheme` 与 PluginViewHost 实例，按 openPanel 同法解构使用）

```ts
    openPluginView: async (request) => {
      await pluginViews.open({
        ...request,
        locale: getUpdaterLocale(),
        theme: getPluginPanelTheme(),
      });
    },
```

（`pluginViews` 为该工厂内既有的 PluginViewHost 实例名，与 `openPanel` 所用 `pluginPanels` 并列；类型声明加到工厂参数/Services 类型处，同 openPanel 的 `PluginPanelRequest` 模式新建 `PluginViewOpenServiceRequest` 或内联。）

- [ ] **Step 3: plugin-runtime hostApi**（`ui: { ... }` 内，closePanel 之后；`apiError`/`resolveInsidePlugin`/`this.netDomains` 均为该文件既有工具）

```ts
        openView: async (input: { view?: unknown }) => {
          const viewId = String(input?.view ?? "");
          const resolution = resolveOwnPluginView({
            permissions: loaded.permissions,
            views: loaded.manifest.contributes?.views ?? [],
            pluginPath,
            viewId,
          });
          if (!resolution.ok) {
            this.services.audit?.({ pluginId, api: "ui.openView", ok: false, message: resolution.error, ts: Date.now() });
            throw apiError(resolution.code === "PERMISSION" ? "PERMISSION_DENIED" : "NOT_FOUND", resolution.error);
          }
          await this.services.openPluginView({
            pluginId,
            viewId,
            htmlPath: resolution.htmlPath,
            netDomains: this.netDomains(loaded),
            netAnyHost: loaded.permissions.has("net.anyHost"),
          });
          this.services.audit?.({ pluginId, api: "ui.openView", ok: true, ts: Date.now() });
        },
```

顶部 import 增加 `import { resolveOwnPluginView } from "./plugin-view-request";`。注意 `pluginPath` 取 hostApi 闭包内既有的插件根路径变量（与 openPanel 的 `resolveInsidePlugin(pluginPath, panel)` 同源）。

- [ ] **Step 4: 类型与单测验证**（纯函数已在 Task 4 覆盖；此处验证接线编译 + 全量不回归）

```bash
pnpm --filter @pi-desktop/desktop typecheck
pnpm --filter @pi-desktop/desktop test 2>&1 | tail -4
```

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-sdk/src/index.ts apps/desktop/electron/main/plugin-runtime.ts apps/desktop/electron/main/services/plugin-services.ts
git commit -m "feat(plugins): pi.ui.openView host API (open own contributed view)"
```

### Task 6: 移除捆绑插件 + 宿主侧引用降级

**Files:**
- Delete: `apps/desktop/resources/plugins/laboflow.slides/`（整目录）
- Modify: `apps/desktop/electron/main/laboflow/slides-artifacts.ts:11`（ID）
- Modify: `apps/desktop/test/slides-artifact-chain.test.mjs`（ID）
- Modify: `apps/desktop/test/bundled-plugins.test.mjs`（删除 3 个 Slides 断言块，改为 Task 7 的条件化校验占位——本任务先删）
- Modify: `apps/desktop/test/ppt-plugin-host.test.mjs`（条件化 skip）

**Interfaces:**
- Produces: 裸仓库（无 vendored 插件副本）全测试绿；`SLIDES_PLUGIN_ID = "laboflow.ppt-master"`

- [ ] **Step 1: 删目录 + 改 artifacts ID**

```bash
cd /Users/lance/laboflow-wt-ppt
git rm -rq apps/desktop/resources/plugins/laboflow.slides
python3 - <<'EOF'
import pathlib
for p, old, new in [
  ("apps/desktop/electron/main/laboflow/slides-artifacts.ts", '"laboflow.slides"', '"laboflow.ppt-master"'),
  ("apps/desktop/test/slides-artifact-chain.test.mjs", 'pluginId: "laboflow.slides"', 'pluginId: "laboflow.ppt-master"'),
]:
    f = pathlib.Path(p); f.write_text(f.read_text().replace(old, new))
EOF
```

slides-artifacts.ts 头注补一行：`Bundled-copy integration only — no-op when the plugin is absent (ADR 0041).`（现逻辑 best-effort，天然 no-op。）

- [ ] **Step 2: bundled-plugins.test.mjs 删除 Slides 三块断言**（"Slides ships the single-engine tool surface"、"Slides exposes the PPT-Master skill corpus"、"Slides vendored PPT-Master stays complete..."整 test 块删除；打包/定位测试保留）。

- [ ] **Step 3: ppt-plugin-host.test.mjs 条件化**（模块顶部的 manifest 读取包进守卫；每个 test 加 `{ skip: !havePlugin }`）

```js
import { existsSync } from "node:fs";   // 已有 readFileSync/resolve 则合并 import
const PLUGIN_DIR = resolve("resources/plugins/laboflow.ppt-master");
const havePlugin = existsSync(PLUGIN_DIR);
const manifestRaw = havePlugin
  ? JSON.parse(readFileSync(resolve(PLUGIN_DIR, "manifest.json"), "utf8"))
  : null;
test("vendored ppt-master copy absent in a bare checkout skips cleanly", () => {
  assert.ok(true);
});
// 其余所有既有 test(...) 改为 test("...", { skip: !havePlugin }, () => {...})
// 断言中 namespace 期望值同步：plugin_laboflow_slides_ → plugin_laboflow_ppt_master_
```

- [ ] **Step 4: 全绿验证 + Commit**

```bash
cd apps/desktop && node --test test/*.test.mjs 2>&1 | tail -4   # fail=0（PPT 套件已迁走或条件 skip）
cd ../.. && pnpm --filter @pi-desktop/desktop typecheck
git add -A apps/desktop/resources/plugins apps/desktop/electron/main/laboflow/slides-artifacts.ts apps/desktop/test/slides-artifact-chain.test.mjs apps/desktop/test/bundled-plugins.test.mjs apps/desktop/test/ppt-plugin-host.test.mjs
git commit -m "feat(ppt): remove bundled slides plugin; artifacts bridge tracks laboflow.ppt-master"
```

（此处的 `git add -A` 仅限已删除的插件目录路径，属于显式路径 add。）

### Task 7: 构建期 pinned 拉取（plugins.bundle.json + fetch 脚本）

**Files:**
- Create: `apps/desktop/plugins.bundle.json`
- Create: `scripts/fetch-bundled-plugins.mjs`
- Modify: `apps/desktop/package.json`（`fetch:plugins` 脚本 + pack/dist 前置）
- Test: `apps/desktop/test/fetch-bundled-plugins.test.mjs`

**Interfaces:**
- Produces: `node scripts/fetch-bundled-plugins.mjs`（幂等；校验 id/version；写入 `resources/plugins/<id>/`）；`pnpm --filter @pi-desktop/desktop fetch:plugins`

- [ ] **Step 1: 写失败测试**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { applyBundle } = await import(join(root, "scripts/fetch-bundled-plugins.mjs"));

function makeSource(id, version) {
  const dir = mkdtempSync(join(tmpdir(), "bund-src-"));
  mkdirSync(join(dir, "renderer"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, version }));
  writeFileSync(join(dir, "renderer/x.html"), "<html/>");
  return dir;
}
test("applyBundle copies a local source and validates id+version", async () => {
  const src = makeSource("laboflow.ppt-master", "4.0.0");
  const dest = mkdtempSync(join(tmpdir(), "bund-dest-"));
  const lock = { "laboflow.ppt-master": { version: "4.0.0", source: src } };
  const report = await applyBundle({ lock, pluginsDir: dest, expectedId: "laboflow.ppt-master" });
  assert.equal(report.copied, true);
  assert.ok(existsSync(join(dest, "laboflow.ppt-master", "renderer/x.html")));
  rmSync(src, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true });
});
test("applyBundle refuses a version mismatch", async () => {
  const src = makeSource("laboflow.ppt-master", "3.0.0");
  const dest = mkdtempSync(join(tmpdir(), "bund-dest-"));
  const lock = { "laboflow.ppt-master": { version: "4.0.0", source: src } };
  await assert.rejects(() => applyBundle({ lock, pluginsDir: dest, expectedId: "laboflow.ppt-master" }), /version/i);
  rmSync(src, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true });
});
```

- [ ] **Step 2: 确认失败**（模块不存在）。

- [  ] **Step 3: 实现 `scripts/fetch-bundled-plugins.mjs`**

```js
#!/usr/bin/env node
/**
 * Fetch pinned bundled plugins listed in apps/desktop/plugins.bundle.json
 * into apps/desktop/resources/plugins/ before packaging (ADR 0041).
 * `source` is a local directory (this iteration) or an http(s) .zip URL.
 * Validates manifest id + version; refuses anything else.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(repoRoot, "apps/desktop/plugins.bundle.json");
const pluginsDir = join(repoRoot, "apps/desktop/resources/plugins");

export async function applyBundle({ lock, pluginsDir: dir, expectedId }) {
  const entry = lock[expectedId];
  if (!entry) throw new Error(`bundle lock has no entry for ${expectedId}`);
  const src = resolve(entry.source);
  if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(`source missing: ${src}`);
  const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  if (manifest.id !== expectedId) throw new Error(`manifest id ${manifest.id} != ${expectedId}`);
  if (manifest.version !== entry.version) throw new Error(`version mismatch: ${manifest.version} != ${entry.version}`);
  if (entry.sha256) {
    const hash = createHash("sha256").update(readFileSync(join(src, "manifest.json"))).digest("hex");
    if (hash !== entry.sha256) throw new Error(`sha256 mismatch for ${expectedId} manifest`);
  }
  const dest = join(dir, expectedId);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(src, dest, { recursive: true, filter: (p) => !p.includes("__pycache__") });
  return { copied: true, id: expectedId, version: entry.version, dest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  mkdirSync(pluginsDir, { recursive: true });
  for (const id of Object.keys(lock)) {
    const report = await applyBundle({ lock, pluginsDir, expectedId: id });
    console.log(`bundled ${report.id}@${report.version} -> ${report.dest}`);
  }
}
```

- [ ] **Step 4: 测试通过 + lock 落盘 + 接线**

```bash
cd apps/desktop && node --test test/fetch-bundled-plugins.test.mjs   # 2 pass
```

`apps/desktop/plugins.bundle.json`：

```json
{
  "laboflow.ppt-master": {
    "version": "4.0.0",
    "source": "/Users/lance/laboflow-ppt-master"
  }
}
```

`apps/desktop/package.json` scripts 增加并在 pack/dist* 链前置（`&& pnpm run fetch:plugins &&`）：

```json
"fetch:plugins": "node ../../scripts/fetch-bundled-plugins.mjs",
```

- [ ] **Step 5: 端到端验证 + Commit**

```bash
cd /Users/lance/laboflow-wt-ppt && pnpm --filter @pi-desktop/desktop fetch:plugins
ls apps/desktop/resources/plugins/    # 期望出现 laboflow.ppt-master（含 vendored/；wheelhouse 由插件仓库构建后随源目录带入）
cd apps/desktop && node --test test/ppt-plugin-host.test.mjs 2>&1 | tail -3   # 条件套件此刻真实执行且绿
cd ../.. && git add apps/desktop/plugins.bundle.json scripts/fetch-bundled-plugins.mjs apps/desktop/test/fetch-bundled-plugins.test.mjs apps/desktop/package.json
git commit -m "feat(build): pinned plugin bundling via plugins.bundle.json (ADR 0041)"
```

注意：`resources/plugins/laboflow.ppt-master/` 为构建产物，加入仓库 `.gitignore`（`apps/desktop/resources/plugins/laboflow.ppt-master/`）。

---

## 阶段 2：插件 UX 重构（Task 8–12，全部在 `/Users/lance/laboflow-ppt-master`）

### Task 8: 前言 A 面改造 + daemon 禁令 + 工具描述

**Files:**
- Modify: `skills/ppt-master.md`（规则 4 重写 + 新增规则 9）
- Modify: `main.js` + `manifest.json`（`ppt_stage_submit`/`ppt_master_status` 描述）
- Test: `test/skill-contract.test.mjs`（新建）

**Interfaces:**
- Produces: 前言含可检索的 asktool 禁令与 daemon 禁令；`ppt_stage_submit` 描述含"唯一确认通道"

- [ ] **Step 1: 写失败契约测试**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const skill = readFileSync(new URL("../skills/ppt-master.md", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("confirmation must route through ppt_stage_submit only (design §5.2)", () => {
  assert.match(skill, /ppt_stage_submit/);
  assert.match(skill, /asktool/);
  assert.match(skill, /禁止[^\n]*asktool/);
  assert.match(skill, /沉默不构成确认/);
});
test("the upstream preview daemon is banned; the workbench is the preview (design §5.2)", () => {
  assert.match(skill, /实时预览服务/);
  assert.match(skill, /禁止[^\n]*(启动|daemon)/);
  assert.match(skill, /工作台[^\n]*翻页/);
});
test("tool descriptions point at the single confirmation channel", () => {
  const tool = (n) => [...manifest.contributes.agentTools, ...[]].find((t) => t.name === n);
  assert.match(tool("ppt_stage_submit").description, /唯一确认/);
  assert.match(tool("ppt_master_status").description, /自动打开工作台/);
  // main.js 注册体与 manifest 描述同步
  const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");
  assert.match(main, /唯一确认/);
  assert.match(main, /自动打开工作台/);
});
```

- [ ] **Step 2: 确认失败 → 改前言**（规则 4 整段替换为下文；文末新增规则 9）

规则 4 新文本：

```markdown
4. **确认面（工作台唯一）**：两阶段确认（Stage-1 沟通契约+模板选择、Stage-2 三个设计方向）**必须**调用工具 `ppt_stage_submit`（`{projectDir, stage, recommendations}`）提交，决策只发生在右侧 PPT 工作台的「设计确认」区。提交后在对话中完整呈现方案内容 + 指引「请在右侧 PPT 工作台确认」，然后**停下轮询 `ppt_stage_status`**。**禁止**：用 asktool/弹窗征询确认；在对话内以问答形式完成确认；代用户确认；把用户沉默视为确认。用户明确要求"快速生成/跳过确认"时，走工作台的「豁免」按钮（需理由），而非对话确认。上游 confirm-surface.md 中"启动确认页（Flask confirm_ui）"分支不可用（本环境未安装 flask）。
```

新增规则 9：

```markdown
9. **实时预览禁令**：禁止启动上游"实时预览服务"（任何前台/后台 daemon 形式——前台启动会挂死 shell，后台进程会耗尽宿主 RPC 预算）。实时预览由宿主工作台的 SVG 翻页区承担：绘制阶段在对话中说明「预览请打开右侧 PPT 工作台翻页区」即可，正文要求启动预览服务的步骤以此替代。
```

- [ ] **Step 3: 工具描述同步**（manifest.json 与 main.js 两处 description 均改）

`ppt_stage_submit`：开头加「两阶段确认的**唯一确认通道**（勿用 asktool/对话确认）」。`ppt_master_status`：加「首次调用会自动打开 PPT 工作台」。

- [ ] **Step 4: 绿 + Commit**

```bash
node --test test/skill-contract.test.mjs && node --test test/*.test.mjs 2>&1 | tail -3
git add skills/ppt-master.md manifest.json main.js test/skill-contract.test.mjs
git commit -m "feat(skill): workbench-only confirmation contract + preview daemon ban"
```

### Task 9: 工作台自动打开（方案 b）

**Files:**
- Modify: `main.js`（`openWorkbench()` + 两处调用）
- Test: `test/auto-open-workbench.test.mjs`（新建，仿 ppt-panel-bridge 的 mock-pi 模式）

**Interfaces:**
- Produces: `ppt_master_status` 与 `ppt_stage_submit` 执行时调用 `pi.ui.openView({view:"workbench"})`；API 缺失/拒绝时仅日志

- [ ] **Step 1: 写失败测试**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN_DIR = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
async function loadPi({ withOpenView, spy }) {
  const dataDir = mkdtempSync(join(tmpdir(), "ppt-autoopen-"));
  globalThis.__pptPreProvisionDisabled = true;
  globalThis.pi = {
    agent: { registerTool: async () => {} },
    plugin: { getSettings: async () => ({}), getDataPath: async () => dataDir },
    workspace: { get: async () => null },
    commands: { register: async () => {} },
    ui: withOpenView
      ? { openView: async (i) => spy.push(i), showToast: async () => {}, showNativeNotification: async () => {} }
      : { showToast: async () => {}, showNativeNotification: async () => {} },
    log: () => {},
  };
  const module = await import(`${PLUGIN_DIR}/main.js?t=${Date.now()}-${Math.random()}`);
  await module.onLoad();
  return { module, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}
const toolCalls = [];
test("ppt_master_status opens the workbench when the API exists", async () => {
  const spy = [];
  const { module, cleanup } = await loadPi({ withOpenView: true, spy });
  const status = module.__registeredTools["ppt_master_status"];  // 见 Step 3 暴露
  await status.execute({});
  assert.deepEqual(spy, [{ view: "workbench" }]);
  cleanup();
});
test("ppt_master_status survives a host without openView", async () => {
  const { module, cleanup } = await loadPi({ withOpenView: false, spy: [] });
  const status = module.__registeredTools["ppt_master_status"];
  const result = await status.execute({});
  assert.ok(result.content);
  cleanup();
});
```

- [ ] **Step 2: 确认失败**（`__registeredTools` 不存在）。

- [ ] **Step 3: 实现**（main.js）

注册处统一改为捕获引用（示例 ppt_master_status；其余工具同法）：

```js
const registered = {};
function reg(tool) { registered[tool.name] = tool; void pi.agent.registerTool(tool); }
```

`reg({...})` 替换各 `void pi.agent.registerTool({...})`；导出 `export const __registeredTools = registered;`。

新增助手（文件顶部工具区）：

```js
/** Plan-b auto-open (design §5.1): the workbench surfaces on the first
 * pipeline tool call. Feature-detected — a host without openView (older
 * LaboFlow, upstream PI-Desktop) logs and continues. */
async function openWorkbench() {
  try {
    await pi.ui?.openView?.({ view: "workbench" });
  } catch (error) {
    pi.log?.("warn", `[laboflow.ppt-master] openView unavailable: ${error?.message ?? error}`);
  }
}
```

`ppt_master_status.execute` 开头：`await openWorkbench();`。
`ppt_stage_submit.execute` 在 `submitStage` 成功、设置 `pendingConfirm` 之后：`await openWorkbench();`。

- [ ] **Step 4: 绿 + Commit**

```bash
node --test test/auto-open-workbench.test.mjs && node --test test/*.test.mjs 2>&1 | tail -3
git add main.js test/auto-open-workbench.test.mjs
git commit -m "feat(workbench): auto-open on first pipeline tool call (feature-detected)"
```

### Task 10: 确认卡退役

**Files:**
- Modify: `manifest.json`（删 `ui` 块、`openConfirmCard` 命令、`ui.panel` 权限）
- Modify: `main.js`（删 openConfirmCard 注册；newPresentation toast 文案去掉「确认卡」指引）
- Delete: `renderer/confirm-card.html`
- Test: `test/retired-surfaces.test.mjs`（新建）

**Interfaces:**
- Produces: 插件唯一 UI 面 = workbench 视图

- [ ] **Step 1: 失败测试**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
test("floating confirm card is retired (design §5.3)", () => {
  assert.equal(manifest.ui, undefined);
  assert.ok(!manifest.permissions.includes("ui.panel"));
  assert.deepEqual(manifest.contributes.commands.map((c) => c.id), ["newPresentation"]);
  assert.equal(existsSync(new URL("../renderer/confirm-card.html", import.meta.url)), false);
  assert.deepEqual(manifest.contributes.views.map((v) => v.id), ["workbench"]);
});
```

- [ ] **Step 2: 确认失败 → 执行退役**（上述四处删除/修改；`ppt_stage_submit` 的指引文案统一为工作台路径，不再提「确认卡」命令）。

- [ ] **Step 3: 绿 + 全量 + Commit**

```bash
node --test test/*.test.mjs 2>&1 | tail -3   # ppt-panel-bridge 若引用 confirm-card 频道则同步清理断言
git add -A manifest.json main.js renderer/ test/retired-surfaces.test.mjs
git commit -m "feat!: retire the floating confirm card; workbench is the only PPT surface"
```

### Task 11: 工作台重设计——骨架（步进条/药丸/分区）

**Files:**
- Modify: `renderer/workbench.html`（结构性重写，保留既有桥通道与轮询）
- Test: `test/workbench-structure.test.mjs`（新建）

**Interfaces:**
- Consumes: 既有通道 `ppt.getBootstrap/getState/confirmStage/runtimeStatus/setup/jobStatus/readSvg/pageAction/openPath`
- Produces: `derivePhase(state, listings)` 纯函数（test 可 import）；DOM 五区：`#stepper`、`#runtime-pill`、`#hero`、`#preview`、`#exports`

- [ ] **Step 1: 失败测试**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../renderer/workbench.html", import.meta.url), "utf8");

test("five zones replace the diagnostic cards (design §6)", () => {
  for (const id of ["stepper", "runtime-pill", "hero", "preview", "exports"]) {
    assert.ok(html.includes(`id="${id}"`), `zone missing: ${id}`);
  }
  assert.ok(!html.includes('id="t-runtime"'), "old runtime card gone");
  assert.ok(!html.includes('id="t-pipeline"'), "old pipeline dump gone");
  assert.ok(html.includes("derivePhase"), "phase derivation present");
});
test("derivePhase maps pipeline state to 1..4", async () => {
  const src = html.match(/function derivePhase[\s\S]*?\n}/)[0];
  const derivePhase = new Function(`${src}; return derivePhase;`)();
  assert.equal(derivePhase({ stages: { stage1: { status: "pending" } } }, {}), 1);
  assert.equal(derivePhase({ stages: { stage1: { status: "confirmed" }, stage2: { status: "pending" } } }, {}), 2);
  assert.equal(derivePhase({ stages: { stage1: { status: "confirmed" }, stage2: { status: "confirmed" } } }, { svgPages: [{ name: "p1.svg" }] }), 3);
  assert.equal(derivePhase({ stages: { stage1: { status: "confirmed" }, stage2: { status: "confirmed" } } }, { svgPages: [{ name: "p1.svg" }], exports: [{ name: "a.pptx" }] }), 4);
});
```

- [ ] **Step 2: 确认失败 → 重写 workbench.html 骨架**

保留：`<meta name="pi-plugin-chrome" content="v2">`、8 语言 i18n 字典与 `data-i18n` 机制、桥调用与轮询循环、SVG 翻页器（页列表/翻页/`ppt.readSvg`/页级操作 ↻✕✎ 走 `ppt.pageAction` 或既有通道）、导出列表打开/访达动作。新增/替换：

```html
<header>
  <ol id="stepper" class="stepper">
    <li data-phase="1"><span data-i18n="ph1">沟通契约</span></li>
    <li data-phase="2"><span data-i18n="ph2">设计方案</span></li>
    <li data-phase="3"><span data-i18n="ph3">页面绘制</span></li>
    <li data-phase="4"><span data-i18n="ph4">质检导出</span></li>
  </ol>
  <button id="runtime-pill" class="pill" type="button" title=""></button>
</header>
<main>
  <section id="hero" class="hero hidden"></section>   <!-- Task 12 填充 -->
  <section id="preview"><!-- 既有 SVG 翻页器原样迁入 --></section>
</main>
<footer><section id="exports"><!-- 既有导出列表紧凑化迁入 --></section></footer>
```

```js
function derivePhase(state, listings) {
  const s1 = state?.stages?.stage1?.status ?? "pending";
  const s2 = state?.stages?.stage2?.status ?? "pending";
  if (s1 === "pending" || s1 === "submitted") return 1;
  if (s2 === "pending" || s2 === "submitted") return 2;
  if ((listings?.svgPages?.length ?? 0) === 0) return 2;
  if ((listings?.exports?.length ?? 0) === 0) return 3;
  return 4;
}
```

步进条渲染：`#stepper li` 按当前 phase 加 `done`（<phase）/`active`（==phase）。运行时药丸：`ready` → 绿点 + i18n `rtReady`；否则琥珀 + `runtime.diag` 单行摘要 + 点击触发 `ppt.setup`（复用现 setup 按钮逻辑，替换原 #btn-setup）。

i18n 新键（8 语言全量）：`ph1..ph4`、`rtReady`、`rtNotReady`、`rtReinstall`。

- [ ] **Step 3: 绿 + Commit**

```bash
node --test test/workbench-structure.test.mjs && node --test test/*.test.mjs 2>&1 | tail -3
git add renderer/workbench.html test/workbench-structure.test.mjs
git commit -m "feat(workbench): phase stepper + runtime pill replace diagnostic cards"
```

### Task 12: 工作台英雄确认区 + 收尾

**Files:**
- Modify: `renderer/workbench.html`（`#hero` 渲染逻辑；从既有底部确认区迁移强化）
- Test: 扩展 `test/workbench-structure.test.mjs`

**Interfaces:**
- Consumes: `ppt.getState` 返回的 `recommendations.stage1/stage2`、`ppt.confirmStage`
- Produces: pending 时 `#hero` 显示并成为主区；确认动作为「确认 Stage1 / 选择方向卡（Stage2）/ 豁免（需理由输入）」

- [ ] **Step 1: 失败断言（追加到 workbench-structure.test.mjs）**

```js
test("hero zone renders stage1 contract table and stage2 direction cards (design §6)", () => {
  assert.ok(html.includes("confirmStage"), "bridge confirm channel wired");
  assert.ok(html.includes('data-hero="stage1"'), "stage1 contract rendering");
  assert.ok(html.includes('data-hero="stage2"'), "stage2 direction cards");
  assert.ok(/豁免|waive/i.test(html), "waive path with reason input");
  assert.ok(html.includes("hidden"), "hero toggles with pending state");
});
```

- [ ] **Step 2: 实现英雄区**（迁移既有底部确认区逻辑：Stage1 → 键值表格（嵌套 `{value:…}` 展平渲染沿用现 kvLines 实现）；Stage2 → 方向卡（点选卡即 `ppt.confirmStage` 带 `directionIndex`——沿用现有载荷约定），底部「确认」「豁免…」；豁免展开理由输入框；提交后调 `ppt.confirmStage` 并刷新 `ppt.getState`。pending 判定沿用 bootstrap/getState 的 pendingConfirm。）

- [ ] **Step 3: 绿 + 全量（含 PPT_IT）+ Commit**

```bash
node --test test/*.test.mjs 2>&1 | tail -3
PPT_IT=1 npm run test:it 2>&1 | tail -3
npm run e2e:s10
git add renderer/workbench.html test/workbench-structure.test.mjs
git commit -m "feat(workbench): hero confirmation zone (stage1 contract / stage2 directions)"
```

---

## 阶段 3：集成与验收（Task 13–14）

### Task 13: LaboFlow 集成 pinned 版本

**Files:**
- Modify: `/Users/lance/laboflow-wt-ppt/apps/desktop/plugins.bundle.json`（锁定实际 tag/sha）

**Interfaces:**
- Produces: `pnpm --filter @pi-desktop/desktop pack` 干跑成功且产物含 `plugins/laboflow.ppt-master/`

- [ ] **Step 1: 插件仓库打 tag**

```bash
cd /Users/lance/laboflow-ppt-master && npm test && git tag v4.0.0
```

- [ ] **Step 2: 更新 lock（source 指向仓库路径；补充 manifest sha256）并拉取**

```bash
cd /Users/lance/laboflow-wt-ppt
node -e "const c=require('crypto'),fs=require('fs');const m=fs.readFileSync('/Users/lance/laboflow-ppt-master/manifest.json');const l=JSON.parse(fs.readFileSync('apps/desktop/plugins.bundle.json'));l['laboflow.ppt-master'].sha256=c.createHash('sha256').update(m).digest('hex');fs.writeFileSync('apps/desktop/plugins.bundle.json',JSON.stringify(l,null,2)+'\n')"
pnpm --filter @pi-desktop/desktop fetch:plugins
```

- [ ] **Step 3: 打包干跑 + 条件测试真跑**

```bash
cd apps/desktop && pnpm run pack 2>&1 | tail -5
ls release/*/  或 dist/…（按 electron-builder 输出）确认 plugins/laboflow.ppt-master 存在
node --test test/ppt-plugin-host.test.mjs 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/plugins.bundle.json
git commit -m "chore(build): pin laboflow.ppt-master v4.0.0 bundle"
```

### Task 14: 实机验收 + ADR 0041 + 文档

**Files:**
- Create: `docs/adr/0041-ppt-master-standalone-plugin-repo.md`（worktree 内）
- Modify: `docs/laboflow/DEV-LOG.md`（追加条目，worktree 内）
- Modify: `docs/laboflow/phase7-ppt-master/`（验收记录 `ACCEPTANCE.md`）

**Interfaces:**
- Produces: DESIGN §9.3 清单全过 + 双仓库全绿

- [ ] **Step 1: 实机验收（LaboFlow Dev 安装路径版插件，茂名脚本场景）**

清单（任一失败即验收失败）：
1. LaboFlow Dev 插件设置从 `/Users/lance/laboflow-ppt-master` 安装（development 热重载开启）
2. `/` 菜单出现且仅出现 `laboflow.ppt-master/ppt-master`；选技能 + 上传茂名脚本 + Prompt
3. Agent 首个 `ppt_master_status` 后**工作台自动打开**
4. Stage 1 到达：Agent 调 `ppt_stage_submit`（转录中无 `asktool` 调用），工作台英雄区显示契约表；在工作台点「确认」
5. Stage 2 到达：方向卡三选一在工作台完成
6. 绘制阶段：工作台翻页可见 SVG；进程列表无预览 daemon（`ps aux | grep -i "preview\|daemon" | grep -v grep` 为空）
7. 质检 + 导出：`exports/*.pptx` 生成；翻为会话工件（工件面板可见）
8. 全程无浮动确认卡、无 asktool 弹窗

- [ ] **Step 2: ADR 0041**（Context：捆绑耦合三处 + PPT Test 取证；Decision：独立仓库/ID/构建期 pinned 分发/openView API/确认面收敛/daemon 禁令；Consequences：+1 仓库协调、发行链新增 fetch 步、升级 venv 重置一次；Alternatives：submodule、不捆绑、中立名——引用 DESIGN §3）

- [ ] **Step 3: 双仓库终验**

```bash
cd /Users/lance/laboflow-ppt-master && npm test && PPT_IT=1 npm run test:it && npm run e2e:s10
cd /Users/lance/laboflow-wt-ppt && pnpm --filter @pi-desktop/desktop typecheck && pnpm --filter @pi-desktop/desktop test 2>&1 | tail -4 && pnpm build:js
```

- [ ] **Step 4: 提交 + 汇报**（ADR/DEV-LOG/ACCEPTANCE 一并提交；向用户交付验收证据与遗留项：RPC 预算策略另立项）

---

## Self-Review 记录

- **Spec 覆盖**：DESIGN §4 架构（T1-7/13）、§5 交互契约（T8/9/10）、§6 工作台（T11/12）、§7 openView（T4/5）、§8 分发兼容（T6/7/13）、§9 测试（各任务内嵌 + T14）、§10 阶段对齐、§11 风险对应（T9 特性检测、T7 sha256、T13 tag）。
- **占位符扫描**：无 TBD/TODO；T5 Step 2 的服务工厂细节以既有 openPanel 为锚点给出等价代码与位置。
- **类型一致性**：`resolveOwnPluginView`/`openPluginView`/`applyBundle`/`derivePhase`/`openWorkbench`/`__registeredTools` 各任务间签名一致；工具全名按 pluginToolName 规则推演为 `plugin_laboflow_ppt_master_*`。
