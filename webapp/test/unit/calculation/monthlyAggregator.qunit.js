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
});
