# Electricity Counter Fiori — Performance Diagnostics
## Implementation Report (task 003)

Date: 2026-11-15
Scope: client-side performance diagnostics per `Fiori_Performance_Diagnostics_Agent_Brief.md` — **instrumentation only**, no retrieval/calculation/UI behaviour changes.

---

## 1. What was delivered

| # | Deliverable | Location |
|---|---|---|
| 1 | Reusable diagnostics utility | [`webapp/service/performanceDiagnostics.js`](../../webapp/service/performanceDiagnostics.js) |
| 2 | Central enable/disable switch (URL flag `?debugPerf=1`, default off) | same module, `ENABLED` + `setEnabledForTest` (test hook only) |
| 3 | OData instrumentation: per page, per logical operation, per chunk, uppercase retry, errors | [`webapp/service/odataService.js`](../../webapp/service/odataService.js) |
| 4 | JS processing-stage timers | [`webapp/service/positionReportService.js`](../../webapp/service/positionReportService.js) |
| 5 | Report run begin/end summaries | [`View1.controller.js`](../../webapp/controller/View1.controller.js), [`CurrentMonth.controller.js`](../../webapp/controller/CurrentMonth.controller.js), [`PositionYear.controller.js`](../../webapp/controller/PositionYear.controller.js) |
| 6 | Unit tests (8 new) | [`webapp/test/unit/service/performanceDiagnostics.qunit.js`](../../webapp/test/unit/service/performanceDiagnostics.qunit.js) |
| 7 | README section | [`README.md`](../../README.md) — "Performance diagnostics (v0.3)" |

## 2. How to use

1.  Open the app with the flag **before the hash**:

    ```text
    http://localhost:8080/index.html?debugPerf=1#/current-month
    http://localhost:8080/index.html?debugPerf=1#/year-report
    http://localhost:8080/index.html?debugPerf=1#/formula-test
    ```

3.  Run the report, open the browser developer console (F12).
4.  Each run appears as a collapsed group with a unique run ID:

    ```text
    [PERF][run-0007][CURRENT_MONTH] REPORT LOAD START
      Started 2026-11-15T19:15:03.125Z | Context: plant=2010, period=2026-11
      [ODATA][run-0007] readParents | entity=/Z_C_ELECR_VALIDATE | duration=1,840 ms | records=250 | status=success
      [ODATA][run-0007] page 1: 120.5 ms, records=250, continuation=no, status=success
      [ODATA][run-0007] readSourceRows | entity=/Z_I_ELECR_CNTR | duration=12,450 ms | records=8,450 | chunks=18 (size 8, concurrency 3) | unique positions=137 | status=success
      [ODATA][run-0007] chunk 1/18: 8 positions, 470 records, 610.2 ms, pages=1, status=success
      [PERF][run-0007][CURRENT_MONTH] Build source index: 340.1 ms (rows=8450)
      [PERF][run-0007][CURRENT_MONTH] Calculate positions: 180.4 ms (positions=137)
      Total wall time: 15,685.2 ms
      OData logical operations: 3 | pages: 20 | records: 8,450 | source chunks: 18 | failed operations: 0 | outcome: success
    ```

## 3. What is measured

### 3.1 OData layer (in `odataService.js`)

| Instrumented point | Details logged |
|---|---|
| `readAll()` — **every page** | page index (1-based), duration ms, record count, continuation (`__next`) yes/no, status. No URLs or skiptokens. |
| `readParents()` | logical operation: entity, duration, records, status; the **uppercase retry** is logged as its own labelled entries (first-read count, retry count/duration). |
| `readRefComponentsRange()` / `readSourceRowsRange()` | logical operation: entity, duration, records, status. |
| `readSourceRows()` | whole operation: unique positions, chunk size (8), chunk count, configured concurrency (3), total records, duration, failed chunks; **per chunk**: chunk i/n, positions, records, duration, pages, status. |
| failures | `logError` with a sanitized message; failed operations counted in the run summary; original Promise rejection behaviour unchanged. |

