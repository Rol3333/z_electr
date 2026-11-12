# Electricity Counter Formula Validation — AI Agent Development Brief

## 0. Mission

Build a **read-only SAPUI5 freestyle application** that lets business users inspect an electricity-counter position, see its formula, inspect an independent JavaScript parse of that formula, compare that parse with the components already exposed by SAP, and investigate daily/monthly calculations.

The first release is a **business-testing and calculation-discovery prototype**, not a production replacement for SAP calculation logic. The application must make uncertainty visible. It must never silently present a provisional interpretation of `P(position)` as an authoritative result.

The intended user workflow is:

1. Select plant, parent position and month.
2. See the formula stored for that position.
3. See the formula parsed independently in JavaScript, as a readable component table.
4. See the existing backend/persisted parser components exposed by OData, where available, and compare the two parses.
5. See the month’s position rows and calculation diagnostics.
6. Select a day and inspect every referenced position, source row, value, sign, multiplier, divisor and contribution.
7. Export or copy the displayed diagnostic results if a useful export mechanism already exists in the project; do not add backend writes.

The app must be useful even when a formula is unsupported or source data is incomplete. It should explain why a result is unavailable rather than treating missing references as zero.

---

## 1. First action: inspect the workspace

Before editing anything, inspect the current repository/workspace and report briefly:

- whether a UI5 application already exists;
- its UI5 version, project structure, build tooling and package manager;
- whether an OData V2 model/dependency is already configured;
- existing linting, formatting and test commands;
- any existing app that can be extended instead of creating a second scaffold.

Work in the existing project if it is clearly the intended Fiori app. Do not overwrite unrelated work, configuration or user changes. If no app exists, create a conventional SAPUI5 freestyle project using the tooling already present in the workspace. The prior project plan assumed SAPUI5 1.108+, but inspect the real environment and keep the implementation compatible with the project's actual supported version.

Do not deploy to SAP, create transports, change backend objects, or modify the OData service unless the user explicitly asks for that in a later task.

---

## 2. Existing backend contract — use it as-is

An OData V2 service is already running:

```text
/sap/opu/odata/sap/Z_BIND_ELECTR_CNT_001/
```

Metadata was supplied in `metadata.xml`. Its default entity container exposes these three relevant entity sets in the same service:

| Entity set | Purpose |
|---|---|
| `Z_C_ELECR_VALIDATE` | Parent position, formula, stored quantities and backend-calculated quantity |
| `Z_C_ELECR_VALIDATE_REF` | Existing parsed formula components, reference values, contribution and reference status |
| `Z_I_ELECR_CNTR` | Daily position quantities and formula from the source position projection |

All three are declared read-only in the metadata. Use GET requests only. Do not use create, update, delete, function imports that change data, or batch changesets.

### 2.1 `Z_C_ELECR_VALIDATE`

Entity type `Z_C_ELECR_VALIDATEType`.

Key fields:

- `Plant` — `Edm.String`, max length 4
- `Pos` — `Edm.String`, max length 15
- `ValidDate` — `Edm.DateTime`, date display format
- `ManualEntry` — `Edm.Boolean`

Other relevant fields:

- `Formula` — string, max length 1024
- `UnitOfMeasure` — string, max length 3
- `StoredSuggestedQuantity` — decimal(13,3)
- `StoredAdjustedQuantity` — decimal(13,3)
- `ComputedQuantity` — `Edm.Double`

**Business rule:** `StoredAdjustedQuantity` is the authoritative stored value for validation. `StoredSuggestedQuantity` is reference/display only. Do not use the suggested value as the expected/target value.

### 2.2 `Z_C_ELECR_VALIDATE_REF`

Entity type `Z_C_ELECR_VALIDATE_REFType`.

Key fields (property names are lowercase in this entity set):

- `plant`
- `pos`
- `valid_date`
- `manual_entry`
- `seq`

Other relevant fields:

