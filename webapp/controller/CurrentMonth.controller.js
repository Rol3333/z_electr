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
    "zelectr/formatter/numberFormatter",
    "sap/m/MessageBox",
    "sap/m/Dialog",
    "sap/m/VBox",
    "sap/m/Label",
    "sap/m/Input",
    "sap/m/CheckBox",
    "sap/m/Button"
], function (Controller, UIComponent, JSONModel, positionReportService,
    numberFormatter, MessageBox, Dialog, VBox, Label, Input, CheckBox, Button) {
    "use strict";

    return Controller.extend("zelectr.controller.CurrentMonth", {

        onInit: function () {
            this._reportService = positionReportService.createReportService(
                this.getOwnerComponent().getModel());
            this._viewModel = new JSONModel({
                rows: [],
                rangeText: "",
                latestDateText: "",
                provisionalText: "",
                capabilityText: "",
                kpiText: "",
                zeroFilterText: "",
                hasPastMeasurement: false
            });
            this.getView().setModel(this._viewModel, "vm");
            this._rows = [];
            this._showZero = false;

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
                contentWidth: "24rem",
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
            this._promptDialog.open();
        },

        onRefresh: function () {
            var self = this;
            var oView = this.getView();

            // parse the period parameter: year.month (e.g. 2026.04 or 2026.4)
            var sPeriod = (this._periodInput.getValue() || "").trim();
            var year, month;
            var m = /^(\d{4})[.\-/](\d{1,2})$/.exec(sPeriod);
            if (m) {
                year = parseInt(m[1], 10);
                month = parseInt(m[2], 10);
            } else {
                var now = new Date();
                year = now.getFullYear();
                month = now.getMonth() + 1;
                this._periodInput.setValue(year + "." + String(month).padStart(2, "0"));
            }
            if (!year || !month || month < 1 || month > 12) {
                MessageBox.warning(this._text("cmInvalidPeriod"));
                return;
            }
            this._showZero = this._zeroCheckBox.getSelected();

            oView.setBusy(true);
            this._reportService.buildCurrentMonthReport({ year: year, month: month })
                .then(function (report) {
                    self._rows = report.rows;
                    self._present(report);
                    oView.setBusy(false);
                })
                .catch(function (err) {
                    oView.setBusy(false);
                    MessageBox.error("Monthly report failed\n" +
                        (err && err.message ? err.message : err));
                });
        },

        _present: function (report) {
            var fmt = numberFormatter;
            var caps = report.caps || {};
            var self = this;

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
                    formulaShort: r.formula && r.formula.length > 60
                        ? r.formula.substring(0, 60) + "…" : (r.formula || "—"),
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

            this._viewModel.setProperty("/rows", rows);
            this._viewModel.setProperty("/hasPastMeasurement", !!caps.pastMeasurement);
            this._viewModel.setProperty("/rangeText", "Period: " + report.rangeStart + " … " + report.rangeEnd);
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
