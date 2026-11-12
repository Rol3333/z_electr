# Electricity Counter — Formula Validation Prototype
## Implementation Report v0.1

Date: 2026-11-12
App: `z_electr` (UI5 1.120.30, sap_horizon, freestyle, read-only)
Service: `/sap/opu/odata/sap/Z_BIND_ELECTR_CNT_001/` (OData V2, GET only)

---

## 1. Purpose

A business-testing and calculation-discovery tool. It shows, for one plant/position/month:

- the stored balancing formula (verbatim),
- an **independent JavaScript parse** of that formula,
- the **backend parser components** exposed by OData, compared structurally with the JS parse,
- daily rows with stored quantities, the backend-computed quantity and a provisional JS calculation,
- a full reference breakdown with source-row lineage for any selected date.

The app deliberately **never presents a provisional number as authoritative**: `P(position)` semantics are not yet confirmed (the OData projection does not expose `PAST_MEASUREMENT`), so every numeric JS result is labelled `PROVISIONAL` and the monthly aggregate is withheld.

---

## 2. Application logic (data flow)

Orchestration lives in [`View1.controller.js`](webapp/controller/View1.controller.js); the pipeline per **Load** press:

```
1. Read filters: Plant (default 2010, editable), Position (free text),
   Month (date picker, any date in the month), Manual-entry filter,
   P() resolution strategy.

2. Clear all previous results (stale data can never be shown under new filters).

3. readParents  ->  Z_C_ELECR_VALIDATE
   $filter = Plant eq '<plant>' and Pos eq '<pos>'
             and ValidDate ge datetime'<month-01>T00:00:00'
             and ValidDate le datetime'<month-last>T00:00:00'
   - If 0 rows and the position has mixed case: retried once with the
     uppercased position (Plant/Pos carry sap:display-format="UpperCase").
   - If still 0 rows: FALLBACK to Z_I_ELECR_CNTR for the entered position
     itself (that view also exposes Formula). The report then shows source
     rows with an explicit warning that no validation record exists and
     backend ComputedQuantity is unavailable.

4. Parse each DISTINCT formula string once with the independent JS parser
   (formulaParser.js). Formulas may vary by date; a change is indicated.

5. readRefComponents -> Z_C_ELECR_VALIDATE_REF (same plant/pos/month range).
   Grouped by date + manual-entry, ordered by seq.

6. Collect the distinct reference positions from all SUPPORTED parses.

7. readSourceRows -> Z_I_ELECR_CNTR for those reference positions,
   plant, and the context window [month start - 10 days .. month end].
   Chunked (8 positions per request), max 3 concurrent requests.
   Server paging followed via $skiptoken; no unbounded $top.

8. Build a normalized in-memory source index keyed by
   plant | position | date | manualEntry. ALL rows are kept - automatic
   and manual rows are never merged or discarded.

9. For every parent row:
   - resolve each parsed term with the selected strategy
     (referenceResolver.js) -> value + diagnostics + exact source rows;
   - calculate the sum with exact decimal arithmetic
     (calculationEngine.js) -> status + value + term breakdown;
   - compare with StoredAdjustedQuantity (exact difference, no tolerance);
   - compare the JS parse structurally with the backend components
     (per occurrence: sign, reference, multiplier, divisor).

10. Present everything from a local JSON model ("vm"). KPI strip,
    monthly totals (provisional), monthly summary (withheld).
```

### 2.1 Parser

- [`decimal.js`](webapp/parser/decimal.js) — exact BigInt-based decimals (value = mantissa / 10^scale). Dot and comma separators. Division truncates at 12 fractional digits (documented); nothing is rounded to the backend scale 3 before the final sum.
- [`formulaTokenizer.js`](webapp/parser/formulaTokenizer.js) — tokens: numbers (dot/comma fraction), `P(...)` references captured **verbatim** (hyphens included: `bTP-13_k06`), `IF(`/`S(` as unsupported functions, operators, parentheses. A hyphen is part of a reference name only inside `P(...)`; outside it is subtraction.
- [`formulaParser.js`](webapp/parser/formulaParser.js) — recursive descent (`expr → term → factor → primary`). **The whole token stream must be consumed**; any leftover token, unbalanced parenthesis or unknown identifier is a `SYNTAX_ERROR` — a partial parse is never reported as supported.
- [`linearizeExpression.js`](webapp/parser/linearizeExpression.js) — AST → ordered term occurrences. Group scalars are distributed (`(P(A)+P(B))*0,66` → both get multiplier 0.66); a divisor applies to the subexpression it follows (`(P(A)+P(B))/1000 + P(C)` divides only the group). Unsupported in v1: `P(A)*P(B)` (nonlinear), division by a reference, `IF(...)`/`S(...)`, constant offsets, division by zero.

