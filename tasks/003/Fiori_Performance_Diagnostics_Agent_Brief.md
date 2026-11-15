# Electricity Counter Fiori — Performance Diagnostics
## AI coding-agent implementation brief

## 0. Mission

Add **client-side performance diagnostics** to the existing Electricity Counter SAPUI5 freestyle application so that the user can identify where report loading time is spent.

The immediate problem is that data takes too long to arrive from SAP. Before changing queries, batching, concurrency, caching or calculation logic, we need reliable measurements that distinguish:

1. OData logical reads and paging;
2. actual HTTP / OData batch activity where observable;
3. the number of rows returned by each entity-set read;
4. JavaScript data preparation and calculation stages;
5. total report-loading time.

The primary output is structured information in the **browser developer console**. Do not add a visible diagnostic panel to the business report unless the existing application already has a diagnostics convention that can be reused.

This is an instrumentation task, **not a performance-optimisation task**. Do not change business calculations or data retrieval behaviour as part of this work. Measurements should help decide what to optimise in a later change.

---

## 1. Inspect the existing application first

Before editing, inspect the current repository/workspace and identify:

- the UI5 version and existing application structure;
- the shared OData V2 model creation/configuration;
- the current routes and report controllers;
- the OData service module and its Promise wrappers;
- where report loading starts and where the final report model is populated;
- the existing build, lint and test commands.

The current project context includes an OData V2 service:

```text
/sap/opu/odata/sap/Z_BIND_ELECTR_CNT_001/
```

The known service module is `odataService.js` (adapt to the actual path/casing in the repository). It currently has logical operations such as:

- `readParents()` — reads `Z_C_ELECR_VALIDATE`;
- `readRefComponents()` — reads `Z_C_ELECR_VALIDATE_REF`;
- `readSourceRows()` — reads `Z_I_ELECR_CNTR` for reference positions;
- an internal `readAll()` Promise wrapper that follows OData V2 `__next` paging;
- bounded source-position chunking and limited concurrency (the previously inspected implementation used chunks of 8 positions and concurrency 3).

Treat those values as the existing implementation, not constants to copy blindly. Log the actual configured chunk size and concurrency where available.

The current application has the formula-validation report and the two business reports. The established direct routes are:

- `#/formula-test`
- `#/current-month`
- `#/year-report`

Use the actual current routing setup if it has evolved. Do not add a home page or alter navigation as part of this task.

Do not overwrite unrelated work or reformat large files unnecessarily.

---

## 2. Scope and non-goals

### In scope

- A small reusable diagnostics utility/module.
- A single feature switch to enable/disable performance logging.
- Report-run start/end summaries.
- Timings and counts for each OData logical operation.
- Per-page timings and row counts for paged reads.
- Per-chunk diagnostics for source-position batches.
- Timings for major JavaScript processing stages.
- Safe error diagnostics for failed reads and failed report runs.
- A concise README note explaining how to enable and use the diagnostics.
- Tests for the diagnostics helpers and instrumentation where practical.

### Explicitly out of scope

Do **not**:

- change OData filters, `$select`, `$orderby`, `$top`, paging or continuation behaviour;
- change source-position chunk size or concurrency;
- add caching, retry logic, request deduplication or query batching;
- change the OData model's `useBatch` setting;
- alter formula parsing, reference resolution, monthly aggregation, decimal precision or report columns;
- change the plant, date ranges or business selection rules;
- add OData write operations or modify SAP backend objects;
- log full OData response payloads, formula text, quantity values, cookies, authorization headers or other credentials;
- add a third-party monitoring/logging dependency.

The instrumentation must be observational only. With diagnostics disabled, report behaviour and console output should remain unchanged apart from negligible wrapper overhead.

---

## 3. Feature switch

Implement one central switch using the project's existing configuration conventions. Suggested interface:

```javascript
// Example only; adapt to the project's UI5 module/configuration style.
var PERFORMANCE_DIAGNOSTICS_ENABLED = false;
```

Prefer a convenient development-time way to enable it without editing multiple modules. An optional URL flag such as `?debugPerf=1` is acceptable if it fits the current application conventions. If a URL flag is implemented, document its exact placement relative to the UI5 hash route, for example:

```text
index.html?debugPerf=1#/current-month
```

