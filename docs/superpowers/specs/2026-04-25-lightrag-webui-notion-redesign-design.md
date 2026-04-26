# LightRAG WebUI · Notion 风格重设计

**Date**: 2026-04-25
**Scope**: `LightRAG/lightrag_webui/`
**Type**: 视觉精修 + 内部 Sidebar 补完 + 死代码清理（无新功能）
**Strategy**: 4 阶段分层增量推进

---

## 1. 背景与目标

### 1.1 现状

LightRAG WebUI 是一个 React 19 + Vite + Tailwind v4 项目，承载 LightRAG 的文档管理 / 知识图谱 / 检索三个核心面板。最近一次重写（commit `7688c11`、`0b740ab`）已经：

- 把"API"tab 从入口移除（`App.tsx:177-180` 把 `currentTab === 'api'` 重定向回 `'documents'`）
- 引入了"全局左 Sidebar + 右工作区"的 shell 布局
- 完整实现了文件夹管理（前端 `FolderTree` 组件 + 后端 `/documents/folders` API + `metadata.folder_id` 元数据存储，最小入侵 LightRAG 文件判断逻辑）
- 在 `index.css` 建立了基础 CSS variable token 系统（`--background`、`--foreground`、`--primary`、`--shadow-card` 等）
- 全局 sidebar 视觉已基本符合 Notion 风格（`#0075de` 蓝、whisper border、4 层阴影、暖白底 `#f6f5f4`）

### 1.2 问题

1. **三个 feature 内部视觉不一致**：DocumentManager、GraphViewer、RetrievalTesting 内部仍有 22+ 内联 hex 值（status badge、特殊文字色），未走 token 系统
2. **缺少工作区内部 Sidebar**：用户要求每个 tab 内部都有 ≥200px 的 Sidebar，目前只有 DocumentManager 通过 FolderTree 部分满足；GraphViewer 用浮层放控件，RetrievalTesting 把 QuerySettings 放右侧
3. **暗色模式负担**：现有 `.dark` token 段、`ThemeProvider`、`ThemeToggle` 在精修亮色时是冗余项；Notion 设计哲学本身只针对亮色
4. **死代码堆积**：`SiteHeader.tsx`（149 行）、`ApiSite.tsx`（39 行）已无引用；`tailwind.config.js` 仍是 v3 风格（`hsl(var(--x))` 包裹），与 v4 的 `@theme inline` 重复且失效
5. **字体栈不稳定**：`'Avenir Next', 'Inter', 'IBM Plex Sans'` —— Avenir Next 仅 macOS 有，跨平台体验不一致

### 1.3 目标

把 LightRAG WebUI 升级到一个完全符合 Notion 设计语言的现代化界面：

1. 建立完整的 token 系统（含 status 语义色），feature 内 inline hex 归零（图标 SVG 除外）
2. 抽出 `WorkspaceShell` 容器，三个 feature 统一通过它承载左 Sidebar（256px）+ 主内容
3. 三个 feature 的 sidebar 内容按职责重组（详见第 4 节）
4. 移除暗色模式（`ThemeProvider` / `ThemeToggle` / `.dark` 段 / `dark:` 修饰）
5. 删除死代码（`SiteHeader.tsx`、`ApiSite.tsx`、`tailwind.config.js` v3 残留）
6. 字体改为本地打包 Inter（`@fontsource/inter`），跨平台一致
7. 现有所有 Dialogs（10+ 个）统一 Notion polish
8. LoginPage 一并 Notion polish

### 1.4 非目标

- 不改 LightRAG 后端、不改任何 API 契约、不改 Zustand store 字段（除删除 theme）
- 不引入多会话功能（RetrievalTesting 维持单会话）
- 不引入 E2E / visual regression 测试框架
- 不动 i18n 已有 11 个 locale，新 key 只补 `zh.json` + `en.json`，其余 fallback

---

## 2. 设计语言（Notion）

