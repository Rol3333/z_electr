/*!
 * zelectr/calculation/referenceResolver.js
 *
 * Resolves P(position) references to concrete source rows and values.
 *
 * IMPORTANT - P() SEMANTICS ARE NOT CONFIRMED (brief section 3.2):
 * The OData projection Z_I_ELECR_CNTR does not expose PAST_MEASUREMENT, so
 * the exact ABAP rule behind P(position) cannot be verified from the
 * frontend. Every strategy in this module is therefore PROVISIONAL. The
 * strategy is injectable so the confirmed rule can be plugged in later
 * without touching the calculation engine.
 *
 * A strategy receives a resolution request and returns a resolution result:
 *
 *   request: {
 *     plant, refPosition, date (Date, midnight UTC),
 *     sourceIndex  - normalized index built by odataService (see below)
 *   }
 *
 *   result: {
 *     status: "RESOLVED" | "MISSING_REFERENCE" | "AMBIGUOUS_SOURCE",
 *     value: Decimal|null        - resolved P(position) value
 *     sourceRows: [row...]       - exact source rows used (lineage)
 *     candidateRows: [row...]    - all candidate rows (kept for diagnostics)
 *     rule: string               - human-readable rule description
 *     confirmed: boolean         - false for all built-in strategies
 *   }
 *
 * sourceIndex shape (built by the service layer):
 *   { byKey: Map "plant|pos|yyyy-MM-dd|manualEntry" -> row,
 *     byPosDate: Map "plant|pos|yyyy-MM-dd" -> [row...] }
 * where row = { plant, pos, date: Date, manualEntry, adjusted (Decimal|null),
 *               suggested (Decimal|null), uom, formula, raw: <OData row> }.
 */
