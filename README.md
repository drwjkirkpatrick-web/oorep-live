# OORep Live

**A cross-platform (macOS & Linux) Electron desktop app for the OOREP homeopathic repertory — with a live data window.**

Offline, practitioner-owned, no cloud. Built from the [OOREP local repertory](../oorep-local-repertory) project's data and algorithms.

## What it does

- **Repertorize** — enter case symptoms in patient language; the clinical mapper expands phrasing (31 synonym rules), retrieves reviewable rubric candidates (hybrid lexical + vector), and ranks remedies by classical grade sums across Kent (German) + Repertorium Publicum, with Herscu Cycles & Segments enrichment (604 cycles).
- **Repertory Search** — lexical / vector / hybrid rubric search (74,785 distinct rubrics), click through to grade-sorted remedy lists (1.36M remedy–rubric links, 2,432 remedies).
- **Cycles** — segment coverage and generalization hits for the current case's top remedies.
- **Live Data** — a live monitoring window: stat cards, a query-rate chart with pulsing live indicator, per-kind query telemetry (count / avg ms / last ms), a watch list of the source project's data files (feedback.db, security.db, metadata.json, build_log.json, 600 cycle files), and an event log. File changes are detected within 2 s and flashed in the UI.

## Fidelity

The TypeScript engine (`src/main/engine.ts`) is a faithful port of the Python engine
(`oorep/homeopathic_repertory.py` + `oorep_vector_search.py` + `clinical_rubric_mapper.py`
+ `cycles_and_segments.py`), verified by golden tests generated from the Python engine
itself: 29/29 conformance tests pass (scores to 1e-4; ids at every unique-score rank;
full match multisets; cycle analysis fields).

Notable parity details:
- rubric ids are **last-wins** across duplicate ids (publicum wins), matching the Python dict comprehension
- lexical search includes the identity partial match (+0.5 on exact hits) exactly like the Python code
- vector rows are FNV-1a hashed 384-dim BoW, quantized to **IEEE float16 with round-to-nearest-even** (matches `numpy.astype(float16)`), publicum-only, with their own fullpath/source (ids collide across sources)
- cycle matching uses `[a-z]{3,}` token sets, +1.0 symptom / +0.5 generalization, coverage rounding at 3 decimals

## Data

`data/oorep.sqlite` (111 MB) is built by `scripts/build-db.mjs` from the source project's JSON exports and embedded in the packaged app. It contains remedies, rubrics, links, inverted search index, vector index, cycles, synonyms, and metadata.

## Build & run (dev)

```bash
npm install
npm run build:ts        # compile main/preload TypeScript
npm run build:db        # build data/oorep.sqlite from data-sources/ (symlinks to the OOREP project)
npm start               # run the app (expects data/oorep.sqlite)
```

The app auto-detects the source project at `~/projects/oorep-local-repertory` for live monitoring (override with `OOREP_SRC`).

## Tests

```bash
npm test                # 29 golden-conformance engine tests (needs data-sources + goldens)
node test/e2e.test.cjs  # 19-check end-to-end: launches real app under Xvfb, drives UI via CDP
node test/packaged.test.cjs  # 6-check verification of the packaged release build
/usr/bin/python3 scripts/gen_goldens.py  # regenerate goldens from the Python engine
```

E2E coverage: preload bridge, IPC engine calls, all five views, UI-driven search and repertorization, live file-change detection (utimes a watched file, asserts the snapshot advances), telemetry, screenshots.

## Distributables

```bash
npm run dist:linux:arm64   # release/OORep-Live-1.0.0-linux-arm64.zip  (tested on this machine)
npm run dist:linux:x64
npm run dist:mac:arm64     # zip; unsigned — right-click > Open on first launch
npm run dist:mac:x64
```

macOS builds are produced on Linux (electron-builder cross-packaging). They are unsigned:
Gatekeeper will prompt on first launch — right-click → Open, or `xattr -cr` the app.
Linux: `unzip`, then run `oorep-live` (or `./OORep-Live` from the unpacked dir). The
chrome-sandbox needs a normal user session; if your distro blocks it, run with
`--no-sandbox` (dev only).

## Architecture

```
src/main/engine.ts        TS port of the Python engine (loads sqlite into memory)
src/main/live-monitor.ts  fs.watch + 2s polling snapshot, query telemetry (qpm, kinds)
src/main/main.ts          Electron main: IPC handlers, window, engine lifecycle
src/preload/preload.ts    contextBridge API (window.oorep)
src/renderer/             plain-ES-module UI: 5 views, canvas chart, esc() everywhere
scripts/build-db.mjs      JSON → sqlite (last-wins ids, dup-counting index, f16 vectors)
scripts/gen_goldens.py    golden vectors from the canonical Python engine
scripts/make_icons.py     icns + hicolor icons (PIL)
```

Data © OOREP (Andreas Bauer), GPL v3. Cycles & Segments method: Paul Herscu (NESH).
This software is a repertory tool, not medical advice.