来自 https://vibeui.top/design-md/notion/DESIGN.md，关键 token：

| 用途 | 值 |
|---|---|
| 页面背景（暖白） | `#f6f5f4` |
| 卡片 / 主内容背景 | `#ffffff` |
| 主文字（暖近黑） | `rgba(0, 0, 0, 0.95)` |
| 次级文字（暖灰） | `#615d59` |
| 弱化文字 | `#a39e98` |
| 强调蓝（CTA / link） | `#0075de` |
| Focus ring | `#097fe8` |
| Badge 蓝底 | `#f2f9ff` |
| Whisper border | `1px solid rgba(0, 0, 0, 0.1)` |
| Card shadow（4 层） | `rgba(0,0,0,.04) 0 4px 18px, rgba(0,0,0,.027) 0 2.025px 7.85px, rgba(0,0,0,.02) 0 .8px 2.93px, rgba(0,0,0,.01) 0 .175px 1.04px` |
| Deep shadow（5 层，modal） | `... max blur 52px @ opacity .05` |
| 圆角 · 按钮/输入 | 4px |
| 圆角 · 卡片 | 12px |
| 圆角 · Hero / Modal | 16px |
| 圆角 · pill badge | 9999px |
| 字体 | Inter Variable（NotionInter 是 Notion 私有版本，不可用），fallback `-apple-system, system-ui, Segoe UI, Helvetica, Arial` |
| 字距规则 | display 64px → -2.125px ；26px → -0.625px ；body 16px → normal ；badge 12px → +0.125px |
| Status semantic | success `#dcfce7/#166534` · info `#dbeafe/#1e40af` · warning `#fef3c7/#92400e` · danger `#fee2e2/#991b1b` · neutral `#f3e8ff/#6b21a8` |
| Accent semantic | teal `#2a9d99` · orange `#dd5b00` · pink `#ff64c8` · purple `#391c57` |

---

## 3. 架构

### 3.1 Token 系统升级

`src/index.css` 在 `:root` 上扩展（删除 `.dark { ... }` 整段）：

```css
:root {
  /* 已有：保留 */
  --background: #f6f5f4;
  --foreground: rgba(0, 0, 0, 0.95);
  --card: #ffffff;
  --card-foreground: rgba(0, 0, 0, 0.95);
  --primary: #0075de;
  --primary-foreground: #ffffff;
  --muted-foreground: #615d59;
  --border: rgba(0, 0, 0, 0.1);
  --ring: #097fe8;
  --radius: 0.75rem; /* 12px */
  --shadow-card: rgba(0,0,0,0.04) 0 4px 18px, rgba(0,0,0,0.027) 0 2.025px 7.85px,
                 rgba(0,0,0,0.02) 0 0.8px 2.93px, rgba(0,0,0,0.01) 0 0.175px 1.04px;

  /* 新增：状态色 */
  --status-success-bg: #dcfce7; --status-success-fg: #166534;
  --status-info-bg:    #dbeafe; --status-info-fg:    #1e40af;
  --status-warning-bg: #fef3c7; --status-warning-fg: #92400e;
  --status-danger-bg:  #fee2e2; --status-danger-fg:  #991b1b;
  --status-neutral-bg: #f3e8ff; --status-neutral-fg: #6b21a8;

  /* 新增：accent semantic */
  --accent-teal:   #2a9d99;
  --accent-orange: #dd5b00;
  --accent-pink:   #ff64c8;
  --accent-purple: #391c57;

  /* 新增：sidebar 内部 */
  --sidebar-section-label: #8a847e;
  --sidebar-divider:       rgba(0, 0, 0, 0.06);

  /* 新增：deep shadow（modal） */
  --shadow-deep: rgba(0,0,0,0.01) 0 1px 3px, rgba(0,0,0,0.02) 0 3px 7px,
                 rgba(0,0,0,0.02) 0 7px 15px, rgba(0,0,0,0.04) 0 14px 28px,
                 rgba(0,0,0,0.05) 0 23px 52px;
}
```