- `sign`
- `ref_position`
- `multiplier` — decimal(15,3)
- `divisor` — decimal(15,3)
- `UnitOfMeasure`
- `RefSuggestedValue` — decimal(13,3)
- `RefAdjustedValue` — decimal(13,3)
- `Contribution` — decimal(31,6)
- `RefStatus` — string, max length 7

Treat this entity set as the **backend/persisted component representation** for comparison with the new JavaScript parser. Do not assume its calculation semantics are correct. It is one of the things the prototype is intended to validate.

### 2.3 `Z_I_ELECR_CNTR`

Entity type `Z_I_ELECR_CNTRType`.

Key fields:

- `Plant`
- `Pos`
- `ValidDate`
- `ManualEntry`

Other relevant fields:

- `SuggestedQuantity` — decimal(13,3)
- `AdjustedQuantity` — decimal(13,3)
- `UnitOfMeasure`
- `Formula`

### 2.4 OData details and constraints

- This is one OData V2 service with all three entity sets. Configure one shared OData V2 model where practical.
- Property casing differs: the first and third entity sets use PascalCase, while the reference entity set uses lowercase for its key/component properties. Use the exact metadata property names.
- Dates are exposed as `Edm.DateTime`; convert selected calendar month dates to the OData V2 date filter representation carefully. Avoid timezone shifts that move a date to the previous/next day.
- `ManualEntry` is exposed as Boolean. Preserve it in row identity and filtering; do not collapse automatic and manual records.
- OData metadata declares the entity sets read-only. The UI must remain read-only.
- Implement paging/continuation handling. Do not assume one OData response contains every row. Respect `$skiptoken`/server paging where returned; do not invent an unbounded `$top` as a workaround.
- Use `$select` to request only needed properties and `$filter` to restrict plant, position and date ranges.
- Escape string literals in OData filters (an apostrophe in a value must be doubled). Encode URL parameters safely.
- Batch reference-position requests into reasonable groups if URL length becomes a problem. Limit concurrent requests rather than firing hundreds simultaneously.
- Use the same-origin relative service URL so normal SAP authentication/SSO works. Do not embed usernames, passwords, cookies or tokens in source code or configuration.
- Do not fetch all positions for all dates unless a measured data-volume check proves it safe.

Metadata excerpts can be consulted in the supplied `metadata.xml`; the three entity sets and fields above are the contract for this task.

---

## 3. Important business and calculation context

### 3.1 Target quantity and precision

- Compare the JavaScript result with `StoredAdjustedQuantity`.
- Show `StoredSuggestedQuantity` as an additional reference column only.
- Do not round individual reference contributions to three decimals before the final sum.
- Keep full available numeric precision internally and format values for display separately.
- Show at least six fractional digits in a diagnostic view where useful.
- The current metadata limits raw stored quantities to scale 3. `Contribution` has scale 6, while `ComputedQuantity` is `Edm.Double`. A browser calculation cannot recover precision that the service does not expose. Make this limitation explicit in the UI/help text or README. Do not claim that the prototype solves backend source precision limitations.
- Do not decide a business tolerance without an explicit configured value or business confirmation. Show the numeric difference exactly; use neutral labels such as `MATCH`, `DIFFERENCE`, `NOT CALCULATED`, or `INCOMPLETE DATA` until tolerance is agreed.

### 3.2 `P(position)` semantics are not yet fully confirmed

The supplied pre-production extract shows that `AdjustedQuantity` can be cumulative/reading-like and that `PAST_MEASUREMENT` exists in the source table, but **the current OData projection `Z_I_ELECR_CNTR` does not expose `PAST_MEASUREMENT`**. The exact ABAP semantics of `P(position)`, meter resets and the selection of manual-entry rows still need confirmation from the ABAP source code/business rules.

Therefore:

