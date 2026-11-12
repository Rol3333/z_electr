/*!
 * zelectr/parser/linearizeExpression.js
 *
 * Transforms a parsed formula AST into an ordered list of reference terms,
 * or reports the expression as UNSUPPORTED when it cannot be represented
 * faithfully as a linear combination of P(position) references.
 *
 * Semantics:
 * - Each P(...) occurrence in the source produces its own term occurrence
 *   (repeated references are NOT merged - the backend component table is
 *   occurrence-based and structural comparison depends on it).
 * - Group scalars are distributed to every reference inside the group,
 *   e.g. (P(A)+P(B))*0,66 gives both A and B multiplier 0.66.
 * - A divisor applies to the subexpression it follows, e.g.
 *   (P(A)+P(B))/1000 + P(C) divides only the grouped terms.
 * - Multiplication/division where BOTH operands contain references is
 *   nonlinear and explicitly unsupported in v1.
 * - IF(...)/S(...) constructs are unsupported in v1.
 * - A nonzero constant offset cannot be represented as reference terms and
 *   is unsupported; a zero constant is ignored.
 * - All arithmetic uses the exact Decimal module; nothing is rounded to the
 *   backend's scale 3 during parsing or summation.
 */
sap.ui.define([
    "zelectr/parser/decimal"
], function (Decimal) {
    "use strict";

    /**
     * Linearizes an AST.
     *
     * @param {object} ast AST produced by formulaParser
     * @returns {object} { status: "SUPPORTED"|"UNSUPPORTED", terms, warnings, reason }
     *   terms: [{ seq, sign, refPosition, multiplier, divisor, sourceSpan, explanation }]
     *   (multiplier/divisor are Decimal instances; sign is "+" or "-")
     */
    function linearize(ast) {
        var warnings = [];
        var value;
        try {
            value = evalNode(ast, warnings);
        } catch (e) {
            return { status: "UNSUPPORTED", terms: [], warnings: warnings, reason: e.message };
        }

        if (value.kind === "SCALAR") {
            return {
                status: "UNSUPPORTED",
                terms: [],
                warnings: warnings,
                reason: "The formula contains no P(position) references - it is a pure constant expression"
            };
        }

        if (!value.constant.isZero()) {
            return {
                status: "UNSUPPORTED",
                terms: [],
                warnings: warnings,
                reason: "The formula contains a constant offset (" + value.constant.toString() +
                    ") which cannot be represented as reference terms"
            };
        }

        if (value.items.length === 0) {
            return {
                status: "UNSUPPORTED",
                terms: [],
                warnings: warnings,
                reason: "The formula contains no P(position) references"
            };
        }

        var terms = value.items.map(function (item, idx) {
            return {
                seq: idx + 1,
                sign: item.sign,
                refPosition: item.name,
                multiplier: item.multiplier,
                divisor: item.divisor,
                sourceSpan: { start: item.start, end: item.end },
                explanation: item.explanation
            };
        });

        return { status: "SUPPORTED", terms: terms, warnings: warnings, reason: null };
    }

    // ----------------------------------------------------------------------

    /**
     * Evaluates an AST node to a value object:
     *   { kind: "SCALAR", value: Decimal }
     *   { kind: "LINEAR", items: [term...], constant: Decimal }
     * where term = { name, sign, multiplier, divisor, start, end, explanation }.
     * Throws Error for unsupported constructs.
     */
    function evalNode(node, warnings) {
        switch (node.type) {
            case "num":
                return { kind: "SCALAR", value: Decimal.fromString(node.value) };

            case "ref":
                return {
                    kind: "LINEAR",
                    items: [{
                        name: node.name,
                        sign: "+",
                        multiplier: Decimal.fromNumber(1),
                        divisor: Decimal.fromNumber(1),
                        start: node.start,
                        end: node.end,
                        explanation: "P(" + node.name + ")"
                    }],
                    constant: Decimal.zero()
                };

            case "unary": {
                var inner = evalNode(node.operand, warnings);
                if (node.op === "+") {
                    return inner;
                }
                if (inner.kind === "SCALAR") {
                    return { kind: "SCALAR", value: inner.value.neg() };
                }
                return {
                    kind: "LINEAR",
                    items: inner.items.map(function (item) {
                        return Object.assign({}, item, {
                            sign: item.sign === "+" ? "-" : "+",
                            explanation: item.explanation + ", sign flipped by unary minus"
                        });
                    }),
                    constant: inner.constant.neg()
                };
            }

            case "group":
                return evalNode(node.operand, warnings);

            case "func":
                throw new Error("Function " + node.name + "(...) is not supported in v1 - its business semantics are not implemented");

            case "bin":
                return evalBinary(node, warnings);

            default:
                throw new Error("Unknown AST node type: " + node.type);
        }
    }

    function isLinear(v) {
        return v.kind === "LINEAR";
    }

    function evalBinary(node, warnings) {
        var left = evalNode(node.left, warnings);
        var right = evalNode(node.right, warnings);

        switch (node.op) {
            case "+":
                return addValues(left, right);
            case "-":
                return addValues(left, negateValue(right));
            case "*":
                return mulValues(left, right, node);
            case "/":
                return divValues(left, right, node);
            default:
                throw new Error("Unknown operator: " + node.op);
        }
    }

    function addValues(a, b) {
        if (a.kind === "SCALAR" && b.kind === "SCALAR") {
            return { kind: "SCALAR", value: a.value.add(b.value) };
        }
        var items = (a.kind === "LINEAR" ? a.items : []).concat(b.kind === "LINEAR" ? b.items : []);
        var constant = (a.kind === "LINEAR" ? a.constant : a.value)
            .add(b.kind === "LINEAR" ? b.constant : b.value);
        return { kind: "LINEAR", items: items, constant: constant };
    }

    function negateValue(v) {
        if (v.kind === "SCALAR") {
            return { kind: "SCALAR", value: v.value.neg() };
        }
        return {
            kind: "LINEAR",
            items: v.items.map(function (item) {
                return Object.assign({}, item, {
                    sign: item.sign === "+" ? "-" : "+"
                });
            }),
            constant: v.constant.neg()
        };
    }

    function mulValues(a, b, node) {
        if (a.kind === "SCALAR" && b.kind === "SCALAR") {
            return { kind: "SCALAR", value: a.value.mul(b.value) };
        }
        if (a.kind === "LINEAR" && b.kind === "LINEAR") {
            throw new Error("Nonlinear expression: two operands containing P(position) references are multiplied (position " +
                node.left.start + "-" + node.right.end + ") - e.g. P(A)*P(B) is not supported in v1");
        }
        var scalar = a.kind === "SCALAR" ? a.value : b.value;
        var linear = a.kind === "LINEAR" ? a : b;
        return {
            kind: "LINEAR",
            items: linear.items.map(function (item) {
                return Object.assign({}, item, {
                    multiplier: item.multiplier.mul(scalar),
                    explanation: item.explanation + " multiplied by the scalar " + scalar.toString()
                });
            }),
            constant: linear.constant.mul(scalar)
        };
    }

    function divValues(a, b, node) {
        if (b.kind === "LINEAR") {
            throw new Error("Nonlinear expression: division by an operand containing P(position) references (position " +
                node.right.start + "-" + node.right.end + ") is not supported in v1");
        }
        if (b.value.isZero()) {
            throw new Error("Division by zero at position " + node.right.start);
        }
        if (a.kind === "SCALAR") {
            return { kind: "SCALAR", value: a.value.div(b.value) };
        }
        return {
            kind: "LINEAR",
            items: a.items.map(function (item) {
                return Object.assign({}, item, {
                    divisor: item.divisor.mul(b.value),
                    explanation: item.explanation + " divided by the scalar " + b.value.toString()
                });
            }),
            constant: a.constant.div(b.value)
        };
    }

    return {
        linearize: linearize
    };
});
