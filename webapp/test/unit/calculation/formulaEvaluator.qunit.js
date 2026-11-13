/* global QUnit */
sap.ui.define([
    "zelectr/parser/decimal",
    "zelectr/calculation/formulaEvaluator"
], function (Decimal, formulaEvaluator) {
    "use strict";

    function comp(seq, sign, refPosition, multiplier, divisor) {
        return {
            seq: seq,
            sign: sign,
            refPosition: refPosition,
            multiplier: Decimal.fromString(multiplier),
            divisor: Decimal.fromString(divisor)
        };
    }

    QUnit.module("formulaEvaluator - evaluateComponents");

    QUnit.test("evaluates adjusted and suggested variants with the same resolver", function (assert) {
        var components = [
            comp(1, "+", "A", "1", "1"),
            comp(2, "-", "B", "1", "1")
        ];
        var adjusted = {
            "A": { status: "RESOLVED", value: Decimal.fromString("100"), uom: "KWH" },
            "B": { status: "RESOLVED", value: Decimal.fromString("20"), uom: "KWH" }
        };
        var suggested = {
            "A": { status: "RESOLVED", value: Decimal.fromString("101"), uom: "KWH" },
            "B": { status: "RESOLVED", value: Decimal.fromString("20"), uom: "KWH" }
        };
        var adj = formulaEvaluator.evaluateComponents(components, function (ref) { return adjusted[ref]; });
        var sug = formulaEvaluator.evaluateComponents(components, function (ref) { return suggested[ref]; });
        assert.strictEqual(adj.status, "EVALUATED", "adjusted evaluated");
        assert.strictEqual(adj.value.toString(), "80", "100 - 20");
        assert.strictEqual(sug.status, "EVALUATED", "suggested evaluated");
        assert.strictEqual(sug.value.toString(), "81", "101 - 20");
        assert.strictEqual(adj.uom, "KWH", "uom taken from resolver");
    });

    QUnit.test("multiplier and divisor applied exactly", function (assert) {
        var components = [comp(1, "+", "A", "20", "1000")];
        var res = { "A": { status: "RESOLVED", value: Decimal.fromString("4568"), uom: "KWH" } };
        var r = formulaEvaluator.evaluateComponents(components, function (ref) { return res[ref]; });
        assert.strictEqual(r.value.toString(), "91.36", "4568 * 20 / 1000");
    });

    QUnit.test("missing reference withholds the result and is never zero", function (assert) {
        var components = [comp(1, "+", "A", "1", "1"), comp(2, "+", "MISSING", "1", "1")];
        var res = { "A": { status: "RESOLVED", value: Decimal.fromString("5"), uom: "KWH" } };
        var r = formulaEvaluator.evaluateComponents(components, function (ref) { return res[ref]; });
        assert.strictEqual(r.status, "MISSING_REFERENCE", "status");
        assert.strictEqual(r.value, null, "no numeric result");
        assert.strictEqual(r.missingReferences.length, 1, "one missing reference");
        assert.strictEqual(r.missingReferences[0].refPosition, "MISSING", "missing is MISSING");
    });

    QUnit.test("incompatible units are withheld, not converted", function (assert) {
        var components = [comp(1, "+", "A", "1", "1"), comp(2, "+", "B", "1", "1")];
        var res = {
            "A": { status: "RESOLVED", value: Decimal.fromString("5"), uom: "KWH" },
            "B": { status: "RESOLVED", value: Decimal.fromString("5"), uom: "MWH" }
        };
        var r = formulaEvaluator.evaluateComponents(components, function (ref) { return res[ref]; });
        assert.strictEqual(r.status, "UOM_MISMATCH", "status");
        assert.strictEqual(r.value, null, "no numeric result");
    });

    QUnit.test("empty component list yields EMPTY", function (assert) {
        var r = formulaEvaluator.evaluateComponents([], function () {
            return { status: "RESOLVED", value: Decimal.fromString("1") };
        });
        assert.strictEqual(r.status, "EMPTY", "status");
        assert.strictEqual(r.value, null, "no value");
    });

    QUnit.module("formulaEvaluator - compareComponents (JS vs ABAP)");

    QUnit.test("matching structures compare as MATCH", function (assert) {
        var js = [comp(1, "+", "A", "1", "1"), comp(2, "-", "B", "1", "1")];
        var abap = [comp(1, "+", "A", "1", "1"), comp(2, "-", "B", "1", "1")];
        var r = formulaEvaluator.compareComponents(js, abap);
        assert.strictEqual(r.status, "MATCH", "status");
        assert.strictEqual(r.differences.length, 0, "no differences");
    });

    QUnit.test("sign difference is detected per occurrence", function (assert) {
        var js = [comp(1, "+", "A", "1", "1")];
        var abap = [comp(1, "-", "A", "1", "1")];
        var r = formulaEvaluator.compareComponents(js, abap);
        assert.strictEqual(r.status, "PARSE_MISMATCH", "status");
        assert.strictEqual(r.differences.length, 1, "one difference");
        assert.strictEqual(r.differences[0].field, "sign", "sign field");
        assert.strictEqual(r.differences[0].seq, 1, "seq 1");
    });

    QUnit.test("coefficient differences are detected", function (assert) {
        var js = [comp(1, "+", "A", "20", "1000")];
        var abap = [comp(1, "+", "A", "1", "1000")];
        var r = formulaEvaluator.compareComponents(js, abap);
        assert.strictEqual(r.status, "PARSE_MISMATCH", "status");
        assert.strictEqual(r.differences[0].field, "multiplier", "multiplier field");
    });

    QUnit.test("missing backend component is reported", function (assert) {
        var js = [comp(1, "+", "A", "1", "1"), comp(2, "+", "B", "1", "1")];
        var abap = [comp(1, "+", "A", "1", "1")];
        var r = formulaEvaluator.compareComponents(js, abap);
        assert.strictEqual(r.status, "PARSE_MISMATCH", "status");
        assert.strictEqual(r.differences[0].field, "component", "component difference");
        assert.strictEqual(r.differences[0].js, "B", "missing on ABAP side");
        assert.strictEqual(r.differences[0].abap, "-", "abap shows dash");
    });

    QUnit.test("no backend components yields NO_ABAP_COMPONENTS", function (assert) {
        var js = [comp(1, "+", "A", "1", "1")];
        var r = formulaEvaluator.compareComponents(js, []);
        assert.strictEqual(r.status, "NO_ABAP_COMPONENTS", "status");
    });

    QUnit.test("totals matching does NOT hide structural mismatch", function (assert) {
        // P(A)+P(B) vs P(A)+P(A): both could evaluate to the same total if
        // A and B have equal values, but the structures differ
        var js = [comp(1, "+", "A", "1", "1"), comp(2, "+", "B", "1", "1")];
        var abap = [comp(1, "+", "A", "1", "1"), comp(2, "+", "A", "1", "1")];
        var r = formulaEvaluator.compareComponents(js, abap);
        assert.strictEqual(r.status, "PARSE_MISMATCH", "structural mismatch detected");
        assert.strictEqual(r.differences[0].field, "reference", "reference differs at seq 2");
    });
});
