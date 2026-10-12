#!/usr/bin/env node
/**
 * Build oorep.sqlite from the OOREP JSON exports.
 * Faithful to the Python engine's semantics:
 *  - rubrics keyed by id with LAST-WINS across duplicate ids (publicum wins)
 *  - inverted search index counts duplicate rubric id occurrences per word
 *  - vector rows: publicum rubrics only, FNV-1a hashed BoW, dim 384, f16 quantized
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "data-sources");
const OUT_DIR = path.join(ROOT, "data");
const OUT = path.join(OUT_DIR, "oorep.sqlite");

const initSqlJs = (await import("sql.js")).default;
const SQL = await initSqlJs();

const db = new SQL.Database();
db.exec(`
PRAGMA journal_mode = MEMORY;
CREATE TABLE remedies (
  id INTEGER PRIMARY KEY,
  abbrev TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE rubrics (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  fullpath TEXT NOT NULL,
  path_parts TEXT
);
CREATE TABLE rubric_links (
  rubric_id INTEGER NOT NULL,
  remedy_id INTEGER NOT NULL,
  weight INTEGER NOT NULL
);
CREATE TABLE search_index (
  word TEXT PRIMARY KEY,
  rubric_ids TEXT NOT NULL
);
CREATE TABLE vector_index (
  rubric_id INTEGER PRIMARY KEY,
  vec BLOB NOT NULL
);
CREATE TABLE cycles (
  remedy_name TEXT PRIMARY KEY,
  abbrev TEXT,
  json TEXT NOT NULL
);
CREATE TABLE synonyms (
  phrase TEXT PRIMARY KEY,
  expansions TEXT NOT NULL
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`);

const q = (sql, params = []) => {
  const stmt = db.prepare(sql);
  stmt.run(params);
  stmt.free();
};

const rj = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const wj = (p, d) => fs.writeFileSync(p, JSON.stringify(d));

console.time("build");
const meta = rj(path.join(SRC, "metadata.json"));
const remedies = rj(path.join(SRC, "remedies.json"));
const rubricsList = rj(path.join(SRC, "rubrics.json"));
const links = rj(path.join(SRC, "rubric_to_remedies.json"));
const searchIndex = rj(path.join(SRC, "rubric_search_index.json"));
const synonyms = rj(path.join(SRC, "synonyms.json"));

console.log("sources:", {
  remedies: remedies.length,
  rubricRows: rubricsList.length,
  links: Object.keys(links).length,
  indexWords: Object.keys(searchIndex).length,
  synonyms: Object.keys(synonyms).length,
});

// ---- remedies
db.exec("BEGIN");
for (const r of remedies) q("INSERT INTO remedies VALUES (?,?,?)", [r.id, r.abbrev, r.name]);
db.exec("COMMIT");

// ---- rubrics: LAST-WINS for duplicate ids (Python dict comprehension semantics)
const rubricsById = new Map();
for (const r of rubricsList) rubricsById.set(r.id, r);
db.exec("BEGIN");
for (const [id, r] of rubricsById) {
  q("INSERT INTO rubrics VALUES (?,?,?,?)", [id, r.source, r.fullpath, JSON.stringify(r.path_parts ?? null)]);
}
db.exec("COMMIT");
console.log("rubrics distinct:", rubricsById.size);

// ---- links: only for rubric ids that exist (Python get(rubric_id, []))
db.exec("BEGIN");
let linkCount = 0;
const weightMap = new Map();
for (const [k, arr] of Object.entries(links)) {
  const rid = parseInt(k, 10);
  if (!rubricsById.has(rid)) continue;
  for (const l of arr) {
    q("INSERT INTO rubric_links VALUES (?,?,?)", [rid, l.remedy_id, l.weight ?? 1]);
    linkCount++;
  }
}
db.exec("COMMIT");
console.log("links:", linkCount);

// ---- inverted index: keep duplicate id occurrences exactly as in JSON
db.exec("BEGIN");
for (const [word, ids] of Object.entries(searchIndex)) {
  q("INSERT INTO search_index VALUES (?,?)", [word, JSON.stringify(ids)]);
}
db.exec("COMMIT");

// ---- vector index: publicum only, hashed BoW, proper IEEE float16 (RNE)
const DIM = 384;
const fnv1a = (tok) => {
  let h = 2166136261;
  for (let i = 0; i < tok.length; i++) {
    h ^= tok.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};
const tokenizeVec = (t) => (t || "").toLowerCase().match(/[a-z0-9]+/g) || [];
const f32buf = new Float32Array(1);
const u32buf = new Uint32Array(f32buf.buffer);
/** IEEE 754 binary16 conversion with round-to-nearest-even (matches numpy astype(float16)). */
function toF16(val) {
  f32buf[0] = val;
  const x = u32buf[0];
  let sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let man = x & 0x7fffff;
  if (exp === 255) return (sign | 0x7e00 | (man ? 1 : 0)) & 0xffff; // inf/nan
  const e = exp - 127 + 15;
  if (e >= 31) return (sign | 0x7c00) & 0xffff; // overflow -> inf
  if (e <= 0) {
    if (e < -10) return sign; // underflow -> zero
    man |= 0x800000;
    const shift = 14 - e;
    let half = sign | (man >>> shift);
    const roundBit = (man >>> (shift - 1)) & 1;
    const sticky = (man & ((1 << (shift - 1)) - 1)) !== 0;
    if (roundBit && (sticky || (half & 1) === 1)) half++;
    return half & 0xffff;
  }
  let half = sign | (e << 10) | (man >>> 13);
  const roundBit = (man >>> 12) & 1;
  const sticky = (man & 0xfff) !== 0;
  if (roundBit && (sticky || (half & 1) === 1)) half++;
  return half & 0xffff;
}
const encodeVec = (text) => {
  const v = new Float64Array(DIM);
  for (const tok of tokenizeVec(text)) {
    const h = fnv1a(tok);
    v[h % DIM] += ((h >>> 1) & 1) === 0 ? 1 : -1;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < DIM; i++) v[i] /= n;
  const buf = new Uint8Array(DIM * 2);
  for (let i = 0; i < DIM; i++) {
    const bits = toF16(v[i]);
    buf[i * 2] = bits & 0xff;        // low byte
    buf[i * 2 + 1] = (bits >> 8) & 0xff; // high byte
  }
  return buf;
};
db.exec("DROP TABLE IF EXISTS vector_index");
db.exec("CREATE TABLE vector_index (rubric_id INTEGER PRIMARY KEY, fullpath TEXT NOT NULL, source TEXT NOT NULL, vec BLOB NOT NULL)");
db.exec("BEGIN");
let vecCount = 0;
for (const r of rubricsList) {
  if (r.source !== "publicum") continue;
  const buf = encodeVec(r.fullpath || "");
  q("INSERT INTO vector_index VALUES (?,?,?,?)", [r.id, r.fullpath || "", r.source, buf]);
  vecCount++;
}
db.exec("COMMIT");
console.log("vector rows (publicum):", vecCount);

