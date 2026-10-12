// verify the PACKAGED app: launch release/linux-arm64-unpacked/oorep-live under Xvfb
// and run the same engine + live checks against the bundled database.
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");

const APP = "/home/walker/projects/oorep-live/release/linux-arm64-unpacked/oorep-live";
const PORT = 9227;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const xvfb = spawn("Xvfb", [":94", "-screen", "0", "1280x800x24"], { stdio: "ignore" });
  await sleep(700);
  const env = { ...process.env, DISPLAY: ":94", OOREP_SRC: "/home/walker/projects/oorep-local-repertory" };
  const el = spawn(APP, [`--remote-debugging-port=${PORT}`], { env, stdio: ["ignore", "ignore", "ignore"] });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      targets = await new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: PORT, path: "/json" }, (res) => {
          let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(JSON.parse(b)));
        }).on("error", reject);
      });
      if (targets.length) break;
    } catch {}
    await sleep(400);
  }
  const checks = [];
  const ok = (n, c, d = "") => { checks.push(c); console.log(`${c ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`); };
  ok("packaged app launched + CDP", targets && targets.length > 0, `${targets?.length ?? 0} targets`);
  if (!targets?.length) { el.kill("SIGKILL"); xvfb.kill("SIGKILL"); process.exit(1); }

  const page = targets.find((t) => t.type === "page");
  const u = new URL(page.webSocketDebuggerUrl);
  const key = require("node:crypto").webcrypto.getRandomValues(new Uint8Array(16));
  const sock = net.connect(parseInt(u.port, 10), u.hostname, () => {
    sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.from(key).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  let buf = Buffer.alloc(0);
  let handshake = false;
  let msgId = 0;
  const pending = new Map();
  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!handshake) {
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      buf = buf.slice(idx + 4);
      handshake = true;
    }
    while (true) {
      if (buf.length < 2) break;
      const opcode = buf[0] & 0x0f;
      const lenByte = buf[1] & 0x7f;
      let off = 2, len = lenByte;
      if (lenByte === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (lenByte === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) break;
      const payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (opcode === 0x1 || opcode === 0x2) {
        const msg = JSON.parse(payload.toString());
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      }
    }
  });
  await sleep(800);
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    const pl = Buffer.from(JSON.stringify({ id, method, params }));
    const mask = require("node:crypto").webcrypto.getRandomValues(new Uint8Array(4));
    const header = pl.length < 126 ? Buffer.from([0x81, 0x80 | pl.length]) : Buffer.alloc(4);
    if (pl.length >= 126) { header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(pl.length, 2); }
    const masked = Buffer.from(pl);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    sock.write(Buffer.concat([header, Buffer.from(mask), masked]));
    setTimeout(() => reject(new Error("timeout " + method)), 20000);
  });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };
  await send("Runtime.enable");

  // wait for engine (embedded DB load ~7s)
  let ready = false, stats = null;
  for (let i = 0; i < 30; i++) {
    try { ready = await evaluate("window.oorep.engineReady()"); } catch {}
    if (ready) break;
    await sleep(700);
  }
  ok("engine ready (embedded sqlite)", ready);
  stats = await evaluate("window.oorep.getStats()");
  ok("embedded stats correct", stats?.ready && stats.rubrics === 143408 && stats.links === 1359572,
    `rubrics=${stats?.rubrics} links=${stats?.links} db=${(stats?.dbSizeBytes / 1e6).toFixed(1)}MB load=${stats?.loadMs}ms`);

  const res = await evaluate("window.oorep.repertorize(['dry cough evening','hoarseness'], {topN: 5})");
  ok("packaged repertorize works", Array.isArray(res) && res.length === 5, `top=${res?.[0]?.abbrev} score=${res?.[0]?.score}`);

  const live = await evaluate("window.oorep.live.status()");
  ok("live monitor running in package", live?.running === true, `watching=${live?.watching}`);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  require("node:fs").writeFileSync("/home/walker/projects/oorep-live/test/artifacts/packaged-app.png", Buffer.from(shot.data, "base64"));
  ok("screenshot", true, "test/artifacts/packaged-app.png");

  console.log(`\n${checks.filter(Boolean).length}/${checks.length} packaged checks passed`);
  el.kill("SIGKILL");
  xvfb.kill("SIGKILL");
  process.exit(checks.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error("PACKAGED TEST FAILED:", e); process.exit(1); });
