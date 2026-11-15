/* global QUnit */
sap.ui.define([
    "zelectr/service/performanceDiagnostics"
], function (perf) {
    "use strict";

    // capture console output instead of printing it during tests
    var captured = [];
    var original = {};

    function captureConsole() {
        ["groupCollapsed", "groupEnd", "info", "warn", "error"].forEach(function (m) {
            original[m] = console[m];
            console[m] = function () {
                captured.push(Array.prototype.slice.call(arguments).join(" "));
            };
        });
    }

    function restoreConsole() {
        Object.keys(original).forEach(function (m) {
            console[m] = original[m];
        });
    }

    QUnit.module("performanceDiagnostics", {
        beforeEach: function () {
            captured = [];
            captureConsole();
        },
        afterEach: function () {
            restoreConsole();
            perf.setEnabledForTest(null);
        }
    });

    QUnit.test("silent when disabled (default)", function (assert) {
        perf.setEnabledForTest(false);
        var run = perf.beginReportRun("CURRENT_MONTH", { plant: "2010" });
        assert.strictEqual(run, null, "beginReportRun returns null when disabled");
        perf.endReportRun(run, "success");
        perf.startStage(run, "stage");
        perf.logODataPage(run, { pageIndex: 1, records: 10, durationMs: 5, hasNext: false, status: "success" });
        perf.logODataOperation(run, { label: "readParents", records: 10, durationMs: 5, status: "success" });
        perf.logODataChunk(run, { chunkIndex: 1, chunkTotal: 1, positions: 8, records: 10, durationMs: 5, status: "success" });
        perf.logError(run, "readParents", new Error("boom"));
        assert.strictEqual(captured.length, 0, "nothing printed when disabled");
    });

    QUnit.test("enabled: report run start and terminal summary", function (assert) {
        perf.setEnabledForTest(true);
        var run = perf.beginReportRun("CURRENT_MONTH", { plant: "2010", period: "2026-11" });
        assert.ok(run, "run context returned");
        assert.ok(/^run-\d+$/.test(run.runId), "run id format: " + run.runId);
        perf.endReportRun(run, "success", { outputRows: 42 });
        var joined = captured.join("\n");
        assert.ok(/REPORT LOAD START/.test(joined), "start logged");
        assert.ok(/Started/.test(joined), "start timestamp logged");
        assert.ok(/Context: plant=2010, period=2026-11/.test(joined), "context logged");
        assert.ok(/Total wall time/.test(joined), "total duration logged");
        assert.ok(/output rows: 42/.test(joined), "details logged");
        assert.ok(/outcome: success/.test(joined), "outcome logged");
    });

    QUnit.test("enabled: OData page and operation counters", function (assert) {
        perf.setEnabledForTest(true);
        var run = perf.beginReportRun("YEAR_REPORT", { pos: "bE24X", year: 2026 });
        perf.logODataPage(run, { pageIndex: 1, durationMs: 120, records: 100, hasNext: true, status: "success" });
        perf.logODataPage(run, { pageIndex: 2, durationMs: 80, records: 50, hasNext: false, status: "success" });
        perf.logODataOperation(run, {
            label: "readSourceRows", entity: "/Z_I_ELECR_CNTR", durationMs: 5000,
            records: 8450, chunks: 18, chunkSize: 8, concurrency: 3, positions: 137, status: "success"
        });
        assert.strictEqual(run.odataPages, 2, "two pages counted");
        assert.strictEqual(run.odataOperations, 1, "one logical operation counted");
        assert.strictEqual(run.odataRecords, 8450, "records accumulated");
        var joined = captured.join("\n");
        assert.ok(/page 1: .*records=100.*continuation=yes/.test(joined), "page 1 logged with continuation");
        assert.ok(/page 2: .*records=50.*continuation=no/.test(joined), "page 2 logged without continuation");
        assert.ok(/readSourceRows.*records=8450.*chunks=18 \(size 8, concurrency 3\)/.test(joined),
            "operation summary logged with chunk info");
    });

    QUnit.test("enabled: failed operations counted and logged as failures", function (assert) {
        perf.setEnabledForTest(true);
        var run = perf.beginReportRun("CURRENT_MONTH", {});
        perf.logODataOperation(run, { label: "readParents", entity: "/Z_C_ELECR_VALIDATE", durationMs: 10, records: 0, status: "failed" });
        perf.logError(run, "readParents", new Error("500 Internal Server Error"));
        assert.strictEqual(run.failedOperations, 1, "failed operation counted");
        var joined = captured.join("\n");
        assert.ok(/status=failed/.test(joined), "failure status logged");
        assert.ok(/FAILED: 500 Internal Server Error/.test(joined), "safe error message logged");
    });

    QUnit.test("enabled: source chunk counters reconcile", function (assert) {
        perf.setEnabledForTest(true);
        var run = perf.beginReportRun("CURRENT_MONTH", {});
        perf.logODataChunk(run, { chunkIndex: 1, chunkTotal: 2, positions: 8, records: 470, durationMs: 610, status: "success" });
        perf.logODataChunk(run, { chunkIndex: 2, chunkTotal: 2, positions: 5, records: 512, durationMs: 720, status: "success" });
        assert.strictEqual(run.sourceChunks, 2, "two chunks counted");
        assert.strictEqual(run.sourceChunkRecords, 982, "chunk records accumulated (470+512)");
    });

    QUnit.test("run counters do not leak into subsequent runs", function (assert) {
        perf.setEnabledForTest(true);
        var run1 = perf.beginReportRun("CURRENT_MONTH", {});
        perf.logODataOperation(run1, { label: "readParents", records: 10, durationMs: 5, status: "success" });
        perf.endReportRun(run1, "success");
        var run2 = perf.beginReportRun("CURRENT_MONTH", {});
        assert.notStrictEqual(run1.runId, run2.runId, "unique run ids");
        assert.strictEqual(run2.odataOperations, 0, "fresh counters for the new run");
        assert.strictEqual(run2.odataRecords, 0, "fresh record counter");
        perf.endReportRun(run2, "success");
    });

    QUnit.test("stage timers log durations and counts", function (assert) {
        perf.setEnabledForTest(true);
        var run = perf.beginReportRun("CURRENT_MONTH", {});
        var timer = perf.startStage(run, "Build source index", { rows: 8450 });
        perf.endStage(timer, { positions: 137 });
        var joined = captured.join("\n");
        assert.ok(/Build source index: .*ms \(rows=8450, positions=137\)/.test(joined),
            "stage duration and counts logged: " + joined);
    });

    QUnit.test("logs never contain payloads, formulas or credentials", function (assert) {
        perf.setEnabledForTest(true);
        var run = perf.beginReportRun("FORMULA_TEST", { plant: "2010", pos: "bE125" });
        perf.logODataOperation(run, {
            label: "readParents", entity: "/Z_C_ELECR_VALIDATE", durationMs: 100,
            records: 250, status: "success"
        });
        perf.logError(run, "readParents", new Error("401 Unauthorized"));
        var joined = captured.join("\n");
        assert.ok(!/Formula|P\(/.test(joined), "no formula text in logs");
        assert.ok(!/Authorization|Cookie|token/i.test(joined), "no credentials in logs");
        assert.ok(!/results|__next/.test(joined), "no payloads or continuation URLs in logs");
    });
});