# Electricity Counter — Two Fiori Reports
## AI coding-agent development brief

## 0. Mission

Extend the existing electricity-counter Fiori work into **one SAPUI5 freestyle application containing two read-only reports**. Both reports must belong to the same existing Fiori application/project and be deployed/registered in the ABAP package **`Z_ELECTR`** (the user has referred to this package as `z_electr`). Do not create two separate Fiori applications or separate packages.

The reports are:

1. **Current-month position overview** — one row per position, showing monthly totals calculated independently using the JavaScript parser and the persisted ABAP parser components.
2. **Position year overview** — one selected position across all 12 months of a selected year.

The main purpose is to let business users compare formula calculations produced from two parser implementations:

- **JS**: components parsed by the JavaScript implementation in the Fiori app.
- **ABAP**: components already parsed/persisted by the backend and exposed by the OData reference entity set.

For each parser representation, calculate two variants:

- adjusted-quantity calculation, using adjusted values for referenced positions;
- suggested-quantity calculation, using suggested values for referenced positions.

The requested report columns are:

| Display column | Meaning |
|---|---|
| Main workshop | Workshop responsible for the position |
| Pos | Position identifier |
| Pos descr | Position description |
| Adjusted quantity JS | Formula result using JS-parsed components and adjusted reference values |
| Suggested quantity JS | Formula result using JS-parsed components and suggested reference values |
| Adjusted quantity ABAP | Formula result using backend-persisted ABAP parser components and adjusted reference values |
| Suggested quantity ABAP | Formula result using backend-persisted ABAP parser components and suggested reference values |
| Formula | Original formula text |
| Notes | Parser, reference-resolution, data-quality and calculation warnings/errors |

Do not confuse the ABAP parser representation with a backend-computed quantity. The ABAP columns above must be derived from the **components produced by the ABAP parser**, unless the live OData metadata and implementation prove that separate backend-computed adjusted and suggested results are already available.

This is a calculation/quality report, not a data-entry application. It must never update source quantities or formula components.

---

## 1. Mandatory first step: inspect and update the existing project

Before coding, inspect the current workspace/repository and preserve existing work. Determine:

- whether the first formula-validation Fiori app has already been scaffolded or implemented;
- its current SAPUI5 version, project structure, build tooling and package manager;
- its current OData V2 model configuration and service URL;
- whether the JavaScript formula parser already exists and has tests;
- whether there is already a `Z_ELECTR` package/deployment configuration;
- existing lint, format, unit-test and build commands.

**Extend the existing Fiori app.** Add two report pages/tabs/routes to the same application. Reuse existing OData, parser, date handling, decimal arithmetic and UI components where reliable. Do not discard or rewrite working parser code merely to make the new reports fit.

Do not overwrite unrelated files, configuration, uncommitted changes or user changes. Do not deploy, create transports or modify backend objects without explicit authorization.

### 1.1 Refresh the OData metadata — important

The previously supplied `metadata.xml` is an older snapshot. It predates the user's backend change adding `MainWorkshop` to `Z_I_ELECR_CNTR`:

```abap
@EndUserText.label: 'Main Workshop'
pl.main_workshop as MainWorkshop,
```

Therefore, **do not treat the old local `metadata.xml` as current**.

Refresh it from the live service in the target SAP system using the same-origin metadata URL:

```text
/sap/opu/odata/sap/Z_BIND_ELECTR_CNT_001/$metadata
```

Update the metadata file used by the Fiori project (and any generated service typings/model documentation, if present). Verify that the refreshed metadata includes `MainWorkshop` in `Z_I_ELECR_CNTR`.

The previously supplied metadata had no `MainWorkshop` and no position-description field in `Z_I_ELECR_CNTR`. The user's backend change confirms `MainWorkshop` is now projected, but does **not** confirm the exact property/source for `Pos_descr`. Inspect the refreshed metadata and available entity sets for the position description.

- If the refreshed service exposes the description, use the exact property and casing from `$metadata`.
- If it is exposed through another entity set or association, use that supported source.
- If it is not exposed anywhere, do not fabricate a description or substitute the position ID. Show an empty/clearly unavailable value and record the backend exposure requirement in the implementation notes. Do not change backend CDS as an unrequested side effect.

