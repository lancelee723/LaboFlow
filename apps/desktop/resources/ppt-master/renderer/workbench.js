// PPT workbench entry (Workbench-v2 T12 split): state, bridge calls, project
// selector, preview/exports wiring and app boot. wb-i18n.js, wb-pipeline.js
// and wb-hero.js load before this module (classic scripts share one scope in
// load order).
const bridge = window.pluginBridge;

for (const [id, key] of [
  ["t-title", "title"], ["t-pages", "pages"], ["t-exports", "exports"],
  ["t-outline", "outline"], ["t-history", "history"],
  ["btn-refresh", "refresh"], ["btn-load", "load"],
]) document.getElementById(id).textContent = t[key];
for (const el of document.querySelectorAll("[data-i18n]")) {
  if (t[el.dataset.i18n]) el.textContent = t[el.dataset.i18n];
}
document.title = t.title;
const regenBtn = document.getElementById("btn-regen");
regenBtn.textContent = t.regen;
regenBtn.title = t.regenTitle;
const delBtn = document.getElementById("btn-del-page");
delBtn.textContent = t.del;
delBtn.title = t.delTitle;
document.getElementById("project-dir").placeholder = t.projectPh;
document.getElementById("preview-empty").textContent = t.emptyPages;
// `t-noexports` is (re)created by loadProject inside #exports-list, so it is
// absent on first paint — a hard null deref here killed the whole init script
// and left every button listener unattached.
document.getElementById("t-noexports")?.append(document.createTextNode(t.noExports));

let projectDir = "";
let pages = []; // { name, bytes, dir }
let pageIndex = 0;
let projectList = []; // ppt.listProjects rows (Workbench-v2 T2)
let lastBoundProjectDir = null; // session↔project binding (V5-T2)
let projectsLoaded = false; // suppress the empty-state flash before the first listing
let pendingConfirmDir = ""; // bootstrap pending.projectDir, refreshed by pollHero
let pipelineState = null; // ppt.getState's `state` for the loaded project (timeline gate facts)
let pipelineRecs = null; // ppt.getState's `recommendations` (gate summary fallback)
let pipelineListings = null; // ppt.getState's `listings` (timeline page/export counts)
let pipelineFiles = null; // ppt.getState's `files` flags (timeline spec/QC facts)
let openGate = 0; // which gate's confirmation summary is expanded (0 = none)
let previewStatus = null; // ppt.getPreviewStatus (legacy B), refreshed by pollHero

// ─────────── Work-surface skeleton: timeline + runtime pill ───────────
// The whole page hangs off five zones (#timeline / #runtime-pill / #hero /
// #preview / #exports). deriveTimeline (wb-pipeline.js) is the single source
// of truth for the pipeline view: ordered gate → spec → draw → quality →
// export nodes with done/active/pending/skipped statuses.

function renderStatusLine() {
  const line = document.getElementById("status-line");
  if (!line) return;
  line.classList.toggle("hidden", !projectDir);
  // pending is scoped to the loaded project: another project's pending
  // decision must not flip this line to "awaiting confirmation" (the hero
  // already points at the right project via pickProject).
  const pending = Boolean(projectDir) && pendingConfirmDir === projectDir;
  const last = projectList.find((p) => p.projectDir === projectDir)?.lastActivityMs ?? 0;
  const status = deriveStatus({ pending, lastActivityMs: last, nowMs: Date.now() });
  // 遗留 B: right after the user clicks Exit preview the line reports it —
  // with the saved-annotation note when there is anything to apply. A waiting
  // gate still wins (that headline outranks the just-closed preview).
  const previewClosed = previewStatus?.closedRecently === true;
  line.textContent = status === "await-confirm" ? t.stAwait
    : previewClosed
      ? (previewStatus.annotationsSaved ? t.stPreviewClosed : t.stPreviewClosedClean)
    : status === "working" ? t.stWorking
    : t.stReady;
}

