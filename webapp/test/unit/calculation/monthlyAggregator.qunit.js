/* global QUnit */
sap.ui.define([
    "zelectr/parser/decimal",
    "zelectr/calculation/monthlyAggregator"
], function (Decimal, monthlyAggregator) {
    "use strict";

    QUnit.module("monthlyAggregator - unconfirmed rule");

    QUnit.test("without a confirmed rule the monthly result is NOT_AVAILABLE", function (assert) {
        var r = monthlyAggregator.aggregateMonth([
            { status: "PROVISIONAL", value: Decimal.fromString("100") },
            { status: "PROVISIONAL", value: Decimal.fromString("50") }
        ], null);
        assert.strictEqual(r.status, "NOT_AVAILABLE", "status");
        assert.strictEqual(r.value, null, "no value invented");
        assert.ok(/P\(\) resolution rule not confirmed/.test(r.reason), "reason explains the P() gap");
    });

    QUnit.module("monthlyAggregator - confirmed rules (unit-level only)");

    QUnit.test("SUM_DAILY_CONSUMPTION sums daily values", function (assert) {
        var rule = monthlyAggregator.AGGREGATION_METHODS.SUM_DAILY_CONSUMPTION;
        var r = monthlyAggregator.aggregateMonth([
            { status: "CALCULATED", value: Decimal.fromString("100.5") },
            { status: "CALCULATED", value: Decimal.fromString("50.25") }
        ], rule);
        assert.strictEqual(r.status, "AGGREGATED", "status");
        assert.strictEqual(r.value.toString(), "150.75", "exact sum");
        assert.strictEqual(r.includedRows, 2, "included rows");
    });

    QUnit.test("SUM_DAILY_CONSUMPTION with excluded rows is PARTIAL", function (assert) {
        var rule = monthlyAggregator.AGGREGATION_METHODS.SUM_DAILY_CONSUMPTION;
        var r = monthlyAggregator.aggregateMonth([
            { status: "CALCULATED", value: Decimal.fromString("100") },
            { status: "MISSING_REFERENCE", value: null }
        ], rule);
        assert.strictEqual(r.status, "PARTIAL", "partial status");
        assert.strictEqual(r.value.toString(), "100", "only calculable rows summed");
        assert.strictEqual(r.excludedRows, 1, "excluded row count");
    });

    QUnit.test("PERIOD_END_CUMULATIVE uses the latest calculable value", function (assert) {
        var rule = monthlyAggregator.AGGREGATION_METHODS.PERIOD_END_CUMULATIVE;
        var r = monthlyAggregator.aggregateMonth([
            { status: "CALCULATED", value: Decimal.fromString("100") },
            { status: "CALCULATED", value: Decimal.fromString("250") }
        ], rule);
        assert.strictEqual(r.status, "AGGREGATED", "status");
        assert.strictEqual(r.value.toString(), "250", "period-end value");
    });

    QUnit.test("no calculable rows -> NOT_AVAILABLE", function (assert) {
        var rule = monthlyAggregator.AGGREGATION_METHODS.SUM_DAILY_CONSUMPTION;
        var r = monthlyAggregator.aggregateMonth([
            { status: "MISSING_REFERENCE", value: null }
        ], rule);
        assert.strictEqual(r.status, "NOT_AVAILABLE", "status");
        assert.strictEqual(r.value, null, "no value");
    });

    QUnit.module("monthlyAggregator - periodChange (candidate rule)");

    function row(dateIso, adjusted, manualEntry) {
        return {
            dateIso: dateIso,
            adjusted: adjusted === null ? null : Decimal.fromString(String(adjusted)),
            manualEntry: !!manualEntry
        };
    }

    QUnit.test("period change = last reading in month minus opening reading", function (assert) {
        // bE31X fixture pattern: April 30 value less March 31 opening
        var rows = [
            row("2026-03-31", "1000"),
            row("2026-04-15", "2000"),
            row("2026-04-30", "13252.120")
        ];
        var r = monthlyAggregator.periodChange(rows, "2026-04-01", "2026-04-30");
        assert.strictEqual(r.status, "EVALUATED", "status");
        assert.strictEqual(r.value.toString(), "12252.12", "13252.120 - 1000 (trailing zeros trimmed)");
        assert.strictEqual(r.openingRow.dateIso, "2026-03-31", "opening row");
        assert.strictEqual(r.lastRow.dateIso, "2026-04-30", "last row");
    });

    QUnit.test("no rows in the month -> NO_DATA", function (assert) {
        var rows = [row("2026-03-31", "1000")];
        var r = monthlyAggregator.periodChange(rows, "2026-04-01", "2026-04-30");
        assert.strictEqual(r.status, "NO_DATA", "status");
        assert.strictEqual(r.value, null, "no value");
    });

    QUnit.test("no opening reading before the month -> INSUFFICIENT_PERIOD_DATA", function (assert) {
        var rows = [row("2026-04-15", "2000")];
        var r = monthlyAggregator.periodChange(rows, "2026-04-01", "2026-04-30");
        assert.strictEqual(r.status, "INSUFFICIENT_PERIOD_DATA", "status");
        assert.strictEqual(r.value, null, "no value invented");
        assert.ok(r.notes.length > 0, "reason explained in notes");
    });

    QUnit.test("manual/reset rows: segment summation across the reset", function (assert) {
        var rows = [
            row("2026-03-31", "1000"),
            row("2026-04-10", "2000"),
            row("2026-04-15", "0", true), // manual reset row
            row("2026-04-30", "500")
        ];
        var r = monthlyAggregator.periodChange(rows, "2026-04-01", "2026-04-30");
        assert.strictEqual(r.status, "EVALUATED", "status");
        assert.strictEqual(r.manualRowsInMonth, 1, "one manual row counted");
        assert.strictEqual(r.resetsInPeriod, 1, "one reset detected");
        // segment 1: 2000 - 1000 = 1000; segment 2 (after reset): 500 - 0 = 500
        assert.strictEqual(r.value.toString(), "1500", "segment sum across reset");
        assert.ok(r.notes.some(function (n) { return /reset/i.test(n); }),
            "reset note present");
    });

    QUnit.test("bE125 pattern: boundary reset (drop at period start) sets baseline 0; manual rows are never readings", function (assert) {
        // verified against the bE125 extract (TP-Skarul_n22, April 2026):
        // Mar 31 = 808099 (auto) + 0 (manual "initial quantity" event);
        // April climbs 18162..860261; Apr 30 = 860261 (auto) + 0 (manual).
        // April consumption = 860261 - 0 (reset-to-zero at the boundary).
        var rows = [
            row("2026-03-31", "808099"),
            row("2026-03-31", "0", true),      // manual event on the opening date
            row("2026-04-15", "400000"),
            row("2026-04-30", "860261"),
            row("2026-04-30", "0", true)      // manual event on the last date
        ];
        var r = monthlyAggregator.periodChange(rows, "2026-04-01", "2026-04-30");
        assert.strictEqual(r.status, "EVALUATED", "status");
        assert.strictEqual(r.value.toString(), "860261", "860261 - 0 (reset baseline)");
        assert.strictEqual(r.resetsInPeriod, 1, "boundary drop detected as reset");
        assert.strictEqual(r.openingRow.adjusted.toString(), "808099", "opening is the automatic reading");
        assert.strictEqual(r.manualRowsInMonth, 1, "manual event counted, not used as reading");
    });

    QUnit.test("manual rows with a non-zero quantity on the other basis never corrupt the series", function (assert) {
        // bTP-48_k02 pattern: manual rows carry SUGGESTED=0 but ADJUSTED=the
        // reading; the suggested series continues monotonically through them
        var rowsAdj = [
            row("2026-03-31", "718876"),
            row("2026-04-10", "720876"),
            row("2026-04-10", "720876", true),  // manual event: adj = reading copy
            row("2026-04-30", "726021"),
            row("2026-04-30", "726021", true)
        ];
        var rowsSug = [
            row("2026-03-31", "718876"),
            row("2026-04-10", "720876"),
            row("2026-04-10", "0", true),       // same events: suggested = 0
            row("2026-04-30", "726021"),
            row("2026-04-30", "0", true)
        ];
        var adj = monthlyAggregator.periodChange(rowsAdj, "2026-04-01", "2026-04-30");
        var sug = monthlyAggregator.periodChange(rowsSug, "2026-04-01", "2026-04-30");
        assert.strictEqual(adj.value.toString(), "7145", "adjusted: 726021 - 718876");
        assert.strictEqual(sug.value.toString(), "7145", "suggested: identical (manual zeros ignored)");
    });

    QUnit.test("bE125 full pattern: month total equals the stored value", function (assert) {
        // the pre-fix bug produced -246.021 for the bE125 formula; the
        // reset-aware segmentation reproduces the stored 1998.367
        var rows = [
            row("2026-03-31", "246.021"),
            row("2026-04-15", "1000"),
            row("2026-04-30", "2244.388"),
            row("2026-04-30", "0", true)
        ];
        var r = monthlyAggregator.periodChange(rows, "2026-04-01", "2026-04-30");
        assert.strictEqual(r.value.toString(), "1998.367", "2244.388 - 246.021 = 1998.367");
    });

    QUnit.test("plain month without resets stays simple last-minus-opening", function (assert) {
        var rows = [
            row("2026-03-31", "1000"),
            row("2026-04-15", "1500"),
            row("2026-04-30", "2000")
        ];
        var r = monthlyAggregator.periodChange(rows, "2026-04-01", "2026-04-30");
        assert.strictEqual(r.value.toString(), "1000", "2000 - 1000");
        assert.strictEqual(r.resetsInPeriod, 0, "no resets");
    });
});
