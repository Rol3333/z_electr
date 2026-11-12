/*!
 * zelectr/formatter/numberFormatter.js
 *
 * Display-boundary number formatting. Internal calculations keep exact
 * Decimal values; formatting happens only here, at the UI boundary.
 */
sap.ui.define([], function () {
    "use strict";

    var LOCALE_GROUPING = false; // keep diagnostic values ungrouped for easy copy/paste

    /**
     * Formats a value (Decimal, number, string or null) with a fixed number
     * of fractional digits. Null/undefined/empty renders as empty string -
     * never as "0" (brief 4.5: missing values must not look numeric).
     *
     * @param {object|number|string|null} v value to format
     * @param {number} [fractionDigits=3] fractional digits to display
     * @returns {string} formatted number or ""
     */
    function formatFixed(v, fractionDigits) {
        if (v === null || v === undefined || v === "") {
            return "";
        }
        var digits = fractionDigits === undefined ? 3 : fractionDigits;
        var s;
        if (v && typeof v === "object" && typeof v.toString === "function" && v.mantissa !== undefined) {
            s = v.toString(); // exact Decimal string
        } else {
            s = String(v);
        }
        if (s === "" || isNaN(parseFloat(s))) {
            return s;
        }
        var neg = s.charAt(0) === "-";
        if (neg) {
            s = s.substring(1);
        }
        var parts = s.split(".");
        var intPart = parts[0] || "0";
        var fracPart = parts[1] || "";
        while (fracPart.length < digits) {
            fracPart += "0";
        }
        fracPart = fracPart.substring(0, digits);
        var out = intPart + (digits > 0 ? "." + fracPart : "");
        return (neg ? "-" : "") + out;
    }

    /**
     * Diagnostic formatting with six fractional digits (brief 3.1).
     *
     * @param {object|number|string|null} v value to format
     * @returns {string} formatted with 6 fractional digits or ""
     */
    function formatDiagnostic(v) {
        return formatFixed(v, 6);
    }

    /**
     * Standard quantity display with three decimals (the stored scale).
     *
     * @param {object|number|string|null} v value to format
     * @returns {string} formatted with 3 fractional digits or ""
     */
    function formatQuantity(v) {
        return formatFixed(v, 3);
    }

    /**
     * Formats a multiplier/divisor coefficient without forced decimals
     * (exact representation, e.g. "20", "0.66", "1000").
     *
     * @param {object|number|string|null} v value to format
     * @returns {string} exact decimal string or ""
     */
    function formatCoefficient(v) {
        if (v === null || v === undefined || v === "") {
            return "";
        }
        if (v && typeof v === "object" && v.mantissa !== undefined) {
            return v.toString();
        }
        return String(v);
    }

    return {
        formatFixed: formatFixed,
        formatDiagnostic: formatDiagnostic,
        formatQuantity: formatQuantity,
        formatCoefficient: formatCoefficient,
        LOCALE_GROUPING: LOCALE_GROUPING
    };
});
