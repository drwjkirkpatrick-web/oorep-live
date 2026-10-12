/* OORep Live renderer — plain ES module, no framework.
 * NOTE on innerHTML: every interpolated dynamic value passes through esc()
 * (full HTML-entity escaping); content comes from the app's own read-only
 * embedded SQLite and local file stats, never from remote input. */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = (n) => (n ?? 0).toLocaleString("en-US");
const fmtKB = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : b > 1e3 ? (b / 1e3).toFixed(1) + " KB" : b + " B";

const api = window.oorep;
const state = {
  symptoms: [],
  results: [],
  candidates: {},
  liveItems: [],
  telemetry: null,
  stats: null,
  runningCase: false,
};

/* ── boot ─────────────────────────────────────────────────────────── */
async function boot() {
  wireNav();
  api.onLiveEvent(handleLiveEvent);
  try {
    state.stats = await api.getStats();
    if (state.stats.ready) setDbBadge("ready", `engine ready · ${fmtInt(state.stats.rubrics)} rubrics · ${fmtInt(state.stats.links)} links`);
    else setDbBadge("error", "engine failed");
  } catch (e) {
    setDbBadge("error", "engine failed: " + esc(String(e)));
  }
  render(viewFromHash());
  setInterval(async () => {
    if (currentView === "live") {
      state.telemetry = await api.live.telemetry();
      updateLiveChart();
    }
  }, 2000);
}

function wireNav() {
  $$("#nav .nav-btn").forEach((b) => {
    b.addEventListener("click", () => {
      location.hash = b.dataset.view;
    });
  });
  window.addEventListener("hashchange", () => render(viewFromHash()));
}

function viewFromHash() {
  const h = (location.hash || "#repertorize").slice(1);
  return ["repertorize", "search", "cycles", "live", "about"].includes(h) ? h : "repertorize";
}