Parser result statuses: `SUPPORTED`, `UNSUPPORTED`, `SYNTAX_ERROR`, `EMPTY`.

### 2.2 Reference resolution (provisional by design)

[`referenceResolver.js`](webapp/calculation/referenceResolver.js) — strategies are injectable; both built-ins are **unconfirmed**:

| Strategy | Rule | Notes |
|---|---|---|
| `EXACT_DATE_ADJUSTED` (default) | `P(pos)` = `AdjustedQuantity` of the exact-date source row | If both an automatic and a manual row exist for the same date → `AMBIGUOUS_SOURCE` (no arbitrary pick). |
| `PREVIOUS_READING_DIFFERENCE` | `P(pos)` = current `AdjustedQuantity` − closest earlier reading | A previous row is **not** automatically `PAST_MEASUREMENT`; gaps/resets/manual rows can affect it. |

Outcomes per reference: `RESOLVED` (with exact source rows), `MISSING_REFERENCE` (never zero), `AMBIGUOUS_SOURCE` (all candidates kept in diagnostics).

### 2.3 Calculation

[`calculationEngine.js`](webapp/calculation/calculationEngine.js):

- contribution = resolved value × multiplier ÷ divisor, sign applied; summed with exact decimals.
- **UOM handling**: the summed terms must be *mutually* compatible — mixing e.g. KWH and MWH references in one sum is withheld as `UOM MISMATCH`. A reference UOM differing from the **parent** UOM is only a **warning**, because formulas routinely contain the conversion themselves (`/1000` turning KWH counters into an MWH parent). Units are never converted silently.
- Any missing/ambiguous reference withholds the whole number for that row.
- Because no strategy is confirmed, a numeric result can only ever be `PROVISIONAL` — never `CALCULATED`, never authoritative.

### 2.4 Monthly aggregation

[`monthlyAggregator.js`](webapp/calculation/monthlyAggregator.js) — the confirmed-rule machinery exists (`SUM_DAILY_CONSUMPTION`, `PERIOD_END_CUMULATIVE`, unit-tested) but **no rule is confirmed**, so the monthly summary always reports:

> `NOT AVAILABLE — P() resolution rule not confirmed; the mathematical meaning of a monthly aggregate (sum of daily consumptions vs period-end cumulative) is unknown`

The **monthly totals row** under the results table is a simple sum of the displayed daily values and is explicitly labelled provisional.

---

## 3. UI output — all tables and columns documented

### 3.1 Selection panel

| Field | Meaning |
|---|---|
| Plant | Plant id, default `2010`, editable (never hard-wired into logic) |
| Position | Free-text position id, e.g. `bE24X` |
| Month | Date picker — any date within the target month |
| Manual entry filter | `All` / `Automatic` / `Manual` — filters the displayed parent rows |
| P() resolution strategy | Selects the provisional resolution strategy (see 2.2) |
| Load | Starts the pipeline; disabled while requests are active |

### 3.2 Position and formula panel

| Element | Meaning |
|---|---|
| Parser status | JS parser status of the first row's formula: `SUPPORTED` / `UNSUPPORTED` / `SYNTAX ERROR` / `NO FORMULA` |
| UOM | `UnitOfMeasure` of the parent position (e.g. `MWH`) |
| Formula constant/changes | Whether the formula is the same on all dates of the month (`Warning` when it changes — the per-date formula is then visible in the detail panels) |
| Formula text | The raw formula, verbatim |
| Message line | Parser message/warnings; also the fallback note (no validation record → source rows shown) or the no-data message including the exact `$filter` used |

### 3.3 Monthly overview (KPI strip)

| KPI | Meaning |
|---|---|
| Parent rows | Number of parent records found (all manual-entry variants) |
| Parser-supported rows | Rows whose formula the JS parser fully parsed (`SUPPORTED`) |
| Unsupported formulas | Rows with `UNSUPPORTED` / `SYNTAX ERROR` / `NO FORMULA` |
| Rows with missing references | Rows withheld due to `INCOMPLETE DATA` / `AMBIGUOUS SOURCE` / `UOM MISMATCH` |
| Calculated rows (provisional) | Rows with a numeric JS value |
| Rows with differences | Rows whose JS value differs from the stored adjusted quantity |
| Monthly aggregate | Always `NOT AVAILABLE` with the reason (see 2.4) |

### 3.4 Monthly results table (one row per parent record)

