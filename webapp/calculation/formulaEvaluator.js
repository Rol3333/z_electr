/*!
 * zelectr/calculation/formulaEvaluator.js
 *
 * Evaluates a component list (from EITHER the JavaScript parser or the
 * persisted ABAP parser components) against resolved reference values.
 * This isolates parser differences from reference-resolution differences:
 * both component representations are evaluated by the SAME function, against
 * the SAME resolved reference values, on an adjusted or a suggested basis.
 *
 * component shape (both representations are normalized to this):
 *   { seq, sign: "+"|"-", refPosition: string,
 *     multiplier: Decimal, divisor: Decimal }
 *
 * resolveValue(refPosition) -> { status: "RESOLVED", value: Decimal, uom }
 *                          |  { status: "MISSING_REFERENCE"|"AMBIGUOUS_SOURCE", ... }
 *
 * Result: { status, value (Decimal|null), missingReferences[], warnings[] }
 * Statuses: EVALUATED | MISSING_REFERENCE | AMBIGUOUS_SOURCE | UOM_MISMATCH | EMPTY
 */
sap.ui.define([
    "zelectr/parser/decimal"
], function (Decimal) {
    "use strict";

    /**
     * Evaluates a component list.
     *
     * @param {object[]} components normalized component list
     * @param {function} resolveValue reference resolver callback
     * @returns {object} evaluation result (see module docs)
     */
    function evaluateComponents(components, resolveValue) {
        var result = {
            status: "EMPTY",
            value: null,
            missingReferences: [],
            warnings: []
        };

        if (!components || components.length === 0) {
            return result;
        }

        var sum = Decimal.zero();
        var allResolved = true;
        var anyAmbiguous = false;
        var uoms = [];

        components.forEach(function (c) {
            var res = resolveValue(c.refPosition);
            if (!res || res.status !== "RESOLVED" || res.value == null) {
                allResolved = false;
                var status = res ? res.status : "MISSING_REFERENCE";
                if (status === "AMBIGUOUS_SOURCE") {
                    anyAmbiguous = true;
                }
                result.missingReferences.push({
                    refPosition: c.refPosition,
                    reason: res ? (res.reason || res.rule || status) : "No resolution attempted"
                });
                return;
            }
            if (res.uom && uoms.indexOf(res.uom) < 0) {
                uoms.push(res.uom);
            }
            var contribution = res.value.mul(c.multiplier.div(c.divisor));
            sum = sum.add(c.sign === "-" ? contribution.neg() : contribution);
        });

        if (!allResolved) {
            result.status = anyAmbiguous ? "AMBIGUOUS_SOURCE" : "MISSING_REFERENCE";
            result.warnings.push("Evaluation withheld - " + result.missingReferences.length +
                " reference(s) could not be resolved; missing references are not treated as zero");
            return result;
        }

        if (uoms.length > 1) {
            result.status = "UOM_MISMATCH";
            result.warnings.push("Evaluation withheld - the summed terms use incompatible units (" +
                uoms.join(", ") + "); units are not converted silently");
            return result;
        }

        result.status = "EVALUATED";
        result.value = sum;
        if (uoms.length === 1) {
            result.uom = uoms[0];
        }
        return result;
    }

    /**
     * Structural comparison of two component representations (JS vs ABAP),
     * per occurrence: count, sign, reference position, multiplier, divisor.
     * Totals are NOT compared.
     *
     * @param {object[]} jsComponents JS parser terms
     * @param {object[]} abapComponents persisted ABAP component rows
     * @returns {object} { status: "MATCH"|"PARSE_MISMATCH"|"NO_ABAP_COMPONENTS",
     *                     differences: [{seq, field, js, abap}] }
     */
    function compareComponents(jsComponents, abapComponents) {
        if (!abapComponents || abapComponents.length === 0) {
            return { status: "NO_ABAP_COMPONENTS", differences: [] };
        }
        if (!jsComponents || jsComponents.length === 0) {
            return { status: "PARSE_MISMATCH", differences: [] };
        }
        var differences = [];
        var max = Math.max(jsComponents.length, abapComponents.length);
        for (var i = 1; i <= max; i++) {
            var js = jsComponents[i - 1];
            var ab = abapComponents[i - 1];
            if (!js && ab) {
                differences.push({ seq: i, field: "component", js: "-", abap: ab.refPosition || "" });
            } else if (js && !ab) {
                differences.push({ seq: i, field: "component", js: js.refPosition, abap: "-" });
            } else {
                if (js.sign !== (ab.sign || "")) {
                    differences.push({ seq: i, field: "sign", js: js.sign, abap: ab.sign || "" });
                }
                if (js.refPosition !== ab.refPosition) {
                    differences.push({ seq: i, field: "reference", js: js.refPosition, abap: ab.refPosition || "" });
                }
                if (!ab.multiplier || js.multiplier.cmp(ab.multiplier) !== 0) {
                    differences.push({ seq: i, field: "multiplier", js: js.multiplier.toString(), abap: ab.multiplier ? ab.multiplier.toString() : "-" });
                }
                if (!ab.divisor || js.divisor.cmp(ab.divisor) !== 0) {
                    differences.push({ seq: i, field: "divisor", js: js.divisor.toString(), abap: ab.divisor ? ab.divisor.toString() : "-" });
                }
            }
        }
        return {
            status: differences.length ? "PARSE_MISMATCH" : "MATCH",
            differences: differences
        };
    }

    return {
        evaluateComponents: evaluateComponents,
        compareComponents: compareComponents
    };
});
