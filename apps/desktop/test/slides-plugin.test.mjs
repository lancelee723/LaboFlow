import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exportDeckToBuffer,
  normalizeOutline,
  sanitizeFileName,
} from "../resources/plugins/laboflow.slides/lib/slides.js";

const DECK = {
  deckTitle: "客户A市场进入研究汇报",
  pages: [
    {
      layout: "title",
      title: "客户A市场进入研究汇报",
      subtitle: "战略咨询项目 · 阶段成果",
      speakerNotes: "开场问好，说明本次汇报范围。",
    },
    {
      layout: "bullets",
      title: "华东细分市场三年内将保持两位数增长",
      bullets: ["行业规模 2025 年达 1,200 亿", "政策端持续释放利好", "需求向头部集中"],
      speakerNotes: "先给结论，再展开三点论据。",
    },
    {
      layout: "data",
      title: "四个关键指标支撑进入决策",
      data: {
        metrics: [
          { label: "市场规模", value: "1,200亿", note: "2025E" },
          { label: "年增速", value: "12.4%", note: "2023-2026 CAGR" },
          { label: "CR3", value: "38%", note: "2024" },
          { label: "毛利率", value: "22%", note: "行业均值" },
        ],
      },
    },
    {
      layout: "matrix",
      title: "四种进入路径各有取舍",
      matrix: [
        { quadrant: "自建", points: ["控制力最强", "周期 3 年+"] },
        { quadrant: "并购", points: ["速度最快", "整合风险高"] },
        { quadrant: "合资", points: ["资源共享", "治理复杂"] },
        { quadrant: "代理", points: ["轻投入", "利润率低"] },
      ],
    },
    {
      layout: "compare",
      title: "并购与自建的关键维度对比",
      columns: [
        { label: "维度", rows: ["速度", "成本", "风险"] },
        { label: "并购", rows: ["6 个月", "高", "整合风险"] },
        { label: "自建", rows: ["3 年", "中", "执行风险"] },
      ],
    },
    {
      layout: "timeline",
      title: "建议 18 个月分三阶段推进",
      milestones: [
        { when: "M1-M3", what: "尽职调查与标的筛选" },
        { when: "M4-M9", what: "交易执行" },
        { when: "M10-M18", what: "整合落地" },
      ],
    },
    {
      layout: "quote",
      title: "客户高管的判断",
      quote: "我们不缺资金，缺的是时间窗口。",
      attribution: "客户A CEO，2026-08 访谈",
    },
    {
      layout: "end",
      title: "谢谢，欢迎讨论",
      subtitle: "LaboFlow 咨询交付团队",
    },
  ],
};

test("normalizeOutline canonicalizes arbitrary drafts", () => {
  const normalized = normalizeOutline({
    deckTitle: "客户A市场进入研究汇报",
    pages: [
      "第一页随便一个字符串",
      { layout: "unknown-layout", title: "逐项要点", bullets: ["甲", "", "乙"] },
      { layout: "data", title: "指标", data: { metrics: [{ label: "规模", value: "100亿" }, { label: "" }] } },
    ],
  });
  assert.equal(normalized.pages.length, 3);
  assert.equal(normalized.pages[0].layout, "title");
  // Unknown layout falls back to bullets; empty bullets are dropped.
  assert.deepEqual(normalized.pages[1].bullets, ["甲", "乙"]);
  assert.equal(normalized.pages[2].data.metrics.length, 1);
});

test("sanitizeFileName strips path-unsafe characters", () => {
  assert.equal(sanitizeFileName('市场/进入:*?"<>|研究'), "市场进入研究");
  assert.equal(sanitizeFileName("   "), "deck");
});

test("exportDeckToBuffer produces a valid editable PPTX (zip structure + content)", async () => {
  const { normalized, buffer } = await exportDeckToBuffer(DECK, { accent: "1F4E79" });
  assert.equal(normalized.pages.length, 8);
  assert.ok(buffer.length > 20_000, `deck too small: ${buffer.length} bytes`);

  const outDir = mkdtempSync(join(tmpdir(), "laboflow-slides-"));
  const outPath = join(outDir, "客户A汇报.pptx");
  writeFileSync(outPath, buffer);
  assert.ok(existsSync(outPath));

  // Real zip: local file header magic + end-of-central-directory record.
  const magic = buffer.subarray(0, 4);
  assert.deepEqual([...magic], [0x50, 0x4b, 0x03, 0x04], "missing PK\\x03\\x04 local header");
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "missing end-of-central-directory");

  // Entries are deflate-compressed: open the zip properly and assert the
  // slide XML carries the Chinese action titles and speaker notes — the
  // content must be genuinely editable text, not a flattened image.
  const { default: AdmZip } = await import("adm-zip");
  const zip = new AdmZip(outPath);
  const entryNames = zip.getEntries().map((entry) => entry.entryName);
  for (const marker of ["[Content_Types].xml", "ppt/presentation.xml", "ppt/slideMasters/slideMaster1.xml", "ppt/theme/theme1.xml"]) {
    assert.ok(entryNames.includes(marker), `${marker} missing`);
  }
  const slideNames = entryNames.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.ok(slideNames.length >= 8, `expected >=8 slides, got ${slideNames.length}`);
  const allSlideXml = slideNames
    .map((name) => zip.readAsText(name))
    .join("\n");
  for (const marker of ["华东细分市场三年内将保持两位数增长", "进入路径", "客户A CEO"]) {
    assert.ok(allSlideXml.includes(marker), `slide text missing: ${marker}`);
  }
  const notesXml = entryNames
    .filter((name) => name.startsWith("ppt/notesSlides/"))
    .map((name) => zip.readAsText(name))
    .join("\n");
  assert.ok(notesXml.includes("开场问好"), "speaker notes missing");
});