`@theme inline` 段同步暴露成 Tailwind classes（`bg-status-success`、`text-status-success-fg`、`shadow-deep` 等）。

`tailwind.config.js` 重写为 Tailwind v4 idiomatic（移除 `darkMode: ['class']`、移除 `colors.x: 'hsl(var(--x))'` 包裹层；保留 `tailwindcss-animate`、`@tailwindcss/typography` 插件配置）。

### 3.2 字体加载

`package.json` 新增依赖 `@fontsource-variable/inter`（变体字体，单文件覆盖 100-900 weight）。

`src/main.tsx` 顶部 `import '@fontsource-variable/inter'`。

`index.css`：

```css
body {
  font-family: 'Inter Variable', 'Inter', -apple-system, system-ui,
               'Segoe UI', Helvetica, Arial, sans-serif;
  font-feature-settings: 'lnum' 1, 'locl' 1;
}
```

### 3.3 WorkspaceShell 抽象

新建 `src/components/workspace/WorkspaceShell.tsx`：

```tsx
type WorkspaceShellProps = {
  sidebar: ReactNode
  children: ReactNode
  sidebarHeader?: ReactNode  // 可选：sidebar 顶部的标题/操作栏
}
```

布局：
- 容器宽度铺满父容器，高度铺满
- 左 Sidebar：固定 `width: 256px`（≥200px 要求满足，比全局 sidebar 240px 略宽）
- 中间分隔：`border-right: 1px solid var(--border)`
- Sidebar 背景：`bg-background`（暖白 `#f6f5f4`）
- 主区背景：`bg-card`（纯白 `#ffffff`）—— 暖白/纯白形成 Notion 标志性的暖色节奏

新建 `src/components/workspace/WorkspaceSidebarSection.tsx`：

```tsx
type WorkspaceSidebarSectionProps = {
  label: string                  // uppercase 小标签
  action?: ReactNode             // 可选：标签右侧操作（如 +新建）
  children: ReactNode
}
```

渲染 `text-[11px] font-semibold uppercase tracking-[0.14em] text-sidebar-section-label`，section 间 16px 垂直 gap。

### 3.4 文件结构

```
src/
├── components/
│   ├── workspace/                    [新]
│   │   ├── WorkspaceShell.tsx
│   │   ├── WorkspaceSidebarSection.tsx
│   │   └── index.ts
│   ├── ui/
│   │   ├── StatusBadge.tsx           [新] 5 variant 复用
│   │   ├── NotionCard.tsx            [新] 12px 圆角 + whisper + shadow-card
│   │   └── ...                       (保留所有现有 ui/ 组件)
│   ├── documents/
│   │   ├── DocumentsSidebar.tsx      [新]
│   │   ├── FolderTree.tsx            [改] 适配 sidebar 槽
│   │   ├── *Dialog.tsx               [改] Notion polish（仅视觉）
│   │   └── ...
│   ├── graph/
│   │   ├── GraphSidebar.tsx          [新]
│   │   ├── GraphLabels.tsx           [改] 改为 sidebar 子组件，去除浮层壳
│   │   ├── LayoutsControl.tsx        [改] 同上
│   │   ├── Settings.tsx              [改] 同上（toggles 暴露给 sidebar）
│   │   ├── Legend.tsx                [改] 同上
│   │   ├── PropertiesView.tsx        [改] 仅视觉，保留浮层位置
│   │   └── ...                       (FullScreenControl/ZoomControl 保留浮层)
│   ├── retrieval/
│   │   ├── RetrievalSidebar.tsx      [新]
│   │   ├── QuerySettings.tsx         [改] 去除 Sheet 包装，改为平铺到 sidebar
│   │   └── ChatMessage.tsx           [改] 仅视觉
│   ├── ApiKeyAlert.tsx               [改] Notion polish
│   ├── AppSettings.tsx               [改] 删除 ThemeToggle 段
│   ├── ThemeProvider.tsx             [删]
│   └── ThemeToggle.tsx               [删]
├── features/
│   ├── DocumentManager.tsx           [改] 用 WorkspaceShell 包裹
│   ├── GraphViewer.tsx               [改] 同上 + 浮窗控件迁移到 sidebar
│   ├── RetrievalTesting.tsx          [改] 同上 + QuerySettings 从右移到左
│   ├── LoginPage.tsx                 [改] Notion polish
│   ├── ApiSite.tsx                   [删]
│   └── SiteHeader.tsx                [删]
├── App.tsx                           [改] 用 WorkspaceShell 渲染
├── index.css                         [改] 新 tokens + 删 .dark + Inter 字体
├── main.tsx                          [改] import @fontsource-variable/inter
└── tailwind.config.js                [改] v4 idiomatic
```