- Do not hard-code `P(position) = current AdjustedQuantity` as a final business rule.
- Do not hard-code `P(position) = current AdjustedQuantity - prior calendar day's AdjustedQuantity` as a final business rule.
- Do not hard-code `P(position) = current AdjustedQuantity - month-opening AdjustedQuantity` as a final business rule.
- A previous day's row is not automatically equivalent to `PAST_MEASUREMENT`; gaps, manual entries, resets and status rows can affect it.
- Do not select an arbitrary duplicate row when both `ManualEntry = false` and `true` exist for the same position/date.
- Do not turn missing reference records into zero.

For the first prototype, build the calculation module with a clearly isolated reference-resolution strategy and diagnostics. If the exact rule cannot be established from the currently available OData fields, show the parser and source-data report, mark numerical calculation as `P semantics not verified` / `NOT CALCULATED`, and document exactly which additional field or backend rule is required. Do not invent a result simply to fill the table.

It is acceptable to implement a clearly labelled **experimental candidate calculation** for comparison if the agent can demonstrate its assumptions and expose the chosen strategy in the UI. Such a result must never be labelled as validated or authoritative. Keep candidate strategies isolated so they can be replaced after reviewing the ABAP calculation code.

### 3.3 Distinguish daily results from monthly aggregation

Do not assume that daily rows are independent month totals, and do not sum month-to-date/cumulative readings.

The UI should show the per-date value and a monthly summary separately. Monthly aggregation must use a documented method based on the confirmed `P(position)` semantics (for example, sum daily consumption values if `P` is daily consumption; or use the appropriate period-end value if `P` is cumulative for the period). Until that rule is confirmed, show the monthly aggregate as unavailable or provisional and state why.

### 3.4 Manual entry and reset diagnostics

`ManualEntry` is part of every entity's key. The business examples include dates where a second row has `ManualEntry = true` and a zero adjusted quantity. Such rows may represent reset/manual meter events. Display them explicitly and preserve them in source data and calculations. Never discard them as duplicates.

For any resolved `P(position)`, the detail panel must show:

- selected source record date;
- selected source `ManualEntry` value;
- source adjusted value;
- any opening/previous reading used, including its date and `ManualEntry`;
- the resolution rule used;
- whether the rule is confirmed or provisional.

---

## 4. Initial UI design

Create a single responsive freestyle page. Keep the first release straightforward and optimized for business UAT, not a generic analytics dashboard.

### 4.1 Filter/header section

Fields:

- **Plant** — default `2010` for the initial testing dataset, but editable. Do not hard-wire plant 2010 into queries or logic.
- **Position** — free-text input is acceptable for v1. Do not load every position eagerly just to populate a dropdown. Validate/resolve it when the user presses Load.
- **Month** — month picker or date picker configured for month selection.
- **Manual entry filter** — `All`, `Automatic`, `Manual`, with `All` as the initial choice.
- **Load** button and a separate Refresh action if useful.

Retain the last entered selection while the user inspects details. Disable Load while requests are active and display a useful busy/error state.

### 4.2 Position and formula section

Show:

- plant, position, selected month;
- raw formula text from the parent record;
- UOM;
- parser status;
- parser message/warnings;
- whether the formula changed during the selected month (if daily parent rows have different formulas).

If formulas vary by date, do not silently pick only one formula. Group or indicate the effective formula per date/range.

### 4.3 JavaScript parser output

Show a table with at least:

| Column | Description |
|---|---|
| Sequence | Stable order of occurrence in the formula |
| Sign | `+` or `-` |
| Reference position | Exact name inside `P(...)` |
| Multiplier | Scalar coefficient associated with this reference |
| Divisor | Scalar divisor associated with this term, where applicable |
| Parse note | Any transformation or warning |

Preserve the exact reference name including prefixes, hyphens, underscores and digits. Preserve repeated references as separate occurrences unless there is an explicit, tested reason to combine them.

### 4.4 Existing backend parser output

Read matching records from `Z_C_ELECR_VALIDATE_REF` for the selected parent position/date/manual-entry key. Show them in a separate table or a comparison table alongside the JavaScript parse.

