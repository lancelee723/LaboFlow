// PPT workbench — pure pipeline derivations and renderers.
// deriveTimeline / deriveStatus (timeline facts), shortTime / clockTime,
// timelineNodeHtml, normalizeQualityReport / renderQualityReports and
// renderCalibration: pure functions over their arguments (plus t / esc from
// wb-i18n.js) — no module state, no bridge calls. Loaded after wb-i18n.js,
// before the workbench.js entry. Split out of workbench.js verbatim
// (Workbench-v2 T12).

/**
 * Workbench-v2 T9: the real pipeline timeline. One PURE derivation over the
 * three fact sources the renderer already has — the pipeline state (gate
 * statuses + timestamps), the file listings (page/export counts), and the
 * file-presence flags from ppt.getState.files — into ordered nodes:
 *   gate1 → gate2 → spec → draw → quality → export
 * Each node carries status done | active | pending | skipped (waived gates,
 * or — Workbench-v2 T12 — a QC step that never ran before an export), and at
 * most ONE node is ever active: the first work region reached but not
 * closed, so the timeline doubles as the "what is happening now" view.
 * Per-node conditions:
 *   gate:    confirmed → done, waived → skipped, submitted → active
 *   spec:    done when design_spec.md + spec_lock.md exist; active once
 *            gate2 is closed until then (authoring is the only next step)
 *   draw:    done when svg_final has pages; active while the spec is closed,
 *            nothing is finalized and nothing is exported (svg_output may
 *            still grow — the planned page count is not readable here)
 *   quality: done when validation/svg_quality_report*.json exists; active
 *            when drawing is done and no export exists yet; skipped (with
 *            the tlNotRun flag label, NOT the waive 豁免 badge) once a deck
 *            was exported without any QC report — the step never ran
 *   export:  done when exports/ has a deck; active after a QC report with
 *            no export yet
 * Timestamps: gates carry the state machine's submittedAt/confirmedAt (exact
 * clock times); the later stages record no time of their own, so their `at`
 * approximates with the project's lastActivityMs and marks `approx: true` —
 * the renderer prefixes those labels with "~".
 */
function deriveTimeline({ state, listings, files, lastActivityMs = 0 }) {
  const stages = state?.stages ?? {};
  const gateAt = (g) => {
    const confirmed = Date.parse(g?.confirmedAt ?? "");
    const submitted = Date.parse(g?.submittedAt ?? "");
    return (Number.isFinite(confirmed) && confirmed) || (Number.isFinite(submitted) && submitted) || undefined;
  };
  const gateNode = (key, labelKey, g) => {
    const status = g?.status ?? "pending";
    if (status === "waived") return { key, labelKey, status: "skipped", at: gateAt(g) };
    if (status === "confirmed") return { key, labelKey, status: "done", at: gateAt(g) };
    if (status === "submitted") return { key, labelKey, status: "active", at: gateAt(g) };
    return { key, labelKey, status: "pending" };
  };
  const gate2Closed = stages.stage2?.status === "confirmed" || stages.stage2?.status === "waived";
  const specDone = files?.designSpec === true && files?.specLock === true;
  const qualityDone = files?.qualityReport === true;
  const svgPages = listings?.svgPages?.length ?? 0;
  const svgFinal = listings?.svgFinal?.length ?? 0;
  const exportsCount = listings?.exports?.length ?? 0;
  const drawn = svgPages + svgFinal;
  const approxAt = lastActivityMs > 0 ? lastActivityMs : undefined;
  const spec = gate2Closed
    ? specDone
      ? { key: "spec", labelKey: "tlSpec", status: "done", at: approxAt, approx: true }
      : { key: "spec", labelKey: "tlSpec", status: "active" }
    : { key: "spec", labelKey: "tlSpec", status: "pending" };
  const draw = spec.status === "done"
    ? svgFinal > 0
      ? { key: "draw", labelKey: "tlDraw", status: "done", at: approxAt, approx: true, count: drawn }
      : exportsCount === 0
        ? { key: "draw", labelKey: "tlDraw", status: "active", count: drawn }
        : { key: "draw", labelKey: "tlDraw", status: "pending", count: drawn }
    : { key: "draw", labelKey: "tlDraw", status: "pending", count: drawn };
  const quality = draw.status === "done"
    ? qualityDone
      ? { key: "quality", labelKey: "tlQuality", status: "done", at: approxAt, approx: true }
      : exportsCount === 0
        ? { key: "quality", labelKey: "tlQuality", status: "active" }
        // Workbench-v2 T12: a deck exported without any QC report means the
        // quality step never ran — show skipped with the factual 未运行
        // label, not 豁免 (no user waive decision happened here).
        : { key: "quality", labelKey: "tlQuality", status: "skipped", flagKey: "tlNotRun" }
    : { key: "quality", labelKey: "tlQuality", status: "pending" };
  const exported = exportsCount > 0;
  const exportNode = quality.status === "done" && !exported
    ? { key: "export", labelKey: "tlExport", status: "active" }
    : exported
      ? { key: "export", labelKey: "tlExport", status: "done", at: approxAt, approx: true, count: exportsCount }
      : { key: "export", labelKey: "tlExport", status: "pending", count: exportsCount };
  return [
    gateNode("gate1", "tlGate1", stages.stage1),
    gateNode("gate2", "tlGate2", stages.stage2),
    spec,
    draw,
    quality,
    exportNode,
  ];
}

