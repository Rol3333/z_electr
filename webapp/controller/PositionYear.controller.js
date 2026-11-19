/*!
 * zelectr/controller/PositionYear.controller.js
 *
 * Report 2 - "Position - 12-month overview" (brief section 4):
 * one selected position across all 12 months of a selected year, with the
 * four calculation variants (JS/ABAP x adjusted/suggested), empty months
 * kept visible, and a per-month component comparison detail panel.
 * Directly addressable via #year-report/{pos} and from its own FLP tile
 * (report=yearReport&pos=...).
 *
 * A prompt dialog collects the parameters (Position, Year) plus a
 * "Show notes" checkbox (default off): when off, the Notes column is not
 * populated/hidden. The dialog opens on entering the report (prefilled when
 * navigated from the Monthly report) and via the Parameters header button.
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

    return Controller.extend("zelectr.controller.PositionYear", {

        onInit: function () {
            this._reportService = positionReportService.createReportService(
                this.getOwnerComponent().getModel());
            this._viewModel = new JSONModel({
                months: [],
                headerText: "",
                provisionalText: "",
                capabilityText: "",
                hasDetail: false,
                showNotes: false,
                detail: {}
            });
            this.getView().setModel(this._viewModel, "vm");
            this._months = [];
            this._showNotes = false;

            this._createPromptDialog();

            var oRouter = UIComponent.getRouterFor(this);
            oRouter.getRoute("RouteYearReport").attachPatternMatched(this._onRouteMatched, this);
            oRouter.getRoute("RouteYearReportPos").attachPatternMatched(this._onRouteMatched, this);
        },

        _createPromptDialog: function () {
            var self = this;
            this._posInput = new Input({ maxLength: 15, width: "12rem", placeholder: this._text("positionPlaceholder") });
            this._yearInput = new Input({ type: "Number", width: "8rem" });
            this._notesCheckBox = new CheckBox({ text: this._text("pyShowNotes") });
            var oContent = new VBox({
                items: [
                    new Label({ text: this._text("pyPosition"), labelFor: this._posInput }),
                    this._posInput,
                    new Label({ text: this._text("pyYear"), labelFor: this._yearInput }),
                    this._yearInput,
                    this._notesCheckBox
                ]
            });
            oContent.addStyleClass("zePromptContent");
            this._promptDialog = new Dialog({
                title: this._text("pyPromptTitle"),
                contentWidth: "34rem",
                contentHeight: "16rem",
                content: oContent,
                beginButton: new Button({
                    text: this._text("dlgRun"),
                    type: "Emphasized",
                    press: function () { self._promptDialog.close(); self.onLoad(); }
                }),
                endButton: new Button({
                    text: this._text("dlgCancel"),
                    press: function () { self._promptDialog.close(); }
                })
            });
            this.getView().addDependent(this._promptDialog);
        },

        _onRouteMatched: function (oEvent) {
            var mArgs = oEvent.getParameters().arguments || {};
            var sPos = mArgs.pos ? decodeURIComponent(mArgs.pos) : "";
            if (sPos) {
                this._posInput.setValue(sPos);
            }
            if (!this._yearInput.getValue()) {
                this._yearInput.setValue(String(new Date().getFullYear()));
            }
            // start the always-on user-perceived statistics stopwatch at the
            // moment the prompt window is populated
            this._beginStats("prompt");
            // open the prompt (prefilled when navigated from the Monthly report)
            this._promptDialog.open();
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
            this._stats = perf.beginUserAction("YEAR_REPORT", trigger);
        },

        onLoad: function () {
            var self = this;
            var oView = this.getView();
            // read the Selection panel inputs; when the report is started from
            // the prompt dialog (Run button), fall back to the prompt inputs
            var sPos = (oView.byId("pyPosInput").getValue() || "").trim();
            var sYear = (oView.byId("pyYearInput").getValue() || "").trim();
            if ((!sPos || !sYear) && this._posInput) {
                sPos = (this._posInput.getValue() || "").trim();
                sYear = (this._yearInput.getValue() || "").trim();
            }
            var year = parseInt(sYear, 10);

            if (!sPos || !sYear || isNaN(year) || year < 1900 || year > 2200) {
                if (this._stats) {
                    perf.endUserAction(this._stats, "failed");
                    this._stats = null;
                }
                MessageBox.warning(this._text("pyMissingInput"));
                return;
            }
            // keep both entry points in sync with the effective values
            oView.byId("pyPosInput").setValue(sPos);
            oView.byId("pyYearInput").setValue(sYear);
            this._posInput.setValue(sPos);
            this._yearInput.setValue(sYear);
            this._showNotes = this._notesCheckBox.getSelected();
            this._viewModel.setProperty("/showNotes", this._showNotes);

            var run = perf.beginReportRun("YEAR_REPORT", { plant: "2010", pos: sPos, year: year });
            // stats stopwatch: reuse the prompt-opened token when present,
            // otherwise start at this refresh press
            var stats = this._stats || perf.beginUserAction("YEAR_REPORT", "refresh");
            this._stats = stats;
            perf.markUserAction(stats, "run_pressed");

            // clear stale data before new requests are issued
            this._viewModel.setProperty("/months", []);
            this._viewModel.setProperty("/hasResults", false);
            this._viewModel.setProperty("/headerInfo", {});
            this._viewModel.setProperty("/hasDetail", false);
            this._viewModel.setProperty("/detail", {});
            this._months = [];
            oView.setBusy(true);
            this._reportService.buildYearReport({ pos: sPos, year: year })
                .then(function (report) {
                    self._months = report.months;
                    perf.markUserAction(stats, "data_loaded");
                    self._present(report);
                    perf.endReportRun(run, "success", { outputRows: report.months.length });
                    oView.setBusy(false);
                    // log the stats line once the final report is rendered
                    perf.endUserActionWhenRendered(stats, "success", { rows: report.months.length });
                    self._stats = null;
                })
                .catch(function (err) {
                    perf.endReportRun(run, "failed");
                    perf.endUserAction(stats, "failed");
                    self._stats = null;
                    oView.setBusy(false);
                    MessageBox.error("Year report failed\n" +
                        (err && err.message ? err.message : err));
                });
        },

        _present: function (report) {
            var fmt = numberFormatter;
            var caps = report.caps || {};
            var self = this;

            var months = report.months.map(function (m) {
                return {
                    monthLabel: m.monthLabel,
                    adjJs: m.adjJs === "" ? "" : fmt.formatDiagnostic(m.adjJs),
                    sugJs: m.sugJs === "" ? "" : fmt.formatDiagnostic(m.sugJs),
                    adjAbap: m.adjAbap === "" ? "" : fmt.formatDiagnostic(m.adjAbap),
                    sugAbap: m.sugAbap === "" ? "" : fmt.formatDiagnostic(m.sugAbap),
                    uom: m.uom || "",
                    pastMeasurement: m.pastMeasurement == null ? "—" : m.pastMeasurement,
                    status: m.status,
                    state: m.state,
                    // "Show notes" off -> the Notes column is not populated
                    notesText: self._showNotes ? m.notes.join(" | ") : ""
                };
            });
            this._viewModel.setProperty("/months", months);
            this._viewModel.setProperty("/hasResults", months.length > 0);
            this._viewModel.setProperty("/headerText",
                report.header.pos + " - " + report.header.year);

            // sync the Selection panel + prompt inputs with the canonical
            // values from the report (e.g. case-insensitive match bE125)
            var oView = this.getView();
            if (oView.byId("pyPosInput")) {
                oView.byId("pyPosInput").setValue(report.header.pos);
            }
            if (oView.byId("pyYearInput")) {
                oView.byId("pyYearInput").setValue(String(report.header.year));
            }
            this._posInput.setValue(report.header.pos);
            this._yearInput.setValue(String(report.header.year));

            // header context above the table: workshop, description, UOM and
            // the latest available formula (months are chronological, so the
            // last non-empty formula is the most recent one)
            var latestFormula = "";
            report.months.forEach(function (m) {
                if (m.formula) {
                    latestFormula = m.formula;
                }
            });
            this._viewModel.setProperty("/headerInfo", {
                workshop: report.header.workshop || "",
                descr: report.header.descr || "",
                uom: report.header.uom || "",
                formula: latestFormula
            });
            this._viewModel.setProperty("/provisionalText",
                "PROVISIONAL - P() rule not verified");

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

        onMonthSelected: function (oEvent) {
            var oCtx = oEvent.getParameter("listItem").getBindingContext("vm");
            if (!oCtx) {
                return;
            }
            var sMonthLabel = oCtx.getProperty("monthLabel");
            var row = null;
            for (var i = 0; i < this._months.length; i++) {
                if (this._months[i].monthLabel === sMonthLabel) {
                    row = this._months[i];
                    break;
                }
            }
            if (!row || !row.detail) {
                this._viewModel.setProperty("/hasDetail", false);
                this._viewModel.setProperty("/detail", {});
                return;
            }
            this._viewModel.setProperty("/detail", this._presentDetail(row));
            this._viewModel.setProperty("/hasDetail", true);
        },

        _presentDetail: function (row) {
            var detail = row.detail;
            var parse = detail.parseStatus === "SUPPORTED"
                ? this._text("parseOk")
                : this._text("parseNotSupported") + " (" + detail.parseStatus + ")";

            var differences = (detail.comparison && detail.comparison.differences) || [];
            var diffBySeq = {};
            differences.forEach(function (d) {
                if (!diffBySeq[d.seq]) {
                    diffBySeq[d.seq] = [];
                }
                diffBySeq[d.seq].push(d.field);
            });

            var max = Math.max(
                detail.jsTerms ? detail.jsTerms.length : 0,
                detail.abapComponents ? detail.abapComponents.length : 0);
            var comparison = [];
            for (var i = 1; i <= max; i++) {
                var js = detail.jsTerms ? detail.jsTerms[i - 1] : null;
                var ab = detail.abapComponents ? detail.abapComponents[i - 1] : null;
                var fields = diffBySeq[i] || [];
                comparison.push({
                    seq: i,
                    jsSign: js ? js.sign : "-",
                    jsRefPosition: js ? js.refPosition : "-",
                    jsMultiplier: js ? js.multiplier.toString() : "-",
                    jsDivisor: js ? js.divisor.toString() : "-",
                    backendSign: ab ? (ab.sign || "") : "-",
                    backendRefPosition: ab ? (ab.refPosition || "") : "-",
                    backendMultiplier: ab && ab.multiplier ? ab.multiplier.toString() : "-",
                    backendDivisor: ab && ab.divisor ? ab.divisor.toString() : "-",
                    matchText: fields.length === 0 ? this._text("cmpMatch") : fields.join(", "),
                    matchState: fields.length === 0 ? "Success" : "Error"
                });
            }

            return {
                formula: detail.formula || "",
                parseText: parse,
                comparison: comparison
            };
        },

        /**
         * Exports the 12 monthly rows the user sees (Notes included only
         * when the "Show notes" option is set) to an Excel-compatible CSV.
         */
        onExportExcel: function () {
            var columns = [
                { label: this._text("colMonth"), key: "monthLabel" },
                { label: this._text("colAdjJs"), key: "adjJs" },
                { label: this._text("colSugJs"), key: "sugJs" },
                { label: this._text("colAdjAbap"), key: "adjAbap" },
                { label: this._text("colSugAbap"), key: "sugAbap" },
                { label: this._text("colPastMeasurement"), key: "pastMeasurement" },
                { label: this._text("colUom"), key: "uom" },
                { label: this._text("colStatus"), key: "status" }
            ];
            if (this._showNotes) {
                columns.push({ label: this._text("colNotes"), key: "notesText" });
            }
            var sPos = (this._posInput.getValue() || "").trim();
            var sYear = (this._yearInput.getValue() || "").trim();
            exportHelper.exportCsv("year-report_" + sPos + "_" + sYear, columns, this._months || []);
        },

        _text: function (sKey) {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey);
        },

        onNavBack: function () {
            var oHistory = sap.ui.core.routing.History.getInstance();
            var sPreviousHash = oHistory.getPreviousHash();
            if (sPreviousHash !== undefined) {
                window.history.go(-1);
            } else {
                UIComponent.getRouterFor(this).navTo("RouteView1", {}, true);
            }
        },

        onNavFormulaTest: function () {
            UIComponent.getRouterFor(this).navTo("RouteFormulaTest", {}, true);
        },

        onNavCurrentMonth: function () {
            UIComponent.getRouterFor(this).navTo("RouteCurrentMonth", {}, true);
        },

        onNavYearReport: function () {
            UIComponent.getRouterFor(this).navTo("RouteYearReport", {}, true);
        }
    });
});