Compare structural fields by sequence/occurrence: sign, reference position, multiplier and divisor. Do not compare only totals. Highlight missing, extra or differing components.

The component entity is keyed by `plant`, `pos`, `valid_date`, `manual_entry`, `seq`. Keep this complete key when selecting the matching rows.

A mismatch between the JS parse and backend components must be visible even if the resulting totals happen to match.

### 4.5 Monthly results table

Show one row per parent position record, preserving `ManualEntry` distinctions:

- date;
- manual entry flag;
- stored adjusted quantity (authoritative comparison target);
- stored suggested quantity (reference only);
- backend `ComputedQuantity`;
- JavaScript calculated quantity, when legitimately available;
- difference: JS calculation minus adjusted target;
- JS/backend parser comparison status;
- calculation status / missing-reference count / warning.

Do not put unsupported, missing-reference or provisional results into a numeric zero. Use an empty value or explicit status.

Selecting a date should refresh/show the detailed reference breakdown below.

### 4.6 Reference breakdown

For the selected parent position and date, show every formula term:

- sequence;
- sign;
- reference position;
- multiplier and divisor;
- source row date and `ManualEntry`;
- reference adjusted quantity;
- suggested quantity for comparison;
- backend `RefAdjustedValue` and `Contribution`, where present;
- JavaScript-resolved value and contribution, if calculated;
- `RefStatus`;
- resolution rule / missing reason.

Missing references must be displayed as missing, not `0`.

### 4.7 Monthly summary / KPI strip

Only show counts and aggregates that can be computed reliably:

- number of parent rows;
- parser-supported rows;
- unsupported formulas;
- rows with missing references;
- calculated rows;
- rows with differences.

If monthly sum/period result cannot be justified because `P(position)` semantics are unresolved, display `Not available — P() resolution rule not confirmed` instead of a misleading KPI.

---

## 5. JavaScript parser requirements

Implement a separate, testable JavaScript parser module. Do not simply port the current ABAP regular expression parser line by line. The known ABAP parser can incorrectly report incomplete parses as supported.

### 5.1 Minimum supported syntax

Use a tokenizer plus recursive-descent parser (or another real expression parser) that can account for the **entire** formula. The initial supported subset should include:

- `P(position)` references;
- identifiers containing letters, digits, underscores and hyphens;
- decimal constants with dot or comma decimal separators;
- unary `+` and `-`;
- addition and subtraction;
- parentheses;
- multiplication or division by scalar-only expressions;
- scalar multipliers applied to groups, e.g. `(P(A)+P(B))*0,66`;
- division applying to a subexpression, e.g. `(P(A)+P(B))/1000 + P(C)`.

The parser may normalize linear expressions into ordered reference terms. Each term must carry its effective sign/coefficient and sufficient information to display multiplier/divisor. Preserve enough structure or source offsets to explain how the term was produced.

### 5.2 Unsupported syntax

At minimum, mark these as unsupported in v1:

- multiplication where both operands contain position references, e.g. `P(A)*P(B)`;
- nonlinear expressions;
- `IF(...)` and `S(...)` constructs until their business semantics are implemented;
- unknown functions/operators;
- malformed or partially consumed expressions;
- any expression that cannot be represented faithfully by the parser's normalized terms.

**Critical rule:** a formula is supported only when the whole expression has been parsed and validated. Finding some `P()` references is not sufficient. If parsing fails at any point, return an error/unsupported result and do not offer a numeric result.

### 5.3 Precision

- Parse decimal literals without losing precision prematurely.
- Avoid rounding coefficients or intermediate terms to three decimal places just because the ABAP table uses scale 3.
- Use an existing decimal arithmetic library if the project already includes one. Otherwise use a small, documented numeric strategy that preserves sufficient precision for the expected values and test it. Do not add a dependency without checking the project's conventions and build constraints.
- Never round each contribution before summing. Format only at the UI boundary.

