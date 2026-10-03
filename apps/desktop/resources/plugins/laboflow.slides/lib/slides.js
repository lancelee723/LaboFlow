/**
 * Slides L1 — pure outline normalization and PPTX generation.
 *
 * No `pi.*` access in this module: everything is testable headlessly. The
 * generated deck keeps every element a native PowerPoint object (text boxes
 * and tables), so consultants can restyle it like any hand-made deck.
 */

import { createRequire } from "node:module";

// The plugin vendors its own self-contained pptxgenjs bundle
// (vendor/pptxgen.bundle.js + license) so packaging stays plugin-local.
const require = createRequire(import.meta.url);

/** FR-PPT-08: predefined deck themes (accent + heading tint). en keys are canonical. */
export const THEMES = {
  "consulting-blue": { accent: "1F4E79", subtitle: "D7E3F1", band: "F3F6FA", border: "D9E2EC" },
  midnight: { accent: "1E293B", subtitle: "C7D2FE", band: "EEF2FF", border: "DBE2F0" },
  forest: { accent: "166534", subtitle: "DCFCE7", band: "F0FDF4", border: "D3E8D9" },
  crimson: { accent: "9F1239", subtitle: "FFE4E6", band: "FFF1F2", border: "F3D6DB" },
  slate: { accent: "334155", subtitle: "E2E8F0", band: "F8FAFC", border: "E2E8F0" },
};

/** FR-PPT-13: canvas presets (inches). */
export const CANVASES = {
  "16:9": { width: 13.333, height: 7.5 },
  "16:10": { width: 12.8, height: 8 },
  "4:3": { width: 10, height: 7.5 },
};

export const LAYOUTS = [
  "title",
  "bullets",
  "data",
  "matrix",
  "compare",
  "timeline",
  "quote",
  "end",
];

export function sanitizeFileName(value, fallback = "deck") {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|\n\r\t]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned.slice(0, 60) || fallback;
}

/**
 * Normalize arbitrary outline JSON into the canonical deck shape:
 * { deckTitle, pages: [{ layout, title, ...layoutPayload, speakerNotes }] }.
 * Unknown layouts fall back to `bullets`; string pages become title pages.
 */
export function normalizeOutline(input) {
  const source = input ?? {};
  const deckTitle = sanitizeFileName(source.deckTitle ?? source.topic ?? "Deck", "Deck");
  const rawPages = Array.isArray(source.pages)
    ? source.pages
    : Array.isArray(source.outline?.pages)
      ? source.outline.pages
      : Array.isArray(source)
        ? source
        : [];
  const pages = rawPages.map((page, index) => {
    if (typeof page === "string") {
      return { layout: index === 0 ? "title" : "bullets", title: page };
    }
    const layout = LAYOUTS.includes(page?.layout) ? page.layout : "bullets";
    const normalized = { layout, title: String(page?.title ?? "").trim() || `第 ${index + 1} 页` };
    for (const key of [
      "subtitle",
      "quote",
      "attribution",
      "speakerNotes",
    ]) {
      if (typeof page?.[key] === "string" && page[key].trim()) {
        normalized[key] = page[key].trim();
      }
    }
    for (const key of ["bullets"]) {
      if (Array.isArray(page?.[key])) {
        normalized[key] = page[key].map((item) => String(item)).filter(Boolean);
      }
    }
    if (page?.data && typeof page.data === "object") {
      const metrics = Array.isArray(page.data.metrics)
        ? page.data.metrics
            .map((metric) => ({
              label: String(metric?.label ?? "").trim(),
              value: String(metric?.value ?? "").trim(),
              ...(metric?.note ? { note: String(metric.note).trim() } : {}),
            }))
            .filter((metric) => metric.label || metric.value)
        : [];
      if (metrics.length) normalized.data = { metrics };
    }
    if (Array.isArray(page?.columns)) {
      const columns = page.columns
        .map((column) => ({
          label: String(column?.label ?? "").trim(),
          rows: Array.isArray(column?.rows)
            ? column.rows.map((row) => String(row)).filter(Boolean)
            : [],
        }))
        .filter((column) => column.label);
      if (columns.length) normalized.columns = columns;
    }
    if (Array.isArray(page?.matrix)) {
      const quadrants = page.matrix
        .map((cell) => ({
          quadrant: String(cell?.quadrant ?? "").trim(),
          points: Array.isArray(cell?.points)
            ? cell.points.map((point) => String(point)).filter(Boolean)
            : [],
        }))
        .filter((cell) => cell.quadrant);
      if (quadrants.length) normalized.matrix = quadrants;
    }
    if (Array.isArray(page?.milestones)) {
      const milestones = page.milestones
        .map((milestone) => ({
          when: String(milestone?.when ?? "").trim(),
          what: String(milestone?.what ?? "").trim(),
        }))
        .filter((milestone) => milestone.when || milestone.what);
      if (milestones.length) normalized.milestones = milestones;
    }
    return normalized;
  });
  if (pages.length === 0) {
    pages.push({ layout: "title", title: deckTitle });
  }
  return { deckTitle, pages };
}

