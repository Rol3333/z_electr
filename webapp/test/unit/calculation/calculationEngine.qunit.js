/* global QUnit */
sap.ui.define([
    "zelectr/parser/formulaParser",
    "zelectr/parser/decimal",
    "zelectr/calculation/calculationEngine",
    "zelectr/calculation/referenceResolver"
], function (formulaParser, Decimal, calculationEngine, referenceResolver) {
    "use strict";

    function makeIndex(rows) {
        // rows: [{pos, dateIso, manualEntry, adjusted, uom}]
        var byPosDate = new Map();
        var rowsByPos = new Map();
        rows.forEach(function (r) {
            var normalized = {
                plant: "2010",
                pos: r.pos,
                dateIso: r.dateIso,
                date: new Date(r.dateIso + "T00:00:00Z"),
                manualEntry: !!r.manualEntry,
                adjusted: r.adjusted == null ? null : Decimal.fromString(String(r.adjusted)),
                suggested: null,
                uom: r.uom || "KWH",
                formula: null,
                raw: r
            };
            var posDateKey = ["2010", r.pos, r.dateIso].join("|");
            if (!byPosDate.has(posDateKey)) {
                byPosDate.set(posDateKey, []);
            }
            byPosDate.get(posDateKey).push(normalized);
            var posKey = ["2010", r.pos].join("|");
            if (!rowsByPos.has(posKey)) {
                rowsByPos.set(posKey, []);
            }
            rowsByPos.get(posKey).push(normalized);
        });
        return { byKey: new Map(), byPosDate: byPosDate, rowsByPos: rowsByPos };
    }

    function resolveAll(formula, rows, strategy) {
        var parse = formulaParser.parseFormula(formula);
        var index = makeIndex(rows);
        var date = new Date("2026-04-15T00:00:00Z");
        var resolutions = parse.terms.map(function (t) {
            return referenceResolver.resolveReference(t, date, "2010", index, strategy);
        });
        return { parse: parse, resolutions: resolutions };
    }

    QUnit.module("calculationEngine - provisional calculation");

    QUnit.test("exact-date strategy sums contributions without premature rounding", function (assert) {
        var formula = "(P(A)+P(B))*0,66";
        var r = resolveAll(formula, [
            { pos: "A", dateIso: "2026-04-15", adjusted: "10.005" },
            { pos: "B", dateIso: "2026-04-15", adjusted: "1.111" }
        ], referenceResolver.STRATEGY_EXACT_DATE);

        var calc = calculationEngine.calculateFormula(r.parse, r.resolutions, "KWH",
            referenceResolver.STRATEGY_EXACT_DATE);
        assert.strictEqual(calc.status, "PROVISIONAL", "unconfirmed rule -> PROVISIONAL, never CALCULATED");
        assert.strictEqual(calc.value.toString(), "7.33656", "(10.005+1.111)*0.66 exact");
        assert.strictEqual(calc.confirmed, false, "not confirmed");
        assert.ok(calc.warnings.some(function (w) { return /PROVISIONAL/.test(w); }), "provisional warning present");
    });

    QUnit.test("missing reference withholds the result and is never zero", function (assert) {
        var formula = "P(A)+P(B)";
        var r = resolveAll(formula, [
            { pos: "A", dateIso: "2026-04-15", adjusted: "5" }
        ], referenceResolver.STRATEGY_EXACT_DATE);

        var calc = calculationEngine.calculateFormula(r.parse, r.resolutions, "KWH",
            referenceResolver.STRATEGY_EXACT_DATE);
        assert.strictEqual(calc.status, "MISSING_REFERENCE", "status");
        assert.strictEqual(calc.value, null, "no numeric result");
        assert.strictEqual(calc.missingReferences.length, 1, "one missing reference");
        assert.strictEqual(calc.missingReferences[0].refPosition, "B", "missing reference is B");
    });

    QUnit.test("duplicate automatic/manual rows are ambiguous, not silently picked", function (assert) {
        var formula = "P(A)";
        var r = resolveAll(formula, [
            { pos: "A", dateIso: "2026-04-15", adjusted: "5", manualEntry: false },
            { pos: "A", dateIso: "2026-04-15", adjusted: "0", manualEntry: true }
        ], referenceResolver.STRATEGY_EXACT_DATE);

        var calc = calculationEngine.calculateFormula(r.parse, r.resolutions, "KWH",
            referenceResolver.STRATEGY_EXACT_DATE);
        assert.strictEqual(calc.status, "AMBIGUOUS_SOURCE", "status");
        assert.strictEqual(calc.value, null, "no numeric result");
    });

    QUnit.test("unsupported formula never produces a number", function (assert) {
        var parse = formulaParser.parseFormula("P(A)*P(B)");
        var calc = calculationEngine.calculateFormula(parse, [], "KWH", referenceResolver.STRATEGY_EXACT_DATE);
        assert.strictEqual(calc.status, "UNSUPPORTED", "status");
        assert.strictEqual(calc.value, null, "no numeric result");
    });

    QUnit.test("reference UOM differing from parent UOM is a warning, not an error", function (assert) {
        // formulas routinely contain the conversion themselves (e.g. /1000
        // turning KWH counters into an MWH parent)
        var formula = "P(A)/1000";
        var r = resolveAll(formula, [
            { pos: "A", dateIso: "2026-04-15", adjusted: "5000", uom: "KWH" }
        ], referenceResolver.STRATEGY_EXACT_DATE);

        var calc = calculationEngine.calculateFormula(r.parse, r.resolutions, "MWH",
            referenceResolver.STRATEGY_EXACT_DATE);
        assert.strictEqual(calc.status, "PROVISIONAL", "numeric result still produced");
        assert.strictEqual(calc.value.toString(), "5", "5000/1000");
        assert.ok(calc.warnings.some(function (w) { return /KWH/.test(w) && /MWH/.test(w); }),
            "UOM difference warning present");
    });

    QUnit.test("summed terms with incompatible units are withheld", function (assert) {
        var formula = "P(A)+P(B)";
        var r = resolveAll(formula, [
            { pos: "A", dateIso: "2026-04-15", adjusted: "5", uom: "KWH" },
            { pos: "B", dateIso: "2026-04-15", adjusted: "5", uom: "MWH" }
        ], referenceResolver.STRATEGY_EXACT_DATE);

        var calc = calculationEngine.calculateFormula(r.parse, r.resolutions, "KWH",
            referenceResolver.STRATEGY_EXACT_DATE);
        assert.strictEqual(calc.status, "UOM_MISMATCH", "status");
        assert.strictEqual(calc.value, null, "no numeric result");
    });

    QUnit.test("previous-reading strategy subtracts the closest earlier row", function (assert) {
        var formula = "P(A)";
        var parse = formulaParser.parseFormula(formula);
        var index = makeIndex([
            { pos: "A", dateIso: "2026-04-14", adjusted: "100" },
            { pos: "A", dateIso: "2026-04-15", adjusted: "150" }
        ]);
        var date = new Date("2026-04-15T00:00:00Z");
        var resolutions = parse.terms.map(function (t) {
            return referenceResolver.resolveReference(t, date, "2010", index,
                referenceResolver.STRATEGY_PREVIOUS_READING);
        });
        var calc = calculationEngine.calculateFormula(parse, resolutions, "KWH",
            referenceResolver.STRATEGY_PREVIOUS_READING);
        assert.strictEqual(calc.status, "PROVISIONAL", "provisional");
        assert.strictEqual(calc.value.toString(), "50", "150 - 100");
        // lineage: both source rows are traceable
        assert.strictEqual(calc.termBreakdown[0].sourceRows.length, 2, "both source rows recorded");
    });

    QUnit.module("calculationEngine - comparison with stored values");

    QUnit.test("exact difference without tolerance", function (assert) {
        var m = calculationEngine.compareWithStored(Decimal.fromString("13.252120"), Decimal.fromString("13.253"));
        assert.strictEqual(m.status, "DIFFERENCE", "difference detected");
        assert.strictEqual(m.difference.toString(), "-0.00088", "exact difference");
        var ok = calculationEngine.compareWithStored(Decimal.fromString("5"), Decimal.fromString("5.000"));
        assert.strictEqual(ok.status, "MATCH", "match");
        var none = calculationEngine.compareWithStored(null, Decimal.fromString("5"));
        assert.strictEqual(none.status, "NOT_CALCULATED", "no calculated value -> NOT_CALCULATED");
    });
});