// Status line (Workbench-v2 T3): one pure tri-state decision rendered in the
// timeline header. pending wins (a gate waiting on the user is the headline),
// then file activity within the last 30s means the agent is drawing, else
// the project is idle/ready.
function deriveStatus({ pending, lastActivityMs, nowMs }) {
  if (pending) return "await-confirm";
  const last = Number(lastActivityMs ?? 0);
  if (last > 0 && nowMs - last <= 30_000) return "working";
  return "ready";
}

/** Confirmed-gate timestamp as a short local HH:MM label ("14:21"). */
function shortTime(iso) {
  const d = new Date(iso ?? "");
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Epoch-ms → the same short local HH:MM label ("" for absent/invalid). */
function clockTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return shortTime(new Date(n).toISOString());
}

function timelineNodeHtml(node) {
  const gate = node.key === "gate1" ? 1 : node.key === "gate2" ? 2 : 0;
  const closed = gate !== 0 && (node.status === "done" || node.status === "skipped");
  const time = clockTime(node.at);
  const timeLabel = time ? `${node.approx ? "~" : ""}${time}` : "";
  const badge = node.key === "draw" && node.count > 0
    ? `<span class="tl-badge">${esc(t.drawn.replace("{n}", String(node.count)))}</span>`
    : node.key === "export" && node.count > 0
      ? `<span class="tl-badge">${esc(String(node.count) + t.unitExports)}</span>`
      : "";
  // Skipped gates carry the factual waive badge (豁免); a skipped non-gate
  // (quality never ran before export) carries its own flagKey label instead.
  const flag = node.status === "skipped" ? `<span class="tl-badge">${esc(t[node.flagKey] ?? t.tlSkipped)}</span>` : "";
  // V5-T5: the draw node in its active-but-zero state (spec done, nothing
  // drawn yet) is where the model's turn most often ended without a gate to
  // hang the resume on (F-6 planning gap). A visible one-click resume: the
  // workbench routes the click through the confirm-resume injection.
  const drawResume = node.key === "draw" && node.status === "active" && !(node.count > 0)
    ? `<button type="button" class="tl-resume" data-draw-resume="1">${esc(t.drawResume ?? "开始绘制 ▶")}</button>`
    : "";
  return `<li class="tl-node ${node.status}${closed ? " gate-closed" : ""}"` +
    `${gate ? ` data-gate="${gate}"` : ""}${closed ? ' tabindex="0"' : ""}>` +
    `<span class="tl-dot" aria-hidden="true"></span>` +
    `<span class="tl-label">${esc(t[node.labelKey] ?? node.labelKey)}</span>` +
    (timeLabel ? `<span class="tl-time">${esc(timeLabel)}</span>` : "") +
    flag +
    badge +
    drawResume +
    `</li>`;
}