If the agent environment cannot access the live SAP service, do not claim the metadata has been refreshed. Keep the old metadata clearly marked as stale and request/provide a visible blocker for the updated `$metadata` file.

---

## 2. OData service and known contract

The current service URL is:

```text
/sap/opu/odata/sap/Z_BIND_ELECTR_CNT_001/
```

It is an OData V2 service. The earlier metadata snapshot exposed these three relevant entity sets; verify their current names and fields against the refreshed live metadata before implementation:

| Entity set | Purpose |
|---|---|
| `Z_C_ELECR_VALIDATE` | Parent position, formula, stored quantities and one backend-computed quantity |
| `Z_C_ELECR_VALIDATE_REF` | Formula components persisted by the ABAP parser, together with reference values/contributions/status |
| `Z_I_ELECR_CNTR` | Source daily position quantities and formula; now also expected to expose `MainWorkshop` |

### 2.1 `Z_I_ELECR_CNTR` — source position quantities

Previously supplied properties included:

- `Plant`
- `Pos`
- `ValidDate`
- `ManualEntry`
- `SuggestedQuantity`
- `AdjustedQuantity`
- `UnitOfMeasure`
- `Formula`

The updated CDS projection is expected to include:

- `MainWorkshop` — added by the user from `pl.main_workshop`.

Check whether `PosDescr` (or equivalent) is present in the refreshed metadata. Do not guess its name.

Keys in the previous metadata:

- `Plant`
- `Pos`
- `ValidDate`
- `ManualEntry`

`ManualEntry` is part of the key and must not be discarded when interpreting records.

### 2.2 `Z_C_ELECR_VALIDATE_REF` — ABAP parser components

The earlier metadata exposed:

- key: `plant`, `pos`, `valid_date`, `manual_entry`, `seq` (lowercase property names in this entity set);
- `sign`;
- `ref_position`;
- `multiplier`;
- `divisor`;
- `RefSuggestedValue`;
- `RefAdjustedValue`;
- `Contribution`;
- `RefStatus`;
- `UnitOfMeasure`.

This entity set is the source of the **backend/ABAP parser component representation**. Use its component rows to evaluate the ABAP parser variant independently from the JS parser variant.

Keep the complete matching key: plant + parent position + valid date + manual-entry flag + sequence. Do not join components only by position or date.

### 2.3 `Z_C_ELECR_VALIDATE` — parent validation data

The earlier metadata exposed:

- key: `Plant`, `Pos`, `ValidDate`, `ManualEntry`;
- `Formula`;
- `UnitOfMeasure`;
- `StoredSuggestedQuantity`;
- `StoredAdjustedQuantity`;
- `ComputedQuantity` (`Edm.Double`).

`StoredAdjustedQuantity` is the authoritative stored adjusted value; `StoredSuggestedQuantity` is the suggested/reference value.

The old metadata exposed only one `ComputedQuantity`, not separate computed adjusted and suggested quantities. Therefore, do not map that single property to both ABAP report columns. The ABAP report columns must be computed from the ABAP parser components plus the respective adjusted/suggested reference values, unless refreshed metadata reveals two explicit backend-calculated outputs.

### 2.4 OData implementation rules

- Use one shared OData V2 model for the same service.
- Respect exact property casing from the refreshed metadata. Historically, the first and third entity sets used PascalCase, while the reference entity set used lowercase component/key names.
- Use only GET/read operations. The UI is read-only.
- Use `$select` to restrict fields and `$filter` to restrict plant/date/position.
- Implement server paging/continuation properly; do not silently calculate totals from the first page only.
- Do not assume `$top` alone returns all data. Respect `__next`/skip-token continuation behavior for OData V2.
- OData V2 does not provide a portable `IN` filter. When selecting multiple positions, use safely escaped OR predicates in bounded chunks or another supported server-side pattern.
- Escape single quotes in OData string literals and URL-encode filter values.
- Preserve `ManualEntry` in record identity. Do not collapse rows with `ManualEntry = false` and `true`.
- Use the same-origin relative service path so SAP authentication/SSO works. Never hard-code credentials, cookies or tokens.
- Limit concurrent requests. Do not issue one request per reference per date without batching/caching.
- Do not request all plants. The user confirmed the relevant current dataset is plant `2010`; use `2010` as an internal configuration constant, not as a user-facing report parameter. Keep it centralized so it can be changed later.

