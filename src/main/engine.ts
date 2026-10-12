/**
 * OORep Live engine — faithful TypeScript port of the Python engine:
 *   oorep/homeopathic_repertory.py (lexical + hybrid + repertorize)
 *   oorep/oorep_vector_search.py   (FNV-1a hashed BoW cosine)
 *   oorep/clinical_rubric_mapper.py(synonym expansion, candidate gating)
 *   oorep/cycles_and_segments.py   (Herscu cycle matching)
 *
 * The database (oorep.sqlite) is prebuilt by scripts/build-db.mjs with the
 * same last-wins rubric-id semantics as the Python dict comprehension.
 */
import type { Database } from "sql.js";

export interface Remedy { id: number; abbrev: string; name: string; }
export interface Rubric { id: number; source: string; fullpath: string; }
export interface RubricRemedy { remedy_id: number; abbrev: string; name: string; weight: number; }
export interface SearchHit extends Rubric { score: number; }
export interface Match {
  query_symptom: string; query_expanded: string | null;
  rubric_id: number; rubric: string; source: string; weight: number;
}
export interface CycleAnalysis {
  remedy_cycle: string | null; segment_matches: string[];
  segments_matched_count: number; total_segments: number;
  coverage: number; segment_coverage: number; generalized_hits: string[];
  cycle_sentence: string | null; map_of_hierarchy_phase: number | null;
  meets_threshold: boolean;
}
export interface RepertorizeResult {
  abbrev: string; name: string; score: number; match_count: number;
  matches: Match[]; cycle_analysis?: CycleAnalysis;
}

/* ── FNV-1a / IEEE float16 (mirrors oorep_vector_search.py + numpy astype(float16)) ── */

const DIM = 384;