### 5.4 Parser return structure

Return a predictable object, for example:

```javascript
{
  status: "SUPPORTED", // or UNSUPPORTED / SYNTAX_ERROR / EMPTY
  formula: "(P(A)+P(B))*0,66",
  terms: [
    {
      seq: 1,
      sign: "+",
      refPosition: "A",
      multiplier: 0.66,
      divisor: 1,
      sourceSpan: { start: 1, end: 5 },
      explanation: "P(A) multiplied by the group scalar 0.66"
    },
    {
      seq: 2,
      sign: "+",
      refPosition: "B",
      multiplier: 0.66,
      divisor: 1,
      sourceSpan: { start: 7, end: 11 },
      explanation: "P(B) multiplied by the group scalar 0.66"
    }
  ],
  warnings: []
}
```

This is an example contract, not a mandate to represent every coefficient with JavaScript floating-point numbers. Adapt it to the project's type conventions while retaining the semantics.

---

## 6. Reference resolution and calculation module

Keep reference resolution separate from parsing. A good boundary is:

```text
parseFormula(formula) -> parse result / ordered terms
resolveReference(term, date, plant, sourceRows, strategy) -> resolved value + diagnostics
calculateFormula(parseResult, resolved terms) -> numeric result + diagnostics
aggregateMonth(daily results, confirmed period rule) -> monthly result
```

Requirements:

1. Resolve positions within the same plant. Plant is part of the business key even though the initial sample uses plant `2010` everywhere.
2. Resolve using exact position IDs and exact dates; do not fuzzy-match names.
3. Keep automatic and manual-entry rows separate until the business rule explicitly tells us which one to use.
4. Preserve all candidate source rows in diagnostics when there are duplicates or reset records.
5. Never use `SuggestedQuantity` as the authoritative reference value unless a future business rule explicitly requires it.
6. Do not silently substitute zero for missing references.
7. Keep calculations in source UOM (the sample positions use `KWH`); only convert at a clearly defined final display boundary if required. Do not mix KWH and MWH in one sum.
8. Validate that the terms being added are dimensionally compatible. If UOMs differ or conversion is unavailable, flag the calculation rather than adding them.
9. Track source lineage: every output must be explainable by the exact source rows used.
10. Make the `P(position)` resolution strategy injectable/configurable so the final rule can be implemented after review of the ABAP code/business logic.
11. If the required fields are not exposed by the current service (notably `PAST_MEASUREMENT`), do not pretend they are available. State the precise OData gap. The app may still show raw records, backend components and backend contribution for diagnostic comparison.
12. Do not assume the prior calendar day is the correct opening/previous record. If a candidate strategy uses it, label that strategy provisional and show both source dates/keys.

### 6.1 Calculation output contract

For each parent row/date, return a result object containing:

- numeric value or null;
- status (`CALCULATED`, `PROVISIONAL`, `UNSUPPORTED`, `MISSING_REFERENCE`, `AMBIGUOUS_SOURCE`, `UOM_MISMATCH`, `NOT_CALCULATED`);
- ordered term breakdown;
- source row identifiers/keys used;
- assumptions/strategy name;
- warnings and missing-reference details.

Never turn an invalid or incomplete calculation into `0`.

### 6.2 Monthly aggregation

Implement monthly aggregation only when the daily/period meaning of `P()` has been confirmed. Keep the aggregation function separate and unit-tested. Its method must be explicitly named and documented (e.g. sum of daily consumptions vs period-end cumulative quantity). Do not infer the method merely from the presence of a month picker.

---

## 7. Reference examples and regression tests

Use these as fixtures for parser and, where possible, calculation diagnostics. The bE31X production position itself may not exist in DEV; the reference rows below were extracted from pre-production. The frontend must not hard-code the expected position or result into runtime logic.

### 7.1 bE31X formula fixture

