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
