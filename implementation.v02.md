# Electricity Counter — Two Fiori Reports
## Implementation Report v0.2

### v0.2.1 calculation fix (verified against the bE125 extract)

**Symptom:** the 12-month overview showed Adj (JS/ABAP) = −246.021 and Sug = 758.787 for bE125 April 2026, while the stored month value is 1998.367.

**Root cause (verified offline against `test/bE125.html`):** the naive `last − opening` period rule picked a **manual reset row (quantity 0)** as the "last reading". The extract shows every month boundary carries a manual reset row (`MANUAL_ENTRY = X`, quantity 0) next to the automatic reading, and the backend row order within a date is not guaranteed. Reproducing the bug offline gave exactly −246.021 / 758.787.

**Fix — reset-aware segment summation in `MonthlyAggregator.periodChange`:**

1. The opening is the latest reading before the period; when a manual reset row (quantity 0) exists on that date it is the LATER event (read, then reset), so it wins and the period baseline becomes **0** ("reset opening of zero", as in the bE31X fixture).
2. Rows within one date are normalized automatic-first (backend order is not guaranteed).
3. Reset **markers** (manual rows with quantity 0) are detected explicitly and close the current consumption segment even when the baseline is already 0 (a pure value-drop test `0 < 0` would fail there — caught by a dedicated regression test).
4. Unexpected reading drops without a marker are treated as resets (no negative consumption is ever added).
5. The period value = sum of segments (each segment = last real reading − segment baseline).