sap.ui.define([
    "zelectr/parser/decimal"
], function (Decimal) {
    "use strict";

    function keyOf(plant, pos, date, manualEntry) {
        return [plant, pos, toIsoDate(date), manualEntry ? "true" : "false"].join("|");
    }

    function toIsoDate(oDate) {
        return oDate.getUTCFullYear() +
            "-" + String(oDate.getUTCMonth() + 1).padStart(2, "0") +
            "-" + String(oDate.getUTCDate()).padStart(2, "0");
    }

    function decimalOrNull(v) {
        return v == null ? null : v;
    }

    /**
     * Strategy: P(position) = AdjustedQuantity of the source row with the
     * exact same plant/position/date. PROVISIONAL - treats the value as a
     * period quantity; the cumulative/reading interpretation is unverified.
     * If both an automatic and a manual row exist for the same date, the
     * result is AMBIGUOUS_SOURCE (no arbitrary duplicate selection).
     */
    var exactDateStrategy = {
        id: "EXACT_DATE_ADJUSTED",
        label: "Exact date AdjustedQuantity (provisional)",
        confirmed: false,
        resolve: function (request) {
            // byPosDate keys are "plant|pos|date"
            var posDateKey = [request.plant, request.refPosition, toIsoDate(request.date)].join("|");
            var candidates = request.sourceIndex.byPosDate.get(posDateKey) || [];

            if (candidates.length === 0) {
                return {
                    status: "MISSING_REFERENCE",
                    value: null,
                    sourceRows: [],
                    candidateRows: [],
                    rule: "No source row exists for position " + request.refPosition +
                        " on " + toIsoDate(request.date) + " in plant " + request.plant,
                    confirmed: false
                };
            }
            if (candidates.length > 1) {
                return {
                    status: "AMBIGUOUS_SOURCE",
                    value: null,
                    sourceRows: [],
                    candidateRows: candidates,
                    rule: "Multiple source rows (automatic and manual entry) exist for position " +
                        request.refPosition + " on " + toIsoDate(request.date) +
                        " and no business rule identifies the correct one",
                    confirmed: false
                };
            }
            var row = candidates[0];
            return {
                status: row.adjusted == null ? "MISSING_REFERENCE" : "RESOLVED",
                value: decimalOrNull(row.adjusted),
                sourceRows: row.adjusted == null ? [] : [row],
                candidateRows: [row],
                rule: "P(" + request.refPosition + ") = AdjustedQuantity of the exact-date source row (manualEntry=" +
                    row.manualEntry + ") - PROVISIONAL, P() semantics not verified",
                confirmed: false
            };
        }
    };

    /**
     * Strategy: P(position) = AdjustedQuantity(date) - AdjustedQuantity of
     * the closest earlier available date (previous reading). PROVISIONAL -
     * a previous row is not automatically equivalent to PAST_MEASUREMENT;
     * gaps, resets and manual entries can affect it (brief section 3.2).
     */
    var previousReadingStrategy = {
        id: "PREVIOUS_READING_DIFFERENCE",
        label: "Difference to closest earlier reading (provisional)",
        confirmed: false,
        resolve: function (request) {
            var posDateKey = [request.plant, request.refPosition, toIsoDate(request.date)].join("|");
            var candidates = request.sourceIndex.byPosDate.get(posDateKey) || [];
            if (candidates.length === 0) {
                return {
                    status: "MISSING_REFERENCE",
                    value: null,
                    sourceRows: [],
                    candidateRows: [],
                    rule: "No source row exists for position " + request.refPosition +
                        " on " + toIsoDate(request.date) + " in plant " + request.plant,
                    confirmed: false
                };
            }
            if (candidates.length > 1) {
                return {
                    status: "AMBIGUOUS_SOURCE",
                    value: null,
                    sourceRows: [],
                    candidateRows: candidates,
                    rule: "Multiple source rows exist for position " + request.refPosition +
                        " on " + toIsoDate(request.date) + " and no business rule identifies the correct one",
                    confirmed: false
                };
            }
            var current = candidates[0];
            if (current.adjusted == null) {
                return {
                    status: "MISSING_REFERENCE",
                    value: null,
                    sourceRows: [],
                    candidateRows: [current],
                    rule: "Current row for " + request.refPosition + " on " + toIsoDate(request.date) +
                        " has no adjusted quantity",
                    confirmed: false
                };
            }
            // find closest earlier row (automatic rows preferred, manual kept as candidates)
            var all = request.sourceIndex.rowsByPos.get([request.plant, request.refPosition].join("|")) || [];
            var earlier = all.filter(function (r) {
                return r.date.getTime() < request.date.getTime() && r.adjusted != null;
            });
            if (earlier.length === 0) {
                return {
                    status: "MISSING_REFERENCE",
                    value: null,
                    sourceRows: [],
                    candidateRows: [current],
                    rule: "No earlier reading available for position " + request.refPosition +
                        " before " + toIsoDate(request.date) + " - opening value unknown",
                    confirmed: false
                };
            }
            var previous = earlier.reduce(function (best, r) {
                return r.date.getTime() > best.date.getTime() ? r : best;
            }, earlier[0]);
            return {
                status: "RESOLVED",
                value: current.adjusted.sub(previous.adjusted),
                sourceRows: [current, previous],
                candidateRows: [current, previous],
                rule: "P(" + request.refPosition + ") = AdjustedQuantity(" + toIsoDate(current.date) +
                    ", manualEntry=" + current.manualEntry + ") - AdjustedQuantity(" + toIsoDate(previous.date) +
                    ", manualEntry=" + previous.manualEntry + ") - PROVISIONAL, P() semantics not verified",
                confirmed: false
            };
        }
    };

    var STRATEGIES = [exactDateStrategy, previousReadingStrategy];

    /**
     * Returns the built-in strategies (all provisional).
     *
     * @returns {object[]} strategy descriptors
     */
    function getStrategies() {
        return STRATEGIES.slice();
    }

    /**
     * Finds a strategy by id.
     *
     * @param {string} id strategy id
     * @returns {object} strategy or undefined
     */
    function getStrategyById(id) {
        return STRATEGIES.find(function (s) { return s.id === id; });
    }

    /**
     * Resolves a single reference using the given strategy.
     *
     * @param {object} term parse term ({refPosition, ...})
     * @param {Date} date parent row date (midnight UTC)
     * @param {string} plant plant id
     * @param {object} sourceIndex normalized source index
     * @param {object} strategy selected resolution strategy
     * @returns {object} resolution result (see module docs)
     */
    function resolveReference(term, date, plant, sourceIndex, strategy) {
        return strategy.resolve({
            plant: plant,
            refPosition: term.refPosition,
            date: date,
            sourceIndex: sourceIndex
        });
    }

    return {
        getStrategies: getStrategies,
        getStrategyById: getStrategyById,
        resolveReference: resolveReference,
        toIsoDate: toIsoDate,
        STRATEGY_EXACT_DATE: exactDateStrategy,
        STRATEGY_PREVIOUS_READING: previousReadingStrategy
    };
});