/**
 * Defensive normalization of ONE QC report into
 * { stage, findings: [{file, severity, message}] } with severity exactly
 * pass | warn | error. The authoritative shape (real ppt-master
 * svg-quality-report.v1) is categories.{blocking,introduced,inherited,
 * source-import}.issues[] items of {file, message} — the category name
 * decides severity (blocking → error, everything else → warn) and the
 * files[] items carry the per-file pass flag. Other variants may carry a
 * top-level issues | findings | violations array with per-item
 * {file|page, severity|level, message|rule}; coded defensively for both.
 * Pure.
 */
function normalizeQualityReport(report) {
  const r = report && typeof report === "object" && !Array.isArray(report) ? report : null;
  if (!r) return null;
  const severity = (v, fallback) => {
    const s = String(v ?? "").toLowerCase();
    if (["error", "blocking", "block", "fail", "failed", "critical"].includes(s)) return "error";
    if (["pass", "passed", "ok", "info"].includes(s)) return "pass";
    return fallback;
  };
  const findings = [];
  const push = (raw, fallbackSeverity) => {
    const it = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    if (!it) return;
    const file = String(it.file ?? it.page ?? it.name ?? "").trim();
    const rawMessage = it.message ?? it.rule ?? it.detail ?? it.description ?? "";
    const message = (typeof rawMessage === "string" ? rawMessage : String(rawMessage ?? ""))
      .replace(/\s+/g, " ").trim();
    if (!file && !message) return;
    findings.push({ file, severity: severity(it.severity ?? it.level, fallbackSeverity), message });
  };
  const cats = r.categories && typeof r.categories === "object" && !Array.isArray(r.categories) ? r.categories : null;
  if (cats) {
    for (const [name, bucket] of Object.entries(cats)) {
      const issues = bucket && typeof bucket === "object" && Array.isArray(bucket.issues) ? bucket.issues : [];
      for (const issue of issues) push(issue, name === "blocking" ? "error" : "warn");
    }
  }
  for (const key of ["issues", "findings", "violations"]) {
    if (Array.isArray(r[key])) for (const item of r[key]) push(item, "warn");
  }
  // Per-file pass rows (files[] {file, passed}): a passed file with no
  // findings of its own renders the green pass line; files that already have
  // findings keep those rows' real severity.
  const files = Array.isArray(r.files) ? r.files : [];
  for (const f of files) {
    const it = f && typeof f === "object" && !Array.isArray(f) ? f : null;
    const name = String(it?.file ?? it?.name ?? "").trim();
    if (!name || it.passed !== true) continue;
    if (findings.some((x) => x.file === name)) continue;
    findings.unshift({ file: name, severity: "pass", message: "" });
  }
  return { stage: String(r.stage ?? ""), findings };
}

/**
 * {final?, early?} bundle → the #quality body HTML: a stage chip, the
 * pass/warn/error count line, then one row per finding — severity chip
 * (pass green / warn amber / error red), the file name, and an esc'd
 * one-liner message. File rows carry data-jump-page so a click can move the
 * preview pager to that page. Returns "" when there is nothing to show.
 * Self-contained on purpose: the tests extract this together with
 * normalizeQualityReport (stubbing t/esc) and run fixture reports of both
 * shapes, like deriveTimeline.
 */
