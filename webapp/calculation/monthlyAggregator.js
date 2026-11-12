/*!
 * zelectr/calculation/monthlyAggregator.js
 *
 * Monthly aggregation of daily calculation results.
 *
 * Per brief section 3.3/6.2, monthly aggregation may only be produced with a
 * DOCUMENTED, CONFIRMED period rule:
 *   - "SUM_DAILY_CONSUMPTION": P() is daily consumption -> sum daily values
 *   - "PERIOD_END_CUMULATIVE": P() is cumulative -> use the period-end value
 * No built-in strategy is confirmed today (PAST_MEASUREMENT is not exposed
 * by Z_I_ELECR_CNTR), so by default the aggregator reports the monthly
 * result as NOT_AVAILABLE with the precise reason instead of inventing a KPI.
 */
sap.ui.define([
    "zelectr/parser/decimal"
], function (Decimal) {
    "use strict";

    var AGGREGATION_METHODS = {
        SUM_DAILY_CONSUMPTION: {
            id: "SUM_DAILY_CONSUMPTION",
            label: "Sum of daily consumption values",
            description: "Valid only when P(position) is confirmed to be a daily consumption quantity"
        },
        PERIOD_END_CUMULATIVE: {
            id: "PERIOD_END_CUMULATIVE",
            label: "Period-end cumulative quantity",
            description: "Valid only when P(position) is confirmed to be cumulative within the period"
        }
    };

    /**
     * Aggregates daily calculation results into a monthly result.
     *
     * @param {object[]} dailyResults calculation results per parent row, each
     *        with { status, value (Decimal|null) }
     * @param {object|null} confirmedRule the confirmed aggregation rule, i.e.
     *        an entry of AGGREGATION_METHODS, or null while P() semantics
     *        are unconfirmed
     * @returns {object} { status: "AGGREGATED"|"NOT_AVAILABLE"|"PARTIAL",
     *                     method, value (Decimal|null), reason,
     *                     includedRows, excludedRows }
     */
    function aggregateMonth(dailyResults, confirmedRule) {
        if (!confirmedRule) {
            return {
                status: "NOT_AVAILABLE",
                method: null,
                value: null,
                reason: "Not available - P() resolution rule not confirmed; the mathematical meaning of a monthly aggregate (sum of daily consumptions vs period-end cumulative) is unknown",
                includedRows: 0,
                excludedRows: dailyResults ? dailyResults.length : 0
            };
        }

        var calculable = (dailyResults || []).filter(function (r) {
            return r.value != null;
        });
        var excludedRows = (dailyResults || []).length - calculable.length;

        if (calculable.length === 0) {
            return {
                status: "NOT_AVAILABLE",
                method: confirmedRule.id,
                value: null,
                reason: "No daily rows with a calculated value are available for aggregation",
                includedRows: 0,
                excludedRows: excludedRows
            };
        }

        if (confirmedRule.id === "SUM_DAILY_CONSUMPTION") {
            var sum = calculable.reduce(function (acc, r) {
                return acc.add(r.value);
            }, Decimal.zero());
            return {
                status: excludedRows > 0 ? "PARTIAL" : "AGGREGATED",
                method: confirmedRule.id,
                value: sum,
                reason: excludedRows > 0
                    ? "Partial aggregate - " + excludedRows + " daily row(s) had no calculated value and were excluded"
                    : null,
                includedRows: calculable.length,
                excludedRows: excludedRows
            };
        }

        if (confirmedRule.id === "PERIOD_END_CUMULATIVE") {
            // the period-end value is the value of the latest calculable row
            var last = calculable[calculable.length - 1];
            return {
                status: excludedRows > 0 ? "PARTIAL" : "AGGREGATED",
                method: confirmedRule.id,
                value: last.value,
                reason: excludedRows > 0
                    ? "Partial aggregate - " + excludedRows + " daily row(s) had no calculated value"
                    : null,
                includedRows: calculable.length,
                excludedRows: excludedRows
            };
        }

        return {
            status: "NOT_AVAILABLE",
            method: confirmedRule.id,
            value: null,
            reason: "Unknown aggregation method: " + confirmedRule.id,
            includedRows: 0,
            excludedRows: (dailyResults || []).length
        };
    }

    return {
        AGGREGATION_METHODS: AGGREGATION_METHODS,
        aggregateMonth: aggregateMonth
    };
});