| Column | Source | Meaning |
|---|---|---|
| Date | `ValidDate` | Row date (yyyy-MM-dd) |
| Manual | `ManualEntry` | `Manual` or `Automatic` — manual/reset rows are preserved, never discarded as duplicates |
| Stored adjusted | `StoredAdjustedQuantity` | **Authoritative stored value** — the comparison target |
| Stored suggested | `StoredSuggestedQuantity` | Reference/display only — never the target |
| Backend computed | `ComputedQuantity` | The quantity the **backend** calculated for this row, shown separately from the JS result (in the current data often `0`) |
| JS value (provisional) | JS calculation | Quantity calculated by the independent JS parser with the selected provisional strategy. **Empty** when the formula is unsupported or references are missing/ambiguous — never a fake 0 |
| Difference (JS - adjusted) | JS value − Stored adjusted | Exact difference, **no tolerance applied**. Empty when no JS value exists |
| Parser comparison | JS parse vs `Z_C_ELECR_VALIDATE_REF` | Structural per-occurrence comparison: *Match* / *Components differ* / *No backend components* |
| Status | Calculation status | `PROVISIONAL`, `INCOMPLETE DATA`, `AMBIGUOUS SOURCE`, `UOM MISMATCH`, `UNSUPPORTED`, `NOT CALCULATED` |

Selecting a row fills the three detail panels below.

**Monthly totals row** (below the table): sums of Stored adjusted, Stored suggested, JS value and total Difference over the displayed rows — explicitly provisional (see 2.4).

### 3.5 Reference breakdown (for the selected date)

One row per formula term of the selected parent record:

| Column | Meaning |
|---|---|
| Seq | Term occurrence order in the formula |
| Sign | `+` or `-` (effective sign of the term) |
| Reference position | Verbatim reference name inside `P(...)` (hyphens/underscores preserved) |
| Multiplier | Scalar coefficient of the term (e.g. `20`, `0.66`) |
| Divisor | Scalar divisor of the term (e.g. `1000`) |
| Source date | Date of the source row used to resolve `P(...)` |
| Source manual | `ManualEntry` of that source row |
| Ref adjusted | Resolved `P(...)` value (source `AdjustedQuantity`, or the difference for the previous-reading strategy) — shown with 6 fractional digits |
| Ref suggested | Source `SuggestedQuantity` of the same row (comparison only) |
| Backend ref adjusted | `RefAdjustedValue` from the backend component row, where present |
| Backend contribution | `Contribution` from the backend component row, where present |
| JS contribution | resolved value × multiplier ÷ divisor, sign applied (exact, 6 fractional digits) |
| RefStatus | `RefStatus` of the backend component row, where present |
| Resolution rule / reason | The rule used (or the exact reason the reference is missing/ambiguous); when several candidate rows exist, all candidates are listed with their dates and manual flags |

Missing references are displayed as missing — never as `0`.

### 3.6 JavaScript parser output (for the selected date)

| Column | Meaning |
|---|---|
| Seq | Stable occurrence order in the formula |
| Sign | `+` / `-` |
| Reference position | Verbatim `P(...)` content |
| Multiplier | Scalar coefficient (exact decimal string) |
| Divisor | Scalar divisor (exact decimal string) |
| Parse note | How the term was produced, e.g. `P(bTP-13_k06) multiplied by the scalar 20 divided by the scalar 1000` |

When the formula is not supported, the panel states it and shows no terms.

### 3.7 Backend parser components and structural comparison

One row per occurrence, JS and backend side by side:

| Column | Meaning |
|---|---|
| Seq | Occurrence number (backend `seq`) |
| Sign / Reference position / Multiplier / Divisor | JS parse values |
| BE sign / BE reference / BE multiplier / BE divisor | Backend component values (`sign`, `ref_position`, `multiplier`, `divisor`) |
| Component match | `Match` (green) or `Differs` / `Extra in backend` / `Missing in backend` (red) |

A mismatch is visible **even if the resulting totals happen to match** — totals are never compared.

---

## 4. Status model

| Status | Meaning |
|---|---|
| `SUPPORTED` | Entire formula parsed and represented by the JS parser |
| `UNSUPPORTED` | Valid syntax but outside v1 semantics (nonlinear, `IF`/`S`, constant offset) |
| `SYNTAX_ERROR` | Malformed or incompletely consumed formula |
| `NO FORMULA` | Formula is empty |
| `PARSE MISMATCH` | JS terms differ from the backend component set |
| `INCOMPLETE DATA` | One or more required source positions/records are absent |
| `AMBIGUOUS SOURCE` | Multiple candidate rows exist and no business rule identifies one |
| `UOM MISMATCH` | The summed terms use incompatible units |
| `PROVISIONAL` | Numeric value from an explicitly unconfirmed candidate rule |
| `CALCULATED` | (reserved) numeric result from a confirmed rule — not reachable today |
| `MATCH` / `DIFFERENCE` | Comparison vs stored adjusted quantity, exact, no tolerance |
| `NOT CALCULATED` | No calculation attempted/possible |

---

## 5. Files created/changed