function renderQualityReports(reports) {
  const bundle = reports && typeof reports === "object" && !Array.isArray(reports) ? reports : null;
  const norm = normalizeQualityReport(bundle?.final ?? bundle?.early ?? null);
  if (!norm || !norm.findings.length) return "";
  const counts = { pass: 0, warn: 0, error: 0 };
  for (const f of norm.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  const chipLabel = { pass: t.qPass, warn: t.qWarn, error: t.qBlock };
  // DOM cap (500 rows): a pathological 1MiB report cannot stall the panel.
  const shown = norm.findings.slice(0, 500);
  const rows = shown.map((f) => {
    const jump = f.file ? ` data-jump-page="${esc(f.file)}" tabindex="0" role="button"` : "";
    return `<div class="q-item q-${f.severity}"${jump}>` +
      `<span class="chip q-chip q-${f.severity}">${esc(chipLabel[f.severity] ?? f.severity)}</span>` +
      (f.file ? `<span class="q-file">${esc(f.file)}</span>` : "") +
      (f.message ? `<span class="q-msg" title="${esc(f.message)}">${esc(f.message)}</span>` : "") +
      `</div>`;
  });
  const rest = norm.findings.length - shown.length;
  const more = rest > 0 ? `<div class="q-item muted">${esc(t.qMore.replace("{n}", String(rest)))}</div>` : "";
  const stage = norm.stage ? `<span class="chip q-stage">${esc(norm.stage)}</span>` : "";
  const countsLine = `<span class="q-counts">` +
    `<span class="q-pass">${counts.pass}</span> ${esc(t.qPass)} / ` +
    `<span class="q-warn">${counts.warn}</span> ${esc(t.qWarn)} / ` +
    `<span class="q-error">${counts.error}</span> ${esc(t.qBlock)}</span>`;
  return `<div class="q-meta">${stage}${countsLine}</div>${rows.join("")}${more}`;
}

/**
 * Workbench-v2 T11: text_calibration.json → the #calibration table HTML —
 * one row per measured text ROLE. The authoritative shape (real on-disk
 * artifact of the vendored text-measure calibrate step) is
 *   { roles: { <role>: { family, size, weight, cjk_chars_per_100px,
 *       latin_chars_per_100px, ..., longest_planned_line: {px, slide, text}
 *       | null } }, script_samples, source, generated_at, notes }
 * Coded defensively: missing/junk fields render an em-dash placeholder, a
 * non-object roles map renders nothing (the section stays hidden). The row
 * shows role name + family, size, the CJK and Latin chars-per-100px rates,
 * and the longest planned line (px + the slide that produced it). Pure.
 */
function renderCalibration(cal) {
  const c = cal && typeof cal === "object" && !Array.isArray(cal) ? cal : null;
  const roles = c?.roles && typeof c.roles === "object" && !Array.isArray(c.roles)
    ? Object.entries(c.roles)
    : [];
  if (!roles.length) return "";
  const dash = "—";
  // Workbench-v2 T12 num() guard: only real numbers and non-empty numeric
  // strings coerce — booleans (true → 1) and arrays ([4] → 4) must not.
  const num = (v) => {
    const numeric = typeof v === "number" || (typeof v === "string" && v.trim() !== "");
    const n = Number(v);
    return numeric && Number.isFinite(n) ? String(n) : dash;
  };
  const rows = roles.map(([name, role]) => {
    const r = role && typeof role === "object" && !Array.isArray(role) ? role : null;
    const family = String(r?.family ?? "").trim();
    const line = r?.longest_planned_line && typeof r.longest_planned_line === "object"
      ? r.longest_planned_line
      : null;
    const linePx = num(line?.px);
    const lineAt = String(line?.slide ?? "").trim();
    return `<tr>` +
      `<td class="cal-role"><b>${esc(name)}</b>` +
      (family ? `<span class="cal-family">${esc(family)}</span>` : "") +
      `</td>` +
      `<td>${num(r?.size)}</td>` +
      `<td>${num(r?.cjk_chars_per_100px)}</td>` +
      `<td>${num(r?.latin_chars_per_100px)}</td>` +
      `<td>${linePx === dash ? dash : `${linePx} px${lineAt ? ` · ${esc(lineAt)}` : ""}`}</td>` +
      `</tr>`;
  });
  return `<table class="cal-table"><thead><tr>` +
    `<th>${esc(t.calRole)}</th>` +
    `<th>${esc(t.calSize)}</th>` +
    `<th>${esc(t.calCjk)}</th>` +
    `<th>${esc(t.calLatin)}</th>` +
    `<th>${esc(t.calLine)}</th>` +
    `</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