function renderTimeline() {
  const list = document.getElementById("timeline-nodes");
  if (!list) return;
  // The 10s listing poll doubles as the timeline's refresh (Workbench-v2 T3
  // piggyback rule): page/export counts and the ~approximate stage times ride
  // lastActivityMs from those rows, so no extra timer exists.
  const last = projectList.find((p) => p.projectDir === projectDir)?.lastActivityMs ?? 0;
  const nodes = deriveTimeline({
    state: pipelineState,
    listings: pipelineListings,
    files: pipelineFiles,
    lastActivityMs: last,
  });
  list.innerHTML = nodes.map(timelineNodeHtml).join("");
  // V5-T5: the draw node's resume affordance — one click asks the main side
  // to resume the agent turn (the F-2 session-continue channel), since the
  // planning phase has no gate for the model to poll.
  const resumeBtn = list.querySelector("[data-draw-resume]");
  if (resumeBtn) {
    resumeBtn.addEventListener("click", () => {
      void bridge
        .invoke("ppt.resumePipeline", { projectDir })
        .catch(() => undefined);
      resumeBtn.disabled = true;
      resumeBtn.textContent = t.resumeSent ?? "已请求继续";
    });
  }
}

// Gate confirmation summary (Workbench-v2 T3): clicking a closed gate node in
// the timeline reveals what that decision recorded — resultSummary.keys from the
// state machine (ppt-state.js readStageResult) as chips, plus the confirm time.
// resultSummary only exists after the agent's first read of result.json (the
// read-once rule); until then the submitted recommendations' keys stand in —
// result.json wraps exactly that object.
// Stage-2 note (updated Workbench-v2 T5): resultSummary now ALSO carries
// selectedDirection (the winning direction's display name) and
// proactiveBooleans; the "index is recorded nowhere" limitation below is
// gone. The gate summary itself still shows keys + time.
function gateSummaryHtml(n) {
  const st = pipelineState?.stages?.[n === 1 ? "stage1" : "stage2"];
  if (!st || (st.status !== "confirmed" && st.status !== "waived")) return "";
  const time = shortTime(st.confirmedAt);
  const keys = Array.isArray(st.resultSummary?.keys) && st.resultSummary.keys.length
    ? st.resultSummary.keys
    : Object.keys(pipelineRecs?.[n === 1 ? "stage1" : "stage2"] ?? {});
  const head = `<b>${esc(n === 1 ? t.stage1 : t.stage2)}</b>` +
    (st.status === "waived" ? ` · ${esc(t.waive)}` : "") +
    (time ? ` · ${time}` : "");
  const chips = keys.length
    ? `<div class="row" style="margin-top:4px">` +
      keys.map((k) => `<span class="chip">${esc(k)}</span>`).join("") +
      `</div>`
    : "";
  return `${head}${chips}`;
}

function toggleGateSummary(n) {
  const box = document.getElementById("gate-summary");
  if (!box) return;
  if (openGate === n) {
    openGate = 0;
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  const content = gateSummaryHtml(n);
  if (!content) return; // gate not closed yet — nothing to reveal
  openGate = n;
  box.innerHTML = content;
  box.classList.remove("hidden");
}

/** A project switch must not carry the previous project's summary over. */
function resetGateSummary() {
  openGate = 0;
  const box = document.getElementById("gate-summary");
  if (!box) return;
  box.classList.add("hidden");
  box.innerHTML = "";
}

// EVERY gate node carries data-gate (pending ones too); only CLOSED ones
// (done/skipped) also get tabindex, so keyboard users reach only actionable
// nodes. The delegated handlers can still toggle blindly on whatever matches
// — a gate that is not closed yet has no summary and toggleGateSummary
// (its `if (!content) return`) leaves it alone.
document.getElementById("timeline").addEventListener("click", (event) => {
  const node = event.target.closest("[data-gate]");
  if (!node) return;
  const n = Number(node.dataset.gate);
  toggleGateSummary(n);
});
document.getElementById("timeline").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const node = event.target.closest("[data-gate]");
  if (!node) return;
  event.preventDefault();
  const n = Number(node.dataset.gate);
  toggleGateSummary(n);
});

