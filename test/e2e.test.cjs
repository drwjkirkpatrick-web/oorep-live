/**
 * E2E test: launches the real Electron app under Xvfb, drives it via CDP,
 * verifies all views render, engine queries work through the full IPC
 * stack (preload → main → engine), and the live data window detects a
 * real change in the watched source files.
 *
 * Exit code 0 = all checks passed. Prints a summary.
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");

const ROOT = path.resolve(__dirname, "..");
const PORT = 9223;
const CHECKS = [];
let electronProc = null;
let xvfbProc = null;

function ok(name, cond, detail = "") {
  CHECKS.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
}

function cdpCall() { /* replaced by inline ws client below */ }

async function main() {
  // 1. launch Xvfb
  xvfbProc = spawn("Xvfb", [":99", "-screen", "0", "1280x800x24"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 700));

  // 2. launch electron with remote debugging
  const env = {
    ...process.env,
    DISPLAY: ":99",
    ELECTRON_ENABLE_LOGGING: "1",
    OOREP_SRC: "/home/walker/projects/oorep-local-repertory",
  };
  electronProc = spawn(path.join(ROOT, "node_modules", ".bin", "electron"), [".", `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let electronErr = "";
  electronProc.stderr.on("data", (d) => { electronErr += d.toString(); });
  electronProc.stdout.on("data", (d) => process.stdout.write("[app] " + d.toString()));

  // 3. wait for CDP endpoint
  const targets = await waitForTargets(PORT, 30000);
  ok("electron launched + CDP reachable", targets.length > 0, `${targets.length} targets`);

  const page = targets.find((t) => t.type === "page");
  ok("page target present", !!page, page?.title);

  // raw CDP over WebSocket using only node stdlib
  const { EventEmitter } = require("node:events");
  const net = require("node:net");
  const { webcrypto } = require("node:crypto");
  const ws = await openWebSocket(page.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const events = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send("Runtime.enable");
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };

  // 4. wait for app boot (renderer JS + preload bridge)
  await sleep(1200);
  const hasApi = await evaluate("typeof window.oorep === 'object'");
  ok("preload bridge exposed (window.oorep)", hasApi);

  const ready = await evaluate("window.oorep.engineReady()");
  ok("engine ready via IPC", ready === true);

  const stats = await evaluate("window.oorep.getStats()");
  ok("stats via IPC", stats && stats.ready && stats.rubrics === 143408 && stats.links === 1359572,
    `rubrics=${stats?.rubrics} distinct=${stats?.rubricsDistinct} links=${stats?.links} loadMs=${stats?.loadMs}`);

  // 5. full-stack repertorization through the UI API
  const t0 = Date.now();
  const results = await evaluate("window.oorep.repertorize(['headache worse morning','nausea','irritability','thirst small sips'], {topN: 10})");
  const dtRep = Date.now() - t0;
  ok("repertorize via IPC", Array.isArray(results) && results.length === 10 && results[0].score >= results[9].score,
    `top=${results?.[0]?.abbrev} score=${results?.[0]?.score} in ${dtRep}ms`);

  const cyclesOk = await evaluate("(async () => { const r = await window.oorep.repertorize(['anxiety about health','sleepless after midnight','fear of death'], {topN: 5}); return r.some(x => x.cycle_analysis && x.cycle_analysis.remedy_cycle); })()");
  ok("cycle analysis attaches to results", cyclesOk);

  // 6. UI view rendering
  await evaluate("(async () => { location.hash = 'search'; await new Promise(r => setTimeout(r, 300)); })()");
  const searchTitle = await evaluate("document.querySelector('.view-title')?.textContent");
  ok("search view renders", searchTitle === "Repertory Search", searchTitle);

  // drive a real search through the UI input
  const searchWorked = await evaluate("(async () => { document.querySelector('#q').value = 'headache morning'; document.querySelector('#go').click(); await new Promise(r => setTimeout(r, 900)); const rows = document.querySelectorAll('#rubric-results tbody tr').length; return rows >= 5; })()");
  ok("UI search returns rubric rows", searchWorked);

  await evaluate("(async () => { location.hash = 'live'; await new Promise(r => setTimeout(r, 400)); })()");
  const liveTitle = await evaluate("document.querySelector('.view-title')?.textContent");
  ok("live data view renders", liveTitle === "Live Data", liveTitle);
  const statCells = await evaluate("document.querySelectorAll('#stat-grid .stat').length");
  ok("live stat cards render", statCells >= 6, `${statCells} cards`);
  const watchRows = await evaluate("document.querySelectorAll('#watch-list .file-row').length");
  ok("source file watch list renders", watchRows >= 4, `${watchRows} files`);

  // feed telemetry with a couple of live queries, then verify the chart drew
  await evaluate("(async () => { await window.oorep.searchRubrics('cough', 'hybrid', 10); await window.oorep.searchRubrics('fever', 'lexical', 10); await new Promise(r => setTimeout(r, 2300)); return true; })()");
  const chartDrawn = await evaluate("(async () => { const c = document.querySelector('#live-chart'); const ctx = c.getContext('2d'); const px = ctx.getImageData(0, 0, c.width, c.height).data; let nonBg = 0; for (let i = 3; i < px.length; i += 4) { if (px[i] !== 0) nonBg++; } return nonBg > 500; })()");
  ok("live chart draws after queries", chartDrawn);

  // 7. LIVE CHANGE DETECTION: touch a watched source file, expect the
  //    snapshot to update its mtime within the 2s poll.
  const before = await evaluate("window.oorep.live.snapshot()");
  const target = before.find((i) => i.exists && /metadata\.json|build_log\.json/.test(i.file));
  if (target) {
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(target.file, future, future);
    await sleep(3000);
    const after = await evaluate("window.oorep.live.snapshot()");
    const afterItem = after.find((i) => i.file === target.file);
    ok("live monitor detected file change", afterItem && afterItem.mtimeMs > target.mtimeMs,
      `${path.basename(target.file)} mtime advanced`);
  } else {
    ok("live monitor detected file change", false, "no watchable file found");
  }

  // 8. telemetry recorded queries
  const tel = await evaluate("window.oorep.live.telemetry()");
  ok("telemetry records queries", tel.totalQueries >= 3 && tel.kinds.length >= 2, `${tel.totalQueries} queries across ${tel.kinds.length} kinds, qpm=${tel.qpm.toFixed(1)}`);

  // 9. repertorize view UI end-to-end
  await evaluate("(async () => { location.hash = 'repertorize'; await new Promise(r => setTimeout(r, 300)); })()");
  const repUi = await evaluate("(async () => { document.querySelector('#sym-input').value = 'dry cough evening'; document.querySelector('#sym-add').click(); document.querySelector('#load-example').click(); await new Promise(r => setTimeout(r, 100)); const chips = document.querySelectorAll('#sym-chips .chip').length; document.querySelector('#run-case').click(); await new Promise(r => setTimeout(r, 2500)); const rows = document.querySelectorAll('#results tbody tr').length; const status = document.querySelector('#case-status').textContent; return { chips, rows, status }; })()");
  ok("repertorize UI full flow", repUi.chips >= 4 && repUi.rows >= 15, `chips=${repUi.chips} rows=${repUi.rows} (${repUi.status})`);

  // 10. cycles view renders from case results
  await evaluate("(async () => { location.hash = 'cycles'; await new Promise(r => setTimeout(r, 300)); })()");
  const cyclePanels = await evaluate("document.querySelectorAll('#cycles-body .panel').length");
  ok("cycles view renders analysis panels", cyclePanels >= 8, `${cyclePanels} panels`);

  // 11. about view
  await evaluate("(async () => { location.hash = 'about'; await new Promise(r => setTimeout(r, 300)); })()");
  const about = await evaluate("document.querySelector('.view-title')?.textContent");
  ok("about view renders", about === "About", about);

  // screenshot for the record
  try {
    await evaluate("(async () => { location.hash = 'live'; await new Promise(r => setTimeout(r, 400)); })()");
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(path.join(ROOT, "test", "artifacts"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "test", "artifacts", "live-view.png"), Buffer.from(shot.data, "base64"));
    ok("screenshot captured", true, "test/artifacts/live-view.png");
  } catch (e) {
    ok("screenshot captured", false, String(e).slice(0, 120));
  }

  // summary
  const passed = CHECKS.filter((c) => c.pass).length;
  console.log(`\n${passed}/${CHECKS.length} checks passed`);
  if (electronErr.includes("ERROR") || electronErr.includes("Uncaught")) {
    console.log("---- electron stderr (tail) ----");
    console.log(electronErr.slice(-1500));
  }
  cleanup();
  process.exit(passed === CHECKS.length ? 0 : 1);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitForTargets(port, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get({ host: "127.0.0.1", port, path: "/json" }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch { retry(); }
        });
      }).on("error", retry);
    };
    const retry = () => {
      if (Date.now() - t0 > timeoutMs) reject(new Error("CDP timeout"));
      else setTimeout(attempt, 400);
    };
    attempt();
  });
}

/* Minimal RFC6455 WebSocket client over net.Socket (node stdlib only). */
function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = require("node:crypto").webcrypto.getRandomValues(new Uint8Array(16));
    const sock = net.connect(parseInt(u.port, 10), u.hostname, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.hostname}:${u.port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${Buffer.from(key).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    let handshake = false;
    const frames = [];
    const listeners = [];
    const api = {
      on(ev, fn) { listeners.push([ev, fn]); return api; },
      send(data) {
        const payload = Buffer.from(data);
        const len = payload.length;
        // Client frames MUST be masked (RFC 6455 §5.3)
        const mask = require("node:crypto").webcrypto.getRandomValues(new Uint8Array(4));
        let header;
        if (len < 126) {
          header = Buffer.from([0x81, 0x80 | len]);
        } else if (len < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x81; header[1] = 0x80 | 126;
          header.writeUInt16BE(len, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81; header[1] = 0x80 | 127;
          header.writeBigUInt64BE(BigInt(len), 2);
        }
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
        sock.write(Buffer.concat([header, Buffer.from(mask), masked]));
      },
      close() { sock.end(); },
    };
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshake) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        if (!/101/.test(head.split("\r\n")[0])) return reject(new Error("ws handshake failed: " + head.split("\r\n")[0]));
        buf = buf.slice(idx + 4);
        handshake = true;
        resolve(api);
      }
      // parse frames
      while (true) {
        if (buf.length < 2) break;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const lenByte = buf[1] & 0x7f;
        let off = 2, len = lenByte;
        if (lenByte === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (lenByte === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (opcode === 0x1 || opcode === 0x2) {
          for (const [ev, fn] of listeners) if (ev === "message") fn(payload);
        } else if (opcode === 0x8) {
          sock.end();
        }
      }
    });
    sock.on("error", reject);
  });
}

function cleanup() {
  try { electronProc?.kill("SIGKILL"); } catch {}
  try { xvfbProc?.kill("SIGKILL"); } catch {}
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

main().catch((e) => {
  console.error("E2E FAILED:", e);
  cleanup();
  process.exit(1);
});
