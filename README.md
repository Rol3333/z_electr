## Electricity Counter — Formula Validation Prototype

A **read-only SAPUI5 freestyle application** for business testing and calculation discovery. It lets business users inspect an electricity-counter position, see its formula parsed independently in JavaScript, compare that parse with the components exposed by the SAP backend parser, and investigate daily/monthly calculations with full source-row lineage.

> **This is a diagnostic prototype, not an authoritative calculation source.** All `P(position)` resolution strategies are provisional; numeric results are clearly labelled `PROVISIONAL` and must never be treated as validated business results.

## Application details

|               |
| ------------- |
| **UI5 Version** | 1.120.30 (sap_horizon) |
| **OData service** | `/sap/opu/odata/sap/Z_BIND_ELECTR_CNT_001/` (V2, read-only) |
| **Entity sets** | `Z_C_ELECR_VALIDATE`, `Z_C_ELECR_VALIDATE_REF`, `Z_I_ELECR_CNTR` |
| **Module name** | z_electr |

## Prerequisites

- Active Node.js LTS version and associated supported npm version (see https://nodejs.org)
- Access to the SAP backend system (same-origin SSO when run via the Fiori tools proxy or deployed on the server)

## Running the app

From the `z_electr` folder:

```bash
npm install
npm start            # dev server, proxies to the configured destination
npm run start-local  # uses ui5-local.yaml
npm run start-mock   # uses the local mock server (no backend needed)
```

### Direct report URLs (local dev server, default port 8080)

Each report is directly addressable — no home page visit needed. The UI language is selected with the `sap-language` URL parameter (`EN` or `LT`), which also follows the Fiori Launchpad user profile language when the app runs in the FLP:

| Report | English (`sap-language=EN`) | Lithuanian (`sap-language=LT`) |
|---|---|---|
| Formula test | `http://localhost:8080/index.html?sap-language=EN#/formula-test` | `http://localhost:8080/index.html?sap-language=LT#/formula-test` |
| Monthly — all positions | `http://localhost:8080/index.html?sap-language=EN#/current-month` | `http://localhost:8080/index.html?sap-language=LT#/current-month` |
| Position — 12-month overview | `http://localhost:8080/index.html?sap-language=EN#/year-report` | `http://localhost:8080/index.html?sap-language=LT#/year-report` |
| 12-month overview, position prefilled | `http://localhost:8080/index.html?sap-language=EN#/year-report/bE24X` | `http://localhost:8080/index.html?sap-language=LT#/year-report/bE24X` |

In the FLP preview (`test/flp.html`) the same destinations are reached through the inner hash, e.g.:

- `http://localhost:8080/test/flp.html?sap-language=EN#app-preview&/current-month`
- `http://localhost:8080/test/flp.html?sap-language=LT#app-preview&/current-month`
- `http://localhost:8080/test/flp.html?sap-language=EN#app-preview&/year-report`
- `http://localhost:8080/test/flp.html?sap-language=LT#app-preview&/year-report`

## Running the tests

```bash
npm run unit-test    # QUnit unit tests (parser, decimal, calculation, aggregator)
npm run int-test     # OPA integration tests
```

The parser and calculation modules are also plain JavaScript and can be exercised outside the browser; the QUnit suites in `webapp/test/unit` cover:

- the bE31X formula fixture (8 expected terms, section 7.1 of the brief);
- decimal comma constants, hyphenated reference names, group scalars, `/1000` grouping;
- unsupported constructs (`P(A)*P(B)`, `IF(...)`, `S(...)`, constant offsets, division by references);
- malformed formulas (never partially parsed as supported);
- exact decimal arithmetic (no binary floating point drift);
- calculation withholding on missing/ambiguous references and UOM mismatch;
- monthly aggregation refusal while the `P()` period rule is unconfirmed.

## Building / deploying

```bash
npm run build        # production build to dist/
npm run deploy       # build + deploy (only when explicitly requested)
```

## Architecture

```text
webapp/
  parser/
    decimal.js               exact BigInt-based decimal arithmetic (no dependency)
    formulaTokenizer.js      tokenizer (P() references, decimal commas, hyphenated ids)
    formulaParser.js         recursive-descent parser, full-consumption required
    linearizeExpression.js   AST -> ordered reference terms (group scalars distributed)
  calculation/
    referenceResolver.js     injectable P(position) strategies (all provisional)
    calculationEngine.js     term summation, status model, stored-value comparison
    monthlyAggregator.js     monthly aggregation, withheld until the rule is confirmed
  service/
    odataService.js          read-only V2 access, paging, chunking, source index
  formatter/                 display-boundary number/status formatting
  controller/View1.controller.js   orchestration
  view/View1.view.xml        single responsive diagnostic page
```

## Data contract (short)

- `Z_C_ELECR_VALIDATE` — parent rows keyed by `Plant`, `Pos`, `ValidDate`, `ManualEntry`; `Formula`, `UnitOfMeasure`, `StoredSuggestedQuantity` (reference only), `StoredAdjustedQuantity` (**authoritative comparison target**), `ComputedQuantity` (backend result, shown separately).
- `Z_C_ELECR_VALIDATE_REF` — backend parsed components keyed by lowercase `plant`, `pos`, `valid_date`, `manual_entry`, `seq`; compared structurally (sign, reference, multiplier, divisor) with the JS parse per occurrence.
- `Z_I_ELECR_CNTR` — daily source rows for reference positions; all rows (automatic and manual) are kept; duplicates are never discarded.

## Two reports (v0.2)

The application now contains **three directly addressable destinations** — the original formula-validation diagnostic view plus two calculation reports. Each can be opened directly via its own URL hash and from a separate Fiori Launchpad tile, without visiting a home page first:

| Destination | Direct URL, English | Direct URL, Lithuanian | FLP tile intent parameter |
|---|---|---|---|
| Formula test | `http://localhost:8080/index.html?sap-language=EN#/formula-test` | `http://localhost:8080/index.html?sap-language=LT#/formula-test` | `report=formulaTest` |
| Monthly — all positions | `http://localhost:8080/index.html?sap-language=EN#/current-month` | `http://localhost:8080/index.html?sap-language=LT#/current-month` | `report=currentMonth` |
| Position — 12-month overview | `http://localhost:8080/index.html?sap-language=EN#/year-report` | `http://localhost:8080/index.html?sap-language=LT#/year-report` | `report=yearReport` (optionally `&pos=<position>`) |

All three reports share one navigation strip, so users can switch freely. The language is driven by the `sap-language` URL parameter or the FLP user profile language (bundles: `i18n.properties` (EN default), `i18n_en.properties`, `i18n_lt.properties`).

### Monthly — all positions

Direct URLs: [EN](http://localhost:8080/index.html?sap-language=EN#/current-month) · [LT](http://localhost:8080/index.html?sap-language=LT#/current-month) (`#current-month`)

- One row per position of the internal plant (`2010`, a centralized constant, not a user parameter) for the month selected in the prompt window (defaults to the current month); a Parameters button reopens the prompt (period `year.month` + "Show positions with 0 amount" checkbox).
- Columns: Main workshop, Position, Description, **Adjusted (JS)**, **Suggested (JS)**, **Adjusted (ABAP)**, **Suggested (ABAP)**, UOM, Past measurement (reference only, when exposed), Formula, Notes.
- The four quantity columns come from two parser representations evaluated by the **same** evaluator against the same resolved references:
  - **JS** = terms of the independent JavaScript parser (`formulaParser.js`);
  - **ABAP** = persisted component rows of `Z_C_ELECR_VALIDATE_REF` (the backend parser output);
  - each representation is evaluated twice: with **adjusted** and with **suggested** reference period values.
- Monthly aggregation uses the `PERIOD_CHANGE` candidate rule (last reading in the month minus the closest earlier opening reading, matching the bE31X fixture reconstruction) — clearly labelled `PROVISIONAL / P(position) RULE NOT VERIFIED` everywhere.
- Structural JS-vs-ABAP component comparison per occurrence; a mismatch is visible even when totals match.
- Notes aggregate parser status, missing/ambiguous references, unit issues, formula changes and metadata gaps; the covered date range and the latest source date are shown so users see whether the month is complete.

### Position — 12-month overview

Direct URLs: [EN](http://localhost:8080/index.html?sap-language=EN#/year-report) · [LT](http://localhost:8080/index.html?sap-language=LT#/year-report) (`#year-report`, position prefilled: `#year-report/<pos>`)

- Two user-facing parameters only, collected in the prompt window: **Position** and **Year** (year defaults to the current year), plus a "Show notes" checkbox. Exactly 12 rows (January–December) are always shown; empty months display `NO DATA` instead of disappearing.
- The same four quantity variants, the same evaluator, resolver and aggregation rule as the current-month report (no second calculation engine).
- Selecting a month shows a JS-vs-ABAP component comparison detail panel for that month.
- Navigation from the current-month report prefills the position (`#year-report/<pos>`).

### Metadata capability detection

The bundled `metadata.xml` is a snapshot and may lag behind the live service (e.g. when `MainWorkshop`, a position-description property or `PastMeasurement` is added to the backend). Instead of guessing, the report service reads the **live service metadata at runtime** (`ODataModel.getServiceMetadata()`) and:
- includes optional fields in `$select` only when they exist in the live metadata (a non-existent `$select` field would fail the request);
- uses the exact description property name found in metadata (no guessed names);
- shows explicit notes such as `MainWorkshop not exposed by the service` or `Position description not exposed by the service` when a field is absent — the gap is visible, never faked.

## Current limitations (important)

1. **`P(position)` semantics are NOT confirmed.** The OData projection `Z_I_ELECR_CNTR` does not expose `PAST_MEASUREMENT`, so the exact ABAP rule (current reading vs daily consumption vs difference to previous/opening reading) cannot be verified from the frontend. Two provisional strategies are provided (`EXACT_DATE_ADJUSTED`, `PREVIOUS_READING_DIFFERENCE`); every numeric result is labelled `PROVISIONAL`.
2. **Monthly aggregation is withheld** (`Not available — P() resolution rule not confirmed`) until the period meaning of `P()` is confirmed with the ABAP owners.
3. **Source precision is limited by the service**: stored quantities have scale 3, `Contribution` scale 6, `ComputedQuantity` is `Edm.Double`. The browser cannot recover precision the service does not expose.
4. **No tolerance is applied** to differences; the exact numeric difference is shown with neutral labels (`MATCH`, `DIFFERENCE`, `NOT CALCULATED`, `INCOMPLETE DATA`).
4a. **UOM handling**: the summed reference terms must be mutually compatible (mixing e.g. KWH and MWH references in one sum is withheld as `UOM MISMATCH`). A reference UOM that differs from the parent UOM is only a **warning** — formulas routinely contain the unit conversion themselves (e.g. `/1000` turning KWH counters into an MWH parent); the app states this explicitly instead of converting silently.
4b. **Monthly totals row**: the totals under the results table are a simple sum of the displayed daily values and are explicitly provisional — if `P()` turns out to be cumulative readings, the month total is the period-end value, not this sum.
5. **Date normalization** assumes the browser timezone matches the SAP server timezone (the supported scenario for this app's users); filter literals are built from calendar fields and are timezone-safe.
6. **Source-row context window**: reference positions are read for the selected month plus 10 days before its start. This is diagnostic context only, not a confirmed opening-value rule.
7. **No export mechanism** is included in v1 (none existed in the project); diagnostic tables can be copied from the UI.
8. Unsupported formulas (`P(A)*P(B)`, `IF(...)`, `S(...)`, nonlinear expressions, constant offsets) are identified and never given numeric results.
