#!/usr/bin/env python3
"""Generate golden test vectors from the canonical Python engine.

Captures: hybrid search top-10, vector search top-10, repertorize top-15
(with mapper + cycles, default settings), and lexical search — for a fixed
set of symptoms. Stored as JSON for the TypeScript port's unit tests.

Match lists are kept complete (not truncated) and cycle_analysis included,
so the TS port can be compared on a like-for-like multiset basis.
"""
import json, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path.home() / "projects" / "oorep-local-repertory"))

from oorep.homeopathic_repertory import HomeopathicRepertory
from oorep.clinical_rubric_mapper import ClinicalRubricMapper

rep = HomeopathicRepertory()
mapper = ClinicalRubricMapper(rep)

QUERIES = [
    "headache morning",
    "dry cough evening",
    "anxiety about health",
    "sleepless after midnight",
    "thirst small sips",
    "head pain worse cold",
]

SYMPTOM_SETS = [
    ["headache morning", "nausea", "irritability"],
    ["dry cough evening", "hoarseness", "thirst small sips"],
    ["anxiety about health", "sleepless after midnight", "fear of death"],
]

def clamp(f):
    return round(float(f), 6)

out = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "hybrid": [], "vector": [], "lexical": [], "repertorize": []}

for q in QUERIES:
    res = rep.search_rubrics_hybrid(q, limit=10)
    out["hybrid"].append({
        "query": q,
        "results": [
            {"id": r["id"], "fullpath": r["fullpath"], "source": r["source"],
             "hybrid": clamp(r.get("_hybrid_score", 0))}
            for r in res
        ],
    })
    res = rep.search_rubrics_vector(q, limit=30)
    out["vector"].append({
        "query": q,
        "results": [
            {"id": r["id"], "fullpath": r["fullpath"], "source": r["source"],
             "score": clamp(r.get("_vector_score", 0))}
            for r in res[:10]
        ],
        "wide": [
            {"id": r["id"], "score": clamp(r.get("_vector_score", 0))}
            for r in res
        ],
    })
    res = rep.search_rubrics(q, limit=10)
    out["lexical"].append({
        "query": q,
        "results": [
            {"id": r["id"], "fullpath": r["fullpath"], "source": r["source"],
             "match": clamp(r.get("_match_score", 0))}
            for r in res
        ],
    })

for symptoms in SYMPTOM_SETS:
    t0 = time.time()
    res = rep.repertorize(symptoms, top_n=15, retrieval="hybrid")
    dt = time.time() - t0

    # Full (untruncated) match reconstruction through the same code path the
    # engine uses: mapper candidates -> per-symptom rubric dedupe -> remedies.
    # This gives the ground-truth multiset for exact TS comparison, immune to
    # the display-order truncation (matches[:5]) in repertorize().
    from collections import defaultdict
    full = defaultdict(list)
    for symptom in symptoms:
        candidates = mapper.suggest_candidates(symptom, limit=10, retrieval="hybrid", require_remedies=True)
        seen = set()
        for c in candidates:
            rid = int(c["rubric_id"])
            if rid in seen:
                continue
            seen.add(rid)
            seen_ab = set()
            for rem in rep.get_remedies_for_rubric(rid):
                ab = rem["abbrev"]
                if ab in seen_ab:
                    continue
                seen_ab.add(ab)
                full[ab].append((symptom, rid, int(rem["weight"])))

    out["repertorize"].append({
        "symptoms": symptoms,
        "elapsed_ms": int(dt * 1000),
        "results": [
            {
                "abbrev": r["abbrev"], "name": r["name"],
                "score": int(r["score"]), "match_count": int(r["match_count"]),
                "matches": [
                    {"query_symptom": m["query_symptom"], "rubric_id": m["rubric_id"],
                     "rubric": m["rubric"], "source": m["source"], "weight": m["weight"],
                     "query_expanded": m.get("query_expanded")}
                    for m in r["matches"]
                ],
                "cycle": r.get("cycle_analysis"),
                "full_matches": sorted(full.get(r["abbrev"], [])),
            }
            for r in res
        ],
    })

dest = ROOT / "test" / "goldens.json"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(out, indent=1))
print("goldens written:", dest)
print("repertorize elapsed (py):", [r["elapsed_ms"] for r in out["repertorize"]], "ms")