// ---- cycles: 604 files + canonical Stramonium baked into the engine
db.exec("BEGIN");
let cycCount = 0;
const cycDir = path.join(SRC, "cycles");
for (const f of fs.readdirSync(cycDir)) {
  if (!f.endsWith(".json")) continue;
  const data = rj(path.join(cycDir, f));
  q("INSERT OR REPLACE INTO cycles VALUES (?,?,?)", [data.remedy_name, data.remedy_abbrev ?? null, JSON.stringify(data)]);
  cycCount++;
}
db.exec("COMMIT");
console.log("cycles:", cycCount);

// ---- synonyms
db.exec("BEGIN");
for (const [phrase, exps] of Object.entries(synonyms)) {
  q("INSERT INTO synonyms VALUES (?,?)", [phrase, JSON.stringify(exps)]);
}
db.exec("COMMIT");

// ---- meta
const stats = meta.statistics ?? {};
const stmts = [
  ["schema_version", "1"],
  ["built_at", new Date().toISOString()],
  ["remedies", String(remedies.length)],
  ["rubrics", String(rubricsList.length)],
  ["rubrics_distinct", String(rubricsById.size)],
  ["links", String(linkCount)],
  ["vector_rows", String(vecCount)],
  ["cycles", String(cycCount)],
  ["index_words", String(Object.keys(searchIndex).length)],
  ["dim", String(DIM)],
];
db.exec("BEGIN");
for (const [k, v] of stmts) q("INSERT INTO meta VALUES (?,?)", [k, v]);
db.exec("COMMIT");

fs.mkdirSync(OUT_DIR, { recursive: true });
const data = db.export();
fs.writeFileSync(OUT, Buffer.from(data));
console.log("wrote", OUT, (fs.statSync(OUT).size / 1e6).toFixed(1) + " MB");
console.timeEnd("build");