NB PAST_MEASUREMENT has recently been added to the CDS projections, but its business meaning and correctness have not yet been confirmed. Do not use it in calculations or change the existing reference-resolution logic based on this field. Build the two reports using the currently tested calculation approach. Keep the implementation modular so the resolution logic can be adjusted after business validation. Add Past_measurement column as a reference column to report output only.
---

## 3. Report 1 — current-month overview of all positions

### 3.1 Purpose and filters

Show **one monthly summary row per position** for the current calendar month. This report has no required user filter bar; the month is dynamic and should default to the current month. A Refresh action is useful.

- Use plant `2010` internally.
- Determine the current month dynamically at runtime; do not hard-code a month/year.
- Show the covered date range and the latest available source date, so business users can see whether the month is complete or month-to-date.
- For a report run during the month, do not imply that future dates have been loaded. Use the current date as the requested upper boundary unless the business/reporting system explicitly defines a different cutoff. Also show the latest date actually found in the source data.

### 3.2 Required columns

Display at least these columns, in this order:

1. `Main workshop` — OData property expected to be `MainWorkshop` in `Z_I_ELECR_CNTR` after metadata refresh.
2. `Pos` — position ID.
3. `Pos descr` — exact description property/source discovered from current metadata.
4. `Adjusted quantity JS` — JS parser result evaluated using adjusted reference quantities.
5. `Suggested quantity JS` — JS parser result evaluated using suggested reference quantities.
6. `Adjusted quantity ABAP` — ABAP-persisted parser components evaluated using adjusted reference quantities.
7. `Suggested quantity ABAP` — ABAP-persisted parser components evaluated using suggested reference quantities.
8. `Formula` — original formula text.
9. `Notes` — human-readable warnings/errors.

A `UOM` column is strongly recommended if more than one unit can occur. At minimum, include the UOM in the quantity display or row context; do not show unlabelled numeric totals.

### 3.3 Row grain and aggregation

- The visible table must have one row per position, not one row per daily reading or per parser component.
- Retrieve the source records for plant `2010` and the current-month date range, plus any boundary/history rows required by the confirmed `P(position)` resolution logic.
- Preserve source rows and their manual-entry identities during calculation.
- Identify the formula that applies to the reporting period. If formula text changes within the month, do not silently select the first or last formula. Either split/flag the effective formula periods or mark the row with a clear `FORMULA CHANGED DURING MONTH` note and make the result unavailable until the intended business rule is known.
- A position may have no formula. Keep it in the all-positions report if it exists in source data, but show `—` for parser-derived quantities and note `NO FORMULA` rather than treating it as zero.
- Positions with unsupported syntax or missing references must remain visible with explanatory notes; never omit them silently.
- If duplicate/manual-entry parent records exist, determine the business rule from the existing application/ABAP implementation. Do not choose an arbitrary row or aggregate duplicate records blindly.

**Monthly total rule must be explicit.** Determine from the existing validated calculation implementation/business rules whether a `P(position)` value on each date is:

- a daily consumption that must be summed over the month; or
- a month-to-date/cumulative period value for which the appropriate final valid date is the monthly total; or
- another period calculation.

Do not sum cumulative/month-to-date values over all days. Do not select the month-end row blindly if the actual period semantics or data completeness say otherwise. Encapsulate the monthly aggregation rule in one named/tested function and document its basis. If the rule is not established, show a provisional/unavailable status rather than claiming an authoritative monthly total.

### 3.4 Formula parser variants and four calculations

For every applicable parent formula:

1. Parse the raw formula text with the JavaScript parser. Preserve exact position identifiers, occurrence order, repeated references, signs and supported coefficients.
2. Retrieve the matching persisted ABAP parser component rows from `Z_C_ELECR_VALIDATE_REF` for the same parent position/date/manual-entry key.
3. Compare the two component structures: count, sequence, sign, reference position, multiplier and divisor. Flag missing/extra/different components.
4. Evaluate each component structure twice against the same source-resolved reference records:
   - adjusted-value basis, using `AdjustedQuantity` / `RefAdjustedValue`;
   - suggested-value basis, using `SuggestedQuantity` / `RefSuggestedValue`.
5. Produce the four report outputs:
   - JS + adjusted;
   - JS + suggested;
   - ABAP components + adjusted;
   - ABAP components + suggested.