```text
(P(bTP-13_k06)*20+P(bTP-15_k01)+P(TP-53_n07)+P(TP-53_n10)+P(bTP-56_k01)+P(bTP-58_k27)-P(bTP-13_k07)-P(bTP-53_n10g))/1000
```

Expected parser terms:

| Seq | Sign | Reference | Multiplier | Divisor |
|---:|:---:|---|---:|---:|
| 1 | + | bTP-13_k06 | 20 | 1000 |
| 2 | + | bTP-15_k01 | 1 | 1000 |
| 3 | + | TP-53_n07 | 1 | 1000 |
| 4 | + | TP-53_n10 | 1 | 1000 |
| 5 | + | bTP-56_k01 | 1 | 1000 |
| 6 | + | bTP-58_k27 | 1 | 1000 |
| 7 | - | bTP-13_k07 | 1 | 1000 |
| 8 | - | bTP-53_n10g | 1 | 1000 |

The prior manual analysis of the pre-production values produced the following **candidate month change totals** (kWh), using April 30 adjusted values less March 31 opening values, with a reset opening of zero for `TP-53_n10`:

| Reference | Candidate period change (kWh) | Formula contribution (kWh) |
|---|---:|---:|
| bTP-13_k06 | 20.000 | +400.000 |
| bTP-15_k01 | 4568.000 | +4568.000 |
| TP-53_n07 | 0.000 | 0.000 |
| TP-53_n10 | 6453.800 | +6453.800 |
| bTP-56_k01 | 6.000 | +6.000 |
| bTP-58_k27 | 3914.000 | +3914.000 |
| bTP-13_k07 | 120.000 | -120.000 |
| bTP-53_n10g | 1969.680 | -1969.680 |

Candidate sum: `13,252.120 kWh` = `13.252120 MWh`.

The Excel workbook reports the expected calculation as `13,252 kWh`; the `Pozicijų duomenys` sheet contains `13.253 MWh` for the stored adjusted value. This is a useful investigation fixture, **not proof that the candidate opening/reset rule is the final `P()` business rule**. The ABAP implementation still needs review. The one-kWh displayed discrepancy must not be dismissed as rounding without tracing the exact source precision and SAP rounding/aggregation point.

### 7.2 Important parser regression patterns

The supplied formula export contains real examples that expose weaknesses in the existing ABAP regex parser. The JavaScript parser should test and correctly handle or explicitly reject them:

1. `((P(FE7714)+P(FE7719))*P(kf0_769))` — nonlinear multiplication of a sum by another position reference. Must be `UNSUPPORTED` in v1.
2. `(P(FI0301)+P(FI03011))*0,66` — scalar applied to a group. The JS parser should support this if its linear-expression implementation supports scalar multiplication.
3. `(P(2K131)+P(2K241)+P(2K211)+P(2K382))/1000+P(QgHID)` — division applies only to the first grouped expression; preserve that distinction.
4. `(P(QI500)-P(FE13011))-P(PSNUA1))/1000` — malformed parentheses in the exported example should produce a syntax error, not a partial parse.
5. `P(position-name)` — identifiers with hyphens must remain one identifier, not be split as subtraction.
6. Decimal comma constants such as `0,66` must be read as decimal 0.66, not as two tokens.

The parser must have automated unit tests for positive, negative, unsupported and malformed cases. Test complete input consumption.

### 7.3 No hard-coded regression results in runtime

Use fixtures only in unit tests or a clearly labelled development/demo mode. Production UI data must always come from OData. Do not special-case bE31X or the listed values in the parser or calculation functions.

---

## 8. Data loading strategy

For a selected parent position/month:

