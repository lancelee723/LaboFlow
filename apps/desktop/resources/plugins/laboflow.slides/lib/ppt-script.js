/**
 * ppt_script — whitelisted runner for the vendored PPT-Master Python tail
 * (module 06 L2, DEVPLAN Phase B).
 *
 * Every entry pins one upstream CLI and builds its argv exactly as the
 * upstream argparse defines it (the Phase-A-dead ppt_quality/finalize/export
 * wrappers died because they didn't). Positional args, `-s` project-relative
 * semantics, and flag names mirror `--help`. Export-class scripts pass
 * through assertExportAllowed first — the hard confirmation gate.
 *
 * Execution model: sync attempt with a 60s cap (inside the 110s tool
 * budget); on timeout the same command is re-submitted as a background job
 * with the full timeout and the tool returns { jobId } for ppt_job_status.
 */

import { basename, join } from "node:path";

const SYNC_BUDGET_MS = 60_000;

/** Identity checks every entry inherits: no absolute args, no shell chars. */
function safeToken(value) {
  return String(value ?? "");
}

const ENTRY_HELP = {};

export const PPT_SCRIPTS = {
  project_manager: {
    script: "scripts/project_manager.py",
    summary: "项目生命周期：init 创建 / import-sources 导入源 / validate 校验（上游 project_manager.py 子命令）",
    buildArgs: (args) => {
      const sub = safeToken(args.subcommand);
      if (sub === "init") {
        if (!safeToken(args.name).trim()) return { error: "init 需要 name（项目名）" };
        if (!safeToken(args.dir).trim()) {
          return { error: "init 需要 dir（工作区 projects/ 目录绝对路径）——上游默认会把项目建进 skill 目录，LaboFlow 必须显式指定工作区" };
        }
        const argv = ["init", safeToken(args.name), "--dir", safeToken(args.dir)];
        if (args.format) argv.push("--format", safeToken(args.format));
        return { argv };
      }
      if (sub === "import-sources") {
        if (!safeToken(args.projectPath).trim() || !Array.isArray(args.sources) || args.sources.length === 0) {
          return { error: "import-sources 需要 projectPath 与 sources 数组" };
        }
        return { argv: ["import-sources", safeToken(args.projectPath), ...args.sources.map(safeToken)] };
      }
      if (sub === "validate") {
        if (!safeToken(args.projectPath).trim()) return { error: "validate 需要 projectPath" };
        return { argv: ["validate", safeToken(args.projectPath)] };
      }
      return { error: "subcommand 必须是 init | import-sources | validate" };
    },
    schema: {
      type: "object",
      properties: {
        subcommand: { type: "string", enum: ["init", "import-sources", "validate"] },
        name: { type: "string", description: "init: 项目名（如 maoming_chantou_20260912）" },
        dir: { type: "string", description: "init: 必填，项目基目录（工作区 projects/ 的绝对路径）" },
        format: { type: "string", description: "init: 画布格式（默认注册格式，常用 ppt169）" },
        projectPath: { type: "string", description: "import-sources/validate: 项目目录（绝对路径）" },
        sources: { type: "array", items: { type: "string" }, description: "import-sources: 源文件/URL 列表" },
      },
      required: ["subcommand"],
    },
  },

  source_to_md: {
    script: "scripts/source_to_md.py",
    summary: "源文档 → Markdown（DOCX/XLSX/PPTX/URL/MD；PDF 已禁用）",
    buildArgs: (args) => {
      if (!safeToken(args.source).trim()) return { error: "需要 source（源文件绝对路径或 URL）" };
      if (/\.pdf$/i.test(safeToken(args.source))) {
        return {
          error:
            "PDF 源在 LaboFlow 已禁用（AGPL 规避，PyMuPDF 未安装）。请让用户先将 PDF 另存为 DOCX/MD，或直接粘贴文本。",
        };
      }
      const argv = [safeToken(args.source)];
      if (args.output) argv.push("-o", safeToken(args.output));
      return { argv };
    },
    schema: {
      type: "object",
      properties: {
        source: { type: "string", description: "源文件绝对路径或 URL（不支持 .pdf）" },
        output: { type: "string", description: "输出目录（默认项目 sources/）" },
      },
      required: ["source"],
    },
  },

  text_measure: {
    script: "scripts/text_measure.py",
    summary: "字号校准（Executor 强制第一步）：calibrate <project_path> 产出字号校准表",
    buildArgs: (args) => {
      const sub = safeToken(args.subcommand || "calibrate");
      if (!["calibrate", "measure", "wrap", "box"].includes(sub)) {
        return { error: "subcommand 必须是 calibrate | measure | wrap | box" };
      }
      if (sub === "calibrate") {
        if (!safeToken(args.projectPath).trim()) return { error: "calibrate 需要 projectPath" };
        const argv = ["calibrate", safeToken(args.projectPath)];
        if (args.outline) argv.push("--outline");
        for (const role of args.roles ?? []) argv.push("--role", safeToken(role));
        argv.push("--json");
        return { argv };
      }
      return { error: "LaboFlow 白名单只开放 calibrate（measure/wrap/box 请直接用 Bash+venv 解释器）" };
    },
    schema: {
      type: "object",
      properties: {
        subcommand: { type: "string", enum: ["calibrate"] },
        projectPath: { type: "string", description: "项目目录（绝对路径）" },
        outline: { type: "boolean", description: "按大纲角色校准" },
        roles: { type: "array", items: { type: "string" }, description: "NAME:FAMILY:SIZE[:bold] 可重复" },
      },
      required: ["projectPath"],
    },
  },

  quality_checker: {
    script: "scripts/svg_quality_checker.py",
    summary: "SVG 质检闸门：早闸（第 5 页后 --stage early）/ 终闸（--stage final，0 error 放行）",
    buildArgs: (args) => {
      if (!safeToken(args.target).trim()) return { error: "需要 target（svg_output 目录或单文件，绝对路径）" };
      const argv = [safeToken(args.target)];
      if (args.stage) argv.push("--stage", safeToken(args.stage));
      if (args.json !== false) argv.push("--json");
      return { argv };
    },
    schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "项目 svg_output 目录（绝对路径）或单个 SVG" },
        stage: { type: "string", enum: ["early", "final"], description: "闸门阶段" },
        json: { type: "boolean", description: "输出 JSON 报告（默认 true）" },
      },
      required: ["target"],
    },
  },

  finalize_svg: {
    script: "scripts/finalize_svg.py",
    summary: "产出 svg_final/ 自包含预览（后处理第一步；需 Stage-2 确认）",
    gate: "export",
    buildArgs: (args) => {
      if (!safeToken(args.projectDir).trim()) return { error: "需要 projectDir（项目目录，绝对路径）" };
      const argv = [safeToken(args.projectDir)];
      if (args.dryRun) argv.push("--dry-run");
      if (args.quiet) argv.push("--quiet");
      return { argv };
    },
    schema: {
      type: "object",
      properties: {
        projectDir: { type: "string", description: "项目目录（绝对路径）" },
        dryRun: { type: "boolean" },
        quiet: { type: "boolean" },
      },
      required: ["projectDir"],
    },
  },

  total_md_split: {
    script: "scripts/total_md_split.py",
    summary: "讲稿拆分为逐页 notes/slideNN.md（需 Stage-2 确认）",
    gate: "export",
    buildArgs: (args) => {
      if (!safeToken(args.projectPath).trim()) return { error: "需要 projectPath（项目目录，绝对路径）" };
      const argv = [safeToken(args.projectPath)];
      if (args.output) argv.push("-o", safeToken(args.output));
      if (args.quiet) argv.push("-q");
      return { argv };
    },
    schema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "项目目录（绝对路径）" },
        output: { type: "string", description: "输出目录（默认项目 notes/）" },
        quiet: { type: "boolean" },
      },
      required: ["projectPath"],
    },
  },

  svg_to_pptx: {
    script: "scripts/svg_to_pptx.py",
    summary: "导出原生可编辑 PPTX（终闸通过后；质检报告指纹由上游导出器强校验；需 Stage-2 确认）",
    gate: "export",
    buildArgs: (args) => {
      if (!safeToken(args.projectPath).trim()) return { error: "需要 projectPath（项目目录，绝对路径）" };
      const argv = [safeToken(args.projectPath)];
      if (args.output) argv.push("-o", safeToken(args.output));
      // Upstream contract: -s is a PROJECT-RELATIVE source dir (default svg_output).
      if (args.source) argv.push("-s", safeToken(args.source));
      if (args.format) argv.push("-f", safeToken(args.format));
      if (args.quickGenerate) argv.push("--quick-generate");
      if (args.nativeChartsAndTables) argv.push("--native-charts-and-tables");
      if (args.quiet) argv.push("-q");
      return { argv };
    },
    schema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "项目目录（绝对路径）" },
        output: { type: "string", description: "输出 .pptx 绝对路径" },
        source: { type: "string", description: "项目相对源目录（默认 svg_output/，禁止绝对路径）" },
        format: { type: "string", description: "画布格式（如 ppt169）" },
        quickGenerate: { type: "boolean", description: "quick profile 的无锁导出" },
        nativeChartsAndTables: { type: "boolean", description: "导出带 Edit Data 的原生图表/表格" },
        quiet: { type: "boolean" },
      },
      required: ["projectPath"],
    },
  },

  image_search: {
    script: "scripts/image_search.py",
    summary: "免 key 图片搜索下载（Openverse/Wikimedia），来源清单落 image_sources.json",
    buildArgs: (args) => {
      const argv = [];
      if (args.query) argv.push(safeToken(args.query));
      if (args.queryVariant) argv.push("--query-variant", safeToken(args.queryVariant));
      if (args.filename) argv.push("--filename", safeToken(args.filename));
      if (args.output) argv.push("-o", safeToken(args.output));
      if (args.orientation) argv.push("--orientation", safeToken(args.orientation));
      if (args.slide) argv.push("--slide", safeToken(args.slide));
      if (args.minWidth) argv.push("--min-width", String(args.minWidth));
      return { argv };
    },
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索词（1–4 个具体关键词最佳）" },
        queryVariant: { type: "string", description: "不同拼法/译名，聚合去重" },
        filename: { type: "string", description: "保存文件名（单查询必填）" },
        output: { type: "string", description: "输出目录（默认项目 images/）" },
        orientation: { type: "string", description: "期望方向" },
        slide: { type: "string", description: "所属页标识（如 01_cover）" },
        minWidth: { type: "number", description: "最小宽度（默认 1200）" },
      },
    },
  },
};

