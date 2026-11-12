/* global QUnit */
sap.ui.define([
    "zelectr/parser/formulaParser"
], function (formulaParser) {
    "use strict";

    // bE31X fixture from section 7.1 of the development brief
    var BE31X = "(P(bTP-13_k06)*20+P(bTP-15_k01)+P(TP-53_n07)+P(TP-53_n10)+P(bTP-56_k01)+P(bTP-58_k27)-P(bTP-13_k07)-P(bTP-53_n10g))/1000";

    QUnit.module("formulaParser - supported formulas");

    QUnit.test("bE31X fixture produces the expected eight terms", function (assert) {
        var r = formulaParser.parseFormula(BE31X);
        assert.strictEqual(r.status, "SUPPORTED", "status is SUPPORTED");
        assert.strictEqual(r.terms.length, 8, "eight terms");

        var expected = [
            { sign: "+", ref: "bTP-13_k06", mult: "20", div: "1000" },
            { sign: "+", ref: "bTP-15_k01", mult: "1", div: "1000" },
            { sign: "+", ref: "TP-53_n07", mult: "1", div: "1000" },
            { sign: "+", ref: "TP-53_n10", mult: "1", div: "1000" },
            { sign: "+", ref: "bTP-56_k01", mult: "1", div: "1000" },
            { sign: "+", ref: "bTP-58_k27", mult: "1", div: "1000" },
            { sign: "-", ref: "bTP-13_k07", mult: "1", div: "1000" },
            { sign: "-", ref: "bTP-53_n10g", mult: "1", div: "1000" }
        ];
        expected.forEach(function (e, i) {
            assert.strictEqual(r.terms[i].seq, i + 1, "seq of term " + i);
            assert.strictEqual(r.terms[i].sign, e.sign, "sign of term " + i);
            assert.strictEqual(r.terms[i].refPosition, e.ref, "reference of term " + i);
            assert.strictEqual(r.terms[i].multiplier.toString(), e.mult, "multiplier of term " + i);
            assert.strictEqual(r.terms[i].divisor.toString(), e.div, "divisor of term " + i);
        });
    });

    QUnit.test("decimal comma constant is one scalar (regression 6)", function (assert) {
        var r = formulaParser.parseFormula("(P(FI0301)+P(FI03011))*0,66");
        assert.strictEqual(r.status, "SUPPORTED", "group scalar supported");
        assert.strictEqual(r.terms.length, 2, "two terms");
        assert.strictEqual(r.terms[0].multiplier.toString(), "0.66", "decimal comma read as 0.66");
        assert.strictEqual(r.terms[1].multiplier.toString(), "0.66", "scalar distributed to second term");
        assert.strictEqual(r.terms[0].divisor.toString(), "1", "no divisor");
    });

    QUnit.test("division applies only to the grouped expression (regression 3)", function (assert) {
        var r = formulaParser.parseFormula("(P(2K131)+P(2K241)+P(2K211)+P(2K382))/1000+P(QgHID)");
        assert.strictEqual(r.status, "SUPPORTED", "status");
        assert.strictEqual(r.terms.length, 5, "five terms");
        for (var i = 0; i < 4; i++) {
            assert.strictEqual(r.terms[i].divisor.toString(), "1000", "grouped term " + i + " divided by 1000");
        }
        assert.strictEqual(r.terms[4].refPosition, "QgHID", "last reference");
        assert.strictEqual(r.terms[4].divisor.toString(), "1", "P(QgHID) not divided");
    });

    QUnit.test("hyphenated reference stays one identifier (regression 5)", function (assert) {
        var r = formulaParser.parseFormula("P(position-name)");
        assert.strictEqual(r.status, "SUPPORTED", "status");
        assert.strictEqual(r.terms.length, 1, "one term");
        assert.strictEqual(r.terms[0].refPosition, "position-name", "verbatim reference name");
    });

    QUnit.test("subtraction between references is not swallowed by hyphen", function (assert) {
        var r = formulaParser.parseFormula("P(A)-P(B)");
        assert.strictEqual(r.status, "SUPPORTED", "status");
        assert.strictEqual(r.terms.length, 2, "two terms");
        assert.strictEqual(r.terms[0].sign, "+", "first sign");
        assert.strictEqual(r.terms[1].sign, "-", "second sign");
        assert.strictEqual(r.terms[1].refPosition, "B", "second reference");
    });

    QUnit.test("repeated references stay separate occurrences", function (assert) {
        var r = formulaParser.parseFormula("P(A)+P(A)");
        assert.strictEqual(r.status, "SUPPORTED", "status");
        assert.strictEqual(r.terms.length, 2, "two occurrences kept");
        assert.strictEqual(r.terms[0].refPosition, "A", "first occurrence");
        assert.strictEqual(r.terms[1].refPosition, "A", "second occurrence");
    });

    QUnit.test("nested parentheses and unary minus", function (assert) {
        // -(A + (B - C)*2) = -A - 2B + 2C
        var r = formulaParser.parseFormula("-(P(A)+(P(B)-P(C))*2)");
        assert.strictEqual(r.status, "SUPPORTED", "status");
        assert.strictEqual(r.terms.length, 3, "three terms");
        assert.strictEqual(r.terms[0].sign, "-", "A flipped");
        assert.strictEqual(r.terms[1].sign, "-", "B flipped");
        assert.strictEqual(r.terms[1].multiplier.toString(), "2", "B multiplier 2");
        assert.strictEqual(r.terms[2].sign, "+", "C double negation resolves to plus");
        assert.strictEqual(r.terms[2].multiplier.toString(), "2", "C multiplier 2");
    });

    QUnit.test("source spans point at the P() occurrence", function (assert) {
        var r = formulaParser.parseFormula("P(A)+P(B)");
        assert.strictEqual(r.terms[0].sourceSpan.start, 0, "span start");
        assert.strictEqual(r.terms[0].sourceSpan.end, 4, "span end");
        assert.strictEqual(r.terms[1].sourceSpan.start, 5, "second span start");
    });

    QUnit.module("formulaParser - unsupported formulas");

    QUnit.test("nonlinear multiplication of references is unsupported (regression 1)", function (assert) {
        var r = formulaParser.parseFormula("((P(FE7714)+P(FE7719))*P(kf0_769))");
        assert.strictEqual(r.status, "UNSUPPORTED", "status");
        assert.ok(/Nonlinear/.test(r.error), "nonlinear reason");
        assert.strictEqual(r.terms.length, 0, "no numeric terms offered");
    });

    QUnit.test("IF function is unsupported", function (assert) {
        var r = formulaParser.parseFormula("IF(P(A),P(B),0)");
        assert.strictEqual(r.status, "UNSUPPORTED", "status");
        assert.ok(/IF/.test(r.error), "mentions IF");
    });

    QUnit.test("S function is unsupported", function (assert) {
        var r = formulaParser.parseFormula("S(P(A))");
        assert.strictEqual(r.status, "UNSUPPORTED", "status");
        assert.ok(/S\(/.test(r.error), "mentions S(");
    });

    QUnit.test("constant offset cannot be represented as terms", function (assert) {
        var r = formulaParser.parseFormula("P(A)+5");
        assert.strictEqual(r.status, "UNSUPPORTED", "status");
        assert.ok(/constant offset/.test(r.error), "constant offset reason");
    });

    QUnit.test("pure constant expression has no references", function (assert) {
        var r = formulaParser.parseFormula("5*2");
        assert.strictEqual(r.status, "UNSUPPORTED", "status");
    });

    QUnit.test("division by a reference is unsupported", function (assert) {
        var r = formulaParser.parseFormula("100/P(A)");
        assert.strictEqual(r.status, "UNSUPPORTED", "status");
    });

    QUnit.test("division by zero scalar is unsupported", function (assert) {
        var r = formulaParser.parseFormula("P(A)/0");
        assert.strictEqual(r.status, "UNSUPPORTED", "status");
    });

    QUnit.module("formulaParser - syntax errors");

    QUnit.test("malformed parentheses produce a syntax error, not a partial parse (regression 4)", function (assert) {
        var r = formulaParser.parseFormula("(P(QI500)-P(FE13011))-P(PSNUA1))/1000");
        assert.strictEqual(r.status, "SYNTAX_ERROR", "status");
        assert.ok(r.error, "error message present");
        assert.strictEqual(r.terms.length, 0, "no terms offered");
    });

    QUnit.test("unterminated P( is a syntax error", function (assert) {
        var r = formulaParser.parseFormula("P(A");
        assert.strictEqual(r.status, "SYNTAX_ERROR", "status");
    });

    QUnit.test("empty P() is a syntax error", function (assert) {
        var r = formulaParser.parseFormula("P()");
        assert.strictEqual(r.status, "SYNTAX_ERROR", "status");
    });

    QUnit.test("trailing operator is a syntax error (full consumption)", function (assert) {
        var r = formulaParser.parseFormula("P(A)+");
        assert.strictEqual(r.status, "SYNTAX_ERROR", "status");
    });

    QUnit.test("unknown identifier is a syntax error", function (assert) {
        var r = formulaParser.parseFormula("P(A)+X");
        assert.strictEqual(r.status, "SYNTAX_ERROR", "status");
    });

    QUnit.test("invalid character is a syntax error", function (assert) {
        var r = formulaParser.parseFormula("P(A)>P(B)");
        assert.strictEqual(r.status, "SYNTAX_ERROR", "status");
    });

    QUnit.module("formulaParser - empty input");

    QUnit.test("empty formula", function (assert) {
        assert.strictEqual(formulaParser.parseFormula("").status, "EMPTY", "empty string");
        assert.strictEqual(formulaParser.parseFormula("   ").status, "EMPTY", "whitespace only");
        assert.strictEqual(formulaParser.parseFormula(null).status, "EMPTY", "null");
    });
});