This isolates parser differences from reference-resolution differences. Both parser variants must use the **same reference-resolution and monthly aggregation strategy**, unless the backend supplies distinct authoritative resolution values. Otherwise a difference between JS and ABAP columns would not tell us whether the parser or the resolver caused it.

Do not assume the single `ComputedQuantity` exposed by the earlier `Z_C_ELECR_VALIDATE` metadata represents both adjusted and suggested variants. Use it only as an additional diagnostic/reference column if its semantic basis can be established from backend code/metadata.

### 3.5 Notes column

Aggregate relevant diagnostics into the Notes cell. Examples:

- `NO FORMULA`
- `JS PARSER: UNSUPPORTED EXPRESSION`
- `JS PARSER: SYNTAX ERROR`
- `ABAP COMPONENTS NOT FOUND`
- `JS / ABAP COMPONENT MISMATCH`
- `REFERENCE POSITION MISSING: <position>`
- `AMBIGUOUS REFERENCE ROW (MANUAL ENTRY)`
- `MIXED / INCOMPATIBLE UNITS`
- `FORMULA CHANGED DURING MONTH`
- `INSUFFICIENT PERIOD DATA`
- `P(position) RULE NOT VERIFIED`
- `DESCRIPTION NOT EXPOSED BY SERVICE`
- `SOURCE DATA INCOMPLETE`

Use concise visible status indicators (success/warning/error) and allow users to inspect complete details in a row popover/dialog/side panel. Do not hide errors in console logs only.

### 3.6 Suggested interaction

- Sort initially by Main workshop, then Pos.
- Allow sorting/filtering/searching the loaded overview locally.
- Selecting a position opens a detail panel or navigates to Report 2 with that position prefilled (the user can then select a year).
- Formula text may be long; truncate in the table with a way to inspect/copy the full expression.
- Include a summary count of positions and counts with errors/warnings, if this can be derived without ambiguous status logic.

---

## 4. Report 2 — one position, 12 months for a year

### 4.1 Parameters

The only user-facing parameters are:

- **Position** — required position identifier. A free-text field with suggestions is acceptable; do not load every position eagerly solely to populate a huge dropdown.
- **Year** — required year; default to the current year. Use a year selector/input appropriate to the current project UI5 version.

Do not add Plant as a user-facing parameter. Use the internal configured plant `2010` as noted above.

### 4.2 Output

Display exactly 12 monthly rows for January through December of the selected year, even when a month has no data. Empty months must display a clear `NO DATA`/`INCOMPLETE` status rather than disappearing.

For every month show:

- month/year;
- Adjusted quantity JS;
- Suggested quantity JS;
- Adjusted quantity ABAP;
- Suggested quantity ABAP;
- formula status / parser comparison status;
- Notes.

Show the position description and Main workshop (when available) in the report header/context, not as extra user parameters.

Provide access to formula text and parser-component comparison for each selected month. This can be an expandable row or a detail panel. The monthly row should make it possible to understand whether the formula changed across months.

Use the same calculation functions, component comparison, reference resolver, decimal handling and aggregation rule as Report 1. Do not implement a second, inconsistent calculation engine.

### 4.3 Navigation

From Report 1, the user should be able to open Report 2 with the selected position prefilled. The user then chooses a year. Provide a way back to the all-position current-month overview.

---

## 5. Calculation and numerical correctness

### 5.1 Do not conflate parsing, reference resolution and aggregation

Keep the implementation separated into testable modules/services:

- `FormulaParserJS` — formula string to normalized component list / parse status.
- `FormulaComponentsABAP` — loads/maps the persisted backend component rows.
- `ReferenceResolver` — resolves `P(position)` values using the agreed source-data rule.
- `FormulaEvaluator` — evaluates a component list against resolved adjusted/suggested values.
- `MonthlyAggregator` — converts the per-date/per-period results to a single monthly value using the confirmed reporting rule.
- `PositionReportService` — coordinates OData retrieval, caching, diagnostics and report models.

Keep parser comparison independent from numeric evaluation. A parser mismatch must be reported even when the four totals happen to be equal.

### 5.2 P(position) and reset behavior

The precise business meaning of `P(position)` and the selection of opening/current reference rows must follow the already validated project implementation or ABAP source/business rules. Do not invent a new interpretation while building these reports.