let currentView = "repertorize";
function render(view) {
  currentView = view;
  $$("#nav .nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const main = $("#main");
  main.innerHTML = "";
  if (view === "repertorize") renderRepertorize(main);
  else if (view === "search") renderSearch(main);
  else if (view === "cycles") renderCycles(main);
  else if (view === "live") renderLive(main);
  else renderAbout(main);
}

function setDbBadge(cls, text) {
  const badge = $("#db-badge");
  badge.className = "db-badge " + cls;
  $("#db-badge-text").innerHTML = text;
}

function handleLiveEvent(e) {
  if (e && e.type === "change" && Array.isArray(e.data)) {
    state.liveItems = e.data;
    if (currentView === "live") updateWatchList(e.data);
    logEvent(`source data changed (${e.data.filter((i) => i.exists).length} files live)`);
  } else if (e && e.type === "stats") {
    state.stats = e.data;
  }
}

const eventLogs = [];
function logEvent(msg) {
  const t = new Date().toLocaleTimeString();
  eventLogs.unshift({ t, msg });
  if (eventLogs.length > 60) eventLogs.pop();
  const el = $("#event-log");
  if (el) el.innerHTML = eventLogs.map((e) => `<div><span class="t">${esc(e.t)}</span> ${esc(e.msg)}</div>`).join("");
}

/* ── repertorize view ─────────────────────────────────────────────── */
function renderRepertorize(main) {
  const view = document.createElement("div");
  view.className = "view";
  view.innerHTML = `
    <h2 class="view-title">Repertorize</h2>
    <p class="view-sub">Enter case symptoms in patient language. The clinical mapper expands phrasing, retrieves reviewable rubrics, and scores remedies by classical grade sums (Kent/Publicum).</p>
    <div class="panel">
      <h3>Case symptoms</h3>
      <div class="row"><input id="sym-input" type="text" placeholder="e.g. headache worse morning, thirst in small sips…" autocomplete="off"><button class="primary" id="sym-add">Add</button></div>
      <div class="row wrap mt" id="sym-chips"></div>
      <div class="row mt">
        <button class="primary" id="run-case" disabled>Run Repertorization</button>
        <button class="ghost" id="load-example">Load example case</button>
        <span id="case-status" class="muted small"></span>
      </div>
    </div>
    <div class="panel" id="candidates-panel" style="display:none">
      <h3>Rubric candidates per symptom <span class="muted small">(retrieved, practitioner-reviewable)</span></h3>
      <div id="candidates"></div>
    </div>
    <div class="panel" id="results-panel" style="display:none">
      <h3>Remedy ranking <span class="muted small">(grade sum · top 20)</span></h3>
      <div id="results"></div>
    </div>`;
  main.appendChild(view);

  const input = $("#sym-input", view);
  const add = () => {
    const v = input.value.trim();
    if (!v) return;
    state.symptoms.push(v);
    input.value = "";
    refreshChips();
  };
  $("#sym-add", view).addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  $("#load-example", view).addEventListener("click", () => {
    state.symptoms = ["headache worse morning", "nausea", "irritability", "thirst small sips"];
    refreshChips();
  });
  $("#run-case", view).addEventListener("click", runCase);
  refreshChips();
}

function refreshChips() {
  const chips = $("#sym-chips");
  if (!chips) return;
  chips.innerHTML = state.symptoms.map((s, i) =>
    `<span class="chip">${esc(s)}<button data-i="${i}" title="remove">×</button></span>`).join("");
  $$("button", chips).forEach((b) => b.addEventListener("click", () => {
    state.symptoms.splice(+b.dataset.i, 1);
    refreshChips();
  }));
  const run = $("#run-case");
  if (run) run.disabled = state.symptoms.length === 0;
}

async function runCase() {
  const btn = $("#run-case");
  const status = $("#case-status");
  if (!btn || state.runningCase) return;
  state.runningCase = true;
  btn.disabled = true;
  status.innerHTML = `<span class="spin"></span> retrieving rubrics & scoring…`;
  $("#results-panel").style.display = "none";
  $("#candidates-panel").style.display = "none";
  const t0 = performance.now();
  try {
    const results = await api.repertorize(state.symptoms, { topN: 20 });
    state.results = results;
    const dt = Math.round(performance.now() - t0);
    status.textContent = `done in ${dt} ms`;
    renderCandidatesPanel();
    renderResultsPanel();
  } catch (e) {
    status.textContent = "error: " + String(e);
  } finally {
    state.runningCase = false;
    const run = $("#run-case");
    if (run) run.disabled = state.symptoms.length === 0;
  }
}

async function renderCandidatesPanel() {
  const panel = $("#candidates-panel");
  panel.style.display = "";
  const box = $("#candidates");
  box.innerHTML = `<span class="spin"></span>`;
  const rows = await Promise.all(state.symptoms.map(async (s) => {
    const cands = await api.candidatesForSymptom(s, 5);
    const norm = await api.normalizeSymptom(s);
    return { s, norm, cands };
  }));
  state.candidates = rows;
  box.innerHTML = rows.map(({ s, norm, cands }) => `
    <div style="margin-bottom:14px">
      <div class="mono" style="color:var(--accent-2)">${esc(s)}</div>
      ${norm.expanded_query !== norm.cleaned ? `<div class="muted small mono">→ ${esc(norm.expanded_query)}</div>` : ""}
      <table><tbody>
        ${cands.map((c) => `
          <tr>
            <td class="mono">#${c.rank}</td>
            <td>${esc(c.rubric)}</td>
            <td><span class="badge src">${esc(c.source)}</span></td>
            <td class="mono muted">${c.remedy_count} rem</td>
            <td class="mono muted">${c.retrieval_score.toFixed(3)}</td>
          </tr>`).join("")}
      </tbody></table>
    </div>`).join("");
}

function renderResultsPanel() {
  const panel = $("#results-panel");
  panel.style.display = "";
  const max = Math.max(...state.results.map((r) => r.score), 1);
  $("#results").innerHTML = `
    <table>
      <thead><tr><th>#</th><th>Remedy</th><th>Score</th><th>Rubrics</th><th>Cycle</th><th>Key matches</th></tr></thead>
      <tbody>
        ${state.results.map((r, i) => `
          <tr>
            <td class="mono muted">${i + 1}</td>
            <td><b>${esc(r.abbrev)}</b><div class="muted small">${esc(r.name)}</div></td>
            <td><span class="score-pill">${r.score}</span>
                <div class="bar mt"><div style="width:${(r.score / max * 100).toFixed(1)}%"></div></div></td>
            <td class="mono">${r.match_count}</td>
            <td>${r.cycle_analysis?.remedy_cycle
              ? `<span class="badge ${r.cycle_analysis.meets_threshold ? "ok" : "off"}">${r.cycle_analysis.segments_matched_count}/${r.cycle_analysis.total_segments}</span>`
              : `<span class="badge off">—</span>`}</td>
            <td class="small muted">${r.matches.slice(0, 3).map((m) =>
              `${esc(m.rubric)} <span class="grade-${Math.min(m.weight, 4)}">(${m.weight})</span>`).join("<br>")}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

/* ── search view ──────────────────────────────────────────────────── */
function renderSearch(main) {
  const view = document.createElement("div");
  view.className = "view";
  view.innerHTML = `
    <h2 class="view-title">Repertory Search</h2>
    <p class="view-sub">Lexical / vector / hybrid rubric search across ${state.stats ? fmtInt(state.stats.rubricsDistinct) : "74,785"} distinct rubrics (Kent-DE + Publicum).</p>
    <div class="panel">
      <div class="row">
        <input id="q" type="text" placeholder="search rubrics… e.g. headache morning" autocomplete="off">
        <select id="mode"><option value="hybrid">hybrid</option><option value="lexical">lexical</option><option value="vector">vector</option></select>
        <button class="primary" id="go">Search</button>
      </div>
    </div>
    <div class="panel" id="rubric-panel" style="display:none">
      <h3>Rubrics</h3><div id="rubric-results"></div>
    </div>
    <div class="panel" id="rem-panel" style="display:none">
      <h3>Remedies for rubric</h3><div id="rem-results"></div>
    </div>`;
  main.appendChild(view);
  const q = $("#q", view);
  const go = async () => {
    const query = q.value.trim();
    if (!query) return;
    $("#rubric-panel").style.display = "none";
    $("#rem-panel").style.display = "none";
    const hits = await api.searchRubrics(query, $("#mode").value, 30);
    $("#rubric-panel").style.display = "";
    $("#rubric-results").innerHTML = hits.length ? `
      <table><thead><tr><th>#</th><th>Rubric</th><th>Source</th><th>Score</th></tr></thead><tbody>
      ${hits.map((h, i) => `
        <tr data-id="${h.id}">
          <td class="mono muted">${i + 1}</td>
          <td><a href="#" class="rubric-link">${esc(h.fullpath)}</a></td>
          <td><span class="badge src">${esc(h.source)}</span></td>
          <td class="mono">${h.score.toFixed(3)}</td>
        </tr>`).join("")}
      </tbody></table>` : `<div class="empty">no rubrics found</div>`;
    $$(".rubric-link", $("#rubric-results")).forEach((a) =>
      a.addEventListener("click", (e) => { e.preventDefault(); showRemedies(+a.closest("tr").dataset.id); }));
  };
  $("#go", view).addEventListener("click", go);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
}

async function showRemedies(rubricId) {
  const rems = await api.remediesForRubric(rubricId);
  $("#rem-panel").style.display = "";
  $("#rem-results").innerHTML = rems.length ? `
    <table><thead><tr><th>Remedy</th><th>Abbrev</th><th>Grade</th></tr></thead><tbody>
    ${rems.slice(0, 80).map((r) => `
      <tr><td>${esc(r.name)}</td><td class="mono">${esc(r.abbrev)}</td>
      <td class="mono"><span class="grade-${Math.min(r.weight, 4)}">${"●".repeat(Math.min(r.weight, 4))} ${r.weight}</span></td></tr>`).join("")}
    </tbody></table>
    ${rems.length > 80 ? `<div class="muted small mt">+ ${rems.length - 80} more…</div>` : ""}` : "";
}

/* ── cycles view ──────────────────────────────────────────────────── */
function renderCycles(main) {
  const view = document.createElement("div");
  view.className = "view";
  view.innerHTML = `
    <h2 class="view-title">Cycles & Segments</h2>
    <p class="view-sub">Herscu cycles for the case symptoms in the Repertorize view — segment coverage and generalization hits.</p>
    <div id="cycles-body"></div>`;
  main.appendChild(view);
  const body = $("#cycles-body", view);
  if (!state.results.length) {
    body.innerHTML = `<div class="panel"><div class="empty">Run a case in Repertorize first — cycle analysis attaches to its top remedies.</div></div>`;
    return;
  }
  body.innerHTML = state.results.slice(0, 12).map((r) => {
    const c = r.cycle_analysis;
    if (!c || !c.remedy_cycle) {
      return `<div class="panel"><b>${esc(r.abbrev)}</b> <span class="badge off">no registered cycle</span></div>`;
    }
    const pct = c.total_segments ? Math.round(c.segment_coverage * 100) : 0;
    return `<div class="panel">
      <h3>${esc(r.abbrev)} — ${esc(c.remedy_cycle)} <span class="badge ${c.meets_threshold ? "ok" : "off"}">${c.meets_threshold ? "meets threshold" : "below threshold"}</span></h3>
      ${c.cycle_sentence ? `<p class="muted small" style="margin-bottom:10px">${esc(c.cycle_sentence)}</p>` : ""}
      <div class="kv">
        <span class="k">Segments matched</span><span class="mono">${c.segments_matched_count} / ${c.total_segments} (${pct}%)</span>
        <span class="k">Symptom coverage</span><span class="mono">${(c.coverage * 100).toFixed(1)}%</span>
        <span class="k">Matched segments</span><span>${c.segment_matches.map(esc).join(", ") || "—"}</span>
        <span class="k">Generalized hits</span><span>${c.generalized_hits.map(esc).join(", ") || "—"}</span>
      </div>
    </div>`;
  }).join("");
}

/* ── live view ────────────────────────────────────────────────────── */
function renderLive(main) {
  const view = document.createElement("div");
  view.className = "view";
  view.innerHTML = `
    <h2 class="view-title">Live Data</h2>
    <p class="view-sub" id="live-sub">Real-time monitoring of the OOREP source data and engine telemetry.</p>
    <div class="stat-grid" id="stat-grid"></div>
    <div class="panel">
      <h3>Query rate (last 10 min)</h3>
      <canvas id="live-chart" width="900" height="120"></canvas>
    </div>
    <div class="panel">
      <h3>Source data files <span class="muted small" id="watch-root"></span></h3>
      <div class="watch-list" id="watch-list"><span class="spin"></span></div>
    </div>
    <div class="panel">
      <h3>Query telemetry</h3>
      <div id="telemetry" class="muted small">no queries yet</div>
    </div>
    <div class="panel">
      <h3>Event log</h3>
      <div class="event-log" id="event-log"></div>
    </div>`;
  main.appendChild(view);
  logEvent("live view opened");
  api.live.snapshot().then((items) => {
    state.liveItems = items;
    updateWatchList(items);
  });
  api.live.status().then((st) => {
    $("#watch-root").textContent = st.srcRoot ? `· watching ${st.srcRoot}` : "· no source project found";
  });
  renderLiveStats();
  // draw immediately (may show the empty-state), then poll
  updateLiveChart();
}

async function renderLiveStats() {
  const grid = $("#stat-grid");
  if (!grid) return;
  let s = state.stats;
  if (!s || !s.ready) {
    try { s = await api.getStats(); state.stats = s; } catch { s = null; }
  }
  const tel = await api.live.telemetry();
  const cells = [
    ["Remedies", fmtInt(s?.remedies)],
    ["Rubrics", fmtInt(s?.rubricsDistinct)],
    ["Rubric links", fmtInt(s?.links)],
    ["Vector rows", fmtInt(s?.vectorRows)],
    ["Cycles", fmtInt(s?.cycles)],
    ["Queries / min", tel.qpm.toFixed(1)],
  ];
  grid.innerHTML = cells.map(([l, n]) => `<div class="stat"><div class="num">${esc(n)}</div><div class="lbl">${esc(l)}</div></div>`).join("");
}

function updateWatchList(items) {
  const list = $("#watch-list");
  if (!list) return;
  list.innerHTML = items.map((i) => `
    <div class="file-row" data-mtime="${i.mtimeMs}">
      <span class="name">${i.exists ? "📄" : "⛔"} ${esc(i.label)}</span>
      <span class="meta">${i.exists ? fmtKB(i.size) + " · " + new Date(i.mtimeMs).toLocaleTimeString() : "missing"}</span>
    </div>`).join("");
}

async function updateLiveChart() {
  const canvas = $("#live-chart");
  if (!canvas) return;
  const tel = state.telemetry ?? await api.live.telemetry();
  state.telemetry = tel;
  renderLiveStats();
  const ctx = canvas.getContext("2d");
  const W = canvas.width = Math.max(300, canvas.clientWidth || 900);
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const hist = tel.history.slice(-120);
  if (!hist.length) {
    ctx.fillStyle = "#8fa1bd";
    ctx.font = "12px sans-serif";
    ctx.fillText("waiting for queries…", 12, H / 2);
    return;
  }
  const maxQ = Math.max(...hist.map((h) => h.qpm), 0.5);
  // grid lines + y-axis labels
  ctx.strokeStyle = "#22304e";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = 0; y <= 3; y++) {
    const yy = H - 8 - (y / 3) * (H - 22);
    ctx.moveTo(0, yy); ctx.lineTo(W, yy);
  }
  ctx.stroke();
  ctx.fillStyle = "#5a6b88";
  ctx.font = "10px monospace";
  ctx.textAlign = "right";
  for (let y = 0; y <= 3; y++) {
    const v = (maxQ * y) / 3;
    const yy = H - 8 - (y / 3) * (H - 22);
    ctx.fillText(v.toFixed(1), 42, Math.min(H - 10, yy + 3));
  }
  ctx.textAlign = "left";
  // line: x by index across the window (history grows left→right)
  ctx.beginPath();
  const n = hist.length;
  hist.forEach((h, i) => {
    const x = n === 1 ? W - 12 : 48 + (i / (n - 1)) * (W - 60);
    const y = H - 8 - (h.qpm / maxQ) * (H - 22);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = "#5eead4";
  ctx.lineWidth = 2;
  ctx.stroke();
  // live pulse dot at the latest point
  const last = hist[n - 1];
  const lx = n === 1 ? W - 12 : 48 + ((n - 1) / (n - 1)) * (W - 60);
  const ly = H - 8 - (last.qpm / maxQ) * (H - 22);
  ctx.fillStyle = "#5eead4";
  ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.fill();
  // pulsing halo
  ctx.strokeStyle = "rgba(94, 234, 212, 0.45)";
  ctx.lineWidth = 1.5;
  const halo = (Date.now() % 1600) / 1600;
  ctx.beginPath(); ctx.arc(lx, ly, 4 + halo * 8, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#8fa1bd";
  ctx.font = "11px monospace";
  ctx.fillText(`${last.qpm.toFixed(1)} q/m`, 10, 14);
  // telemetry table
  const telEl = $("#telemetry");
  if (telEl) {
    telEl.innerHTML = tel.kinds.length
      ? `<table><thead><tr><th>Kind</th><th>Count</th><th>Avg ms</th><th>Last ms</th></tr></thead><tbody>
          ${tel.kinds.map((k) => `<tr><td class="mono">${esc(k.kind)}</td><td class="mono">${k.count}</td><td class="mono">${k.avgMs}</td><td class="mono">${k.lastMs}</td></tr>`).join("")}
        </tbody></table>`
      : "no queries yet";
  }
}

/* ── about view ───────────────────────────────────────────────────── */
async function renderAbout(main) {
  const view = document.createElement("div");
  view.className = "view";
  const info = await api.appInfo();
  const st = state.stats ?? (await api.getStats());
  view.innerHTML = `
    <h2 class="view-title">About</h2>
    <div class="panel">
      <h3>OORep Live ${esc(info.version)}</h3>
      <div class="kv">
        <span class="k">Platform</span><span class="mono">${esc(info.platform)}</span>
        <span class="k">Electron / Node</span><span class="mono">${esc(info.electron)} / ${esc(info.node)}</span>
        <span class="k">Data</span><span class="mono">${st.ready ? fmtInt(st.rubrics) + " rubric rows · " + fmtInt(st.links) + " links · " + fmtKB(st.dbSizeBytes) + " db" : "not loaded"}</span>
        <span class="k">Engine</span><span class="mono">TypeScript port of OOREP ${st.ready ? "(loaded in " + st.loadMs + " ms)" : ""}</span>
        <span class="k">Source project</span><span class="mono">${esc(st.srcRoot ?? "not detected")}</span>
      </div>
    </div>
    <div class="panel">
      <h3>Attribution</h3>
      <p class="small muted">Data: OOREP (Open Online Repertory) by Andreas Bauer, GPL v3 — 2,432 remedies, Kent Repertory (German) + Repertorium Publicum, 1.36M remedy-grade links. Cycles & Segments method: Paul Herscu, NESH. This app is a practitioner-owned offline tool; it does not provide medical advice.</p>
    </div>`;
  main.appendChild(view);
}

boot();
