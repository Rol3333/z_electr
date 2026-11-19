/*!
 * zelectr/controller/CurrentMonth.controller.js
 *
 * Report 1 - "Monthly" (all positions, one month). Directly addressable via
 * #current-month and from its own FLP tile.
 *
 * A prompt dialog collects the report parameters:
 *   - Period as year.month (e.g. 2026.04); defaults to the current month.
 *   - Checkbox "Show positions with 0 amount" (default off): when off,
 *     positions whose adjusted AND suggested quantities are 0/empty for the
 *     period are filtered out of the report.
 * A Parameters button in the header reopens the dialog at any time.
 */
sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/UIComponent",
    "sap/ui/model/json/JSONModel",
    "zelectr/service/positionReportService",
    "zelectr/service/performanceDiagnostics",
    "zelectr/formatter/numberFormatter",
    "zelectr/formatter/exportHelper",
    "sap/m/MessageBox",
    "sap/m/Dialog",
    "sap/m/VBox",
    "sap/m/Label",
    "sap/m/Input",
    "sap/m/CheckBox",
    "sap/m/Button"
], function (Controller, UIComponent, JSONModel, positionReportService, perf,
    numberFormatter, exportHelper, MessageBox, Dialog, VBox, Label, Input, CheckBox, Button) {
    "use strict";

    return Controller.extend("zelectr.controller.CurrentMonth", {

        onInit: function () {
            this._reportService = positionReportService.createReportService(
                this.getOwnerComponent().getModel());
            this._viewModel = new JSONModel({
                rows: [],
                rangeText: "",
                refreshText: "",
                latestDateText: "",
                provisionalText: "",
                capabilityText: "",
                kpiText: "",
                zeroFilterText: "",
                hasPastMeasurement: false,
                hasResults: false
            });
            this.getView().setModel(this._viewModel, "vm");
            this._rows = [];
            this._showZero = false;

            // prefill the Selection panel period with the current month
            var now = new Date();
            this.byId("cmPeriodInput").setValue(
                now.getFullYear() + "." + String(now.getMonth() + 1).padStart(2, "0"));

            this._createPromptDialog();

            // open the prompt every time the report is entered (same proven
            // mechanism as the 12-month overview: route matched -> dialog)
            UIComponent.getRouterFor(this)
                .getRoute("RouteCurrentMonth")
                .attachPatternMatched(this._onRouteMatched, this);
        },

        /**
         * Opens the prompt when the report route is matched (direct URL,
         * nav strip or FLP tile). The open is deferred with setTimeout so it
         * runs after the navigation transition starts; the dialog renders
         * itself into the static UI area, so the view state does not matter.
         */
        _onRouteMatched: function () {
            var self = this;
            // start the always-on user-perceived statistics stopwatch at the
            // moment the prompt window is populated
            this._beginStats("prompt");
            setTimeout(function () {
                try {
                    if (self._promptDialog && !self._promptDialog.isOpen()) {
                        self._promptDialog.open();
                    }
                } catch (e) {
                    console.error("Failed to open the Monthly report prompt", e);
                }
            }, 0);
        },

        _createPromptDialog: function () {
            var self = this;
            this._periodInput = new Input({ width: "8rem", placeholder: "YYYY.MM" });
            this._zeroCheckBox = new CheckBox({ text: this._text("cmShowZero") });
            var oContent = new VBox({
                items: [
                    new Label({ text: this._text("cmPeriodLabel"), labelFor: this._periodInput }),
                    this._periodInput,
                    new Label({ text: this._text("cmPeriodHint") }),
                    this._zeroCheckBox
                ]
            });
            oContent.addStyleClass("zePromptContent");
            this._promptDialog = new Dialog({
                title: this._text("cmPromptTitle"),
                contentWidth: "34rem",
                contentHeight: "14rem",
                content: oContent,
                beginButton: new Button({
                    text: this._text("dlgRun"),
                    type: "Emphasized",
                    press: function () { self._promptDialog.close(); self.onRefresh(); }
                }),
                endButton: new Button({
                    text: this._text("dlgCancel"),
                    press: function () { self._promptDialog.close(); }
                })
            });
            this.getView().addDependent(this._promptDialog);
        },

        onOpenPrompt: function () {
            this._beginStats("prompt");
            this._promptDialog.open();
        },

        /**
         * Starts (or restarts) the always-on report statistics stopwatch.
         * An already-running stopwatch is closed as "aborted" first.
         *
         * @param {string} trigger "prompt" | "refresh"
         */
        _beginStats: function (trigger) {
            if (this._stats) {
                perf.endUserAction(this._stats, "aborted");
            }
            this._stats = perf.beginUserAction("CURRENT_MONTH", trigger);
        },

        onRefresh: function () {
            var self = this;
            var oView = this.getView();

            // read the Selection panel inputs; when the report is started from
            // the prompt dialog (Run button), fall back to the prompt inputs
            var sPeriod = (oView.byId("cmPeriodInput").getValue() || "").trim();
            var bZero = oView.byId("cmZeroCheck").getSelected();
            if (!sPeriod && this._periodInput) {
                sPeriod = (this._periodInput.getValue() || "").trim();
                bZero = this._zeroCheckBox.getSelected();
            }

            // parse the period parameter: year.month (e.g. 2026.04 or 2026.4)
            var year, month;
            var m = /^(\d{4})[.\-/](\d{1,2})$/.exec(sPeriod);
            if (m) {
                year = parseInt(m[1], 10);
                month = parseInt(m[2], 10);
            } else {
                var now = new Date();
                year = now.getFullYear();
                month = now.getMonth() + 1;
                sPeriod = year + "." + String(month).padStart(2, "0");
            }
            if (!year || !month || month < 1 || month > 12) {
                MessageBox.warning(this._text("cmInvalidPeriod"));
                return;
            }
            // keep both entry points in sync with the effective values
            oView.byId("cmPeriodInput").setValue(sPeriod);
            oView.byId("cmZeroCheck").setSelected(bZero);
            this._periodInput.setValue(sPeriod);
            this._zeroCheckBox.setSelected(bZero);
            this._showZero = bZero;

            var run = perf.beginReportRun("CURRENT_MONTH", {
                plant: "2010",
                period: year + "-" + String(month).padStart(2, "0")
            });
            // stats stopwatch: reuse the prompt-opened token when present,
            // otherwise start at this refresh press
            var stats = this._stats || perf.beginUserAction("CURRENT_MONTH", "refresh");
            this._stats = stats;
            perf.markUserAction(stats, "run_pressed");
            oView.setBusy(true);
            this._reportService.buildCurrentMonthReport({ year: year, month: month })
                .then(function (report) {
                    self._rows = report.rows;
                    perf.markUserAction(stats, "data_loaded");
                    self._present(report);
                    perf.endReportRun(run, "success", { outputRows: report.rows.length });
                    oView.setBusy(false);
                    // log the stats line once the final report is rendered
                    perf.endUserActionWhenRendered(stats, "success", { rows: report.rows.length });
                    self._stats = null;
                })
                .catch(function (err) {
                    perf.endReportRun(run, "failed");
                    perf.endUserAction(stats, "failed");
                    self._stats = null;
                    oView.setBusy(false);
                    MessageBox.error("Monthly report failed\n" +
                        (err && err.message ? err.message : err));
                });
        },

        _present: function (report) {
            var fmt = numberFormatter;
            var caps = report.caps || {};
            var self = this;

            console.table(report.rows.slice(0, 10).map(r => ({
                position: r.pos,
                workshop: r.workshop,
                description: r.descr
            })));

            var rows = report.rows.map(function (r) {
                return {
                    workshop: r.workshop || "",
                    pos: r.pos,
                    descr: r.descr || "",
                    adjJs: r.adjJs === "" ? "" : fmt.formatDiagnostic(r.adjJs),
                    sugJs: r.sugJs === "" ? "" : fmt.formatDiagnostic(r.sugJs),
                    adjAbap: r.adjAbap === "" ? "" : fmt.formatDiagnostic(r.adjAbap),
                    sugAbap: r.sugAbap === "" ? "" : fmt.formatDiagnostic(r.sugAbap),
                    uom: r.uom || "",
                    pastMeasurement: r.pastMeasurement == null ? "—" : r.pastMeasurement,
                    formula: r.formula || "",
                    formulaShort: r.formula && r.formula.length > 80
                        ? r.formula.substring(0, 80) + "…" : (r.formula || "—"),
                    status: r.status,
                    state: r.state,
                    notesText: r.notes.join(" | ")
                };
            });

            // zero-amount filter: when the checkbox is off, hide positions
            // whose adjusted AND suggested quantities are 0/empty for the period
            if (!this._showZero) {
                rows = rows.filter(function (r) {
                    return !self._isZeroRow(r);
                });
            }
            
            //tmp output to console for debugging
            console.table(rows.map(function (r) {
            return {
                Position: r.pos,
                Workshop: r.workshop,
                Description: r.descr
            };
            }));


            this._viewModel.setProperty("/rows", rows);
            this._viewModel.setProperty("/hasPastMeasurement", !!caps.pastMeasurement);
            this._viewModel.setProperty("/hasResults", true);
            this._viewModel.setProperty("/rangeText", "Period: " + report.rangeStart + " … " + report.rangeEnd);
            // last data refresh = the moment the report data was (re)loaded
            var d = new Date();
            var pad = function (n) { return String(n).padStart(2, "0"); };
            this._viewModel.setProperty("/refreshText",
                this._text("cmLastRefresh") + ": " +
                d.getFullYear() + "." + pad(d.getMonth() + 1) + "." + pad(d.getDate()) +
                " " + pad(d.getHours()) + ":" + pad(d.getMinutes()));
            this._viewModel.setProperty("/latestDateText", report.latestSourceDate
                ? "Latest source data: " + report.latestSourceDate
                : "No source data in period");
            this._viewModel.setProperty("/provisionalText", "PROVISIONAL - P() rule not verified");
            this._viewModel.setProperty("/kpiText",
                report.kpis.positions + " positions, " +
                report.kpis.withValues + " with values, " +
                report.kpis.withErrors + " with errors/warnings, " +
                report.kpis.noFormula + " without formula");
            this._viewModel.setProperty("/zeroFilterText", this._showZero
                ? this._text("cmZeroFilterOff")
                : this._text("cmZeroFilterOn"));

            var capNotes = [];
            if (!caps.metadataAvailable) {
                capNotes.push("Live service metadata not readable - optional fields unknown");
            } else {
                if (!caps.mainWorkshop) {
                    capNotes.push("MainWorkshop not exposed by the service");
                }
                if (!caps.posDescr) {
                    capNotes.push("Position description not exposed by the service");
                }
                if (caps.pastMeasurement) {
                    capNotes.push("PastMeasurement shown as reference only (business meaning unconfirmed)");
                }
            }
            this._viewModel.setProperty("/capabilityText", capNotes.join(" | "));
        },

        /** A row is a zero-amount row when all four variant values are empty or 0. */
        _isZeroRow: function (r) {
            var isBlankOrZero = function (v) {
                return v === "" || v === "—" || parseFloat(v) === 0;
            };
            return isBlankOrZero(r.adjJs) && isBlankOrZero(r.sugJs) &&
                isBlankOrZero(r.adjAbap) && isBlankOrZero(r.sugAbap);
        },

        onSearch: function () {
            var sQuery = (this.byId("searchField").getValue() || "").toLowerCase();
            var aFilters = [];
            if (sQuery) {
                ["pos", "workshop", "descr", "formula"].forEach(function (field) {
                    aFilters.push(new sap.ui.model.Filter({
                        path: field,
                        operator: sap.ui.model.FilterOperator.Contains,
                        value1: sQuery,
                        caseSensitive: false
                    }));
                });
            }
            var oBinding = this.byId("positionsTable").getBinding("items");
            oBinding.filter(aFilters.length ? new sap.ui.model.Filter({
                filters: aFilters,
                and: false
            }) : []);
        },

        onRowSelected: function (oEvent) {
            var oCtx = oEvent.getParameter("listItem").getBindingContext("vm");
            if (!oCtx) {
                return;
            }
            var sPos = oCtx.getProperty("pos");
            UIComponent.getRouterFor(this).navTo("RouteYearReportPos", { pos: encodeURIComponent(sPos) });
        },

        /**
         * Exports the data the user currently sees (zero-amount filter and
         * search applied) to an Excel-compatible CSV download.
         */
        onExportExcel: function () {
            var self = this;
            var columns = [
                { label: this._text("colWorkshop"), key: "workshop" },
                { label: this._text("colPos"), key: "pos" },
                { label: this._text("colPosDescr"), key: "descr" },
                { label: this._text("colAdjJs"), key: "adjJs" },
                { label: this._text("colSugJs"), key: "sugJs" },
                { label: this._text("colAdjAbap"), key: "adjAbap" },
                { label: this._text("colSugAbap"), key: "sugAbap" },
                { label: this._text("colUom"), key: "uom" },
                { label: this._text("colPastMeasurement"), key: "pastMeasurement" },
                { label: this._text("colFormula"), key: "formula" },
                { label: this._text("colStatus"), key: "status" },
                { label: this._text("colNotes"), key: "notesText" }
            ];
            // apply the same filters as the visible table: zero-amount
            // filter + search field
            var sQuery = (this.byId("searchField").getValue() || "").toLowerCase();
            var rows = (this._rows || []).filter(function (r) {
                if (!self._showZero && self._isZeroRow(r)) {
                    return false;
                }
                if (sQuery) {
                    var hay = [r.pos, r.workshop, r.descr, r.formula].join(" ").toLowerCase();
                    if (hay.indexOf(sQuery) < 0) {
                        return false;
                    }
                }
                return true;
            });
            var oView = this.getView();
            var sPeriod = (oView.byId("cmPeriodInput").getValue() || "").trim();
            if (!sPeriod) {
                sPeriod = (this._periodInput.getValue() || "").trim();
            }
            var period = sPeriod.replace(/[^0-9]/g, "");
            exportHelper.exportCsv("monthly-report_" + period, columns, rows);
        },

        onNavFormulaTest: function () {
            UIComponent.getRouterFor(this).navTo("RouteFormulaTest", {}, true);
        },

        onNavCurrentMonth: function () {
            UIComponent.getRouterFor(this).navTo("RouteCurrentMonth", {}, true);
        },

        onNavYearReport: function () {
            UIComponent.getRouterFor(this).navTo("RouteYearReport", {}, true);
        },

        _text: function (sKey) {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey);
        }
    });
});