// ───────────── Quality report section (Workbench-v2 T10, T11) ─────────────
// The QC gate's per-page results render under the timeline (#quality), and
// T11 adds the text-measure calibration table (#calibration) inside the same
// section — a QC report and the calibration are produced at different points
// of the pipeline, so each body renders independently and the section shows
// while either has content. The bridge's ppt.readReport whitelist serves
// {final?, early?, calibration?}; the final-gate report wins and the early
// one stands in before the final gate has run.
// refreshQualityReports is called from loadProject — the only path that
// refreshes pipelineFiles, so the files.qualityReport / files.calibration
// flags flipping true land here through the existing load paths (no new
// timer). Empty or absent artifacts keep their part hidden.

let qualityReports = null; // ppt.readReport's {reports} for the loaded project
let qualityReportsDir = ""; // which project qualityReports belongs to
let qualityRefreshSeq = 0; // monotonic token: only the newest refresh may paint


/**
 * Load + render the loaded project's QC reports and calibration table.
 * Each part hides unless its flag is true AND the whitelisted artifact
 * parses into content (findings for the report, roles for the calibration).
 * A project switch clears synchronously so the previous project's rows
 * never flash while the new bundle loads.
 */
async function refreshQualityReports() {
  const section = document.getElementById("quality");
  const body = document.getElementById("quality-body");
  const qTitle = document.getElementById("quality-title");
  const calSec = document.getElementById("calibration");
  const calBody = document.getElementById("calibration-body");
  if (!section || !body) return;
  // Stale-async guard (§9): every invocation invalidates any refresh still
  // in flight, so only the newest one may paint — a project switch or a
  // flag flip mid-await can never overwrite the newer state with old rows.
  const seq = ++qualityRefreshSeq;
  const requestedDir = projectDir;
  const clear = () => {
    qualityReports = null;
    body.innerHTML = "";
    if (qTitle) qTitle.classList.remove("hidden");
    if (calBody) calBody.innerHTML = "";
    if (calSec) calSec.classList.add("hidden");
    section.classList.add("hidden");
  };
  if (!projectDir ||
      (pipelineFiles?.qualityReport !== true && pipelineFiles?.calibration !== true)) {
    clear();
    qualityReportsDir = projectDir;
    return;
  }
  if (qualityReportsDir !== projectDir) {
    clear();
    qualityReportsDir = projectDir;
  }
  let data;
  try {
    data = await bridge.invoke("ppt.readReport", { projectDir });
  } catch {
    return; // bridge busy — keep the previous render; the next load retries
  }
  if (seq !== qualityRefreshSeq || requestedDir !== projectDir) return;
  if (data?.error || !data?.reports) {
    clear();
    return;
  }
  qualityReports = data.reports;
  const qHtml = renderQualityReports(qualityReports);
  body.innerHTML = qHtml;
  // No QC rows → hide the QC heading too, so the section never shows an
  // empty "quality report" block above the calibration table.
  if (qTitle) qTitle.classList.toggle("hidden", !qHtml);
  const calHtml = renderCalibration(qualityReports?.calibration);
  if (calBody) calBody.innerHTML = calHtml;
  if (calSec) calSec.classList.toggle("hidden", !calHtml);
  section.classList.toggle("hidden", !qHtml && !calHtml);
}

/** Match a report entry's filename stem against the loaded pages list and
 * move the preview pager there (svg_output pages are searched first — the
 * same first-match order the preview itself uses). */
function jumpToReportPage(file) {
  const stem = (name) => String(name ?? "").replace(/\.svg$/i, "").toLowerCase();
  const target = stem(file);
  if (!target) return false;
  const idx = pages.findIndex((p) => stem(p.name) === target);
  if (idx < 0) return false;
  pageIndex = idx;
  void showPage();
  return true;
}

