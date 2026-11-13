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

    /**
     * Candidate monthly rule: PERIOD_CHANGE with reset-aware segmentation.
     *
     * The period value is the sum of consumption segments:
     *   - baseline starts at the opening reading (the closest available
     *     reading before the period start; when an automatic and a manual
     *     row exist on the same date, the automatic row is preferred);
     *   - readings are walked chronologically; whenever a reading is LOWER
     *     than the current baseline, a meter reset is detected: the previous
     *     segment is closed (segment value = previous reading - baseline)
     *     and the baseline restarts at the reset value (candidate rule:
     *     "reset opening = reset value", as reconstructed for the bE31X
     *     fixture);
     *   - the final segment is closed with the last reading.
     *
     * This matches the bE31X fixture reconstruction ("April 30 adjusted
     * values less March 31 opening values, with a reset opening of zero")
     * and is NOT business-confirmed. Reset detection assumes decreasing
     * readings are meter resets (negative consumption is treated as a
     * reset) - documented as a candidate-rule assumption.
     *
     * Manual/reset rows inside the period are preserved and reported;
     * they are never silently discarded, and they no longer corrupt the
     * result by being picked as the "last reading".
     *
     * @param {object[]} rows chronological normalized source rows of ONE
     *        position (each { dateIso, adjusted, manualEntry, ... })
     * @param {string} monthStartIso "yyyy-MM-dd" first day of the month
     * @param {string} monthEndIso "yyyy-MM-dd" last day of the month
     * @returns {object} { status: "EVALUATED"|"NO_DATA"|"INSUFFICIENT_PERIOD_DATA",
     *                     value (Decimal|null), openingRow, lastRow,
     *                     manualRowsInMonth, resetsInPeriod, notes[] }
     */
    function periodChange(rows, monthStartIso, monthEndIso) {
        var notes = [];
        var all = rows || [];
        var inMonth = all.filter(function (r) {
            return r.dateIso >= monthStartIso && r.dateIso <= monthEndIso;
        });
        if (inMonth.length === 0) {
            return { status: "NO_DATA", value: null, openingRow: null, lastRow: null,
                manualRowsInMonth: 0, resetsInPeriod: 0, notes: notes };
        }

        // Only AUTOMATIC rows participate as readings. Manual rows (verified
        // against the bE125 extract: "Pradinis kaupiamojo skaitiklio
        // pozicijos kiekis" initial-quantity events) are EVENTS, not
        // readings - their quantity fields can be 0 for one basis while the
        // other basis carries the reading, so using them as readings or
        // reset markers corrupts the series (this produced the wrong
        // suggested values). They remain visible in the UI and are counted
        // in the notes.
        var before = all.filter(function (r) {
            return r.dateIso < monthStartIso && !r.manualEntry && r.adjusted != null;
        });
        var opening = before.length ? before[before.length - 1] : null;
        if (!opening) {
            notes.push("No opening reading available before " + monthStartIso +
                " - the period change cannot be computed");
            return { status: "INSUFFICIENT_PERIOD_DATA", value: null, openingRow: null,
                lastRow: inMonth[inMonth.length - 1], manualRowsInMonth: 0,
                resetsInPeriod: 0, notes: notes };
        }

        // chronological AUTOMATIC readings inside the period
        var manualRows = inMonth.filter(function (r) { return r.manualEntry; });
        var readings = inMonth.filter(function (r) {
            return !r.manualEntry && r.adjusted != null;
        });
        if (readings.length === 0) {
            notes.push("No reading with an adjusted quantity inside the period");
            return { status: "INSUFFICIENT_PERIOD_DATA", value: null, openingRow: opening,
                lastRow: null, manualRowsInMonth: manualRows.length,
                resetsInPeriod: 0, notes: notes };
        }

        // reset-aware segment summation over the AUTOMATIC reading series.
        // A reading BELOW the current baseline is a meter reset: the previous
        // segment is closed with the last reading (never negative) and the
        // baseline restarts at 0 (reset-to-zero candidate rule - the
        // consumption of the reset day counts in full from zero, which
        // reproduces the stored bE125/bE31X values).
        var total = Decimal.zero();
        var baseline = opening.adjusted;
        var prevValue = opening.adjusted;
        var resets = 0;
        var last = null;
        readings.forEach(function (r) {
            if (r.adjusted.cmp(baseline) < 0) {
                // meter reset detected: close the previous segment with the
                // last real reading and restart the baseline at zero
                total = total.add(prevValue.sub(baseline));
                baseline = Decimal.zero();
                resets++;
            }
            prevValue = r.adjusted;
            last = r;
        });
        // close the final segment
        total = total.add(prevValue.sub(baseline));

        if (resets > 0) {
            notes.push("Meter reset detected in the period (" + resets +
                ") - period change computed as segment sums across resets " +
                "(candidate rule, decreasing readings treated as resets)");
        }
        if (manualRows.length) {
            notes.push("Manual/reset rows present in the period (" + manualRows.length + ")");
        }

        return {
            status: "EVALUATED",
            value: total,
            openingRow: opening,
            lastRow: last,
            manualRowsInMonth: manualRows.length,
            resetsInPeriod: resets,
            notes: notes
        };
    }

    return {
        AGGREGATION_METHODS: AGGREGATION_METHODS,
        aggregateMonth: aggregateMonth,
        periodChange: periodChange
    };
});
