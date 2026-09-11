# WeKnora 部署与接入指引（模块 05）

## 一、部署 WeKnora（组织管理员或个人）

WeKnora 是腾讯开源的 LLM 知识库平台（MIT 许可），无需 GPU。

```bash
git clone https://github.com/Tencent/WeKnora.git
cd WeKnora
cp .env.example .env        # 按需修改端口与模型配置
docker compose up -d        # Web :80 / API :8080
```

- 系统要求：Docker + Compose；约 4GB 内存 / 20GB 磁盘；模型推理走外部 API（DeepSeek/Qwen/GLM 等）或本地 Ollama。
- 登录 Web 端（http://localhost）创建账号 → 上传文档（支持 PDF/Word/Excel/PPT/Markdown/HTML/图片等 13 种格式）。

## 二、获取 API Key

Web 端右上角「账号设置」→「API 密钥」→ 创建。建议使用**限定权限**的 Key（只读检索）。
把 API Base 记为：`http://<你的服务器>:8080/api/v1`

## 三、接入 LaboFlow（MCP 检索通道）

### 远程（推荐，服务器/组织部署）
设置 → Agent → MCP → 添加：
- 传输：`http`
- URL：`http://<服务器>:8080/mcp`（或部署时配置的 MCP 网关地址）
- Headers：`{"X-API-Key": "<你的密钥>"}`

### 本地（个人，经官方 MCP 服务器）
- 传输：`stdio`
- 命令：`uvx`
- 参数：`--from tencent-weknora-mcp weknora-mcp-server`
- 环境变量：`WEKNORA_API_KEY=<密钥>`、`WEKNORA_BASE_URL=http://localhost:8080/api/v1`

> 需要本机 Python 3.10+ 与 [uv](https://docs.astral.sh/uv/)。安装：`curl -LsSf https://astral.sh/uv/install.sh | sh`

## 四、验证

1. MCP 列表中该服务状态变为 ok，工具数 ≥1（含 hybrid_search）。
2. 会话中提问：「基于知识库检索……」，回答应带 [引用:n] 标注。

## 五、网页端通道

侧栏「知识库」→ 添加 URL（如 http://localhost）→ 内嵌浏览器打开，浏览/下载文件，下载完成可一键带入会话。