// Delegated handlers live on the static section — refreshQualityReports
// re-renders #quality-body's inner HTML on every project load.
document.getElementById("quality").addEventListener("click", (event) => {
  const item = event.target.closest("[data-jump-page]");
  if (item) jumpToReportPage(item.dataset.jumpPage);
});
document.getElementById("quality").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const item = event.target.closest("[data-jump-page]");
  if (!item) return;
  event.preventDefault();
  jumpToReportPage(item.dataset.jumpPage);
});

const pill = document.getElementById("runtime-pill");
let pillBusy = false;

function renderPill(runtime, jobLine) {
  const ready = !jobLine && runtime?.stage === "ready";
  pill.classList.toggle("ready", ready);
  pill.classList.toggle("busy", Boolean(jobLine));
  const label = jobLine ?? (ready ? t.rtReady : `${t.rtNotReady} · ${runtime?.diag ?? ""}`);
  pill.title = ready ? t.rtReady : t.rtReinstall;
  pill.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="pill-label">${esc(label)}</span>`;
}

async function refreshRuntime() {
  const { runtime } = await bridge.invoke("ppt.runtimeStatus");
  renderPill(runtime);
}

async function refreshJobs() {
  const { jobs } = await bridge.invoke("ppt.jobStatus");
  const active = (jobs ?? []).find((j) => j.status === "running");
  if (active) {
    renderPill(null, `${active.id}: ${active.status} — ${(active.logTail ?? []).slice(-1)[0] ?? ""}`);
    setTimeout(refreshJobs, 2000);
  } else {
    await refreshRuntime();
  }
}

// Replaces the old #btn-setup: when the runtime is not ready the pill itself
// starts the setup flow; while a job runs the busy class blocks re-entry.
pill.addEventListener("click", async () => {
  if (pillBusy || pill.classList.contains("ready") || pill.classList.contains("busy")) return;
  pillBusy = true;
  pill.classList.add("busy");
  try {
    await bridge.invoke("ppt.setup");
  } catch {
    /* submission failed — refreshJobs below repaints the pill from real state */
  } finally {
    pillBusy = false;
    pill.classList.remove("busy");
  }
  refreshJobs();
});

// ─────────────── Project selector (Workbench-v2 T2) ─────────────
// The selector is the default entry: ppt.listProjects feeds a compact
// dropdown, polled every 10s (also when the panel becomes visible again).
// Selection priority lives in pickProject — a bootstrap-pending project
// wins (the confirm hero above the preview belongs to it), otherwise the
// most-recent entry (the bridge sorts by lastActivityMs desc). Auto-selection
// follows a pending decision anywhere; without one it only fills an empty
// selection, so the poll never yanks an explicit user choice back.

function pickProject(list, pendingDir, boundDir) {
  const items = Array.isArray(list) ? list : [];
  if (pendingDir) {
    const hit = items.find((p) => p?.projectDir === pendingDir);
    if (hit) return hit;
  }
  // The session↔project binding (recorded at stage submission) beats
  // recency: a fresh conversation working on an older project must not
  // have the selector snap back to the most-recent one.
  if (boundDir) {
    const hit = items.find((p) => p?.projectDir === boundDir);
    if (hit) return hit;
  }
  return items[0] ?? null;
}

function relTime(ms) {
  const diff = Date.now() - (ms || 0);
  if (!ms) return t.relNever; // empty project: no activity recorded yet
  if (diff < 60e3) return t.relNow; // also covers clock skew into the future
  const [n, unit] = diff < 3600e3 ? [diff / 60e3, t.unitMin]
    : diff < 86400e3 ? [diff / 3600e3, t.unitHour]
    : [diff / 86400e3, t.unitDay];
  return `${t.agoPrefix}${Math.floor(n)}${unit}${t.agoSuffix}`;
}

function stageChip(p) {
  if (p?.s1 === "confirmed" && p?.s2 === "confirmed") return `<span class="chip done">${esc(t.chipDone)}</span>`;
  return `<span class="chip">${esc(p?.s1 === "confirmed" ? t.chipS2 : t.chipS1)}</span>`;
}

function renderProjectSelector() {
  const label = document.getElementById("project-selector-label");
  const list = document.getElementById("project-list");
  if (!label || !list) return;
  list.setAttribute("aria-label", t.pickProject);
  const current = projectList.find((p) => p.projectDir === projectDir);
  label.innerHTML = current
    ? `<b>${esc(current.name)}</b>${stageChip(current)}`
    : `<span class="muted">${esc(t.pickProject)}</span>`;
  list.innerHTML = projectList.length
    ? projectList.map((p) =>
        `<div class="project-item${p.projectDir === projectDir ? " selected" : ""}" data-dir="${esc(p.projectDir)}"` +
        ` role="option" tabindex="0" aria-selected="${p.projectDir === projectDir}">` +
        `<div class="p-line1"><span class="p-name">${esc(p.name)}</span>${stageChip(p)}</div>` +
        `<div class="p-meta">${p.svgPages}${esc(t.unitPages)} · ${p.exports}${esc(t.unitExports)} · ${esc(relTime(p.lastActivityMs))}</div>` +
        `</div>`).join("")
    : (projectsLoaded ? `<div class="p-meta" style="padding:4px 9px">${esc(t.noProjects)}</div>` : "");
}

function maybeAutoSelect() {
  const pick = pickProject(projectList, pendingConfirmDir, lastBoundProjectDir);
  if (!pick || pick.projectDir === projectDir) return;
  // While a pending decision points somewhere, follow only that project (it
  // wins inside pickProject; if it is not listed yet, wait for the next poll
  // instead of loading an unrelated most-recent project).
  if (pendingConfirmDir && pick.projectDir !== pendingConfirmDir) return;
  if (pendingConfirmDir || !projectDir) void loadProject(pick.projectDir);
}

async function refreshProjects() {
  try {
    const payload = await bridge.invoke("ppt.listProjects");
    projectList = Array.isArray(payload.projects) ? payload.projects : [];
    lastBoundProjectDir = payload.boundProjectDir ?? null;
    projectsLoaded = true;
  } catch {
    return; // bridge busy; the next tick retries
  }
  renderProjectSelector();
  // Piggyback (Workbench-v2 T3/T9): the 10s listing poll is the status line's
  // activity refresh — no extra timer. lastActivityMs comes from these rows
  // and also feeds the timeline's approximate stage times.
  renderStatusLine();
  renderTimeline();
  maybeAutoSelect();
}

document.getElementById("project-list").addEventListener("click", (event) => {
  const item = event.target.closest("[data-dir]");
  if (!item) return;
  document.getElementById("project-selector").open = false;
  void loadProject(item.dataset.dir);
});
document.getElementById("project-list").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const item = event.target.closest("[data-dir]");
  if (!item) return;
  event.preventDefault();
  item.click();
});
renderProjectSelector();
renderTimeline(); // first paint: all-pending nodes until a project loads
// V6-T1: manual force-reset — re-poll listing + state from disk and repaint
// everything (user review: the timeline must never feel stuck).
{
  const resetBtn = document.getElementById("tl-reset");
  if (resetBtn) {
    resetBtn.textContent = t.tlReset ?? "↻ 刷新";
    resetBtn.title = t.tlResetTitle ?? "强制刷新管线状态";
    resetBtn.addEventListener("click", () => {
      void refreshProjects();
      void refreshQualityReports();
      if (projectDir) void loadProject(projectDir);
      else renderTimeline();
    });
  }
}

async function loadProject(dir) {
  const next = String(dir ?? projectDir ?? "").trim();
  if (!next) return;
  projectDir = next;
  // Keep the collapsed 高级 path input in sync with the selection.
  document.getElementById("project-dir").value = next;
  const data = await bridge.invoke("ppt.getState", { projectDir });
  if (data.error) return;
  pipelineState = data.state ?? null;
  pipelineRecs = data.recommendations ?? null;
  pipelineListings = data.listings ?? null;
  pipelineFiles = data.files ?? null;
  resetGateSummary();
  // FR-PPT-13: the per-project export toggle reflects saved prefs.
  try {
    const { prefs } = await bridge.invoke("ppt.getExportPrefs", { projectDir });
    document.getElementById("opt-native-charts").checked = prefs?.nativeChartsAndTables === true;
  } catch { document.getElementById("opt-native-charts").checked = false; }
  pages = [
    ...(data.listings?.svgPages ?? []).map((p) => ({ ...p, dir: "svg_output" })),
    ...(data.listings?.svgFinal ?? []).map((p) => ({ ...p, dir: "svg_final" })),
  ];
  // V6-T3: a loaded project reveals the working sections; the empty home
  // keeps them hidden (user review — dead headers read as leftovers).
  for (const id of ["preview", "exports"]) {
    document.getElementById(id)?.closest("section")?.classList.remove("hidden");
  }
  // After `pages`, so the drawing node's count badge reflects THIS project.
  renderTimeline();
  renderStatusLine();
  // Workbench-v2 T10/T11: the QC report + calibration ride the same load
  // path — this is the only place pipelineFiles refreshes, so the
  // qualityReport / calibration flags flipping true land here (piggyback;
  // no extra timer).
  void refreshQualityReports();
  pageIndex = 0;
  document.getElementById("pager").classList.toggle("hidden", pages.length === 0);
  if (pages.length === 0) {
    document.getElementById("preview-empty").textContent = t.noPagesYet;
  } else {
    await showPage();
  }
  const exportsSection = document.getElementById("exports-list")?.closest("section");
  const exportsList = document.getElementById("exports-list");
  const files = data.listings?.exports ?? [];
  if (exportsSection) exportsSection.classList.toggle("hidden", !files.length);
  exportsList.innerHTML = files.length
    ? files.map((f) =>
        `<div class="f"><span>${esc(f.name)}</span><span class="row"><span class="muted">${bytes(f.bytes)}</span>` +
        `<span class="linkish" data-open="${esc(projectDir + "/exports")}">${esc(t.open)}</span></span></div>`).join("")
    : "";
  renderOutline();
  renderHistory(data);
}

/** FR-PPT-18 outline tree: deck root → draft/final page groups → per-page nodes. */
function renderOutline() {
  const tree = document.getElementById("outline-tree");
  if (!tree) return;
  tree.classList.remove("hidden");
  const deck = projectDir.split("/").filter(Boolean).pop() || projectDir;
  const groups = [
    { label: "svg_output", items: pages.filter((p) => p.dir === "svg_output") },
    { label: "svg_final", items: pages.filter((p) => p.dir === "svg_final") },
  ];
  tree.innerHTML =
    `<div class="outline-root">${esc(deck)}</div>` +
    groups
      .filter((g) => g.items.length)
      .map(
        (g) =>
          `<div class="outline-group"><div class="outline-group-label">${esc(g.label)}</div>` +
          g.items
            .map((p, i) => {
              const globalIndex = pages.indexOf(p);
              return `<div class="outline-page linkish" data-page="${globalIndex}">${esc(p.name)}${p.bytes ? ` · ${bytes(p.bytes)}` : ""}</div>`;
            })
            .join("") +
          `</div>`,
      )
      .join("");
  tree.querySelectorAll(".outline-page").forEach((node) => {
    node.addEventListener("click", () => {
      pageIndex = Number(node.dataset.page);
      showPage();
    });
  });
}

/** FR-PPT-18 version history: backup snapshots taken at each finalize_svg run. */
function renderHistory(data) {
  const section = document.getElementById("history")?.closest("section");
  const panel = document.getElementById("history");
  if (!panel || !section) return;
  const snaps = data.listings?.backups ?? [];
  if (!snaps.length) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  panel.classList.remove("hidden");
  panel.innerHTML = snaps
    .map((s) => `<div class="f"><span>${esc(s.name)}</span></div>`).join("");
}

async function showPage() {
  const page = pages[pageIndex];
  document.getElementById("pg-label").textContent = `${pageIndex + 1} / ${pages.length}`;
  document.getElementById("pg-placeholder").textContent = page.name + (page.bytes ? ` · ${bytes(page.bytes)}` : "");
  // FR-PPT-04 页级操作: one-click regenerate instruction lands on the
  // clipboard; the user pastes it into the chat to drive the agent.
  const regen = document.getElementById("btn-regen");
  if (regen) {
    regen.onclick = async () => {
      const instruction = `重新生成第 ${pageIndex + 1} 页（${page.name}）：`;
      try {
        await navigator.clipboard.writeText(instruction);
        regen.textContent = t.copied;
        window.setTimeout(() => { regen.textContent = t.regen; }, 1200);
      } catch { regen.textContent = t.copyFailed; }
    };
  }
  const { svg, error } = await bridge.invoke("ppt.readSvg", { path: `${projectDir}/${page.dir}/${page.name}` });
  const preview = document.getElementById("preview-stage");
  if (error || !svg) {
    preview.innerHTML = `<span class="muted">${esc(error ?? "empty")}</span>`;
    return;
  }
  preview.innerHTML = svg;
}

document.getElementById("btn-refresh").addEventListener("click", refreshRuntime);
// Advanced path: the typed value always wins over the current selection.
document.getElementById("btn-load").addEventListener("click", () => {
  void loadProject(document.getElementById("project-dir").value);
});
// FR-PPT-04: delete + reorder operate on the pipeline's page files; the
// result is the refreshed listing so the pager stays truthful.
document.getElementById("btn-del-page").addEventListener("click", async () => {
  const page = pages[pageIndex];
  if (!page || !projectDir) return;
  if (!window.confirm(t.confirmDel)) return;
  const result = await bridge.invoke("ppt.deletePage", {
    projectDir, dir: page.dir, name: page.name,
  });
  if (result?.error) { document.getElementById("pg-placeholder").textContent = result.error; return; }
  await loadProject();
  pageIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));
  if (pages.length) await showPage();
});
async function movePage(direction) {
  const page = pages[pageIndex];
  if (!page || !projectDir) return;
  const result = await bridge.invoke("ppt.movePage", {
    projectDir, dir: page.dir, name: page.name, direction,
  });
  if (result?.error) { document.getElementById("pg-placeholder").textContent = result.error; return; }
  await loadProject();
  pageIndex = pages.findIndex((p) => p.dir === page.dir && p.name === page.name);
  if (pageIndex < 0) pageIndex = 0;
  if (pages.length) await showPage();
}
document.getElementById("btn-move-prev").addEventListener("click", () => void movePage("prev"));
document.getElementById("btn-move-next").addEventListener("click", () => void movePage("next"));
// FR-PPT-13: persist the toggle per project.
document.getElementById("opt-native-charts").addEventListener("change", (event) => {
  if (!projectDir) return;
  void bridge.invoke("ppt.setExportPrefs", {
    projectDir,
    prefs: { nativeChartsAndTables: event.target.checked },
  });
});

document.getElementById("pg-prev").addEventListener("click", () => { if (pages.length) { pageIndex = (pageIndex - 1 + pages.length) % pages.length; showPage(); } });
document.getElementById("pg-next").addEventListener("click", () => { if (pages.length) { pageIndex = (pageIndex + 1) % pages.length; showPage(); } });
document.addEventListener("keydown", (event) => {
  // TEXTAREA too: the Stage-1 form (T6) types prose — arrow keys inside it
  // must move the caret, not flip the preview pager.
  if (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.closest?.("#timeline")) return;
  if (event.key === "ArrowLeft") document.getElementById("pg-prev").click();
  if (event.key === "ArrowRight") document.getElementById("pg-next").click();
});
document.getElementById("exports-list").addEventListener("click", (event) => {
  const target = event.target.closest("[data-open]");
  if (target) bridge.invoke("ppt.openPath", { path: target.dataset.open });
});

setInterval(pollHero, 2000);
setInterval(refreshProjects, 10000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { void pollHero(); void refreshProjects(); }
});
void pollHero();
void refreshProjects();

refreshRuntime();