| File | Purpose |
|---|---|
| `webapp/parser/decimal.js` | Exact decimal arithmetic (BigInt, no dependency) |
| `webapp/parser/formulaTokenizer.js` | Tokenizer |
| `webapp/parser/formulaParser.js` | Recursive-descent parser + public parse result |
| `webapp/parser/linearizeExpression.js` | AST → ordered terms |
| `webapp/calculation/referenceResolver.js` | Injectable provisional P() strategies |
| `webapp/calculation/calculationEngine.js` | Summation, UOM check, status model, comparison |
| `webapp/calculation/monthlyAggregator.js` | Monthly aggregation (withheld until confirmed) |
| `webapp/service/odataService.js` | Read-only V2 access: paging, chunking, source index |
| `webapp/formatter/numberFormatter.js` | Display-boundary formatting (3/6 digits) |
| `webapp/formatter/statusFormatter.js` | Status → label/UI5 state |
| `webapp/controller/View1.controller.js` | Orchestration |
| `webapp/view/View1.view.xml` | Single responsive diagnostic page |
| `webapp/model/models.js` | View-state JSON model factory |
| `webapp/i18n/i18n.properties` | All UI texts |
| `webapp/css/style.css` | Layout styles |
| `webapp/manifest.json` | `flexEnabled: false` (diagnostic tool) |
| `webapp/test/unit/parser/decimal.qunit.js` | Decimal tests |
| `webapp/test/unit/parser/formulaParser.qunit.js` | Parser tests (bE31X fixture + regressions) |
| `webapp/test/unit/calculation/calculationEngine.qunit.js` | Calculation tests |
| `webapp/test/unit/calculation/monthlyAggregator.qunit.js` | Aggregation tests |
| `webapp/test/unit/AllTests.js` | Test registration |
| `jsconfig.json` | ES2020 JS language service |
| `README.md` | Run/build/test + limitations |

## 6. Commands executed and outcomes

| Command | Outcome |
|---|---|
| `npm install` (in `z_electr`) | OK — 523 packages |
| `npm run build` | OK — build succeeded (pre-existing i18n fallback-locale warning only) |
| Unit tests (44 QUnit tests, also verified in Node) | **44 passed, 0 failed** |

## 7. Test coverage

- bE31X fixture → exactly the 8 expected terms (sign/reference/multiplier/divisor).
- Decimal comma (`0,66`), hyphenated references (`position-name`), subtraction vs hyphen (`P(A)-P(B)`), repeated references kept separate, nested parentheses/unary minus, source spans.
- Unsupported: `P(A)*P(B)`, `IF(...)`, `S(...)`, constant offset, pure constant, division by reference, division by zero.
- Syntax errors: malformed parentheses (regression 4), unterminated `P(`, empty `P()`, trailing operator, unknown identifier, invalid character; empty input.
- Decimal exactness: `0.1 + 0.2 = 0.3` exactly; division truncation; invalid literals.
- Calculation: provisional status, missing reference withheld (never zero), ambiguous source, unsupported formula, UOM warning vs error, previous-reading strategy, exact difference without tolerance.
- Aggregation: `NOT AVAILABLE` without a confirmed rule; `SUM_DAILY_CONSUMPTION` / `PERIOD_END_CUMULATIVE` / `PARTIAL` paths (unit-level only).

## 8. Confirmed vs provisional

| Area | State |
|---|---|
| Parser term structure (bE31X fixture, regressions) | **Confirmed** by unit tests |
| Exact decimal arithmetic | **Confirmed** by unit tests |
| Structural JS-vs-backend comparison | **Confirmed** logic; backend data itself is one of the validation targets |
| `P(position)` resolution (both strategies) | **Provisional** — `PAST_MEASUREMENT` not exposed by `Z_I_ELECR_CNTR`; ABAP review required |
| All numeric JS results | **Provisional** — labelled as such in the UI |
| Monthly aggregate | **Withheld** (`NOT AVAILABLE`) — period rule unconfirmed |
| Monthly totals row | **Provisional** — simple sum of displayed daily values, labelled |

## 9. Known gaps / limitations

1. `P()` semantics unconfirmed; `PAST_MEASUREMENT` field is not exposed by the OData projection — precise OData gap, documented in the UI and README.
2. Service precision: stored quantities scale 3, `Contribution` scale 6, `ComputedQuantity` is `Edm.Double` — the browser cannot recover precision the service does not expose.
3. Date normalization assumes browser timezone = server timezone (supported scenario); filter literals are built from calendar fields and are timezone-safe.
4. Source-row context window = selected month + 10 days before its start (diagnostic context only, not a confirmed opening-value rule).
5. No export mechanism in v1 (none existed in the project); tables can be copied from the UI.
6. `ComputedQuantity` was `0` for all inspected bE24X rows — backend-side question, not an app defect.
