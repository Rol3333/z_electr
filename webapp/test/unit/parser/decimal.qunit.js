/* global QUnit */
sap.ui.define([
    "zelectr/parser/decimal"
], function (Decimal) {
    "use strict";

    QUnit.module("decimal - parsing");

    QUnit.test("dot and comma separators", function (assert) {
        assert.strictEqual(Decimal.fromString("0.66").toString(), "0.66", "dot separator");
        assert.strictEqual(Decimal.fromString("0,66").toString(), "0.66", "comma separator");
        assert.strictEqual(Decimal.fromString("20").toString(), "20", "integer");
        assert.strictEqual(Decimal.fromString("-13.252120").toString(), "-13.25212", "negative, trailing zeros trimmed");
        assert.strictEqual(Decimal.fromString(" 1,5 ").toString(), "1.5", "whitespace trimmed");
    });

    QUnit.test("invalid literals throw", function (assert) {
        assert.throws(function () { Decimal.fromString("abc"); }, /Not a valid decimal/, "letters rejected");
        assert.throws(function () { Decimal.fromString(""); }, /Not a valid decimal/, "empty rejected");
        assert.throws(function () { Decimal.fromString("1.2.3"); }, /Not a valid decimal/, "double separator rejected");
    });

    QUnit.module("decimal - exact arithmetic");

    QUnit.test("no binary floating point drift", function (assert) {
        // 0.1 + 0.2 === 0.30000000000000004 with doubles; must be exact here
        var r = Decimal.fromString("0.1").add(Decimal.fromString("0.2"));
        assert.strictEqual(r.toString(), "0.3", "0.1 + 0.2 is exactly 0.3");
    });

    QUnit.test("add/sub with different scales", function (assert) {
        var r = Decimal.fromString("13.252120").sub(Decimal.fromString("0.00012"));
        assert.strictEqual(r.toString(), "13.252", "13.252120 - 0.00012");
        assert.strictEqual(
            Decimal.fromString("1.5").add(Decimal.fromString("2.25")).toString(), "3.75", "1.5 + 2.25");
    });

    QUnit.test("multiplication keeps full precision", function (assert) {
        var r = Decimal.fromString("4568").mul(Decimal.fromString("0.66"));
        assert.strictEqual(r.toString(), "3014.88", "4568 * 0.66");
    });

    QUnit.test("division truncates at the documented precision", function (assert) {
        var r = Decimal.fromString("1").div(Decimal.fromString("3"));
        assert.strictEqual(r.toString(), "0.333333333333", "1/3 truncated to 12 fractional digits");
        assert.strictEqual(Decimal.fromString("10").div(Decimal.fromString("4")).toString(), "2.5", "exact division");
    });

    QUnit.test("division by zero throws", function (assert) {
        assert.throws(function () {
            Decimal.fromString("1").div(Decimal.fromString("0"));
        }, /Division by zero/, "zero divisor rejected");
    });

    QUnit.test("comparison and sign helpers", function (assert) {
        assert.strictEqual(Decimal.fromString("-1").cmp(Decimal.fromString("1")), -1, "-1 < 1");
        assert.strictEqual(Decimal.fromString("1.0").cmp(Decimal.fromString("1")), 0, "1.0 == 1");
        assert.ok(Decimal.fromString("-0.001").isNegative(), "isNegative");
        assert.ok(Decimal.fromString("0").isZero(), "isZero");
        assert.strictEqual(Decimal.fromString("-5").abs().toString(), "5", "abs");
    });

    QUnit.test("toNumber is a lossy display conversion only", function (assert) {
        assert.strictEqual(Decimal.fromString("0.66").toNumber(), 0.66, "toNumber value");
        assert.strictEqual(Decimal.fromString("13252.120").toNumber(), 13252.12, "toNumber value 2");
    });
});