function fnv1a(tok: string): number {
  let h = 2166136261;
  for (let i = 0; i < tok.length; i++) {
    h ^= tok.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** IEEE 754 binary16 → float32 (exact — no rounding needed). */
function f16BitsToF32(bits: number): number {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const man = bits & 0x3ff;
  if (exp === 0) return sign * man * Math.pow(2, -24); // subnormal
  if (exp === 31) return man ? NaN : sign * Infinity;
  return sign * (man + 1024) * Math.pow(2, exp - 25);
}

function vecTokenize(text: string): string[] {
  return (text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

function encodeQuery(text: string): Float32Array {
  const v = new Float64Array(DIM);
  for (const tok of vecTokenize(text)) {
    const h = fnv1a(tok);
    v[h % DIM] += ((h >>> 1) & 1) === 0 ? 1 : -1;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  const out = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) out[i] = n > 0 ? v[i] / n : 0;
  return out;
}

/* ── Engine ────────────────────────────────────────────────────────── */

export class OorepEngine {
  private db: Database;
  private remedies = new Map<number, Remedy>();
  private remediesByAbbrev = new Map<string, Remedy>();
  private rubrics = new Map<number, Rubric>();
  private linksByRubric = new Map<number, RubricRemedy[]>();
  private searchIndex = new Map<string, number[]>();
  private synonyms = new Map<string, string[]>();
  private cycles = new Map<string, Cycle>();
  private vecRows: { id: number; fullpath: string; source: string; vec: Float32Array }[] = [];
  stats = { remedies: 0, rubrics: 0, rubricsDistinct: 0, links: 0, vectorRows: 0, cycles: 0, indexWords: 0 };
  loadMs = 0;

  constructor(db: Database) {
    this.db = db;
  }

  /** Load all data into memory. ~1.36M links; expect a few seconds. */
  load(): void {
    const t0 = Date.now();
    const each = (sql: string, fn: (s: any) => void) => {
      const stmt = this.db.prepare(sql);
      while (stmt.step()) fn(stmt.getAsObject());
      stmt.free();
    };

    each("SELECT id, abbrev, name FROM remedies", (r) => {
      const rem: Remedy = { id: r.id, abbrev: r.abbrev, name: r.name };
      this.remedies.set(rem.id, rem);
      this.remediesByAbbrev.set(rem.abbrev, rem);
    });

    each("SELECT id, source, fullpath FROM rubrics", (r) => {
      this.rubrics.set(r.id, { id: r.id, source: r.source, fullpath: r.fullpath });
    });

    each("SELECT rubric_id, remedy_id, weight FROM rubric_links", (r) => {
      let arr = this.linksByRubric.get(r.rubric_id);
      if (!arr) { arr = []; this.linksByRubric.set(r.rubric_id, arr); }
      const rem = this.remedies.get(r.remedy_id);
      if (!rem) return;
      arr.push({ remedy_id: r.remedy_id, abbrev: rem.abbrev, name: rem.name, weight: r.weight });
    });

    each("SELECT word, rubric_ids FROM search_index", (r) => {
      this.searchIndex.set(r.word, JSON.parse(r.rubric_ids));
    });

    each("SELECT phrase, expansions FROM synonyms", (r) => {
      this.synonyms.set(r.phrase, JSON.parse(r.expansions));
    });

    each("SELECT remedy_name, abbrev, json FROM cycles", (r) => {
      const cyc = JSON.parse(r.json) as Cycle;
      this.cycles.set(cyc.remedy_name.toLowerCase(), cyc);
      if (cyc.remedy_abbrev) this.cycles.set(cyc.remedy_abbrev.toLowerCase().replace(/\.$/, ""), cyc);
    });

    // vector rows: f16-quantized blobs — expand once into Float32Arrays
    each("SELECT rubric_id, fullpath, source, vec FROM vector_index", (r) => {
      const blob = r.vec as Uint8Array;
      const f = new Float32Array(DIM);
      for (let i = 0; i < DIM; i++) f[i] = f16BitsToF32((blob[i * 2 + 1] << 8) | blob[i * 2]);
      this.vecRows.push({ id: r.rubric_id, fullpath: r.fullpath, source: r.source, vec: f });
    });

    each("SELECT key, value FROM meta", (r) => {
      const keyMap: Record<string, keyof OorepEngine["stats"]> = {
        remedies: "remedies", rubrics: "rubrics", rubrics_distinct: "rubricsDistinct",
        links: "links", vector_rows: "vectorRows", cycles: "cycles", index_words: "indexWords",
      };
      const k = keyMap[r.key as string];
      if (k) (this.stats as any)[k] = parseInt(r.value as string, 10);
    });

    this.loadMs = Date.now() - t0;
  }

  getStats() { return { ...this.stats, loadMs: this.loadMs }; }

  /* ── lexical search (mirrors _search_rubrics_lexical) ──────────── */

  private tokenize(text: string): string[] {
    return (text || "").split(/\s+/).filter((w) => w.length > 2).map((w) => w.toLowerCase());
  }

  searchRubricsLexical(query: string, limit = 50): SearchHit[] {
    const words = this.tokenize(query);
    if (!words.length) return [];
    const scores = new Map<number, number>();
    const bump = (id: number, d: number) => scores.set(id, (scores.get(id) ?? 0) + d);
    for (const word of words) {
      const exact = this.searchIndex.get(word);
      if (exact) for (const id of exact) bump(id, 1.0);
      // Partial matches — Python checks `word in idx_word or idx_word in word` over ALL
      // entries, which includes the identity case (adds +0.5 even for exact hits).
      for (const [idxWord, ids] of this.searchIndex) {
        if (idxWord.includes(word) || word.includes(idxWord)) {
          for (const id of ids) bump(id, 0.5);
        }
      }
    }
    return this.rankIds(scores, limit);
  }

  private rankIds(scores: Map<number, number>, limit: number): SearchHit[] {
    const arr = [...scores.entries()];
    // stable sort desc by score (Array.prototype.sort is stable in V8)
    arr.sort((a, b) => b[1] - a[1]);
    const out: SearchHit[] = [];
    for (const [id, score] of arr.slice(0, limit)) {
      const rub = this.rubrics.get(id);
      if (rub) out.push({ ...rub, score });
    }
    return out;
  }

  /* ── vector search (mirrors OORepVectorSearch.search) ──────────── */

  searchRubricsVector(query: string, limit = 20): SearchHit[] {
    type VecRow = { id: number; fullpath: string; source: string; vec: Float32Array };
    const q = encodeQuery(query);
    let qn = 0;
    for (let i = 0; i < DIM; i++) qn += q[i] * q[i];
    if (qn === 0) return [];
    const scored: { row: VecRow; score: number }[] = [];
    for (const row of this.vecRows) {
      let s = 0;
      const v = row.vec;
      for (let i = 0; i < DIM; i++) s += v[i] * q[i];
      scored.push({ row, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    const out: SearchHit[] = [];
    for (const r of scored.slice(0, limit)) {
      // Python uses the vector row's own fullpath/source (numeric ids collide across sources)
      out.push({ id: r.row.id, fullpath: r.row.fullpath, source: r.row.source, score: r.score });
    }
    return out;
  }

  /* ── hybrid (mirrors search_rubrics_hybrid) ────────────────────── */

  private normalizeScores(m: Map<number, number>): Map<number, number> {
    if (!m.size) return new Map();
    let min = Infinity, max = -Infinity;
    for (const v of m.values()) { if (v < min) min = v; if (v > max) max = v; }
    if (max === min) {
      const out = new Map<number, number>();
      for (const k of m.keys()) out.set(k, 1.0);
      return out;
    }
    const span = max - min;
    const out = new Map<number, number>();
    for (const [k, v] of m) out.set(k, (v - min) / span);
    return out;
  }

  searchRubricsHybrid(query: string, limit = 50, lexicalK = 200, vectorK = 200): SearchHit[] {
    const qTokens = new Set(this.tokenize(query));
    const lexical = this.searchRubricsLexical(query, Math.max(limit, lexicalK));
    const vector = this.searchRubricsVector(query, Math.max(limit, vectorK));

    const byId = new Map<number, Rubric & { lex?: number; vec?: number }>();
    const lexScores = new Map<number, number>();
    for (const r of lexical) { byId.set(r.id, r); lexScores.set(r.id, r.score); }
    const vecScores = new Map<number, number>();
    for (const r of vector) {
      if (!byId.has(r.id)) byId.set(r.id, r);
      vecScores.set(r.id, r.score);
    }

    let lexicalWeight = 0.35, vectorWeight = 0.55, overlapWeight = 0.10;
    if (vecScores.size === 0) { lexicalWeight = 0.90; vectorWeight = 0.0; overlapWeight = 0.10; }

    const normLex = this.normalizeScores(lexScores);
    const normVec = this.normalizeScores(vecScores);

    const scored: SearchHit[] = [];
    for (const [id, rub] of byId) {
      const fpTokens = new Set(this.tokenize(rub.fullpath));
      let overlap = 0;
      if (qTokens.size) {
        let hit = 0;
        for (const t of qTokens) if (fpTokens.has(t)) hit++;
        overlap = hit / qTokens.size;
      }
      const l = normLex.get(id) ?? 0;
      const v = normVec.get(id) ?? 0;
      const h = lexicalWeight * l + vectorWeight * v + overlapWeight * overlap;
      scored.push({ id, source: rub.source, fullpath: rub.fullpath, score: h });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /* ── clinical mapper (mirrors ClinicalRubricMapper) ────────────── */

  private static clean(text: string): string {
    return (text || "").trim().toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ");
  }
  private static wordTokens(text: string): string[] {
    const toks = (text || "").match(/[A-Za-zÀ-ÖØ-öø-ÿ0-9']+/g) || [];
    return toks.map((t) => t.toLowerCase()).filter((t) => t.length > 1);
  }

  normalizeSymptom(symptom: string): { original: string; cleaned: string; expanded_terms: string[]; expanded_query: string } {
    const cleaned = OorepEngine.clean(symptom);
    const expanded: string[] = [];
    expanded.push(...OorepEngine.wordTokens(cleaned));
    for (const [phrase, adds] of this.synonyms) {
      if (cleaned.includes(phrase)) expanded.push(...adds);
    }
    for (const tok of OorepEngine.wordTokens(cleaned)) {
      const adds = this.synonyms.get(tok);
      if (adds) expanded.push(...adds);
    }
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const it of expanded) {
      const c = it.trim().toLowerCase();
      if (c && !seen.has(c)) { seen.add(c); terms.push(c); }
    }
    return { original: symptom, cleaned, expanded_terms: terms, expanded_query: terms.join(" ") };
  }

  suggestCandidates(symptom: string, limit = 10, retrieval: "lexical" | "vector" | "hybrid" = "hybrid", requireRemedies = true) {
    const normalized = this.normalizeSymptom(symptom);
    const mode = (retrieval || "hybrid").toLowerCase().trim();
    const query = normalized.expanded_query;
    const searchLimit = Math.max(limit * 5, limit, 25);
    let rubrics: SearchHit[];
    if (mode === "lexical") rubrics = this.searchRubricsLexical(query, searchLimit);
    else if (mode === "vector") rubrics = this.searchRubricsVector(query, searchLimit);
    else rubrics = this.searchRubricsHybrid(query, searchLimit);

    const candidates: {
      rank: number; review_status: string; query_original: string; query_expanded: string;
      rubric_id: number; rubric: string; source: string; retrieval: string;
      retrieval_score: number; remedy_count: number;
    }[] = [];
    for (const rub of rubrics) {
      const remedies = this.getRemediesForRubric(rub.id);
      const remedyCount = new Set(remedies.map((r) => r.abbrev).filter(Boolean)).size;
      if (requireRemedies && remedyCount === 0) continue;
      candidates.push({
        rank: candidates.length + 1,
        review_status: "pending",
        query_original: normalized.original,
        query_expanded: normalized.expanded_query,
        rubric_id: rub.id,
        rubric: rub.fullpath,
        source: rub.source,
        retrieval: mode,
        retrieval_score: rub.score,
        remedy_count: remedyCount,
      });
      if (candidates.length >= limit) break;
    }
    return candidates;
  }

  /* ── remedies for rubric (Python sorts by weight desc, keeps all) ── */

  getRemediesForRubric(rubricId: number, limit?: number): RubricRemedy[] {
    const arr = this.linksByRubric.get(rubricId) ?? [];
    const sorted = [...arr].sort((a, b) => b.weight - a.weight);
    return limit ? sorted.slice(0, limit) : sorted;
  }

  searchRemedies(query: string, limit = 20): Remedy[] {
    const q = query.toLowerCase();
    const out: Remedy[] = [];
    for (const r of this.remedies.values()) {
      if (r.name.toLowerCase().includes(q) || r.abbrev.toLowerCase().includes(q)) {
        out.push(r);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  getRemedyByAbbrev(abbrev: string): Remedy | undefined {
    return this.remediesByAbbrev.get(abbrev);
  }

  /* ── cycles (mirrors CyclesAndSegmentsEngine) ──────────────────── */

  getCycle(remedy: string): Cycle | undefined {
    const key = remedy.toLowerCase();
    return this.cycles.get(key) ?? this.cycles.get(key.replace(/\.$/, ""));
  }

  private static cycTokens(text: string): Set<string> {
    return new Set((text || "").toLowerCase().match(/[a-z]{3,}/g) || []);
  }

  matchCaseToCycle(caseSymptoms: string[], cycle: Cycle, generalize = true) {
    if (!caseSymptoms.length) {
      return { matched_segments: [] as string[], coverage: 0, segment_scores: {} as Record<string, number>, generalized_hits: [] as string[], missing_segments: cycle.segments.map((s) => s.name) };
    }
    const caseTokens = caseSymptoms.map((s) => OorepEngine.cycTokens(s));
    const segmentScores: Record<string, number> = {};
    const matched: string[] = [];
    const genHits: Set<string> = new Set();
    const missing: string[] = [];
    let totalPossible = 0, totalMatched = 0;

    for (const seg of cycle.segments) {
      let score = 0;
      for (const sym of seg.symptoms ?? []) {
        totalPossible++;
        const symTokens = OorepEngine.cycTokens(sym);
        if (caseTokens.some((ct) => intersects(symTokens, ct))) { score += 1; totalMatched++; }
      }
      if (generalize) {
        for (const gen of seg.generalizations ?? []) {
          const genTokens = OorepEngine.cycTokens(gen);
          if (caseTokens.some((ct) => intersects(genTokens, ct))) { score += 0.5; genHits.add(gen); }
        }
      }
      segmentScores[seg.name] = Math.round(score * 100) / 100;
      if (score > 0) matched.push(seg.name); else missing.push(seg.name);
    }
    const coverage = totalPossible ? Math.round((totalMatched / totalPossible) * 1000) / 1000 : 0;
    return { matched_segments: matched, coverage, segment_scores: segmentScores, generalized_hits: [...genHits], missing_segments: missing };
  }

  listCycles(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of this.cycles.values()) {
      if (!seen.has(c.remedy_name)) { seen.add(c.remedy_name); out.push(c.remedy_name); }
    }
    return out;
  }

  /* ── repertorize (mirrors HomeopathicRepertory.repertorize) ────── */

  repertorize(
    symptoms: string[],
    opts: {
      topN?: number; retrieval?: "lexical" | "vector" | "hybrid"; rubricsPerSymptom?: number;
      useClinicalMapper?: boolean; withCycles?: boolean;
      cycleMinSegments?: number; cycleMinCoverage?: number;
      /** Return all matches instead of the display-truncated first 5 (Python parity). */
      fullMatches?: boolean;
    } = {}
  ): RepertorizeResult[] {
    const {
      topN = 20, retrieval = "hybrid", rubricsPerSymptom = 10,
      useClinicalMapper = true, withCycles = true,
      cycleMinSegments = 2, cycleMinCoverage = 0.25,
      fullMatches = false,
    } = opts;

    interface Acc { score: number; matches: Match[]; rubricIds: Set<number>; name?: string; }
    const remedyScores = new Map<string, Acc>();
    const acc = (abbrev: string): Acc => {
      let a = remedyScores.get(abbrev);
      if (!a) { a = { score: 0, matches: [], rubricIds: new Set() }; remedyScores.set(abbrev, a); }
      return a;
    };

    for (const symptom of symptoms) {
      let rubrics: { id: number; fullpath: string; source: string; query_expanded?: string }[];
      if (useClinicalMapper) {
        const candidates = this.suggestCandidates(symptom, rubricsPerSymptom, retrieval, true);
        rubrics = candidates.map((c) => ({
          id: c.rubric_id, fullpath: c.rubric, source: c.source, query_expanded: c.query_expanded,
        }));
      } else {
        rubrics = this.retrieveRubrics(symptom, retrieval, rubricsPerSymptom).map((r) => ({
          id: r.id, fullpath: r.fullpath, source: r.source,
        }));
      }
      const seen = new Set<number>();
      for (const rub of rubrics) {
        if (seen.has(rub.id)) continue;
        seen.add(rub.id);
        const remedies = this.getRemediesForRubric(rub.id);
        const scoredAbbrevs = new Set<string>();
        for (const rem of remedies) {
          if (scoredAbbrevs.has(rem.abbrev)) continue;
          scoredAbbrevs.add(rem.abbrev);
          const a = acc(rem.abbrev);
          a.score += rem.weight;
          a.name = rem.name;
          a.rubricIds.add(rub.id);
          a.matches.push({
            query_symptom: symptom, query_expanded: rub.query_expanded ?? null,
            rubric_id: rub.id, rubric: rub.fullpath, source: rub.source, weight: rem.weight,
          });
        }
      }
    }

    const sorted = [...remedyScores.entries()].sort((a, b) => b[1].score - a[1].score);
    const results: RepertorizeResult[] = [];
    for (const [abbrev, data] of sorted.slice(0, topN)) {
      results.push({
        abbrev, name: data.name ?? "", score: data.score, match_count: data.rubricIds.size,
        matches: fullMatches ? data.matches : data.matches.slice(0, 5),
      });
    }

    if (withCycles) {
      for (const r of results) {
        const cycle = this.getCycle(r.abbrev) ?? this.getCycle(r.name ?? "");
        if (!cycle) {
          r.cycle_analysis = {
            remedy_cycle: null, segment_matches: [], segments_matched_count: 0, total_segments: 0,
            coverage: 0, segment_coverage: 0, generalized_hits: [], cycle_sentence: null,
            map_of_hierarchy_phase: null, meets_threshold: false,
          };
          continue;
        }
        const match = this.matchCaseToCycle(symptoms, cycle, true);
        const segCount = match.matched_segments.length;
        const total = cycle.segments.length;
        const segCoverage = total ? segCount / total : 0;
        r.cycle_analysis = {
          remedy_cycle: cycle.remedy_name,
          segment_matches: match.matched_segments,
          segments_matched_count: segCount,
          total_segments: total,
          coverage: match.coverage,
          segment_coverage: Math.round(segCoverage * 1000) / 1000,
          generalized_hits: match.generalized_hits,
          cycle_sentence: cycle.sentence ?? null,
          map_of_hierarchy_phase: cycle.map_of_hierarchy_phase ?? null,
          meets_threshold: segCount >= cycleMinSegments && segCoverage >= cycleMinCoverage,
        };
      }
    }
    return results;
  }

  private retrieveRubrics(symptom: string, retrieval: string, k: number): SearchHit[] {
    const mode = (retrieval || "hybrid").trim().toLowerCase();
    if (mode === "lexical") return this.searchRubricsLexical(symptom, k);
    if (mode === "vector") return this.searchRubricsVector(symptom, k);
    return this.searchRubricsHybrid(symptom, k);
  }
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  if (a.size < b.size) { for (const x of a) if (b.has(x)) return true; return false; }
  for (const x of b) if (a.has(x)) return true;
  return false;
}

export interface CycleSegment {
  name: string; description?: string;
  symptoms: string[]; generalizations: string[]; next_segment?: string;
}
export interface Cycle {
  remedy_name: string; remedy_abbrev?: string; sentence?: string;
  cycle_loop?: boolean; map_of_hierarchy_phase?: number | null;
  references?: string[]; segments: CycleSegment[];
}
