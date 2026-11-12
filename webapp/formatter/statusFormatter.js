/*!
 * zelectr/formatter/statusFormatter.js
 *
 * Maps internal statuses to business-readable labels and UI5 visual states
 * (brief section 10 status model). Neutral wording: no undocumented
 * tolerance, no "validated" claims for provisional results.
 */
sap.ui.define([], function () {
    "use strict";

    var STATUS_TEXT = {
        SUPPORTED: "SUPPORTED",
        UNSUPPORTED: "UNSUPPORTED",
        SYNTAX_ERROR: "SYNTAX ERROR",
        NO_FORMULA: "NO FORMULA",
        EMPTY: "NO FORMULA",
        PARSE_MISMATCH: "PARSE MISMATCH",
        MISSING_REFERENCE: "INCOMPLETE DATA",
        AMBIGUOUS_SOURCE: "AMBIGUOUS SOURCE",
        UOM_MISMATCH: "UOM MISMATCH",
        P_RULE_UNCONFIRMED: "P RULE NOT CONFIRMED",
        PROVISIONAL: "PROVISIONAL",
        CALCULATED: "CALCULATED",
        DIFFERENCE: "DIFFERENCE",
        MATCH: "MATCH",
        NOT_CALCULATED: "NOT CALCULATED",
        INCOMPLETE_DATA: "INCOMPLETE DATA",
        RESOLVED: "RESOLVED",
        NOT_RESOLVED: "NOT RESOLVED",
        AGGREGATED: "AGGREGATED",
        PARTIAL: "PARTIAL",
        NOT_AVAILABLE: "NOT AVAILABLE"
    };

    var STATUS_STATE = {
        SUPPORTED: "Success",
        UNSUPPORTED: "Warning",
        SYNTAX_ERROR: "Error",
        NO_FORMULA: "None",
        EMPTY: "None",
        PARSE_MISMATCH: "Error",
        MISSING_REFERENCE: "Warning",
        AMBIGUOUS_SOURCE: "Error",
        UOM_MISMATCH: "Error",
        P_RULE_UNCONFIRMED: "Warning",
        PROVISIONAL: "Information",
        CALCULATED: "Success",
        DIFFERENCE: "Warning",
        MATCH: "Success",
        NOT_CALCULATED: "None",
        INCOMPLETE_DATA: "Warning",
        RESOLVED: "Success",
        NOT_RESOLVED: "Warning",
        AGGREGATED: "Success",
        PARTIAL: "Warning",
        NOT_AVAILABLE: "None"
    };

    /**
     * Business-readable label for a status.
     *
     * @param {string} sStatus internal status
     * @returns {string} display label
     */
    function statusText(sStatus) {
        if (!sStatus) {
            return "";
        }
        return STATUS_TEXT[sStatus] || sStatus;
    }

    /**
     * UI5 visual state (ValueState / ObjectStatus state) for a status.
     *
     * @param {string} sStatus internal status
     * @returns {string} UI5 state ("Success", "Warning", "Error", "None", "Information")
     */
    function statusState(sStatus) {
        if (!sStatus) {
            return "None";
        }
        return STATUS_STATE[sStatus] || "None";
    }

    /**
     * Comparison label for the JS-vs-backend structural component check.
     *
     * @param {string} sStatus comparison status
     * @returns {string} display label
     */
    function comparisonText(sStatus) {
        if (sStatus === "MATCH") {
            return "Components match";
        }
        if (sStatus === "PARSE_MISMATCH") {
            return "Components differ";
        }
        if (sStatus === "NO_BACKEND_COMPONENTS") {
            return "No backend components";
        }
        return sStatus ? statusText(sStatus) : "";
    }

    return {
        statusText: statusText,
        statusState: statusState,
        comparisonText: comparisonText
    };
});