---

## 4. 组件设计

### 4.1 共享基础组件

**`<StatusBadge variant="success|info|warning|danger|neutral">`**
- pill 形（9999px）
- 12px font-weight 600，0.125px 字距
- 替代 DocumentManager.tsx 内 `bg-[#dcfce7] text-[#166534]` 等所有内联 status 配色

**`<NotionCard>`**
- `rounded-[12px] border border-border bg-card shadow-card`
- 接受 `variant="raised|flat"`，flat 去阴影

**Button 微调（不新建组件）**

现有 `src/components/ui/Button.tsx` 已基于 cva + token 实现，且 `--destructive: #dd5b00`（orange，已符合 Notion "无鲜红" 原则）。本次只在该文件里：

- 给 base classes 追加 `active:scale-[0.98] transition-transform`（轻微按压反馈）
- 让 default variant 的 hover 用更明确的 `hover:bg-[#005bab]`（Notion 蓝的 active 变体）替代 `hover:bg-primary/90`
- 不新增 variant，不改公共 API；所有现有调用点不动

### 4.2 DocumentsSidebar（~120 行新代码）

```
WorkspaceSidebarSection [文件夹]   action=<+新建文件夹按钮>
  └── FolderTreeList                         (6 项内置 + 用户自定义)
        ├── 📁 全部文档       (active 时蓝边白底)
        ├── 📁 未分类
        └── ... 用户文件夹 (hover 显示删除)

WorkspaceSidebarSection [状态筛选]
  └── StatusFilterList
        ├── 全部 · count
        ├── 已处理 · count       (success 色)
        ├── 处理中 · count       (info 色)
        ├── 等待中 · count       (warning 色)
        └── 失败 · count          (danger 色)
```

数据源：
- 文件夹：`useFolders()` hook（已存在，调用 `getFolders` API）
- 状态计数：`useDocumentsStatusCounts()` 从现有的 `DocsStatusesResponse.status_counts`
- 选中态：`useSettingsStore.use.documentsFolderId()` / `useSettingsStore.use.documentsStatusFilter()`

主区 `DocumentsMain`：保留现有 row-card 列表 + 顶部工具栏（扫描 / 上传 / 刷新），所有 inline hex → token class。

### 4.3 GraphSidebar（~150 行新代码）

```
WorkspaceSidebarSection [节点搜索]
  └── <GraphSearchInput>            (从 GraphSearch.tsx 提取核心逻辑)

WorkspaceSidebarSection [标签筛选]
  └── <LabelChipList>               (chip 列表带计数 · 来自 GraphLabels)

WorkspaceSidebarSection [布局]
  └── <LayoutSelect>                (下拉 · 来自 LayoutsControl)

WorkspaceSidebarSection [显示设置]
  └── <DisplayToggles>              (4-6 个开关 · 来自 Settings)

WorkspaceSidebarSection [图例]
  └── <LegendList>                  (来自 Legend.tsx)
```

