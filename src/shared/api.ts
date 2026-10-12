import type { OorepEngine, RepertorizeResult, SearchHit, RubricRemedy, Cycle } from "../main/engine";

export interface AppInfo { version: string; platform: string; electron: string; node: string; }
export interface EngineStats {
  ready: boolean;
  remedies?: number; rubrics?: number; rubricsDistinct?: number; links?: number;
  vectorRows?: number; cycles?: number; indexWords?: number; loadMs?: number;
  srcRoot?: string | null; dbSizeBytes?: number;
}
export interface LiveStatus { srcRoot: string | null; running: boolean; watching: number; }
export interface LiveItem { label: string; file: string; exists: boolean; size: number; mtimeMs: number; }
export interface Telemetry {
  qpm: number; history: { t: number; qpm: number }[];
  kinds: { kind: string; count: number; avgMs: number; lastMs: number }[];
  totalQueries: number;
}
export interface Candidate {
  rank: number; review_status: string; query_original: string; query_expanded: string;
  rubric_id: number; rubric: string; source: string; retrieval: string;
  retrieval_score: number; remedy_count: number;
}
export interface NormalizedSymptom {
  original: string; cleaned: string; expanded_terms: string[]; expanded_query: string;
}
export interface CycleInfo {
  remedy_name: string; sentence?: string; segments: { name: string; symptoms: string[] }[];
}

export interface Api {
  appInfo(): Promise<AppInfo>;
  engineReady(): Promise<boolean>;
  getStats(): Promise<EngineStats>;
  searchRubrics(query: string, mode: "lexical" | "vector" | "hybrid", limit?: number): Promise<SearchHit[]>;
  searchRemedies(query: string, limit?: number): Promise<{ id: number; abbrev: string; name: string }[]>;
  remediesForRubric(rubricId: number): Promise<RubricRemedy[]>;
  repertorize(symptoms: string[], opts?: Parameters<OorepEngine["repertorize"]>[1]): Promise<RepertorizeResult[]>;
  candidatesForSymptom(symptom: string, limit?: number): Promise<Candidate[]>;
  normalizeSymptom(symptom: string): Promise<NormalizedSymptom>;
  getCycle(remedy: string): Promise<CycleInfo | null>;
  live: {
    status(): Promise<LiveStatus>;
    snapshot(): Promise<LiveItem[]>;
    telemetry(): Promise<Telemetry>;
    pause(): Promise<boolean>;
    resume(): Promise<boolean>;
    refreshDb(): Promise<{ ok: boolean; stats?: unknown; error?: string }>;
  };
  onLiveEvent(cb: (e: { type: "change" | "stats" | "ready" | "error"; data: unknown }) => void): void;
}

declare global {
  interface Window { oorep: Api; }
}

export {};