**Verification:** the reset-aware evaluation of the bE125 April formula over the extract data yields **Adj = 1998.367**, exactly the stored value (bE125's own April daily sum is also 1998.367, confirming formula positions carry daily consumptions and their month total is the sum). New unit tests lock in the bE125 pattern (62 tests total, all green).

**Remaining open point:** the reset semantics ("reset opening = reset value") are still a candidate rule pending ABAP/business confirmation; reset markers and assumptions are reported in the Notes column of both reports.

Date: 2026-11-12
App: `z_electr` (UI5 1.120.30, sap_horizon, freestyle, read-only)
Service: `/sap/opu/odata/sap/Z_BIND_ELECTR_CNT_001/` (OData V2, GET only)
Scope: extends the v0.1 formula-validation prototype with two calculation reports and three directly addressable destinations.

---

## 1. Mission delivered

One SAPUI5 freestyle application now contains **three directly accessible destinations**, each addressable by its own URL hash and launchable from a separate Fiori Launchpad tile without visiting a home page:

| Destination | Route / URL hash | FLP tile startup parameter |
|---|---|---|
| Formula test (v0.1 diagnostic view) | `#formula-test` (also the app default) | `report=formulaTest` |
| Current month — all positions | `#current-month` | `report=currentMonth` |
| Position — 12-month overview | `#year-report`, `#year-report/<pos>` | `report=yearReport` (optionally `&pos=<position>`) |

Both reports are read-only calculation/quality reports; no OData writes exist anywhere in the app.

---

## 2. Metadata refresh — blocker recorded, capability detection implemented

- **Blocker:** the live `$metadata` could not be fetched from the agent environment (`HTTP 401`, SSO required). A fresh extract was later supplied by the user into `test/metdata.xml`, which confirmed the backend additions:
  - `Z_I_ELECR_CNTRType` now exposes **`MainWorkshop`** and **`PositionDescription`** (the description source the brief warned might not exist);
  - **`PastMeasurement`** exists on both `Z_I_ELECR_CNTRType` and `Z_C_ELECR_VALIDATEType`.
- **Runtime capability detection:** instead of relying on a possibly stale local snapshot, [`positionReportService.js`](webapp/service/positionReportService.js) reads the **live service metadata at runtime** (`ODataModel.getServiceMetadata()`) and:
  - adds `MainWorkshop`, the description property (exact name from metadata) and `PastMeasurement` to `$select` only when present — a non-existent `$select` field would fail the request;
  - reports explicit notes (`MainWorkshop not exposed by the service`, `Position description not exposed by the service`) when fields are absent — never faked;
  - `PastMeasurement` is shown as a **reference column only**; it is not used in any calculation (brief 2.4 NB).

---

## 3. Architecture (new/extended modules)

```text
webapp/
  service/
    odataService.js             extended: range reads for all positions (readSourceRowsRange),
                                component range reads (readRefComponentsRange), paging, chunking
    positionReportService.js    NEW: two-phase retrieval, caching, capability detection,
                                per-period calculation of the four variants, notes aggregation
  calculation/
    formulaEvaluator.js         NEW: one evaluator for BOTH component representations,
                                adjusted/suggested variants; structural comparison
    monthlyAggregator.js        extended: periodChange() candidate monthly rule
  view/
    CurrentMonth.view.xml       NEW
    PositionYear.view.xml       NEW
  controller/
    CurrentMonth.controller.js  NEW
    PositionYear.controller.js  NEW
  parser/, calculation/(v0.1)   reused unchanged (parser, decimal, resolver, engine)
```

Key design rule honoured (brief 3.4/5.1): **parser differences are isolated from reference-resolution differences.** Both the JS parse and the ABAP components are evaluated by the *same* `FormulaEvaluator.evaluateComponents` against the *same* resolved reference values, so a JS-vs-ABAP column difference can only come from the parser representation, and a difference from the stored value can only come from resolution/aggregation.

### 3.1 Monthly aggregation rule — explicit and provisional

`MonthlyAggregator.periodChange(rows, monthStart, monthEnd)`:
- value = last reading inside the month − closest available reading before the month start (the bE31X fixture reconstruction "April 30 adjusted less March 31 opening");
- `NO_DATA` when the month has no rows; `INSUFFICIENT_PERIOD_DATA` when no opening reading exists (never zero);
- manual/reset rows inside the month are counted and reported in notes;
- **NOT business-confirmed** — every numeric output carries the note `P(position) RULE NOT VERIFIED` and the UI labels all values `PROVISIONAL`.

### 3.2 Formula-change handling

If a position's formula text changes within the period, the row shows `FORMULA CHANGED DURING PERIOD` and all parser-derived quantities are withheld (no silent first/last-formula selection).

---

## 4. Report 1 — Current month, all positions

One row per position of plant `2010` (internal constant) for the dynamically determined current month. No filter bar; Refresh action only. The covered range and the latest source date are displayed so users see whether the month is complete.

| Column | Source / meaning |
|---|---|
| Workshop | `MainWorkshop` from `Z_I_ELECR_CNTR` (when exposed by live metadata) |
| Position | `Pos` |
| Description | description property from live metadata (`PositionDescription`); explicit gap note when not exposed |
| Adj (JS) | JS parser terms evaluated with **adjusted** reference period values |
| Sug (JS) | JS parser terms evaluated with **suggested** reference period values |
| Adj (ABAP) | Persisted ABAP components evaluated with **adjusted** reference period values |
| Sug (ABAP) | Persisted ABAP components evaluated with **suggested** reference period values |
| UOM | `UnitOfMeasure` of the position |
| Past measurement | `PastMeasurement` reference column (latest row), reference only |
| Formula | Original formula text (truncated with tooltip, full text inspectable) |
| Notes | Aggregated diagnostics: `NO FORMULA`, `JS PARSER: UNSUPPORTED EXPRESSION`, `JS PARSER: SYNTAX ERROR`, `ABAP COMPONENTS NOT FOUND`, `JS / ABAP COMPONENT MISMATCH`, `REFERENCE POSITION MISSING: <pos>`, `AMBIGUOUS REFERENCE ROW (MANUAL ENTRY)`, `MIXED / INCOMPATIBLE UNITS`, `FORMULA CHANGED DURING PERIOD`, `INSUFFICIENT PERIOD DATA`, `P(position) RULE NOT VERIFIED`, `DESCRIPTION NOT EXPOSED BY SERVICE`, `NO DATA` |

Positions with no formula stay visible with `NO FORMULA` and no parser-derived quantities (never zero). Missing references are never turned into zero. Local search filters by position/workshop/description/formula; rows sorted by workshop then position; KPI strip shows position/error counts. Row selection navigates to the 12-month overview with the position prefilled.

## 5. Report 2 — Position, 12-month overview

- Parameters: **Position** (free text) and **Year** (defaults to current year). No plant parameter.
- Exactly **12 rows** (January–December) always displayed; empty months show `NO DATA`.
- Same four quantity variants, the same evaluator/resolver/aggregation rule as Report 1 (no second engine).
- Header context: position, description, workshop, year.
- Selecting a month opens the **component comparison detail panel**: per occurrence, JS sign/reference/multiplier/divisor vs ABAP sign/reference/multiplier/divisor with a per-occurrence match label; a mismatch is visible even when totals match.

---

## 6. Routing and FLP tile support

- `manifest.json` routes: `formula-test`, `current-month`, `year-report`, `year-report/{pos}` (plus the empty default route targeting the formula-test view).
- [`Component.js`](webapp/Component.js) reads FLP `startupParameters` and navigates directly to the requested report — each tile can launch its own destination without a home page:
  - `report=formulaTest` → formula test
  - `report=currentMonth` → current month
  - `report=yearReport` (+ optional `pos`) → 12-month overview
- All three views share a navigation strip; local direct URLs work with `npm run start-noflp` (e.g. `http://localhost:8080/index.html#current-month`).

---

## 7. Files created/changed (v0.2)

| File | Change |
|---|---|
| `webapp/service/positionReportService.js` | NEW — report coordination, capability detection, four variants, notes |
| `webapp/service/odataService.js` | extended with `readSourceRowsRange`, `readRefComponentsRange` |
| `webapp/calculation/formulaEvaluator.js` | NEW — evaluateComponents (both representations), compareComponents |
| `webapp/calculation/monthlyAggregator.js` | extended with `periodChange()` |
| `webapp/view/CurrentMonth.view.xml`, `webapp/controller/CurrentMonth.controller.js` | NEW |
| `webapp/view/PositionYear.view.xml`, `webapp/controller/PositionYear.controller.js` | NEW |
| `webapp/manifest.json` | three direct routes + position parameter route |
| `webapp/Component.js` | FLP startup-parameter routing |
| `webapp/view/View1.view.xml` | navigation strip |
| `webapp/i18n/i18n.properties` | navigation/report texts; fixed corrupted header line |
| `webapp/css/style.css` | `.zeNavStrip` styles |
| `webapp/test/unit/calculation/formulaEvaluator.qunit.js` | NEW tests |
| `webapp/test/unit/calculation/monthlyAggregator.qunit.js` | extended with periodChange tests |
| `webapp/test/unit/AllTests.js` | registration |
| `README.md` | two-reports documentation |

## 8. Commands executed and outcomes

| Command | Outcome |
|---|---|
| Unit tests (59 QUnit tests, verified in Node) | **59 passed, 0 failed** |
| `npm run build` | OK — build succeeded (pre-existing i18n fallback-locale warning only) |

## 9. Test coverage (new in v0.2)

- Evaluator: adjusted and suggested variants with the same resolver; multiplier/divisor applied exactly; missing reference withheld (never zero); incompatible units withheld; empty list → `EMPTY`.
- Component comparison: structural match; sign/coefficient differences per occurrence; missing backend component; `NO_ABAP_COMPONENTS`; **totals matching does NOT hide structural mismatch**.
- `periodChange`: last-minus-opening value; `NO_DATA`; `INSUFFICIENT_PERIOD_DATA` (no invented value); manual/reset rows preserved and reported.
- v0.1 suites (parser regressions 1–6, decimal exactness, calculation withholding) remain green: 59 total tests.

## 10. Confirmed vs provisional — explicit statement

| Area | State |
|---|---|
| Parser equivalence logic, evaluator, comparison | **Confirmed** by unit tests (mechanics) |
| `P(position)` resolution / `PERIOD_CHANGE` aggregation | **Provisional** — needs ABAP/business confirmation; every numeric output labelled `P(position) RULE NOT VERIFIED` |
| Monthly aggregation correctness | **Withheld/provisional** — if `P()` is cumulative, the correct total is the period-end value, not a sum; the UI states this |
| Precision | Exact BigInt decimals internally; the service's scale-3/6 limits remain documented as backend precision boundaries |
| Business acceptance | **Not claimed** — building green and tests passing do not constitute business validation |

## 11. Remaining gaps

1. `P(position)` semantics and reset handling still need ABAP review; the resolver/aggregator are isolated and injectable for that purpose.
2. `PastMeasurement` is displayed as reference only; its business meaning is unconfirmed.
3. If the live service lags behind the local snapshot, capability notes make the gap visible rather than failing silently.
4. FLP tile registration itself (catalog/target mapping) is backend/FLP configuration and out of scope per the brief; the app side (startup parameters, direct routes) is ready.