主区 `GraphMain`：纯 Sigma 画布。保留三个浮层：
- 右上：`<PropertiesView>`（contextual：选中节点/边时浮现）
- 右下：`<ZoomControl>` + `<FullScreenControl>`
- 浮层一律 `<NotionCard variant="raised">` 风格

迁移注意：`Settings.tsx` 现在是 Sheet/Drawer 形式，需重构成纯组件，把 toggles 暴露给 sidebar 使用；浮层版本删除。`LayoutsControl.tsx` 同理。

### 4.4 RetrievalSidebar（~90 行新代码）

```
WorkspaceSidebarSection [检索模式]
  └── <ModeSelect>          (5 模式 · naive/local/global/hybrid/mix)

WorkspaceSidebarSection [高级参数]
  └── <QuerySettingsForm>   (从 QuerySettings.tsx 平铺，含 top_k、temperature 等)

WorkspaceSidebarSection [对话操作]
  ├── <清空对话>             (Eraser icon)
  └── <复制全部>             (Copy icon)
```

主区 `RetrievalMain`：
- 聊天气泡：用户右侧（`bg-[#f2f9ff]`，圆角 `12 12 4 12`）；助手左侧（`bg-card border border-border`，圆角 `12 12 12 4`）
- 引用脚注用 `text-muted-foreground text-[11px]` 加 `border-t border-border/40` 分隔
- 底部输入：`<NotionCard>` 包 textarea + 发送按钮
- **维持单会话**：聊天历史从 `useSettingsStore.retrievalHistory` 读，逻辑不变

### 4.5 Dialogs Notion 化（仅视觉，10+ 个）

涉及组件：
- `UploadDocumentsDialog`
- `ClearDocumentsDialog`
- `DeleteDocumentsDialog`
- `CreateFolderDialog`
- `DeleteFolderDialog`
- `MoveToFolderDialog`
- `PipelineStatusDialog`
- `PropertyEditDialog`
- `MergeDialog`
- `ApiKeyAlert`

统一规则：
- DialogContent：`bg-card rounded-[16px] shadow-deep` + backdrop `bg-black/40`
- 标题：`text-[22px] font-bold tracking-[-0.25px] text-foreground`
- 描述：`text-[14px] text-muted-foreground`
- 按钮：一律使用现有 `<Button>`（destructive 自动是 orange，无需特殊处理）

### 4.6 LoginPage Notion 化

- 页面背景沿用 body 的 radial gradient
- 居中卡片：`<NotionCard variant="raised">` `rounded-[16px]`，宽度 400px
- Logo + brand badge 复用 App.tsx 顶部样式
- Inputs：4px 圆角 whisper border + focus blue ring
- 主按钮用现有 `<Button>`（默认 primary 蓝），全宽
- 保留现有 WIP 改动（auto-login as guest 不弹 toast）

### 4.7 删除清单

| 路径 | 处理 | 原因 |
|---|---|---|
| `src/features/SiteHeader.tsx` | 删除 | 全仓库无 import |
| `src/features/ApiSite.tsx` | 删除 | 全仓库无 import |
| `src/components/ThemeProvider.tsx` | 删除 | 移除暗色模式 |
| `src/components/ThemeToggle.tsx` | 删除 | 移除暗色模式 |
| `src/components/AppSettings.tsx` 内 ThemeToggle 段 | 段落删除 | 同上 |
| `src/index.css` 内 `.dark { ... }` | 删除 | 同上 |
| `src/index.css` 内 `.dark .katex` / `.dark .shell-sidebar-scroll` | 删除 | 同上 |
| `tailwind.config.js` `darkMode` + `hsl(var(...))` 包裹 | 重写 | v3 残留，与 v4 `@theme inline` 重复 |
| 各 feature 内 `dark:` Tailwind 修饰 | grep 删除 | 同上 |

---

## 5. 数据流

**几乎无变化**。所有 API、Zustand store、副作用 hook 全部保留：

