/*!
 * zelectr/formatter/exportHelper.js
 *
 * Client-side export of the data displayed in the reports to a CSV file
 * that Excel opens natively. No backend writes, no new dependencies.
 *
 * Format choices (Excel-friendly):
 *   - UTF-8 BOM so Excel detects the encoding correctly;
 *   - semicolon field separator (correct for comma-decimal locales such as
 *     Lithuanian; every field is quoted, so embedded separators/newlines
 *     are safe);
 *   - decimal values keep the dot notation used across the app.
 */
sap.ui.define([], function () {
    "use strict";

    function escapeCsv(value) {
        var s = value === null || value === undefined ? "" : String(value);
        return '"' + s.replace(/"/g, '""') + '"';
    }

    /**
     * Exports rows to a CSV download.
     *
     * @param {string} fileName file name without extension
     * @param {object[]} columns [{ label, key }]
     * @param {object[]} rows array of row objects
     */
    function exportCsv(fileName, columns, rows) {
        var lines = [];
        lines.push(columns.map(function (c) { return escapeCsv(c.label); }).join(";"));
        (rows || []).forEach(function (row) {
            lines.push(columns.map(function (c) {
                return escapeCsv(row[c.key]);
            }).join(";"));
        });
        // BOM prefix: Excel opens UTF-8 CSV with correct characters
        var csv = "﻿" + lines.join("\r\n");

        if (typeof document === "undefined" || typeof Blob === "undefined" ||
            typeof URL === "undefined" || !URL.createObjectURL) {
            // non-browser environment (tests): no download possible
            return csv;
        }
        var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var link = document.createElement("a");
        link.href = url;
        link.download = fileName + ".csv";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        return csv;
    }

    return {
        exportCsv: exportCsv
    };
});