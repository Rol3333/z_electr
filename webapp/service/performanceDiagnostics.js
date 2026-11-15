/*!
 * zelectr/service/performanceDiagnostics.js
 *
 * Client-side performance diagnostics for the Electricity Counter reports
 * (see tasks/003/Fiori_Performance_Diagnostics_Agent_Brief.md).
 *
 * Observational only: this module never changes data retrieval or
 * calculation behaviour. When disabled (the default), every helper is a
 * no-op with negligible overhead and nothing is printed to the console.
 *
 * Central switch:
 *   - default: disabled;
 *   - enable per browser session with the URL flag BEFORE the hash:
 *       index.html?debugPerf=1#/current-month
 *     (the flag is read once at module load; no persistent storage).
 *
 * Console format:
 *   [PERF][run-0007][CURRENT_MONTH] ...   - report run / JS stages
 *   [ODATA][run-0007] ...                 - OData logical operations,
 *                                           pages and chunks
 *
 * Timing rules (per the brief):
 *   - durations use performance.now() (monotonic), never wall-clock Date;
 *   - wall-clock ISO timestamps are for humans only;
 *   - every run has a unique run ID;
 *   - stage timers are closed in finally blocks by the callers.
 *
 * Privacy: never log payloads, formulas, quantities, credentials, cookies
 * or full request URLs - only counts, durations, statuses and safe labels.
 */
