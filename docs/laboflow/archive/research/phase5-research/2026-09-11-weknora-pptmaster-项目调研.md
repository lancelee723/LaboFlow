# 调研底稿：WeKnora 与 PPT-Master

- 日期：2026-09-11（GitHub/官方文档核验，当天版本状态）
- 用途：模块 05（知识库）、模块 06（PPT 助手）的集成规划依据

## 1. Tencent WeKnora（模块 05 的首选知识库）

- 仓库：https://github.com/Tencent/WeKnora · 主页 weknora.weixin.qq.com · 22.3k stars · 最新 v0.8.0（2026-09-03）· 迭代活跃（2–4 周一发）。
- **许可：MIT**（附第三方声明附录——Apache/BSD/MIT 等，合规无障碍，可商用互操作）。
- 形态：完整服务端产品（Go/gin 后端 + Vue 前端 + 可插拔向量库 pgvector/ES/Milvus/Qdrant… + 对象存储本地/MinIO/S3 系 + Redis）。多租户 + 四级 RBAC（Owner/Admin/Contributor/Viewer）+ 共享空间 + 审计。
- 部署：docker compose（full/lite/neo4j/minio profiles）/ K8s Helm / 离线镜像；**无需 GPU**（推理走外部 LLM API 或 Ollama）；端口 Web :80 / API :8080。
- 摄取：13 种格式（PDF/Word/Txt/MD/HTML/EPUB/MHTML/图片/CSV/Excel/PPT/JSON/XMInd）+ ASR；知识库类型 FAQ/文档/Wiki；文件夹树、分块编辑与版本回滚、自动打标；数据源同步（飞书 wiki/云盘、Notion、语雀、GitLab、RSS…）。
- API：REST 约 360 个端点（`/api/v1`，swagger 在库内）；鉴权 `X-API-Key`（支持按能力/按库限定的 scoped key）。
- **MCP：官方一等支持**——PyPI `tencent-weknora-mcp`（旧社区包 weknora-mcp 已弃用），传输 stdio/SSE/HTTP，约 29 工具：`hybrid_search`、KB CRUD、知识 CRUD（file/url/text）、会话/chat、分块管理等；配置示例（Claude 风格）：

```json
"weknora": {
  "command": "uv", "args": ["--directory", "/path/WeKnora/mcp-server", "run", "run_server.py"],
  "env": {"WEKNORA_API_KEY": "<key>", "WEKNORA_BASE_URL": "http://localhost:8080/api/v1"}
}
```

- WeKnora 自身也是 MCP 客户端（agent 可挂外部 MCP 工具，带 OAuth 与人工批准）。
- 集成结论：**MCP 是最佳接缝**（检索/问答/库管理全有）；REST 直连备选（swagger 可代码生成）；桌面端不内嵌引擎，组织/用户自部署（docker compose 或 Helm）。

## 2. PPT-Master（模块 06 L2 引擎）

- 仓库：https://github.com/hugohe3/ppt-master · 53.7k stars · 最新 v6.3.2（2026-09-10）· 单人维护（Hugo He）极活跃。
- **形态：Agent 技能包**（Claude-Code 式插件/skill），非应用/服务/库——`skills/ppt-master/SKILL.md` + 路由工作流 + 确定性 Python 工具链（约 50 个脚本）；声明框架无关（Claude Code/Codex/Gemini CLI/Cursor 等均可承载）。
- **许可：MIT**。⚠️ 例外：可选 PDF 转换依赖 **PyMuPDF（AGPL-3.0）**、pandoc（GPL）回退——商业产品须禁用该路径；核心 SVG→PPTX 路径全 MIT 依赖。
- 技术栈：Python 3.10+，19 个 pip 依赖（python-pptx、XlsxWriter、skia-pathops、uharfbuzz 文本整形、edge-tts、mammoth、openpyxl、Pillow、numpy、flask 等）。
- **管线**：「AI 生成 SVG → 后处理转 DrawingML（PPTX）」：
  1. 规划（Strategist）：源（PDF/DOCX/XLSX/PPTX/URL/MD/主题）→ `design_spec.md`（设计理由）+ `spec_lock.md`（机器契约：色彩锚点/字体/图标库/逐页路由）；
  2. 生成（Executor）：逐页手写 SVG 到 `svg_output/`（P01–P05 早门禁 → 其余 → 终检；禁止脚本生成页），`svg_quality_checker.py` 阻断错误；
  3. 转换：`total_md_split.py`（讲者备注）/ `finalize_svg.py`（预览定稿）/ `svg_to_pptx.py`（SVG→原生 DrawingML 元素映射，如 `<path>`→`<a:custGeom>`）+ postflight 报告。
- 产物：**原生可编辑 .pptx**（文本/形状可点选重排；图片入 media 不拍扁）；图表/表格默认可编辑形状，`--native-charts-and-tables` 导出数据驱动原生 Chart/Table（几何校验）；LaTeX→OMML；超链接/动画/旁白（edge-tts）；自有模板与**模板蒸馏**（Brand/Style/Layout 工作区）；10+ 画幅（PPT 16:9/小红书/微信…）。
- 路由：默认生成/快速/编辑原生 PPTX（往返填充增强，未动页字节级还原）/创建模板/美化/图转 PPT。
- 使用侧：无 CLI 应用/HTTP API/MCP——会话式触发（agent 读 SKILL.md）；**attribution_guard.py 首步强制**（非零退出即停）；数据本地（除模型调用；可选图片生成/搜索 API）。
- 模型要求：强长上下文（推荐 Kimi K3/Claude，~1M 上下文）——模型弱则质量降级。
- 集成结论（LaboFlow 落地路径）：vendor `skills/ppt-master/`（pin 版本）→ 引导 Python venv（uv）→ 脚本边界包装为受控 agentTools（plan/batch_generate/finalize/export/quality）→ 工作台 UI 呈现 manifest。**不 fork 不改内部**；禁用 PyMuPDF/pandoc 路径规避 AGPL；保留 attribution 文件。