Requirements:

- Default to disabled for normal business use/production.
- One central switch controls all diagnostics.
- Do not scatter independent debug booleans across services and controllers.
- When disabled, do not print performance logs.
- Avoid persistent browser storage unless the project already uses it for developer settings.

---

## 4. Reusable diagnostics utility

Add a small module, for example `service/performanceDiagnostics.js`, adapted to the existing AMD/UI5 module style.

The utility should provide a minimal API equivalent to:

```javascript
beginReportRun(reportName, context) -> runContext
endReportRun(runContext, outcome, details)
startStage(runContext, stageName, details) -> timer
endStage(timer, details)
logODataPage(runContext, details)
logODataOperation(runContext, details)
logError(runContext, label, error, details)
```

The agent may use a different API if simpler, but it must support the same information.

### Timing rules

- Use `performance.now()` for elapsed durations (monotonic timing).
- Use `new Date().toISOString()` only for human-readable wall-clock timestamps.
- Do not calculate durations by subtracting wall-clock `Date` values.
- Give every report run a short unique run ID so messages from overlapping/repeated runs can be separated.
- Include the report name and run ID in every message.
- Ensure timers are closed in `finally` blocks so failed stages are still measured.

### Console presentation

Use consistent prefixes, for example:

```text
[PERF][run-0042][CURRENT_MONTH]
[ODATA][run-0042][CURRENT_MONTH]
```

Use `console.groupCollapsed`, `console.info`, `console.warn`, `console.error` and `console.table` where useful. Avoid one log line per individual data record; log summaries and page/chunk-level details instead.

The console output should be compact enough to use during normal testing, but detailed enough to identify the slow operation.

---

## 5. OData instrumentation

Instrument the existing OData service layer rather than duplicating reads in controllers.

### 5.1 Logical operation measurements

For each logical operation, record:

- operation label (`readParents`, `readRefComponents`, `readSourceRows`);
- entity-set path;
- report run ID;
- start timestamp;
- elapsed milliseconds;
- total records returned across all pages/chunks;
- page count;
- chunk count, if applicable;
- number of unique positions requested, if applicable;
- success/failure status;
- safe error status/message on failure.

At minimum, the logs must make it clear which entity set was read and how many records were collected.

### 5.2 Paging measurements

The existing `readAll()` follows OData V2 continuation using `__next`. Instrument **each page**, not just the overall logical read.

For every page, record:

- page index (1-based);
- elapsed milliseconds for that page;
- number of records in that page;
- whether a continuation (`__next`) was present;
- success/failure.

Also record a total for the logical read:

- total elapsed milliseconds;
- total records from all pages;
- total pages.

Do not log the full `__next` URL if it could contain long filters or tokens. A boolean indicating continuation is enough; a redacted/truncated URL may be included only if it is safe.

### 5.3 Source-position chunks and concurrency

`readSourceRows()` divides the unique reference positions into chunks and runs them with bounded concurrency. Add diagnostics at both levels:

**Per chunk:**

- chunk index / total chunks;
- number of positions in the chunk;
- elapsed milliseconds;
- records returned;
- page count if the chunk read is paged;
- success/failure.

**Whole source-row operation:**

- total number of unique positions requested;
- chunk size;
- number of chunks;
- configured maximum concurrency;
- total records returned;
- total elapsed time;
- failed chunks.

Do not change chunking or concurrency while adding these measurements.

### 5.4 Retry/fallback visibility

If `readParents()` retries a position using uppercase formatting after the initial read returns no records, log the retry explicitly:

- original position representation;
- retry representation (uppercase);
- first-read result count;
- retry result count and duration.

Do not log source quantity values or full formula text.

### 5.5 Errors and partial data

A failed page or chunk must be logged as a failure. Do not let diagnostics turn a failed read into a successful result.

If the existing service rejects the Promise on any failed page/chunk, preserve that behaviour. If it currently permits partial results, do not silently change it in this task; report the limitation and ensure the failure is visible in logs.

### 5.6 OData V2 model/network events

Inspect whether the application uses OData batching (`useBatch`) and which model events are available in the installed UI5 version.

If useful and supported, attach diagnostics listeners once to the shared OData V2 model for events such as:

- `requestSent`, `requestCompleted`, `requestFailed`;
- `batchRequestSent`, `batchRequestCompleted`, `batchRequestFailed`.

Use these only to provide transport-level context (URL/path, method, duration, status/success). Avoid attaching duplicate listeners on every route navigation or report refresh; attach once and detach if the model is destroyed.

Important distinction:

- `readParents()` / `readSourceRows()` are **logical service operations**;
- model request events may represent individual OData operations or transport/batch activity depending on UI5 model configuration;
- one `$batch` HTTP request can contain multiple logical OData operations.

Label these layers separately. Do not add their durations together or present logical reads and batch requests as the same request count. Do not claim that a logical read equals one HTTP request.

The browser Network panel remains the source of truth for the actual HTTP exchanges. Do not monkey-patch private UI5 internals to infer network calls.

---

## 6. JavaScript processing-stage instrumentation

Add stage measurements around the existing report-loading pipeline. Do not change the pipeline's order or calculations.

For the formula-validation report, current-month report and year report, instrument the stages that actually exist in the current implementation. Typical stages include:

1. report loading start / filter preparation;
2. read parent/source records;
3. read ABAP parser components;
4. collect and deduplicate reference positions;
5. read reference-position source rows;
6. build the source index;
7. parse formula text with the JavaScript parser;
8. compare JS and ABAP component structures;
9. resolve references;
10. calculate adjusted quantities;
11. calculate suggested quantities;
12. monthly/year aggregation;
13. build view-model rows;
14. set the report model / data-ready point.

Only instrument stages that exist. Do not invent artificial stages merely to match this list.

For each stage, log:

- stage name;
- elapsed milliseconds;
- useful counts where available (parents, formulas, components, unique positions, source rows, output rows);
- outcome (success/failure).

For a sequential pipeline, the individual durations should be interpretable against total report duration. If independent operations run concurrently, log their individual elapsed time and the overall wall-clock time; do not sum concurrent durations and call that total time.

### Rendering note

At minimum, record when report data is ready and bound to the view model. Optionally measure the first table rendering after that data-ready point if it can be done cleanly using the project's existing lifecycle. Avoid logging every rerender, sorting, scrolling or resize as part of the report-load duration.

Do not claim that `setData()` duration is the same as browser rendering time.

---

## 7. Expected console output

The precise format is up to the agent, but it should communicate approximately this level of detail:

```text
========== REPORT LOAD START ==========
[PERF][run-0042][CURRENT_MONTH] Started 2026-11-15T19:15:03.125Z
Context: plant=2010, period=2026-11

[ODATA][run-0042] readParents
  Entity: /Z_C_ELECR_VALIDATE
  Duration: 1,840 ms
  Pages: 1
  Records: 250
  Status: success

[ODATA][run-0042] readRefComponents
  Entity: /Z_C_ELECR_VALIDATE_REF
  Duration: 620 ms
  Pages: 1
  Records: 1,240
  Status: success

[ODATA][run-0042] readSourceRows
  Entity: /Z_I_ELECR_CNTR
  Unique positions: 137
  Chunk size: 8
  Chunks: 18
  Max concurrency: 3
  Records: 8,450
  Duration: 12,450 ms

  Chunk 1/18: 8 positions, 470 records, 610 ms, 1 page
  Chunk 2/18: 8 positions, 512 records, 720 ms, 2 pages
  ...

[PERF][run-0042] Build source index: 340 ms (8,450 rows)
[PERF][run-0042] Parse JS formulas: 45 ms (250 formulas)
[PERF][run-0042] Compare components: 24 ms (250 parents)
[PERF][run-0042] Calculate adjusted: 180 ms
[PERF][run-0042] Calculate suggested: 165 ms
[PERF][run-0042] Aggregate monthly values: 72 ms
[PERF][run-0042] Build report model: 90 ms (137 output rows)

========== REPORT LOAD COMPLETE ==========
[PERF][run-0042][CURRENT_MONTH]
  Total wall time: 15,685 ms
  OData logical operations: 3
  OData pages: 20
  Source chunks: 18
  Source rows: 8,450
  Output rows: 137
  Failed operations: 0
  Outcome: success
```

The numbers above are illustrative only. Never hard-code or report them as actual performance results.