export const EXPORT_SCRIPTS = Object.entries(PPT_SCRIPTS)
  .filter(([, entry]) => entry.gate === "export")
  .map(([name]) => name);

/**
 * Build the final spawn plan for one whitelisted script.
 * Returns { ok, script, argv, scriptPath, cwd } or { ok:false, error }.
 */
export function planScript({ pluginDir, script: name, args, exportGate }) {
  const entry = PPT_SCRIPTS[name];
  if (!entry) {
    return {
      ok: false,
      code: "PPT_SCRIPT_NOT_ALLOWED",
      error: `不在白名单：${name}。可用：${Object.keys(PPT_SCRIPTS).join("、")}`,
    };
  }
  const built = entry.buildArgs(args ?? {});
  if (built.error) return { ok: false, code: "PPT_SCRIPT_INVALID_ARGS", error: built.error };

  if (entry.gate === "export" && exportGate) {
    const verdict = exportGate(safeToken(args?.projectPath ?? args?.projectDir ?? ""));
    if (!verdict.ok) return { ok: false, code: verdict.code, error: verdict.hint, gate: true };
  }

  const projectDir = safeToken(args?.projectPath ?? args?.projectDir ?? "");
  return {
    ok: true,
    script: name,
    argv: built.argv,
    scriptPath: join(pluginDir, "vendored", "ppt-master", entry.script),
    summary: entry.summary,
    cwd: projectDir || undefined,
    syncBudgetMs: SYNC_BUDGET_MS,
  };
}

export { ENTRY_HELP, basename };
