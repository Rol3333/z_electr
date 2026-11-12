/*!
 * zelectr/calculation/calculationEngine.js
 *
 * Calculates a parent row quantity from a parse result plus resolved
 * references. Separated from parsing (formulaParser) and resolution
 * (referenceResolver) per the boundary in section 6 of the brief:
 *
 *   parseFormula(formula)            -> parse result / ordered terms
 *   resolveReference(term, ...)      -> resolved value + diagnostics
 *   calculateFormula(parseResult, resolved terms) -> numeric result + diagnostics
 *
 * Rules enforced here:
 * - Contributions are summed with exact Decimal arithmetic; no rounding to
 *   scale 3 before the final sum (brief 3.1/5.3).
 * - A missing, ambiguous or unresolvable reference never becomes zero; the
 *   whole calculation is withheld with an explicit status.
 * - UOM compatibility is checked: all resolved references must share the
 *   parent row's UOM, otherwise UOM_MISMATCH.
 * - A numeric result is only produced when the formula is SUPPORTED and all
 *   references resolved. Because every built-in P() strategy is currently
 *   unconfirmed, any numeric result is labelled PROVISIONAL - never
 *   CALCULATED and never authoritative (brief 3.2).
 */
sap.ui.define([
    "zelectr/parser/decimal"
], function (Decimal) {
    "use strict";

    /**
     * Calculates one parent row.
     *
     * @param {object} parseResult output of parseFormula()
     * @param {object[]} resolutions one resolution result per parse term,
     *        same order as parseResult.terms
     * @param {string} parentUom UOM of the parent position
     * @param {object} [strategy] the resolution strategy used (for lineage)
     * @returns {object} calculation result:
     *   { status, value (Decimal|null), termBreakdown: [...],
     *     missingReferences: [...], warnings: [...], strategyId, confirmed }
     */
    function calculateFormula(parseResult, resolutions, parentUom, strategy) {
        var result = {
            status: "NOT_CALCULATED",
            value: null,
            termBreakdown: [],
            missingReferences: [],
            warnings: [],
            strategyId: null,
            confirmed: false
        };

        if (!parseResult || parseResult.status === "EMPTY") {
            result.status = "NOT_CALCULATED";
            result.warnings.push("No formula available for this row");
            return result;
        }
        if (parseResult.status === "SYNTAX_ERROR") {
            result.status = "UNSUPPORTED";
            result.warnings.push("Formula syntax error: " + parseResult.error);
            return result;
        }
        if (parseResult.status === "UNSUPPORTED") {
            result.status = "UNSUPPORTED";
            result.warnings.push("Formula outside supported v1 semantics: " + parseResult.error);
            return result;
        }

        // SUPPORTED - resolve every term; any failure withholds the number
        var sum = Decimal.zero();
        var allResolved = true;
        var anyAmbiguous = false;
        var uomMismatch = false;
        var confirmed = true;
        // UOMs of the resolved terms - compatibility is checked BETWEEN the
        // summed terms, not against the parent UOM: formulas routinely
        // contain the unit conversion themselves (e.g. /1000 turning KWH
        // counters into an MWH parent), so a reference UOM differing from
        // the parent UOM is a warning, not an error.
        var termUoms = [];

        parseResult.terms.forEach(function (term, idx) {
            var res = resolutions[idx];
            var breakdown = {
                seq: term.seq,
                sign: term.sign,
                refPosition: term.refPosition,
                multiplier: term.multiplier,
                divisor: term.divisor,
                status: "NOT_RESOLVED",
                resolvedValue: null,
                contribution: null,
                sourceRows: [],
                rule: res ? res.rule : "No resolution attempted"
            };

            if (!res) {
                allResolved = false;
                breakdown.status = "NOT_RESOLVED";
                result.termBreakdown.push(breakdown);
                return;
            }
            if (res.confirmed === false) {
                confirmed = false;
            }
            breakdown.rule = res.rule;
            breakdown.candidateRows = res.candidateRows || [];

            if (res.status === "AMBIGUOUS_SOURCE") {
                allResolved = false;
                anyAmbiguous = true;
                breakdown.status = "AMBIGUOUS_SOURCE";
                result.missingReferences.push({
                    refPosition: term.refPosition,
                    reason: res.rule
                });
            } else if (res.status === "MISSING_REFERENCE" || res.value == null) {
                allResolved = false;
                breakdown.status = "MISSING_REFERENCE";
                result.missingReferences.push({
                    refPosition: term.refPosition,
                    reason: res.rule
                });
            } else {
                // UOM check: the source rows of ONE term must agree with
                // each other; cross-term compatibility is checked below
                var refUoms = (res.sourceRows || []).map(function (r) { return r.uom; })
                    .filter(function (u) { return !!u; });
                var termUomSet = [];
                refUoms.forEach(function (u) {
                    if (termUomSet.indexOf(u) < 0) {
                        termUomSet.push(u);
                    }
                });
                if (termUomSet.length > 1) {
                    allResolved = false;
                    uomMismatch = true;
                    breakdown.status = "UOM_MISMATCH";
                } else {
                    if (termUomSet.length === 1 && termUoms.indexOf(termUomSet[0]) < 0) {
                        termUoms.push(termUomSet[0]);
                    }
                    var coeff = term.multiplier.div(term.divisor);
                    var contribution = res.value.mul(coeff);
                    breakdown.status = "RESOLVED";
                    breakdown.resolvedValue = res.value;
                    breakdown.contribution = term.sign === "-" ? contribution.neg() : contribution;
                    breakdown.sourceRows = res.sourceRows || [];
                    sum = sum.add(breakdown.contribution);
                }
            }
            result.termBreakdown.push(breakdown);
        });

        result.strategyId = strategy ? strategy.id : null;
        result.confirmed = confirmed;

        if (!allResolved) {
            if (anyAmbiguous) {
                result.status = "AMBIGUOUS_SOURCE";
            } else if (uomMismatch) {
                result.status = "UOM_MISMATCH";
            } else {
                result.status = "MISSING_REFERENCE";
            }
            result.warnings.push("Calculation withheld - " + result.missingReferences.length +
                " reference(s) could not be resolved; missing references are not treated as zero");
            return result;
        }

        if (termUoms.length > 1) {
            // the summed terms themselves use incompatible units
            result.status = "UOM_MISMATCH";
            result.warnings.push("Calculation withheld - the summed reference terms use incompatible units (" +
                termUoms.join(", ") + "); units are not converted silently");
            return result;
        }

        result.value = sum;
        // No built-in strategy is confirmed yet, so a numeric result can only
        // ever be PROVISIONAL (brief 3.2 / status model section 10).
        result.status = confirmed ? "CALCULATED" : "PROVISIONAL";
        if (!confirmed) {
            result.warnings.push("PROVISIONAL value - P(position) resolution rule is not confirmed; " +
                "do not treat this number as authoritative");
        }
        if (termUoms.length === 1 && parentUom && termUoms[0] !== parentUom) {
            result.warnings.push("JS result is in " + termUoms[0] + " while the stored value is in " +
                parentUom + " - the formula scale factors (e.g. /1000) must provide the unit " +
                "conversion; verify this against the ABAP calculation logic");
        }
        return result;
    }

    /**
     * Compares a calculated value with the authoritative stored adjusted
     * quantity. No tolerance is applied (brief 3.1) - the exact difference
     * is returned and the caller decides the label.
     *
     * @param {module:zelectr/parser/decimal} calculatedValue calculated value or null
     * @param {module:zelectr/parser/decimal} storedAdjusted StoredAdjustedQuantity or null
     * @returns {object} { status: "MATCH"|"DIFFERENCE"|"NOT_CALCULATED"|"INCOMPLETE_DATA",
     *                     difference: Decimal|null }
     */
    function compareWithStored(calculatedValue, storedAdjusted) {
        if (calculatedValue == null || storedAdjusted == null) {
            return { status: calculatedValue == null ? "NOT_CALCULATED" : "INCOMPLETE_DATA", difference: null };
        }
        var diff = calculatedValue.sub(storedAdjusted);
        return {
            status: diff.isZero() ? "MATCH" : "DIFFERENCE",
            difference: diff
        };
    }

    return {
        calculateFormula: calculateFormula,
        compareWithStored: compareWithStored
    };
});