sap.ui.define([], function () {
    "use strict";

    /**
     * Central feature switch. Enabled only via the URL flag ?debugPerf=1
     * (any value other than "0"/"false" counts as enabled when the
     * parameter is present).
     */
    var ENABLED = (function () {
        try {
            var sSearch = (typeof window !== "undefined" && window.location && window.location.search) || "";
            var m = /[?&]debugPerf=([^&]*)/.exec(sSearch);
            if (!m) {
                return false;
            }
            var v = decodeURIComponent(m[1]).toLowerCase();
            return v !== "0" && v !== "false" && v !== "no";
        } catch (e) {
            return false;
        }
    })();

    var runCounter = 0;
    // current run, set by beginReportRun/endReportRun - lets shared
    // modules (odataService) log without explicit run plumbing
    var currentRun = null;
    // test-only override (null = use the URL flag); keeps one central
    // production switch while allowing deterministic unit tests
    var enabledOverride = null;

    function now() {
        if (typeof performance !== "undefined" && performance.now) {
            return performance.now();
        }
        return Date.now(); // fallback for very old environments
    }

    function isEnabled() {
        if (enabledOverride !== null) {
            return enabledOverride;
        }
        return ENABLED;
    }

    /**
     * Test-only hook: force diagnostics on/off regardless of the URL flag.
     * Not used by the application at runtime.
     *
     * @param {boolean|null} value true/false to override, null to restore
     */
    function setEnabledForTest(value) {
        enabledOverride = (value === null || value === undefined) ? null : !!value;
        currentRun = null;
    }

    function prefix(runId, reportName) {
        return "[PERF][" + runId + "][" + reportName + "]";
    }

    /**
     * Starts a report run.
     *
     * @param {string} reportName e.g. CURRENT_MONTH, YEAR_REPORT, FORMULA_TEST
     * @param {object} [context] safe summary values (plant, period, pos, year)
     * @returns {object|null} run context, or null when disabled
     */
    function beginReportRun(reportName, context) {
        if (!isEnabled()) {
            return null;
        }
        runCounter++;
        var runId = "run-" + String(runCounter).padStart(4, "0");
        var run = {
            runId: runId,
            reportName: reportName,
            startTime: now(),
            startWall: new Date().toISOString(),
            context: context || {},
            odataOperations: 0,
            odataPages: 0,
            odataRecords: 0,
            sourceChunks: 0,
            sourceChunkRecords: 0,
            failedOperations: 0,
            stages: []
        };
        currentRun = run;
        console.groupCollapsed("%c" + prefix(runId, reportName) + " REPORT LOAD START",
            "font-weight: bold;");
        console.info(prefix(runId, reportName) + " Started " + run.startWall +
            (context ? " | Context: " + safeContext(context) : ""));
        return run;
    }

    function safeContext(context) {
        return Object.keys(context || {}).map(function (k) {
            return k + "=" + context[k];
        }).join(", ");
    }

    /**
     * Ends a report run and prints the terminal summary.
     *
     * @param {object} run run context from beginReportRun
     * @param {string} outcome "success" | "failed" | "aborted"
     * @param {object} [details] safe extra counters (e.g. outputRows)
     */
    function endReportRun(run, outcome, details) {
        if (!isEnabled() || !run) {
            return;
        }
        if (currentRun === run) {
            currentRun = null;
        }
        var totalMs = now() - run.startTime;
        var d = details || {};
        console.info(prefix(run.runId, run.reportName) +
            " Total wall time: " + totalMs.toFixed(1) + " ms");
        console.info(prefix(run.runId, run.reportName) +
            " OData logical operations: " + run.odataOperations +
            " | pages: " + run.odataPages +
            " | records: " + run.odataRecords +
            " | source chunks: " + run.sourceChunks +
            " | source chunk records: " + run.sourceChunkRecords +
            " | failed operations: " + run.failedOperations +
            (d.outputRows !== undefined ? " | output rows: " + d.outputRows : "") +
            " | outcome: " + outcome);
        console.groupEnd();
    }

    /**
     * Starts a named JS processing stage.
     *
     * @param {object} run run context
     * @param {string} stageName
     * @param {object} [details] safe extra values (counts)
     * @returns {object|null} timer to pass to endStage
     */
    function startStage(run, stageName, details) {
        if (!isEnabled() || !run) {
            return null;
        }
        return {
            run: run,
            stageName: stageName,
            startTime: now(),
            details: details || {}
        };
    }

    /**
     * Ends a stage timer and logs its duration.
     *
     * @param {object} timer from startStage
     * @param {object} [details] additional safe values (counts, outcome)
     */
    function endStage(timer, details) {
        if (!isEnabled() || !timer) {
            return;
        }
        var ms = now() - timer.startTime;
        var d = Object.assign({}, timer.details, details || {});
        var counts = Object.keys(d).map(function (k) {
            return k + "=" + d[k];
        }).join(", ");
        console.info(prefix(timer.run.runId, timer.run.reportName) +
            " " + timer.stageName + ": " + ms.toFixed(1) + " ms" +
            (counts ? " (" + counts + ")" : ""));
    }

    /**
     * Logs one OData page (inside readAll).
     */
    function logODataPage(run, details) {
        run = run || currentRun;
        if (!isEnabled() || !run) {
            return;
        }
        run.odataPages++;
        var d = details || {};
        console.info("[ODATA][" + run.runId + "] page " + d.pageIndex +
            ": " + (d.durationMs !== undefined ? d.durationMs.toFixed(1) + " ms" : "?") +
            ", records=" + (d.records !== undefined ? d.records : "?") +
            ", continuation=" + (d.hasNext ? "yes" : "no") +
            ", status=" + (d.status || "success"));
    }

    /**
     * Logs one logical OData operation (readParents, readSourceRows, ...).
     */
    function logODataOperation(run, details) {
        run = run || currentRun;
        if (!isEnabled() || !run) {
            return;
        }
        run.odataOperations++;
        run.odataRecords += (details && details.records) || 0;
        if (details && details.status === "failed") {
            run.failedOperations++;
        }
        var d = details || {};
        console.info("[ODATA][" + run.runId + "] " + d.label +
            " | entity=" + (d.entity || "-") +
            " | duration=" + (d.durationMs !== undefined ? d.durationMs.toFixed(1) + " ms" : "?") +
            " | pages=" + (d.pages !== undefined ? d.pages : "-") +
            " | records=" + (d.records !== undefined ? d.records : "-") +
            (d.chunks !== undefined ? " | chunks=" + d.chunks + " (size " + d.chunkSize + ", concurrency " + d.concurrency + ")" : "") +
            (d.positions !== undefined ? " | unique positions=" + d.positions : "") +
            " | status=" + (d.status || "success"));
    }

    /**
     * Logs one source-position chunk.
     */
    function logODataChunk(run, details) {
        run = run || currentRun;
        if (!isEnabled() || !run) {
            return;
        }
        run.sourceChunks++;
        run.sourceChunkRecords += (details && details.records) || 0;
        var d = details || {};
        console.info("[ODATA][" + run.runId + "] chunk " + d.chunkIndex + "/" + d.chunkTotal +
            ": " + d.positions + " positions, " + d.records + " records, " +
            (d.durationMs !== undefined ? d.durationMs.toFixed(1) + " ms" : "?") +
            ", pages=" + (d.pages !== undefined ? d.pages : "-") +
            ", status=" + (d.status || "success"));
    }

    /**
     * Logs a safe error (never the payload).
     */
    function logError(run, label, error, details) {
        if (!isEnabled()) {
            return;
        }
        var runId = run ? run.runId : "run-????";
        var reportName = run ? run.reportName : "-";
        var msg = error && error.message ? error.message : String(error);
        console.error("[PERF][" + runId + "][" + reportName + "] " + label +
            " FAILED: " + msg +
            (details ? " | " + safeContext(details) : ""));
    }

    return {
        isEnabled: isEnabled,
        setEnabledForTest: setEnabledForTest,
        beginReportRun: beginReportRun,
        endReportRun: endReportRun,
        startStage: startStage,
        endStage: endStage,
        logODataPage: logODataPage,
        logODataOperation: logODataOperation,
        logODataChunk: logODataChunk,
        logError: logError
    };
});
