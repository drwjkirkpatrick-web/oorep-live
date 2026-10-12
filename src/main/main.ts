import { app, BrowserWindow, ipcMain, dialog, Menu } from "electron";
import path from "node:path";
import fs from "node:fs";
import { OorepEngine } from "./engine";
import { LiveMonitor } from "./live-monitor";

/**
 * OORep Live — offline homeopathic repertory with a live data window.
 *
 * Main process: loads the embedded oorep.sqlite (sql.js) into the ported
 * engine, serves IPC queries, and runs the LiveMonitor watching the source
 * project's data files.
 */

let mainWindow: BrowserWindow | null = null;
let engine: OorepEngine | null = null;
let monitor: LiveMonitor | null = null;
let srcRoot: string | null = null;

const isDev = process.env.OOREP_DEV === "1";

function resourcePath(): string {
  // packaged: data/oorep.sqlite under resources/
  const p = path.join(process.resourcesPath, "data", "oorep.sqlite");
  if (fs.existsSync(p)) return p;
  // dev: data/oorep.sqlite in repo root
  return path.join(app.getAppPath(), "data", "oorep.sqlite");
}

function detectSrcRoot(): string | null {
  const candidates = [
    process.env.OOREP_SRC,
    path.join(process.env.HOME ?? "", "projects", "oorep-local-repertory"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "data"))) return c;
  }
  return null;
}

function initEngine(): { ok: boolean; error?: string } {
  const t0 = Date.now();
  try {
    const dbPath = resourcePath();
    const initSqlJs = require("sql.js");
    return { ok: false, error: "sql.js must be imported async" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function initEngineAsync(): Promise<{ ok: boolean; error?: string }> {
  const dbPath = resourcePath();
  if (!fs.existsSync(dbPath)) return { ok: false, error: `Database not found: ${dbPath}` };
  const initSqlJs = (await import("sql.js")).default as any;
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  engine = new OorepEngine(db);
  engine.load();
  monitor?.setLiveStats(engine.getStats() as any);
  console.log(`[oorep] engine loaded in ${engine.loadMs} ms from ${dbPath}`);
  return { ok: true };
}

function send(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: "OORep Live",
    backgroundColor: "#0b1220",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  const index = isDev
    ? path.join(__dirname, "..", "..", "src", "renderer", "index.html")
    : path.join(__dirname, "..", "..", "src", "renderer", "index.html");
  mainWindow.loadFile(index);
  if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });
  mainWindow.on("closed", () => { mainWindow = null; });
}

/* ── IPC wiring ────────────────────────────────────────────────────── */

function wireIpc(): void {
  const need = () => {
    if (!engine) throw new Error("Engine not loaded yet");
    return engine;
  };

  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    electron: process.versions.electron,
    node: process.versions.node,
  }));

  ipcMain.handle("engine:ready", () => !!engine);
  ipcMain.handle("engine:stats", () => {
    if (!engine) return { ready: false as const };
    const st = fs.statSync(resourcePath());
    return { ...engine.getStats(), ready: true as const, srcRoot, dbSizeBytes: st.size };
  });

  ipcMain.handle("search:rubrics", (_e, query: string, mode: string, limit?: number) => {
    const e = need();
    const t0 = Date.now();
    const m = (["lexical", "vector", "hybrid"].includes(mode) ? mode : "hybrid") as any;
    const res = m === "lexical" ? e.searchRubricsLexical(query, limit ?? 50)
      : m === "vector" ? e.searchRubricsVector(query, limit ?? 20)
      : e.searchRubricsHybrid(query, limit ?? 50);
    monitor?.recordQuery(`search:${m}`, Date.now() - t0);
    return res;
  });

  ipcMain.handle("search:remedies", (_e, query: string, limit?: number) => {
    const e = need();
    const t0 = Date.now();
    const res = e.searchRemedies(query, limit ?? 20);
    monitor?.recordQuery("search:remedies", Date.now() - t0);
    return res;
  });

  ipcMain.handle("rubric:remedies", (_e, rubricId: number) => {
    const e = need();
    const t0 = Date.now();
    const res = e.getRemediesForRubric(rubricId);
    monitor?.recordQuery("rubric:remedies", Date.now() - t0);
    return res;
  });

  ipcMain.handle("repertorize", (_e, symptoms: string[], opts?: any) => {
    const e = need();
    const t0 = Date.now();
    const res = e.repertorize(symptoms, opts ?? {});
    monitor?.recordQuery("repertorize", Date.now() - t0);
    return res;
  });

  ipcMain.handle("mapper:candidates", (_e, symptom: string, limit?: number) => {
    const e = need();
    const t0 = Date.now();
    const res = e.suggestCandidates(symptom, limit ?? 10);
    monitor?.recordQuery("mapper:candidates", Date.now() - t0);
    return res;
  });

  ipcMain.handle("mapper:normalize", (_e, symptom: string) => need().normalizeSymptom(symptom));

  ipcMain.handle("cycle:get", (_e, remedy: string) => {
    const cyc = need().getCycle(remedy);
    if (!cyc) return null;
    return {
      remedy_name: cyc.remedy_name,
      sentence: cyc.sentence,
      segments: cyc.segments.map((s) => ({ name: s.name, symptoms: s.symptoms })),
    };
  });

  /* live monitor */
  ipcMain.handle("live:status", () => monitor?.status() ?? { srcRoot: null, running: false, watching: 0 });
  ipcMain.handle("live:snapshot", () => monitor?.snapshot() ?? []);
  ipcMain.handle("live:telemetry", () => monitor?.telemetry() ?? { qpm: 0, history: [], kinds: [], totalQueries: 0 });
  ipcMain.handle("live:pause", () => { monitor?.pause(); return true; });
  ipcMain.handle("live:resume", () => { monitor?.resume(); return true; });
  ipcMain.handle("live:refresh", async () => {
    try {
      const r = await initEngineAsync();
      return r.ok ? { ok: true, stats: engine!.getStats() } : { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
}

app.whenReady().then(async () => {
  wireIpc();
  createWindow();
  const r = await initEngineAsync();
  if (!r.ok) {
    console.error("[oorep] engine init failed:", r.error);
    send("engine:error", r.error);
  } else {
    send("engine:ready", { stats: engine!.getStats() });
  }
  srcRoot = detectSrcRoot();
  monitor = new LiveMonitor(srcRoot ?? path.dirname(resourcePath()));
  monitor.on("change", (items) => send("live:change", items));
  monitor.start();
  send("live:change", monitor.snapshot());
});

app.on("window-all-closed", () => {
  monitor?.stop();
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