1. Query `Z_C_ELECR_VALIDATE` for selected plant, position and month dates, including all `ManualEntry` variants. Request formula, stored adjusted/suggested and backend computed quantities.
2. Query `Z_C_ELECR_VALIDATE_REF` for the same parent position, plant, date range and relevant manual-entry keys. Retrieve all component rows, preserving `seq`.
3. Parse each distinct formula string with the JavaScript parser. Do not assume the formula is constant for the whole month.
4. Collect the distinct reference positions appearing across the formulas.
5. Query `Z_I_ELECR_CNTR` for those reference positions, same plant and required date range. The required history range must be set by the confirmed resolver strategy. If the strategy is not confirmed, load enough context for the UI's diagnostic comparison without claiming that it is sufficient for a final calculation.
6. Keep a normalized in-memory index keyed by plant, position, date and manual-entry flag. Do not discard multiple source rows.
7. Resolve and calculate only after checking parse status, source availability, UOM compatibility and the selected resolution strategy.
8. Keep source responses cached for the current selection so selecting another date does not cause unnecessary repeat requests.
9. Clear stale results when the plant, position or month changes; do not show old data beneath new filters.

Make OData read failures visible with the failing entity set and request context. Avoid exposing credentials or full sensitive request headers in logs.

---

## 9. Suggested UI state and modules

Keep the implementation understandable and testable. Adapt paths to the existing repo conventions, but separate concerns along these lines:

```text
webapp/
  Component.js
  manifest.json
  view/
    App.view.xml
    Main.view.xml
  controller/
    App.controller.js
    Main.controller.js
  model/
    models.js
  service/
    odataService.js
  parser/
    formulaTokenizer.js
    formulaParser.js
    linearizeExpression.js
  calculation/
    referenceResolver.js
    calculationEngine.js
    monthlyAggregator.js
  formatter/
    numberFormatter.js
    statusFormatter.js
  test/
    unit/
      formulaTokenizer.qunit.js
      formulaParser.qunit.js
      linearizeExpression.qunit.js
      referenceResolver.qunit.js
      calculationEngine.qunit.js
```

This is a suggested separation, not a requirement to create all files if the project uses another established structure.

Use an OData V2 model for service access and a JSON model for local view state/results. Do not bind a table directly to the remote entity set and then also overwrite it with a separate JSON model; choose a consistent approach. Prefer loading the filtered datasets through a service module, then presenting normalized results from a JSON model because the client is combining the three sets and independent parser output.

For OData V2, handle `read()` using its success/error callbacks or a Promise wrapper around those callbacks. Do not assume `.read()` returns a native Promise.

---

## 10. Status model

Use explicit statuses, with distinct meanings:

| Status | Meaning |
|---|---|
| `SUPPORTED` | Entire formula parsed and represented by the JS parser |
| `UNSUPPORTED` | Valid expression syntax but outside v1 supported semantics |
| `SYNTAX_ERROR` | Malformed or incompletely consumed formula |
| `NO_FORMULA` | Formula is empty |
| `PARSE_MISMATCH` | JS terms differ from the backend component set |
| `MISSING_REFERENCE` | One or more required source positions/records are absent |
| `AMBIGUOUS_SOURCE` | Multiple candidate source rows exist and business rule does not identify one |
| `UOM_MISMATCH` | Terms cannot safely be added due to incompatible units |
| `P_RULE_UNCONFIRMED` | Formula parsed, but `P(position)` source resolution is not confirmed |
| `PROVISIONAL` | Numeric value calculated using an explicitly labelled candidate rule |
| `CALCULATED` | Numeric result produced using a confirmed rule and complete data |
| `DIFFERENCE` | Calculated result differs from `StoredAdjustedQuantity`; do not apply an undocumented tolerance |

The UI may combine statuses into badges/KPIs, but retain the underlying detailed status and message for each record.

---

## 11. Acceptance criteria

The task is complete when all of the following are true:

### Application and OData

- [ ] App starts locally using the repository's documented command.
- [ ] It uses the single existing OData V2 service root and all three supplied entity sets.
- [ ] It uses plant, position and month filters; plant defaults to 2010 but is editable.
- [ ] It handles `Edm.DateTime`, `Edm.Boolean` and the entity-specific property casing correctly.
- [ ] It retrieves all matching rows using paging/continuation handling.
- [ ] It preserves the full source key, including `ManualEntry`.
- [ ] It performs only read requests.