const EMU_PER_INCH = 914400;

function buildPptxBuffer(deck, theme = {}) {
  // Vendored CJS build; its `require("jszip")` resolves against
  // vendor/node_modules (the plugin owns its dependency copy).
  const PptxGenJS = require("../vendor/pptxgen.cjs.js");
  const pptx = new PptxGenJS();
  // FR-PPT-13: canvas preset (default 16:9 wide).
  const canvas = CANVASES[theme.canvas] ?? CANVASES["16:9"];
  pptx.defineLayout({ name: "WIDE", width: canvas.width, height: canvas.height });
  pptx.layout = "WIDE";
  const wide = canvas.width >= 12;
  pptx.author = "LaboFlow Slides";
  pptx.title = deck.deckTitle;

  // FR-PPT-08: themeId picks a palette; an explicit accent still wins.
  const palette = THEMES[theme.themeId] ?? THEMES["consulting-blue"];
  const accent = /^#?[0-9a-fA-F]{6}$/.test(String(theme.accent ?? ""))
    ? `#${String(theme.accent).replace("#", "")}`
    : `#${palette.accent}`;
  const subtitleTint = `#${palette.subtitle}`;
  const bandFill = `#${palette.band}`;
  const border = `#${palette.border}`;
  const ink = "1F2937";
  const muted = "6B7280";
  const fontFace = String(theme.font ?? "").trim() || "PingFang SC";

  const addTitleBar = (slide, title, subtitle) => {
    slide.addText(title, {
      x: 0.6,
      y: 0.45,
      w: 12.1,
      h: 0.9,
      fontSize: 24,
      bold: true,
      color: ink,
      fontFace,
    });
    slide.addShape("rect", {
      x: 0.62,
      y: 1.35,
      w: 0.85,
      h: 0.045,
      fill: { color: accent },
      line: { type: "none" },
    });
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.6,
        y: 1.5,
        w: 12.1,
        h: 0.5,
        fontSize: 13,
        color: muted,
        fontFace,
      });
    }
  };

  for (const page of deck.pages) {
    const slide = pptx.addSlide();
    switch (page.layout) {
      case "title": {
        slide.addShape("rect", {
          x: 0,
          y: 0,
          w: "100%",
          h: "100%",
          fill: { color: accent },
          line: { type: "none" },
        });
        slide.addText(page.title, {
          x: 1,
          y: 2.4,
          w: 11.3,
          h: 1.6,
          fontSize: 36,
          bold: true,
          color: "FFFFFF",
          fontFace,
        });
        if (page.subtitle) {
          slide.addText(page.subtitle, {
            x: 1,
            y: 4.1,
            w: 11.3,
            h: 0.8,
            fontSize: 16,
            color: subtitleTint,
            fontFace,
          });
        }
        break;
      }
      case "data": {
        addTitleBar(slide, page.title, page.subtitle);
        const metrics = page.data?.metrics ?? [];
        // FR-PPT-13: opt-in native chart instead of KPI tiles when the
        // metric values can be plotted.
        if (theme.nativeCharts && metrics.length >= 2) {
          const numeric = metrics.filter((m) => /[0-9]/.test(String(m.value)));
          if (numeric.length >= 2) {
            slide.addChart(
              "bar",
              [
                {
                  name: deck.deckTitle,
                  labels: numeric.map((m) => m.label),
                  values: numeric.map((m) => Number(String(m.value).replace(/[^0-9.\-]/g, "")) || 0),
                },
              ],
              {
                x: 0.8,
                y: 2.0,
                w: (wide ? 11.7 : canvas.width - 1.6),
                h: 4.6,
                chartColors: [accent],
                showValue: true,
                fontFace,
              },
            );
            break;
          }
        }
        const columnCount = Math.min(metrics.length || 1, 4);
        const cardWidth = 12.1 / columnCount - 0.25;
        metrics.slice(0, 4).forEach((metric, index) => {
          const x = 0.6 + index * (cardWidth + 0.25);
          slide.addShape("roundRect", {
            x,
            y: 2.3,
            w: cardWidth,
            h: 2.4,
            fill: { color: bandFill },
            line: { color: border, width: 0.75 },
            rectRadius: 0.08,
          });
          slide.addText(metric.value || "—", {
            x,
            y: 2.55,
            w: cardWidth,
            h: 1.0,
            fontSize: 30,
            bold: true,
            color: accent,
            align: "center",
            fontFace,
          });
          slide.addText(metric.label, {
            x: x + 0.12,
            y: 3.6,
            w: cardWidth - 0.24,
            h: 0.5,
            fontSize: 13,
            bold: true,
            color: ink,
            align: "center",
            fontFace,
          });
          if (metric.note) {
            slide.addText(metric.note, {
              x: x + 0.12,
              y: 4.1,
              w: cardWidth - 0.24,
              h: 0.45,
              fontSize: 10,
              color: muted,
              align: "center",
              fontFace,
            });
          }
        });
        break;
      }
      case "matrix": {
        addTitleBar(slide, page.title, page.subtitle);
        const quadrants = page.matrix ?? [];
        const positions = [
          [0.6, 1.9],
          [6.85, 1.9],
          [0.6, 4.5],
          [6.85, 4.5],
        ];
        quadrants.slice(0, 4).forEach((cell, index) => {
          const [x, y] = positions[index];
          slide.addShape("roundRect", {
            x,
            y,
            w: 5.85,
            h: 2.35,
            fill: { color: index % 3 === 0 ? "EEF3F9" : "F8FAFC" },
            line: { color: "D9E2EC", width: 0.75 },
            rectRadius: 0.06,
          });
          slide.addText(cell.quadrant, {
            x: x + 0.2,
            y: y + 0.12,
            w: 5.45,
            h: 0.5,
            fontSize: 15,
            bold: true,
            color: accent,
            fontFace,
          });
          if (cell.points.length) {
            slide.addText(
              cell.points.map((point) => ({ text: point, options: { bullet: true } })),
              {
                x: x + 0.25,
                y: y + 0.62,
                w: 5.35,
                h: 1.6,
                fontSize: 12,
                color: ink,
                fontFace,
              },
            );
          }
        });
        break;
      }
      case "compare":
      case "timeline": {
        addTitleBar(slide, page.title, page.subtitle);
        const tableRows =
          page.layout === "compare"
            ? (() => {
                const columns = (page.columns ?? []).slice(0, 4);
                const rowCount = Math.max(...columns.map((column) => column.rows.length), 0);
                const header = columns.map((column) => ({
                  text: column.label,
                  options: { bold: true, color: "FFFFFF", fill: { color: accent } },
                }));
                const body = Array.from({ length: rowCount }, (_, rowIndex) =>
                  columns.map((column) => ({ text: column.rows[rowIndex] ?? "" })),
                );
                return [header, ...body];
              })()
            : (page.milestones ?? []).map((milestone) => [
                { text: milestone.when, options: { bold: true, color: accent } },
                { text: milestone.what },
              ]);
        const columnCount =
          page.layout === "compare"
            ? Math.max((page.columns ?? []).length, 1)
            : 2;
        slide.addTable(tableRows.length ? tableRows : [[{ text: "" }]], {
          x: 0.6,
          y: 1.9,
          w: 12.1,
          colW: Array.from({ length: columnCount }, () => 12.1 / columnCount),
          fontSize: 12,
          border: { type: "solid", color: border, pt: 0.75 },
          color: ink,
          fontFace,
          rowH: 0.55,
        });
        break;
      }
      case "quote": {
        addTitleBar(slide, page.title, page.subtitle);
        slide.addText(`“${page.quote ?? ""}”`, {
          x: 1.2,
          y: 2.5,
          w: 10.9,
          h: 2.6,
          fontSize: 26,
          italic: true,
          color: ink,
          fontFace,
        });
        if (page.attribution) {
          slide.addText(`—— ${page.attribution}`, {
            x: 1.2,
            y: 5.3,
            w: 10.9,
            h: 0.6,
            fontSize: 13,
            color: muted,
            fontFace,
          });
        }
        break;
      }
      case "end": {
        slide.addShape("rect", {
          x: 0,
          y: 0,
          w: "100%",
          h: "100%",
          fill: { color: accent },
          line: { type: "none" },
        });
        slide.addText(page.title, {
          x: 1,
          y: 3.0,
          w: 11.3,
          h: 1.2,
          fontSize: 32,
          bold: true,
          color: "FFFFFF",
          align: "center",
          fontFace,
        });
        if (page.subtitle) {
          slide.addText(page.subtitle, {
            x: 1,
            y: 4.3,
            w: 11.3,
            h: 0.6,
            fontSize: 14,
            color: subtitleTint,
            align: "center",
            fontFace,
          });
        }
        break;
      }
      default: {
        // bullets
        addTitleBar(slide, page.title, page.subtitle);
        const bullets = (page.bullets ?? []).map((bullet) => ({
          text: bullet,
          options: { bullet: { code: "2022" } },
        }));
        slide.addText(bullets.length ? bullets : [{ text: "" }], {
          x: 0.75,
          y: 1.9,
          w: 11.8,
          h: 4.9,
          fontSize: 15,
          color: ink,
          lineSpacingMultiple: 1.35,
          fontFace,
        });
        break;
      }
    }
    if (page.speakerNotes) {
      slide.addNotes(page.speakerNotes);
    }
  }
  void EMU_PER_INCH;
  return pptx.write({ outputType: "nodebuffer" });
}

export async function exportDeckToBuffer(deck, theme) {
  const normalized = normalizeOutline(deck);
  const buffer = await buildPptxBuffer(normalized, theme);
  return { normalized, buffer };
}