| Store / Hook | 状态 |
|---|---|
| `useSettingsStore` | 保留所有字段；删除 `theme` 相关字段（如有） |
| `useGraphStore` | 完全保留 |
| `useBackendState` | 完全保留 |
| `useAuthStore` | 完全保留 |
| `ThemeProvider` Context | 删除（连同 hook） |
| Folder API（`getFolders` / `createFolder` / `deleteFolder` / `moveDocumentsToFolder`） | 完全保留 |
| `getDocumentsPaginatedWithTimeout`（带 `folder_id` 参数） | 完全保留 |
| `queryText` / `queryTextStream` | 完全保留 |

**新组件无新 store**：`WorkspaceShell` 是纯 props 容器；status filter 用现有 `useSettingsStore.documentsStatusFilter`；graph sidebar 的 toggle 用现有 settings 字段；retrieval 仍读 `useSettingsStore.retrievalHistory`。

---

## 6. 错误处理

- 现有错误处理（`errorMessage()`、`toast.error()`、ErrorBoundary）全部保留
- 新组件 `WorkspaceShell` / `WorkspaceSidebarSection` 不引入异步 → 无新错误源
- **新增风险**：Inter 字体加载失败。处理：`@fontsource-variable/inter` 用 `font-display: swap`，fallback 到 `-apple-system` / system-ui，加载失败也能正常渲染
- Dialogs 视觉重写不改动 form 校验/提交逻辑 → 错误路径未变

---

## 7. 测试策略

### 自动检查（每 phase 必跑）

| 类型 | 命令 | 通过条件 |
|---|---|---|
| 类型检查 | `bun x tsc --noEmit` | 0 错误 |
| Lint | `bun run lint` | 0 错误 |
| 构建 | `bun run build` | 成功输出到 `dist/` |
| 单元测试 | `bun test` | 现有用例全部通过 + `WorkspaceShell` 新增 1 个 smoke test |
| 死引用 | `grep -r "from '@/components/ThemeProvider'" src/` 等 | 0 命中 |
| `dark:` 残留 | `grep -rn "dark:" src/` | 0 命中（除 `katex` 上游样式） |
| inline hex 残留 | `grep -rnE "#[0-9a-f]{6}" src/features/ src/components/documents/ src/components/graph/ src/components/retrieval/` | 仅允许 SVG 内联色（`<svg fill="...">`）和 lib/constants.ts 中的图表配色 |

### 手动验证（每 phase 提交前）

1. `bun run dev` 启动开发服务器
2. LoginPage：自动登录（guest）/ 输入 token 登录 / 错误 token 看提示
3. Documents：
   - 切换 sidebar 文件夹（全部 / 未分类 / 自定义）→ 列表更新
   - 状态筛选切换 → 列表更新
   - 上传 / 删除 / 移入文件夹 / 创建文件夹 / 删除文件夹
4. Graph：
   - sidebar 选择 label → 加载图
   - 拖动节点 → 位置更新
   - 点击节点 → PropertiesView 浮层出现
   - 切换布局 / 显示设置 → 即时反映
5. Retrieval：
   - sidebar 切换检索模式
   - 改高级参数 → 后续查询使用新参数
   - 发送一条问题 → 流式回复正常 + Markdown / LaTeX 渲染正常
   - 清空对话 / 复制全部
6. 响应式：1280px / 1024px / 768px 三档断点目测无破版
7. 浏览器 DevTools console：0 React warning、0 网络 404

### 不做的事

- 不引入 Playwright / E2E 框架（超出本次范围）
- 不写 visual regression 截图测试（成本高，性价比低）
- 不引入 Storybook（暂无场景需要）

---

## 8. 实施路径（4 Phase）

### Phase 1 — Foundation（基础整备）

**目标**：token 系统就位、暗色模式与死代码全部消除。UI 几乎无可见变化（除非用户原本在用暗色）。

