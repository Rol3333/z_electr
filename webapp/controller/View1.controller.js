/*!
 * zelectr/controller/View1.controller.js
 *
 * Orchestrates the diagnostic workflow (brief section 8):
 *   1. read parent rows (Z_C_ELECR_VALIDATE) for plant/position/month
 *   2. read backend components (Z_C_ELECR_VALIDATE_REF)
 *   3. parse each distinct formula with the independent JS parser
 *   4. collect distinct reference positions
 *   5. read source rows (Z_I_ELECR_CNTR) for those positions
 *   6. resolve references with the selected (provisional) strategy
 *   7. calculate, compare with stored values, compare parses structurally
 *   8. present everything from a local JSON model (read-only UI)
 *
 * Results are cached for the current selection; changing the selection
 * clears stale data before new requests are issued.
 */
sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "zelectr/model/models",
    "zelectr/service/odataService",
    "zelectr/parser/formulaParser",
    "zelectr/calculation/referenceResolver",
    "zelectr/calculation/calculationEngine",
    "zelectr/calculation/monthlyAggregator",
    "zelectr/formatter/numberFormatter",
    "zelectr/formatter/statusFormatter",
    "zelectr/parser/decimal",
    "sap/m/MessageBox"
], function (Controller, models, odataService, formulaParser, referenceResolver,
    calculationEngine, monthlyAggregator, numberFormatter, statusFormatter, Decimal, MessageBox) {
    "use strict";

    // Context window for source-row reads: the month plus this many days
    // before its start, so "closest earlier reading" strategies have some
    // context. This is diagnostic context only - it is NOT claimed to be
    // sufficient for a confirmed opening-value rule (brief 8.5).
    var CONTEXT_DAYS_BEFORE_MONTH = 10;

    return Controller.extend("zelectr.controller.View1", {

        onInit: function () {
            this._service = odataService.createService(this.getOwnerComponent().getModel());
            this._strategies = referenceResolver.getStrategies();
            this._viewModel = models.createViewModel();
            this._viewModel.setProperty("/strategies", this._strategies.map(function (s) {
                return { id: s.id, label: s.label };
            }));
            this._viewModel.setProperty("/selectedStrategy", this._strategies[0].id);
            this._viewModel.setProperty("/canLoad", true);
            this.getView().setModel(this._viewModel, "vm");
            this._lastSelectionKey = null;
        },

        // ------------------------------------------------------------------
        // Event handlers
        // ------------------------------------------------------------------

        onLoad: function () {
            var oView = this.getView();
            var plant = (oView.byId("plantInput").getValue() || "").trim().toUpperCase();
            var pos = (oView.byId("posInput").getValue() || "").trim();
            var sDate = oView.byId("monthPicker").getValue() || oView.byId("monthPicker").getDateValue();
            var manualFilter = oView.byId("manualSelect").getSelectedKey();
            var strategyId = oView.byId("strategySelect").getSelectedKey();

            if (!plant || !pos || !sDate) {
                MessageBox.warning(this._text("msgMissingInput"));
                return;
            }

            var year = parseInt(sDate.substring(0, 4), 10);
            var month = parseInt(sDate.substring(5, 7), 10);
            var selection = { plant: plant, pos: pos, year: year, month: month };

            // Clear stale results immediately so old data can never appear
            // to belong to the new selection (brief 8.9).
            this._clearResults();
            this._viewModel.setProperty("/busy", true);
            this._viewModel.setProperty("/canLoad", false);
            oView.setBusy(true);

            var strategy = referenceResolver.getStrategyById(strategyId) || this._strategies[0];
            var self = this;

            this._service.readParents(selection)
                .then(function (res) {
                    selection.posUsed = res.posUsed;
                    selection.parentFilter = res.filter;
                    return self._loadEverything(selection, res.rows, strategy);
                })
                .then(function (context) {
                    self._present(selection, context, manualFilter, strategy);
                    self._viewModel.setProperty("/busy", false);
                    self._viewModel.setProperty("/canLoad", true);
                    oView.setBusy(false);
                })
                .catch(function (err) {
                    self._viewModel.setProperty("/busy", false);
                    self._viewModel.setProperty("/canLoad", true);
                    oView.setBusy(false);
                    MessageBox.error(self._text("msgLoadError") + "\n" + (err && err.message ? err.message : err));
                });
        },

        onRowSelected: function (oEvent) {
            var oCtx = oEvent.getParameter("listItem").getBindingContext("vm");
            if (!oCtx) {
                return;
            }
            var rowKey = oCtx.getProperty("key");
            this._showDetail(rowKey);
        },

        // ------------------------------------------------------------------
        // Data loading pipeline
        // ------------------------------------------------------------------

        /** Loads components, source rows and returns the analysis context. */
        _loadEverything: function (selection, parents, strategy) {
            var service = this._service;

            // source-row context window: month start minus context days
            // (also used by the no-validation-record fallback below)
            var monthStartUtc = Date.UTC(selection.year, selection.month - 1, 1);
            var from = new Date(monthStartUtc - CONTEXT_DAYS_BEFORE_MONTH * 86400000);
            var lastDay = new Date(Date.UTC(selection.year, selection.month, 0)).getUTCDate();
            var fromDate = from.getUTCFullYear() + "-" +
                String(from.getUTCMonth() + 1).padStart(2, "0") + "-" +
                String(from.getUTCDate()).padStart(2, "0");
            var toDate = selection.year + "-" +
                String(selection.month).padStart(2, "0") + "-" +
                String(lastDay).padStart(2, "0");

            // normalize parents, keep ALL rows including manual/reset rows
            var parentRows = parents.map(function (r) {
                return {
                    plant: r.Plant,
                    pos: r.Pos,
                    date: r.ValidDate,
                    dateIso: service.toIsoDate(r.ValidDate),
                    manualEntry: r.ManualEntry === true,
                    formula: r.Formula == null ? "" : String(r.Formula),
                    uom: r.UnitOfMeasure || null,
                    storedAdjusted: service.toDecimal(r.StoredAdjustedQuantity),
                    storedSuggested: service.toDecimal(r.StoredSuggestedQuantity),
                    backendComputed: r.ComputedQuantity == null ? null : Number(r.ComputedQuantity),
                    isFallback: false,
                    raw: r
                };
            });

            var fallbackInfo = { active: false, note: "", caseMatched: false };
            var parentsReady;

            if (parentRows.length > 0) {
                parentsReady = Promise.resolve(parentRows);
            } else {
                // No validation record in Z_C_ELECR_VALIDATE. Fall back to the
                // source projection Z_I_ELECR_CNTR for the entered position
                // itself (it also exposes Formula) so the report stays useful
                // and explains exactly what is missing (brief section 0/2.3).
                var fallbackPos = selection.posUsed || selection.pos;
                if (fallbackPos.toUpperCase() !== selection.pos) {
                    fallbackInfo.caseMatched = true;
                }
                parentsReady = service.readSourceRows({
                    plant: selection.plant,
                    positions: [fallbackPos],
                    fromDate: fromDate,
                    toDate: toDate
                }).then(function (rows) {
                    if (rows.length === 0) {
                        return [];
                    }
                    fallbackInfo.active = true;
                    parentRows = rows.map(function (r) {
                        return {
                            plant: r.Plant,
                            pos: r.Pos,
                            date: r.ValidDate,
                            dateIso: service.toIsoDate(r.ValidDate),
                            manualEntry: r.ManualEntry === true,
                            formula: r.Formula == null ? "" : String(r.Formula),
                            uom: r.UnitOfMeasure || null,
                            storedAdjusted: service.toDecimal(r.AdjustedQuantity),
                            storedSuggested: service.toDecimal(r.SuggestedQuantity),
                            backendComputed: null,
                            isFallback: true,
                            raw: r
                        };
                    });
                    return parentRows;
                });
            }

            return parentsReady.then(function (rows) {
            parentRows = rows.sort(function (a, b) {
                return a.date.getTime() - b.date.getTime() ||
                    (a.manualEntry === b.manualEntry ? 0 : (a.manualEntry ? 1 : -1));
            });

            // parse each distinct formula once
            var parseCache = {};
            parentRows.forEach(function (row) {
                if (!(row.formula in parseCache)) {
                    parseCache[row.formula] = formulaParser.parseFormula(row.formula);
                }
            });

            return service.readRefComponents(selection).then(function (refRows) {
                var componentsByKey = {};
                refRows.forEach(function (r) {
                    var key = service.toIsoDate(r.valid_date) + "|" + (r.manual_entry === true ? "true" : "false");
                    if (!componentsByKey[key]) {
                        componentsByKey[key] = [];
                    }
                    componentsByKey[key].push({
                        seq: r.seq,
                        sign: r.sign || null,
                        refPosition: r.ref_position || null,
                        multiplier: service.toDecimal(r.multiplier),
                        divisor: service.toDecimal(r.divisor),
                        uom: r.UnitOfMeasure || null,
                        refSuggested: service.toDecimal(r.RefSuggestedValue),
                        refAdjusted: service.toDecimal(r.RefAdjustedValue),
                        contribution: service.toDecimal(r.Contribution),
                        refStatus: r.RefStatus || null,
                        raw: r
                    });
                });
                Object.keys(componentsByKey).forEach(function (k) {
                    componentsByKey[k].sort(function (a, b) { return a.seq - b.seq; });
                });

                // distinct reference positions across SUPPORTED parses
                var refPositions = [];
                Object.keys(parseCache).forEach(function (f) {
                    var p = parseCache[f];
                    if (p.status === "SUPPORTED") {
                        p.terms.forEach(function (t) {
                            if (refPositions.indexOf(t.refPosition) < 0) {
                                refPositions.push(t.refPosition);
                            }
                        });
                    }
                });

                if (refPositions.length === 0) {
                    return {
                        parentRows: parentRows,
                        parseCache: parseCache,
                        componentsByKey: componentsByKey,
                        sourceIndex: service.buildSourceIndex([]),
                        refPositions: [],
                        fallback: fallbackInfo
                    };
                }

                return service.readSourceRows({
                    plant: selection.plant,
                    positions: refPositions,
                    fromDate: fromDate,
                    toDate: toDate
                }).then(function (sourceRows) {
                    return {
                        parentRows: parentRows,
                        parseCache: parseCache,
                        componentsByKey: componentsByKey,
                        sourceIndex: service.buildSourceIndex(sourceRows),
                        refPositions: refPositions,
                        fallback: fallbackInfo
                    };
                });
            });
            });
        },

        // ------------------------------------------------------------------
        // Analysis and presentation
        // ------------------------------------------------------------------

        _present: function (selection, context, manualFilter, strategy) {
            var self = this;
            var fmt = numberFormatter;
            var parentRows = context.parentRows;

            var results = [];
            var analysisByKey = {};

            parentRows.forEach(function (row) {
                var parse = context.parseCache[row.formula];
                var resolutions = [];
                var calc = null;

                if (parse && parse.status === "SUPPORTED") {
                    resolutions = parse.terms.map(function (term) {
                        return referenceResolver.resolveReference(term, row.date, row.plant, context.sourceIndex, strategy);
                    });
                    calc = calculationEngine.calculateFormula(parse, resolutions, row.uom, strategy);
                }

                var cmp = calculationEngine.compareWithStored(
                    calc ? calc.value : null, row.storedAdjusted);

                var backendComponents = context.componentsByKey[row.dateIso + "|" + (row.manualEntry ? "true" : "false")] || [];
                var comparison = self._compareComponents(parse, backendComponents);

                var status = calc ? calc.status : (parse ? self._parseStatusToCalcStatus(parse.status) : "NOT_CALCULATED");
                var warnings = calc ? calc.warnings.slice(0) : [];
                if (parse && parse.error && parse.status !== "SUPPORTED") {
                    warnings.unshift(parse.error);
                }

                var key = row.dateIso + "|" + (row.manualEntry ? "true" : "false");
                analysisByKey[key] = {
                    row: row,
                    parse: parse,
                    calc: calc,
                    comparison: comparison,
                    backendComponents: backendComponents,
                    resolutions: resolutions
                };

                results.push({
                    key: key,
                    dateIso: row.dateIso,
                    manualEntry: row.manualEntry,
                    manualEntryText: row.manualEntry ? self._text("manualYes") : self._text("manualNo"),
                    parseStatus: parse ? parse.status : "NO_FORMULA",
                    storedAdjusted: fmt.formatQuantity(row.storedAdjusted),
                    storedSuggested: fmt.formatQuantity(row.storedSuggested),
                    backendComputed: row.backendComputed == null ? "" : fmt.formatDiagnostic(row.backendComputed),
                    jsValue: calc && calc.value != null ? fmt.formatDiagnostic(calc.value) : "",
                    difference: cmp.difference != null ? fmt.formatDiagnostic(cmp.difference) : "",
                    differenceStatus: cmp.status,
                    comparisonText: statusFormatter.comparisonText(comparison.status),
                    comparisonState: statusFormatter.statusState(comparison.status),
                    statusText: statusFormatter.statusText(status),
                    statusState: statusFormatter.statusState(status),
                    warning: warnings.join(" ")
                });
            });

            // apply the manual-entry display filter
            var visibleResults = results.filter(function (r) {
                if (manualFilter === "AUTO") {
                    return !r.manualEntry;
                }
                if (manualFilter === "MANUAL") {
                    return r.manualEntry;
                }
                return true;
            });

            // Monthly totals: sums of the DISPLAYED daily values. Explicitly
            // provisional - a sum of daily values is only the month total if
            // P() turns out to be daily consumption (rule unconfirmed).
            var sumAdjusted = Decimal.zero();
            var sumSuggested = Decimal.zero();
            var sumJs = Decimal.zero();
            var anyJs = false;
            visibleResults.forEach(function (r) {
                var a = analysisByKey[r.key];
                if (!a) {
                    return;
                }
                if (a.row.storedAdjusted != null) {
                    sumAdjusted = sumAdjusted.add(a.row.storedAdjusted);
                }
                if (a.row.storedSuggested != null) {
                    sumSuggested = sumSuggested.add(a.row.storedSuggested);
                }
                if (a.calc && a.calc.value != null) {
                    anyJs = true;
                    sumJs = sumJs.add(a.calc.value);
                }
            });

            // KPIs (only reliably computable counts - brief 4.7)
            var kpis = this._buildKpis(results);

            // monthly summary - withheld while P() semantics are unconfirmed
            var monthly = monthlyAggregator.aggregateMonth(
                results.map(function (r) {
                    var a = analysisByKey[r.key];
                    return { status: a.calc ? a.calc.status : "NOT_CALCULATED", value: a.calc ? a.calc.value : null };
                }),
                null // no confirmed aggregation rule exists yet
            );

            // header: formula (verbatim), parser status, formula-change note
            var distinctFormulas = Object.keys(context.parseCache);
            var formulaChanged = distinctFormulas.length > 1;
            var firstRow = parentRows[0];
            var firstParse = firstRow ? context.parseCache[firstRow.formula] : null;
            var parserMessage = firstParse && firstParse.error ? firstParse.error :
                (firstParse && firstParse.warnings && firstParse.warnings.length ? firstParse.warnings.join(" ") : "");
            if (parserMessage === "" && firstParse && firstParse.status === "SUPPORTED") {
                parserMessage = this._text("parserOk");
            }
            var fallback = context.fallback || { active: false, note: "", caseMatched: false };
            if (fallback.active) {
                parserMessage = this._text("fallbackNote") +
                    (fallback.caseMatched ? " " + this._text("fallbackCase") : "") +
                    (parserMessage ? " | " + parserMessage : "");
            }
            if (parentRows.length === 0) {
                parserMessage = this._text("msgNoData") +
                    (selection.parentFilter ? " $filter=" + selection.parentFilter : "");
            }

            this._viewModel.setProperty("/header", {
                plant: selection.plant,
                pos: selection.pos,
                month: selection.year + "-" + String(selection.month).padStart(2, "0"),
                uom: firstRow && firstRow.uom ? firstRow.uom : "",
                formula: firstRow ? firstRow.formula : "",
                parserStatus: statusFormatter.statusText(firstParse ? firstParse.status : "NO_FORMULA"),
                parserState: statusFormatter.statusState(firstParse ? firstParse.status : "NO_FORMULA"),
                parserMessage: parserMessage,
                hasParserMessage: !!parserMessage,
                formulaChanged: formulaChanged ? this._text("formulaChanged") : this._text("formulaStable"),
                formulaChangedState: formulaChanged ? "Warning" : "Success"
            });

            this._viewModel.setProperty("/kpis", kpis);
            this._viewModel.setProperty("/monthly", {
                status: statusFormatter.statusText(monthly.status),
                state: statusFormatter.statusState(monthly.status),
                reason: monthly.reason || ""
            });
            this._viewModel.setProperty("/totals", {
                storedAdjusted: fmt.formatQuantity(sumAdjusted),
                storedSuggested: fmt.formatQuantity(sumSuggested),
                jsValue: anyJs ? fmt.formatDiagnostic(sumJs) : "",
                difference: anyJs ? fmt.formatDiagnostic(sumJs.sub(sumAdjusted)) : "",
                note: this._text("totalsNote")
            });
            this._viewModel.setProperty("/results", visibleResults);
            this._viewModel.setProperty("/hasResults", true);
            this._analysisByKey = analysisByKey;
            this._strategy = strategy;

            // preselect the first visible row for the detail panels
            if (visibleResults.length > 0) {
                this._showDetail(visibleResults[0].key);
            } else {
                this._viewModel.setProperty("/selected", {});
            }
        },

        /** Builds the detail/parse/comparison panels for one parent row. */
        _showDetail: function (sKey) {
            var a = this._analysisByKey && this._analysisByKey[sKey];
            if (!a) {
                return;
            }
            var fmt = numberFormatter;
            var self = this;
            var parse = a.parse;
            var calc = a.calc;
            var backendBySeq = {};
            a.backendComponents.forEach(function (c) {
                backendBySeq[c.seq] = c;
            });

            // JS parse table
            var terms = (parse && parse.terms || []).map(function (t) {
                return {
                    seq: t.seq,
                    sign: t.sign,
                    refPosition: t.refPosition,
                    multiplier: fmt.formatCoefficient(t.multiplier),
                    divisor: fmt.formatCoefficient(t.divisor),
                    explanation: t.explanation
                };
            });

            // structural comparison table (JS vs backend, by occurrence)
            var comparison = [];
            var maxSeq = Math.max(terms.length, a.backendComponents.length);
            for (var i = 1; i <= maxSeq; i++) {
                var jsTerm = parse && parse.terms[i - 1];
                var be = backendBySeq[i];
                var match = "MATCH";
                if (!jsTerm && be) {
                    match = "EXTRA_BACKEND";
                } else if (jsTerm && !be) {
                    match = "MISSING_BACKEND";
                } else if (jsTerm && be) {
                    if (jsTerm.sign !== (be.sign || "") ||
                        jsTerm.refPosition !== be.refPosition ||
                        !be.multiplier || jsTerm.multiplier.cmp(be.multiplier) !== 0 ||
                        !be.divisor || jsTerm.divisor.cmp(be.divisor) !== 0) {
                        match = "DIFFERS";
                    }
                }
                comparison.push({
                    seq: i,
                    jsSign: jsTerm ? jsTerm.sign : "",
                    jsRefPosition: jsTerm ? jsTerm.refPosition : "",
                    jsMultiplier: jsTerm ? fmt.formatCoefficient(jsTerm.multiplier) : "",
                    jsDivisor: jsTerm ? fmt.formatCoefficient(jsTerm.divisor) : "",
                    backendSign: be ? (be.sign || "") : "",
                    backendRefPosition: be ? (be.refPosition || "") : "",
                    backendMultiplier: be ? fmt.formatCoefficient(be.multiplier) : "",
                    backendDivisor: be ? fmt.formatCoefficient(be.divisor) : "",
                    matchText: match === "MATCH" ? this._text("cmpMatch") :
                        match === "EXTRA_BACKEND" ? this._text("cmpExtra") :
                        match === "MISSING_BACKEND" ? this._text("cmpMissing") :
                        this._text("cmpDiffers"),
                    matchState: match === "MATCH" ? "Success" : "Error"
                });
            }

            // reference breakdown (per term, with source lineage)
            var detail = [];
            if (calc) {
                calc.termBreakdown.forEach(function (b) {
                    var be = backendBySeq[b.seq];
                    var src = b.sourceRows && b.sourceRows[0];
                    var candidates = b.candidateRows || [];
                    var sourceNote = "";
                    if (candidates.length > 1) {
                        sourceNote = candidates.map(function (c) {
                            return c.dateIso + (c.manualEntry ? " (manual)" : " (auto)");
                        }).join(", ");
                    }
                    detail.push({
                        seq: b.seq,
                        sign: b.sign,
                        refPosition: b.refPosition,
                        multiplier: fmt.formatCoefficient(b.multiplier),
                        divisor: fmt.formatCoefficient(b.divisor),
                        sourceDate: src ? src.dateIso : (sourceNote || ""),
                        sourceManual: src ? (src.manualEntry ? self._text("manualYes") : self._text("manualNo")) : "",
                        refAdjusted: b.resolvedValue != null ? fmt.formatDiagnostic(b.resolvedValue) : "",
                        refSuggested: src && src.suggested != null ? fmt.formatDiagnostic(src.suggested) : "",
                        backendRefAdjusted: be && be.refAdjusted != null ? fmt.formatDiagnostic(be.refAdjusted) : "",
                        backendContribution: be && be.contribution != null ? fmt.formatDiagnostic(be.contribution) : "",
                        jsContribution: b.contribution != null ? fmt.formatDiagnostic(b.contribution) : "",
                        refStatus: be ? (be.refStatus || "") : "",
                        refState: b.status === "RESOLVED" ? "Success" : (b.status === "UOM_MISMATCH" ? "Error" : "Warning"),
                        rule: b.rule + (sourceNote ? " | Candidates: " + sourceNote : "")
                    });
                });
            }

            this._viewModel.setProperty("/selected", {
                detailTitle: this._text("detailFor") + " " + a.row.dateIso +
                    (a.row.manualEntry ? " (" + this._text("manualYes") + ")" : ""),
                parseTitle: parse && parse.status === "SUPPORTED"
                    ? this._text("parseFor") + " " + a.row.dateIso
                    : this._text("parseNotSupported"),
                comparisonTitle: this._text("comparisonFor") + " " + a.row.dateIso,
                terms: terms,
                comparison: comparison,
                detail: detail
            });
        },

        // ------------------------------------------------------------------
        // Helpers
        // ------------------------------------------------------------------

        /**
         * Structural comparison of the JS parse against the backend
         * component set (totals are NOT compared - brief 4.4).
         */
        _compareComponents: function (parse, backendComponents) {
            if (!parse || parse.status !== "SUPPORTED") {
                return { status: "NOT_CALCULATED" };
            }
            if (backendComponents.length === 0) {
                return { status: "NO_BACKEND_COMPONENTS" };
            }
            if (parse.terms.length !== backendComponents.length) {
                return { status: "PARSE_MISMATCH" };
            }
            for (var i = 0; i < parse.terms.length; i++) {
                var t = parse.terms[i];
                var b = backendComponents[i];
                if (t.sign !== (b.sign || "") ||
                    t.refPosition !== b.refPosition ||
                    !b.multiplier || t.multiplier.cmp(b.multiplier) !== 0 ||
                    !b.divisor || t.divisor.cmp(b.divisor) !== 0) {
                    return { status: "PARSE_MISMATCH" };
                }
            }
            return { status: "MATCH" };
        },

        _parseStatusToCalcStatus: function (sParseStatus) {
            if (sParseStatus === "EMPTY") {
                return "NOT_CALCULATED";
            }
            return "UNSUPPORTED";
        },

        _buildKpis: function (results) {
            var kpis = [];
            var count = function (fn) {
                return results.filter(fn).length;
            };
            kpis.push({ title: this._text("kpiRows"), value: String(results.length), state: "None" });
            kpis.push({
                title: this._text("kpiSupported"),
                value: String(count(function (r) { return r.parseStatus === "SUPPORTED"; })),
                state: "Success"
            });
            kpis.push({
                title: this._text("kpiUnsupported"),
                value: String(count(function (r) {
                    return r.parseStatus === "UNSUPPORTED" || r.parseStatus === "SYNTAX_ERROR" ||
                        r.parseStatus === "EMPTY" || r.parseStatus === "NO_FORMULA";
                })),
                state: "Warning"
            });
            kpis.push({
                title: this._text("kpiMissingRefs"),
                value: String(count(function (r) {
                    return r.statusText === "INCOMPLETE DATA" || r.statusText === "AMBIGUOUS SOURCE" ||
                        r.statusText === "UOM MISMATCH";
                })),
                state: "Error"
            });
            kpis.push({
                title: this._text("kpiCalculated"),
                value: String(count(function (r) { return r.jsValue !== ""; })),
                state: "Information"
            });
            kpis.push({
                title: this._text("kpiDifferences"),
                value: String(count(function (r) { return r.differenceStatus === "DIFFERENCE"; })),
                state: "Warning"
            });
            return kpis;
        },

        _clearResults: function () {
            this._analysisByKey = null;
            this._viewModel.setProperty("/hasResults", false);
            this._viewModel.setProperty("/totals", {});
            this._viewModel.setProperty("/results", []);
            this._viewModel.setProperty("/selected", {});
            this._viewModel.setProperty("/kpis", []);
            this._viewModel.setProperty("/header", {});
            this._viewModel.setProperty("/monthly", {});
        },

        _text: function (sKey) {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey);
        },

        // ------------------------------------------------------------------
        // Navigation between the three reports
        // ------------------------------------------------------------------
        onNavFormulaTest: function () {
            sap.ui.core.UIComponent.getRouterFor(this).navTo("RouteFormulaTest", {}, true);
        },

        onNavCurrentMonth: function () {
            sap.ui.core.UIComponent.getRouterFor(this).navTo("RouteCurrentMonth", {}, true);
        },

        onNavYearReport: function () {
            sap.ui.core.UIComponent.getRouterFor(this).navTo("RouteYearReport", {}, true);
        }
    });
});