### 3.2 JavaScript stages (in `positionReportService.js`)

| Stage | Counts |
|---|---|
| Collect reference positions | unique positions |
| Build source index | raw rows |
| Calculate positions | positions |

### 3.3 Report runs (controllers)

| Report | Run label | Context |
|---|---|---|
| Monthly — all positions | `CURRENT_MONTH` | plant, period `yyyy-MM` |
| Position — 12-month overview | `YEAR_REPORT` | plant, pos, year |
| Formula test | `FORMULA_TEST` | plant, pos, month |

Each run ends with a terminal summary: total wall time, OData logical operations / pages / records / source chunks / failed operations, output rows, outcome (`success` / `failed`).

## 4. Design rules honoured (per the brief)

- **Observational only**: no changes to filters, `$select`, `$top`, paging, chunk size (8), concurrency (3), caching, calculations, columns or navigation. With diagnostics disabled every helper is a no-op and nothing is printed.
- **One central switch**: the `?debugPerf=1` URL flag (read once at module load, no persistent storage). `setEnabledForTest()` exists only for deterministic unit tests.
- **Timing**: `performance.now()` for all durations (monotonic); wall-clock ISO strings for humans only; unique run IDs; stage timers closed in `finally`-style flows by the callers.
- **Privacy**: no payloads, formulas, quantities, credentials, cookies, tokens or full request URLs are logged — only counts, durations, statuses, entity-set paths and safe labels.
- **Layer distinction**: `[ODATA]` logical operations/pages/chunks are reported separately from anything transport-level; the README states that the browser Network panel and SAP Gateway traces remain the source of truth for actual HTTP exchanges.
- **No new dependencies, no backend changes, no deployment.**

## 5. Verification

| Command | Outcome |
|---|---|
| Unit tests (71 QUnit tests: 63 existing + 8 new diagnostics tests, executed in Node) | **71 passed, 0 failed** |
| `npm run build` | OK — build succeeded |

New tests cover: silence when disabled; start/terminal summary when enabled; page and operation counters; failure counting with preserved error behaviour; chunk counter reconciliation; no counter leaks between runs; stage timers with counts; and absence of payloads/formulas/credentials in the logs.

## 6. Files changed

| File | Change |
|---|---|
| `webapp/service/performanceDiagnostics.js` | **NEW** — diagnostics utility + central switch |
| `webapp/service/odataService.js` | instrumented `readAll` (pages), `readParents` (incl. uppercase retry), `readRefComponentsRange`, `readSourceRowsRange`, `readSourceRows` (chunks) |
| `webapp/service/positionReportService.js` | stage timers (collect reference positions, build source index, calculate positions) |
| `webapp/controller/View1.controller.js` | `FORMULA_TEST` run begin/end |
| `webapp/controller/CurrentMonth.controller.js` | `CURRENT_MONTH` run begin/end |
| `webapp/controller/PositionYear.controller.js` | `YEAR_REPORT` run begin/end |
| `webapp/test/unit/service/performanceDiagnostics.qunit.js` | **NEW** — 8 diagnostics tests |
| `webapp/test/unit/AllTests.js` | registration |
| `README.md` | "Performance diagnostics (v0.3)" section |

## 7. Notes / limitations

- The diagnostics are client-side only; they measure the browser's view of the work. Actual HTTP exchanges (and backend processing time) must be confirmed with the browser Network panel and SAP Gateway traces.
- One logical read can span several pages/chunks — the logs deliberately keep these as separate lines and the summary never equates a logical read with one HTTP request.
- The console output is intentionally compact; with very large months the chunk lines are the bulk of the output — this is by design (per-chunk visibility is required to locate the slow batch).
- No performance optimisations were made; the measurements are the baseline for a follow-up optimisation task.