**改动**：
1. `index.css`：扩展 `:root` tokens（status / accent / sidebar-* / shadow-deep）；删除 `.dark { ... }`、`.dark .katex`、`.dark .shell-sidebar-scroll`；body font-family 改 Inter
2. `@theme inline` 同步暴露新 tokens 为 utility classes
3. `tailwind.config.js`：移除 `darkMode: ['class']`；移除 `colors.x: 'hsl(var(--x))'` 包裹层；保留 `tailwindcss-animate` / `@tailwindcss/typography` 插件
4. `package.json`：新增 `@fontsource-variable/inter`
5. `main.tsx`：`import '@fontsource-variable/inter'`
6. 删除文件：`SiteHeader.tsx`、`ApiSite.tsx`、`ThemeProvider.tsx`、`ThemeToggle.tsx`
7. `AppSettings.tsx`：删除 ThemeToggle 段
8. 全仓库 grep 替换：`dark:` Tailwind 修饰删除（不删 `katex` 上游 css）
9. 新建 `<StatusBadge>` / `<NotionCard>`；微调 `Button.tsx`（追加 active scale + hover 蓝色明确化）

**验收**：tsc / lint / build 通过；dev 启动后三个 tab 视觉与改动前**几乎一致**（除了暗色切换不再可用）；`grep dark:` / `grep "ThemeProvider\|SiteHeader\|ApiSite"` 在 src/ 中 0 命中。

### Phase 2 — WorkspaceShell（容器抽象）

**目标**：抽出工作区容器，三个 feature 用它包一层但不填 sidebar。视觉上等同 Phase 1 状态。

**改动**：
1. 新建 `src/components/workspace/WorkspaceShell.tsx`、`WorkspaceSidebarSection.tsx`
2. `App.tsx`：`renderWorkspace()` 内部用 `<WorkspaceShell sidebar={null}>` 包裹三个 feature（sidebar 暂时为空槽）
3. 新增 `WorkspaceShell` 的 smoke test（渲染 + sidebar 落位）

**验收**：tsc / lint / build / 现有 bun test 通过；dev 启动后三个 tab 渲染正常；新增 test 通过。

### Phase 3 — 三 feature 迁移（主体）

**目标**：三个 feature 按顺序填上 sidebar 内容，feature 内部 inline hex 全部 token 化。

**子步骤（可拆 3 个 commit）**：

**3a. Documents**
- 新建 `DocumentsSidebar.tsx`
- `DocumentManager.tsx`：用 `<WorkspaceShell sidebar={<DocumentsSidebar />}>` 包裹；主区 inline hex → token class；status badge → `<StatusBadge>`；按钮 → `<NotionButton>`
- `FolderTree.tsx`、各 Documents Dialog：视觉对齐（暂不重写交互）

**3b. Graph**
- 新建 `GraphSidebar.tsx`
- 重构 `Settings.tsx`：抽出 toggles 为可单独使用的小组件，删除 Sheet 包装版本
- 重构 `LayoutsControl.tsx`：变成 `<LayoutSelect>` 下拉
- 重构 `GraphLabels.tsx`：从浮层提取核心列表为 `<LabelChipList>`
- 重构 `Legend.tsx` / `LegendButton.tsx`：合并为 sidebar 内的 `<LegendList>`
- `GraphSearch.tsx`：从 React Sigma 浮层提取为 sidebar 内的 `<GraphSearchInput>`
- `GraphViewer.tsx`：用 `<WorkspaceShell sidebar={<GraphSidebar />}>` 包裹；保留 PropertiesView / Zoom / FullScreen 浮层；inline hex 清理
- `PropertiesView.tsx` / `EditablePropertyRow.tsx`：仅视觉清理

**3c. Retrieval**
- 新建 `RetrievalSidebar.tsx`
- 重构 `QuerySettings.tsx`：去除 Sheet 包装，平铺
- `RetrievalTesting.tsx`：用 `<WorkspaceShell sidebar={<RetrievalSidebar />}>` 包裹；聊天气泡视觉重写；inline hex 清理
- `ChatMessage.tsx`：视觉清理