### Formula inspection and parser

- [ ] The parent formula text is displayed verbatim.
- [ ] The JavaScript parser returns ordered, readable terms.
- [ ] bE31X formula fixture produces the expected eight terms shown in section 7.1.
- [ ] The parser supports decimal comma and hyphenated reference names.
- [ ] Group scalar factors are either correctly distributed to each reference term or explicitly unsupported; they are never silently ignored.
- [ ] Nonlinear reference multiplication is explicitly unsupported.
- [ ] Partial parses are never reported as supported.
- [ ] Parser unit tests cover positive, negative, nested, decimal, unsupported and malformed formulas.
- [ ] The frontend parser output can be compared structurally with `Z_C_ELECR_VALIDATE_REF`.

### Calculation and data lineage

- [ ] The app shows daily parent rows with target `StoredAdjustedQuantity` and reference `StoredSuggestedQuantity`.
- [ ] It shows backend `ComputedQuantity` separately from JavaScript results.
- [ ] It shows reference-level detail and identifies exact source rows used.
- [ ] Missing references are not converted to zero.
- [ ] Manual/reset rows remain visible and are not discarded as duplicates.
- [ ] Calculation is withheld or visibly marked provisional until `P(position)` semantics are verified.
- [ ] Monthly aggregation is withheld or marked provisional until its mathematical meaning is confirmed.
- [ ] Calculations do not round intermediate contributions to three decimals.
- [ ] UOM inconsistencies and ambiguous source rows are shown as errors/warnings, not numeric results.

### Usability and quality

- [ ] Loading, empty, partial, error and unsupported states are visible and understandable to business users.
- [ ] Changing filters cannot leave stale data visible as if it belonged to the new selection.
- [ ] The layout works at ordinary desktop widths and remains usable on a smaller viewport.
- [ ] The project builds successfully and automated tests pass.
- [ ] A README explains prerequisites, local run/build commands, service configuration, current limitations and how to run tests.

---

## 12. Deliverables from the AI agent

1. Working UI5 freestyle app in the existing workspace (or a new app folder if none exists).
2. Independent JavaScript parser module with unit tests.
3. OData V2 data-access module for the three entity sets.
4. Reference-resolution/calculation modules, with unresolved business semantics safely isolated and clearly labelled.
5. Business-facing report screen containing formula, parsed components, monthly/daily rows and reference breakdown.
6. README with run/build/test instructions and a short description of the data contract.
7. A concise implementation report listing:
   - files created/changed;
   - commands executed and outcomes;
   - parser test coverage;
   - which calculations are confirmed vs provisional;
   - any OData/backend data gaps preventing authoritative monthly calculation.

Do not claim business calculation correctness solely because the app builds or because a numeric result resembles an Excel value. Correctness requires the formula parser, reference resolver, aggregation method and source lineage to be independently explainable and verified.

---

## 13. Out of scope for this task

- Changing ABAP parser `ZCL_ELECR_FORMULA_PARSER` or persistence logic.
- Changing `ZPP_POS_QUANT` or `ZPP_FORMULA_COMP`.
- Creating/changing CDS views, OData service definitions or backend table structures.
- Writing quantities or formulas back to SAP.
- User administration, roles or authorizations beyond using existing SAP authentication.
- Production deployment, transport requests or FLP catalog/target mapping changes.
- Supporting every possible formula language construct. Unsupported formulas must be identified accurately.
- Replacing SAP/Qlik or making the app an official accounting/settlement source.

---

## 14. Development principle

Prioritize **traceability over apparent completeness**. Business users should be able to see exactly what was parsed, which reference rows were selected, how each contribution was produced, and why a result is provisional or unavailable. A clearly explained `NOT CALCULATED` is better than a plausible but incorrect number.
