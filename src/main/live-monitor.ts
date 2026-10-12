/**
 * Live data monitor: watches the OOREP source project's databases and data
 * files for changes, and streams change events + refreshed live stats to
 * the renderer. This is the "live data window" backbone.
 */
import { app, ipcMain as _ipc, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

export interface LiveWatchItem {
  label: string;
  file: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
}

export interface LiveStats {
  remedies: number;
  rubrics: number;
  rubricsDistinct: number;
  links: number;
  vectorRows: number;
  cycles: number;
  indexWords: number;
}

export class LiveMonitor extends EventEmitter {
  private watchers: fs.FSWatcher[] = [];
  private statTimer: NodeJS.Timeout | null = null;
  private items: LiveWatchItem[] = [];
  private paused = false;
  private liveDb: LiveStats | null = null;
  private history: { t: number; qpm: number }[] = [];
  private queryTimes: number[] = [];
  private qTracker = new QueryTracker();
  readonly srcRoot: string;

  constructor(srcRoot: string) {
    super();
    this.srcRoot = srcRoot;
  }

  /** Files to watch for live change events. */
  watchFiles(): string[] {
    const d = path.join(this.srcRoot, "data");
    return [
      path.join(d, "feedback.db"),
      path.join(d, "security.db"),
      path.join(d, "metadata.json"),
      path.join(d, "build_log.json"),
      path.join(this.srcRoot, "data", "cycles"),
    ];
  }

  start(): void {
    this.stop();
    const targets = this.watchFiles();
    for (const t of targets) {
      try {
        const w = fs.watch(t, { persistent: false }, (event) => {
          this.handleChange(t, event);
        });
        w.on("error", () => { /* file removed; rescan below */ });
        this.watchers.push(w);
      } catch { /* missing file — record as absent in snapshot */ }
    }
    // directory watcher for cycles dir contents
    this.snapshot();
    this.statTimer = setInterval(() => this.snapshot(), 2000);
  }

  stop(): void {
    for (const w of this.watchers) try { w.close(); } catch { /* noop */ }
    this.watchers = [];
    if (this.statTimer) clearInterval(this.statTimer);
    this.statTimer = null;
  }

  isRunning(): boolean { return this.statTimer !== null; }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.snapshot(); }

  setLiveStats(s: LiveStats): void { this.liveDb = s; }

  snapshot(): LiveWatchItem[] {
    const files: string[] = [];
    for (const t of this.watchFiles()) {
      if (fs.existsSync(t) && fs.statSync(t).isDirectory()) {
        for (const f of fs.readdirSync(t)) files.push(path.join(t, f));
      } else files.push(t);
    }
    const next: LiveWatchItem[] = files.map((f) => {
      try {
        const st = fs.statSync(f);
        return { label: this.labelFor(f), file: f, exists: true, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return { label: this.labelFor(f), file: f, exists: false, size: 0, mtimeMs: 0 };
      }
    });
    const changed = JSON.stringify(this.items) !== JSON.stringify(next);
    this.items = next;
    if (changed) this.emit("change", this.items);
    return this.items;
  }

  private labelFor(f: string): string {
    return f.replace(this.srcRoot + path.sep, "").split(path.sep).pop() || path.basename(f);
  }

  private handleChange(file: string, _event: string): void {
    if (this.paused) return;
    // debounce: snapshot on next tick (fs.watch can coalesce)
    setImmediate(() => this.snapshot());
  }

  /* ── query telemetry (feeds the live window charts) ────────────── */

  recordQuery(kind: string, ms: number): void {
    this.qTracker.record(kind, ms);
    this.queryTimes.push(Date.now());
    this.pruneHistory();
  }

  private pruneHistory(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    this.queryTimes = this.queryTimes.filter((t) => t >= cutoff);
    const qpm = this.queryTimes.length / 10;
    this.history.push({ t: Date.now(), qpm });
    if (this.history.length > 600) this.history.splice(0, this.history.length - 600);
  }

  telemetry(): { qpm: number; history: { t: number; qpm: number }[]; kinds: { kind: string; count: number; avgMs: number; lastMs: number }[]; totalQueries: number } {
    const cutoff = Date.now() - 10 * 60 * 1000;
    this.queryTimes = this.queryTimes.filter((t) => t >= cutoff);
    return {
      qpm: this.queryTimes.length / 10,
      history: [...this.history],
      kinds: this.qTracker.summary(),
      totalQueries: this.qTracker.total,
    };
  }

  status(): { srcRoot: string; running: boolean; watching: number } {
    return { srcRoot: this.srcRoot, running: this.statTimer !== null, watching: this.watchers.length };
  }
}

class QueryTracker {
  total = 0;
  private byKind = new Map<string, { count: number; totalMs: number; lastMs: number }>();
  record(kind: string, ms: number): void {
    this.total++;
    let e = this.byKind.get(kind);
    if (!e) { e = { count: 0, totalMs: 0, lastMs: 0 }; this.byKind.set(kind, e); }
    e.count++; e.totalMs += ms; e.lastMs = ms;
  }
  summary(): { kind: string; count: number; avgMs: number; lastMs: number }[] {
    return [...this.byKind.entries()].map(([kind, e]) => ({
      kind, count: e.count, avgMs: Math.round(e.totalMs / e.count), lastMs: e.lastMs,
    }));
  }
}