The earlier investigation suggested that some positions behave like cumulative meter readings and that manual-entry/reset rows can be significant. Treat that as a diagnostic finding, not a universal rule.

- Preserve manual-entry records.
- Never silently use zero for a missing reference.
- Never choose a duplicate reference record arbitrarily.
- Expose the source row/date/manual-entry value used in a calculation detail view.
- Where the resolver rule cannot be verified for a particular case, mark its result provisional or unavailable and explain why.

### 5.3 Decimal precision and rounding

The business has explained that SAP/Qlik differences can arise from rounding to three decimal places, and wants better precision to avoid cumulative differences across companies and years.

- Avoid rounding each reference contribution to three decimals.
- Keep full available precision through multiplication, addition, subtraction and division.
- Round only for display, or at an explicitly agreed business boundary.
- Prefer the decimal arithmetic library already used by the project. If none exists, evaluate adding a small established decimal library rather than using repeated binary floating-point `Number` arithmetic for financial/measurement totals.
- Parse OData `Edm.Decimal` values without accidental precision loss. Check how the current UI5 OData V2 model represents decimal properties in this project.
- Do not imply that the UI can recover precision already lost in an ABAP field defined with scale 3. Document the precision available from each source field.
- Display enough decimal places to make differences diagnosable (six decimals is a reasonable initial diagnostic display). Keep unit labels visible.
- Do not introduce an arbitrary match tolerance. Show numerical differences and neutral statuses until business confirms a tolerance.

### 5.4 Units

- Respect `UnitOfMeasure` for parent and reference positions.
- Do not add quantities with incompatible units.
- If conversion is required, use a valid SAP unit conversion source/rule and expose the conversion in the calculation detail. Do not assume all positions always use KWH.

---

## 6. Data retrieval, performance and completeness

The all-position report may require multiple OData calls because formula references can point to other positions.

Recommended two-phase strategy:

1. Read the current-month parent/source records for plant `2010` from `Z_I_ELECR_CNTR`, with `$select` for only fields needed for the summary, formula, workshop, description and source identity. Include any required opening/boundary history after the `P(position)` rule is confirmed.
2. Extract unique parent formulas and their reference positions. Read the ABAP parser components for those parents/date/manual-entry keys from `Z_C_ELECR_VALIDATE_REF`.
3. Collect unique reference positions and fetch their source rows from `Z_I_ELECR_CNTR` in bounded batches for the required date range/history. Preserve manual-entry rows.
4. Cache records by complete source key and reuse them across formulas and dates.
5. Evaluate four result variants and aggregate per position/month.

For the one-position/year report, use the same strategy over the selected year and required boundary data. Fetch the position's parent records first, then only the unique referenced positions. Avoid fetching the entire plant's full-year dataset when it is unnecessary.

For both reports:

- handle OData paging until every page has been consumed;
- show a data-load error if any required page/batch failed;
- do not calculate a result using a partial set of references without marking it incomplete;
- throttle parallel requests;
- use bounded caches with keys that include plant, position, date and `ManualEntry`;
- avoid duplicate requests for the same reference data;
- cancel or ignore stale in-flight responses when the user changes report selection.

---

## 7. UI and project architecture

Use the current project's established UI5 conventions. Do not introduce a framework migration.

The application should have two clear navigation destinations (tabs, segmented navigation, or routes, according to the existing app pattern):

- **Current Month — All Positions**
- **Position — 12-Month Overview**

Suggested files/modules (adapt to the existing structure instead of forcing these exact names):

```text
webapp/
  view/
    App.view.xml
    CurrentMonth.view.xml
    PositionYear.view.xml
    fragments/
      FormulaDetail.fragment.xml
      ComponentComparison.fragment.xml
  controller/
    App.controller.js
    CurrentMonth.controller.js
    PositionYear.controller.js
  model/
    models.js
  service/
    ODataService.js
    PositionReportService.js
  calculation/
    FormulaParserJS.js
    FormulaComponentsABAP.js
    ReferenceResolver.js
    FormulaEvaluator.js
    MonthlyAggregator.js
  test/
    unit/
    integration/
```

Use a clear view model for each report. Separate raw OData data from calculated display rows. Keep the UI responsive and usable at normal business desktop resolution; ensure basic tablet behaviour if the existing app supports it.