**验收**（每个子步骤）：
- tsc / lint / build / bun test 全过
- 手动验证清单（第 7 节）对应 feature 部分跑过
- `grep -nE "#[0-9a-f]{6}" src/features/<相应 feature>.tsx src/components/<相应目录>/*.tsx` 仅剩 SVG/常量

### Phase 4 — Polish（视觉收尾）

**目标**：Dialogs 与 LoginPage 全部 Notion 化；i18n 新 key 补完。

**改动**：
1. 重写 10+ Dialogs 视觉（仅样式，逻辑不动）：rounded-[16px]、shadow-deep、`<NotionButton>`、destructive 改 orange
2. `LoginPage.tsx`：Notion 化（NotionCard 包裹、按钮 / 输入升级）
3. `src/locales/zh.json` + `en.json`：补充新 sidebar / sidebar-section / 状态筛选所需的 key（其他 locale 走 fallback 不动）
4. 全仓库再扫一次 `dark:` / inline hex / 死引用，保证清零

**验收**：完整手动验证清单走一遍；新增 i18n key 在 zh / en 中均存在；其他 locale 文件未被改动。

---

## 9. 风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| 用户依赖暗色模式 | 中 | Phase 1 提交时在 PR 描述里提示；如反馈强烈，未来可单独加回（亮色 token 仍是基础） |
| Inter 本地字体增加 bundle 体积 | 低 | `@fontsource-variable/inter` 单文件 ~30KB（Variable 字体高效） |
| Graph sidebar 在 256px 内挤 5 个 section | 低 | section 用折叠 `<details>` 兜底；用户已确认内容数量 OK |
| 现有 i18n 文案与新 sidebar 标签冲突 | 低 | 新 key 走独立命名空间 `workspace.documents.sidebar.*` 等 |
| Tailwind v4 重写后 build 失败 | 低 | Phase 1 单独提交，build 出问题立即回滚 |
| Dialog 视觉重写打破现有交互 | 中 | 每个 Dialog 改完单独手动测试；form 提交逻辑不动 |

---

## 10. 验收标准（Project Done）

1. `bun x tsc --noEmit` / `bun run lint` / `bun run build` / `bun test` 全部通过
2. `grep -rn "dark:" src/`（除 katex 上游）= 0 命中
3. `grep -rn "from '@/components/ThemeProvider'\|ThemeToggle\|SiteHeader\|ApiSite'" src/` = 0 命中
4. `grep -rnE "#[0-9a-f]{6}" src/features/*.tsx src/components/{documents,graph,retrieval}/*.tsx` 仅剩 SVG `fill=` 与 `lib/constants.ts` 图表配色
5. 三个 feature 的工作区都有左侧 ≥256px Sidebar，包含第 4 节定义的内容
6. 第 7 节手动验证清单全部走通，console 0 warning
7. 7 个 `.dark` 段落与 4 个死代码文件均已删除
8. LoginPage / 所有 Dialogs / Sidebar / 主内容均匹配 Notion 视觉规范

---

## 11. 工作量估计

| Phase | 增加文件 | 修改文件 | 删除文件 | 净代码变化（行） |
|---|---|---|---|---|
| Phase 1 | 2 (StatusBadge, NotionCard) | 6 (含 Button.tsx) | 4 | -150 ~ -200 |
| Phase 2 | 3 (workspace/*) | 1 (App.tsx) | 0 | +150 |
| Phase 3a | 1 (DocumentsSidebar) | 6 | 0 | +200 ~ +250 |
| Phase 3b | 1 (GraphSidebar) | 9 | 0 | +250 ~ +350 |
| Phase 3c | 1 (RetrievalSidebar) | 3 | 0 | +150 ~ +200 |
| Phase 4 | 0 | 12 | 0 | +100 ~ +200 |
| **合计** | **8** | **36** | **4** | **+700 ~ +950** |