For the year report, include selected position and year in the context. For the formula-validation route, include the selected position/month and relevant options, but do not include formula text or quantity values.

---

## 8. Privacy and log volume

The console is intended for controlled developer/UAT troubleshooting. Even so, logs must be deliberately limited.

Safe to log:

- report name and run ID;
- plant, selected position and reporting period where useful;
- entity-set path;
- `$select` field names;
- page/chunk indexes;
- record counts;
- durations, success/failure and HTTP status;
- sanitized error text.

Do not log:

- authorization headers, cookies, CSRF tokens or credentials;
- complete response objects or row arrays;
- formulas or full calculation breakdowns;
- adjusted/suggested quantity values;
- personal/business data not needed to diagnose performance;
- full request URLs when they include sensitive filter values or continuation tokens.

Do not use `console.log(data)` for OData payloads. Avoid logging every row or every formula term. If a filter is logged, prefer a safe summary such as `Plant=2010; ValidDate range=2026-11-01..2026-11-15; positions=137` rather than dumping potentially sensitive values.

---

## 9. Concurrency, overlapping runs and lifecycle

The user may refresh the report or navigate between routes while a previous run is still active.

- Every report load must have its own run ID and independent counters/timers.
- Do not use shared mutable global counters that mix two report runs.
- Diagnostics must not cancel, delay or serialize requests.
- If the existing report logic already ignores stale responses, preserve it. Do not add request cancellation as part of this instrumentation task.
- Attach model-level event listeners once only. Avoid listener leaks on repeated navigation or refresh.
- Ensure failed or cancelled runs produce a clear terminal summary if the existing flow exposes that outcome.
- Do not hide or replace the application's existing busy indicators or error messages.

---

## 10. Tests and verification

Add tests using the existing test framework. Avoid adding a new test framework solely for this task.

At minimum, verify:

1. Diagnostics are silent when disabled.
2. Diagnostics emit a report start and terminal summary when enabled.
3. A successful OData page logs elapsed time and the correct record count.
4. Multiple pages produce the correct total page and record counts.
5. A failed page/chunk is logged as a failure and the original error behaviour is preserved.
6. Source chunk summaries report the correct number of positions, chunks and returned rows.
7. A report run's counters do not leak into a subsequent run.
8. Repeated route navigation / report refresh does not attach duplicate model event listeners.
9. Logs do not include response payloads, formulas, quantities, cookies or authorization headers.
10. Existing parser, resolver, aggregation and report tests still pass unchanged.

Use a controllable clock or stubbed `performance.now()` where deterministic timing assertions are needed. Do not assert exact real elapsed milliseconds in tests.

Manually verify in the browser:

- diagnostics can be enabled and disabled centrally;
- the three report routes produce distinct report labels;
- the console shows counts for every OData logical operation;
- paged reads show per-page detail and a total;
- source-position chunk totals reconcile with the total source-row count;
- a failed request is visible and does not appear as a successful report run;
- normal report values and behaviour are unchanged.

Run the project's existing build and test commands and report their results.

---

## 11. Deliverables

Provide:

1. Reusable performance diagnostics module.
2. Central enable/disable switch and documented activation method.
3. Instrumentation in the existing OData service (`readAll`, logical reads, paging and source chunks).
4. Instrumentation around major report-processing stages for all applicable report routes.
5. Optional one-time OData model request/batch event instrumentation, only if supported and useful in the installed UI5 version.
6. Tests for the diagnostics and proof that existing behaviour is unchanged.
7. A short README section with instructions:
   - how to enable diagnostics;
   - which browser console to open;
   - how to identify report runs;
   - how to read OData page/chunk and JavaScript stage timings;
   - reminder that browser Network and SAP Gateway traces are needed to distinguish client wait from backend processing.
8. A concise implementation summary listing files changed, tests/build run and any limitations.

Do not make performance claims or optimisations based on illustrative/example timings. The result of this task should be a trustworthy measurement baseline for the next performance-investigation step.

---

## 12. Development principle

**Measure first. Optimise second.**

The diagnostics should tell us whether the time is spent waiting for SAP OData responses, fetching many pages/chunks, processing data in JavaScript, or preparing/rendering the report. Keep the instrumentation small, reusable, safe and easy to disable.