Read-only controls only. Provide busy states, clear error messages, empty states and refresh capability. Do not show a green/success result when the calculation is only provisional.

---

## 8. Testing requirements

### 8.1 Unit tests

Add or extend automated tests for:

- JS parser output for supported formulas, signs, coefficients, decimal comma normalization, hyphenated/underscored position IDs and repeated references;
- unsupported constructs and syntax errors being explicitly flagged;
- mapping ABAP component rows from the OData reference entity set;
- component-by-component JS/ABAP parser comparison;
- adjusted and suggested evaluation variants;
- missing, duplicate and manual-entry reference records;
- formula changes within the period;
- unit mismatch handling;
- monthly aggregation semantics;
- decimal precision and display rounding;
- OData paging/continuation and failed batch handling.

### 8.2 Regression fixture: bE31X

The user's pre-production example for UAB TRANSACHEMA provides a useful fixture even if the parent position is not currently available in DEV.

Formula:

```text
(P(bTP-13_k06)*20+P(bTP-15_k01)+P(TP-53_n07)+P(TP-53_n10)+P(bTP-56_k01)+P(bTP-58_k27)-P(bTP-13_k07)-P(bTP-53_n10g))/1000
```

Previously reconstructed April inputs and expected unrounded result:

| Reference | Period input used in fixture (kWh) | Formula contribution (kWh) |
|---|---:|---:|
| bTP-13_k06 | 20.000 | 400.000 |
| bTP-15_k01 | 4568.000 | 4568.000 |
| TP-53_n07 | 0.000 | 0.000 |
| TP-53_n10 | 6453.800 | 6453.800 |
| bTP-56_k01 | 6.000 | 6.000 |
| bTP-58_k27 | 3914.000 | 3914.000 |
| bTP-13_k07 | 120.000 | -120.000 |
| bTP-53_n10g | 1969.680 | -1969.680 |

Expected total:

```text
13252.12 kWh = 13.25212 MWh
```

The previously supplied workbook displays an expected whole-kWh comparison of 13,252 and a SAP/Qlik value of 13,253. Do not round the calculation inputs/contributions to whole kWh or three decimals during evaluation. Treat this as a calculation regression fixture, not proof that current DEV OData has the same parent data.

### 8.3 UAT acceptance checks

- Both reports open from the same Fiori application.
- Both are delivered in the same `Z_ELECTR` package/application deployment context.
- Report 1 shows all positions for plant `2010` in the dynamically selected current month, one row per position.
- Report 1 contains all requested columns and uses current `MainWorkshop` metadata.
- Position description is populated only if the current service exposes a valid description source; otherwise the gap is explicit.
- Report 2 has exactly two user-facing parameters: Position and Year.
- Report 2 displays all 12 months, including months without data.
- JS and ABAP parser representations are calculated separately and compared structurally.
- Each parser representation is evaluated separately against adjusted and suggested reference values.
- Unsupported formulas, missing references, partial OData results, ambiguous source records and formula changes produce understandable Notes.
- No missing data is silently converted to zero.
- No daily cumulative values are incorrectly summed into monthly totals.
- Numeric values are not rounded at each component step.
- The app performs no OData writes.
- All automated tests and the production build pass.

---

## 9. Agent execution instructions and deliverables

Work in small, reviewable steps. First report the discovered project structure and refreshed metadata findings, then implement the reports in the same project.

Deliver:

1. Two working report views in the existing Fiori application.
2. Shared parser/evaluator/resolver/aggregation services (reusing working code where possible).
3. Updated `metadata.xml` downloaded from the live service, or an explicit blocker if the agent cannot access it.
4. Unit tests and the bE31X regression fixture.
5. A concise README section explaining the two reports, their columns, the calculation basis, the meaning of JS versus ABAP results, precision/rounding, and any unresolved backend metadata or `P(position)` business-rule gaps.
6. Build/test command results and a list of files changed.

Do not claim the report is business-validated merely because it builds or the parser tests pass. Clearly distinguish:

- parser equivalence;
- reference-resolution correctness;
- monthly aggregation correctness;
- precision/rounding behaviour;
- business acceptance.

If a required source field (especially `PosDescr`) or a confirmed monthly aggregation rule is unavailable, implement the unaffected parts and make the missing requirement visible. Do not invent data or silently make an assumption look authoritative.
