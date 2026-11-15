/*!
 * zelectr/service/positionReportService.js
 *
 * Coordinates OData retrieval, caching, capability detection, calculation
 * and diagnostics for the two reports (brief sections 3-6):
 *
 *   Report 1 "Current month - all positions": one row per position of the
 *   internal plant (2010) for the current calendar month.
 *
 *   Report 2 "Position - 12-month overview": one selected position across
 *   all 12 months of a selected year (empty months stay visible).
 *
 * Four calculation variants per row, isolating parser differences from
 * reference-resolution differences (brief 3.4):
 *   - JS parser terms   evaluated with ADJUSTED reference values
 *   - JS parser terms   evaluated with SUGGESTED reference values
 *   - ABAP components   evaluated with ADJUSTED reference values
 *   - ABAP components   evaluated with SUGGESTED reference values
 * Both representations are evaluated by the same FormulaEvaluator against
 * the same resolved reference values.
 *
 * Monthly aggregation rule: PERIOD_CHANGE (last reading in the period minus
 * the closest earlier opening reading) - the candidate rule matching the
 * bE31X fixture reconstruction. NOT business-confirmed; every result is
 * reported with the note "P(position) RULE NOT VERIFIED".
 *
 * Capability detection: the local metadata.xml is a stale snapshot (the
 * live $metadata could not be fetched from the agent environment - HTTP 401,
 * SSO required). Instead of guessing, the service inspects the LIVE service
 * metadata at runtime (ODataModel.getServiceMetadata) to decide whether
 * MainWorkshop, a position-description property and PastMeasurement exist,
 * and builds $select accordingly. Missing fields are reported, never faked.
 */
sap.ui.define([
    "zelectr/service/odataService",
    "zelectr/service/performanceDiagnostics",
    "zelectr/parser/formulaParser",
    "zelectr/calculation/formulaEvaluator",
    "zelectr/calculation/monthlyAggregator",
    "zelectr/parser/decimal"
], function (odataService, perf, formulaParser, formulaEvaluator, monthlyAggregator, Decimal) {
    "use strict";

    // Internal configuration constant - NOT a user-facing parameter (brief 2.4)
    var PLANT = "2010";
    var CONTEXT_DAYS_BEFORE = 10;

    function pad2(n) {
        return String(n).padStart(2, "0");
    }

    function isoAddDays(iso, days) {
        var d = new Date(iso + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + days);
        return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
    }

    function monthRange(year, month) {
        var lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        return {
            start: year + "-" + pad2(month) + "-01",
            end: year + "-" + pad2(month) + "-" + pad2(lastDay)
        };
    }

    /**
     * Creates the report service.
     *
     * @param {sap.ui.model.odata.v2.ODataModel} oModel shared V2 model
     * @returns {object} report service facade
     */
    function createReportService(oModel) {
        var service = odataService.createService(oModel);
        var rowCache = new Map(); // bounded cache: plant|pos|dateIso|manual -> normalized row

        function clearCache() {
            rowCache.clear();
        }

        // ------------------------------------------------------------------
        // Capability detection from the LIVE service metadata
        // ------------------------------------------------------------------

        function detectCapabilities() {
            var caps = {
                metadataAvailable: false,
                mainWorkshop: null,
                posDescr: null,
                pastMeasurement: null
            };
            try {
                var meta = oModel.getServiceMetadata();
                // the v2 model metadata JSON can appear either wrapped
                // ({ dataServices: { schema: [...] } }) or directly
                // ({ schema: [...] }) depending on the model version -
                // handle both instead of silently finding nothing
                var dataServices = (meta && meta.dataServices) ? meta.dataServices : meta;
                var schemas = (dataServices && dataServices.schema) || [];
                if (!Array.isArray(schemas)) {
                    schemas = [schemas];
                }
                var cntrProps = [];
                schemas.forEach(function (s) {
                    var entityTypes = s.entityType || [];
                    if (!Array.isArray(entityTypes)) {
                        entityTypes = [entityTypes];
                    }
                    entityTypes.forEach(function (et) {
                        if (et.name === "Z_I_ELECR_CNTRType") {
                            var props = et.property || [];
                            if (!Array.isArray(props)) {
                                props = [props];
                            }
                            props.forEach(function (p) {
                                cntrProps.push(p.name);
                            });
                        }
                    });
                });
                caps.metadataAvailable = cntrProps.length > 0;
                caps.mainWorkshop = cntrProps.indexOf("MainWorkshop") >= 0 ? "MainWorkshop" : null;
                caps.pastMeasurement = null;
                cntrProps.forEach(function (n) {
                    if (n.toLowerCase().replace(/_/g, "") === "pastmeasurement") {
                        caps.pastMeasurement = n;
                    }
                });
                // position description: use the exact property from metadata
                // if exactly one description-like property exists; never guess
                var descr = cntrProps.filter(function (n) { return /descr/i.test(n); });
                caps.posDescr = descr.length === 1 ? descr[0] : null;
                // diagnostic: visible in the browser console when the
                // optional fields are missing from the live service metadata
                console.log("zelectr: Z_I_ELECR_CNTR capabilities", JSON.stringify(caps));
            } catch (e) {
                // metadata not (yet) available - all optional fields unknown
                console.warn("zelectr: service metadata not readable - optional fields unknown", e);
            }
            return caps;
        }

        function sourceSelectFields(caps) {
            var fields = ["Plant", "Pos", "ValidDate", "ManualEntry",
                "SuggestedQuantity", "AdjustedQuantity", "UnitOfMeasure", "Formula"];
            if (caps.mainWorkshop) {
                fields.push(caps.mainWorkshop);
            }
            if (caps.posDescr) {
                fields.push(caps.posDescr);
            }
            if (caps.pastMeasurement) {
                fields.push(caps.pastMeasurement);
            }
            return fields;
        }

        // ------------------------------------------------------------------
        // Row normalization (keeps ALL rows; manual identity preserved)
        // ------------------------------------------------------------------

        function normalizeSourceRows(rawRows, caps) {
            return (rawRows || []).map(function (r) {
                var dateIso = service.toIsoDate(r.ValidDate);
                var manual = r.ManualEntry === true;
                var key = [r.Plant, r.Pos, dateIso, manual ? "true" : "false"].join("|");
                // optional fields are requested under their exact metadata
                // names; read them directly (with the detected-name override)
                var row = {
                    key: key,
                    plant: r.Plant,
                    pos: r.Pos,
                    dateIso: dateIso,
                    date: r.ValidDate,
                    manualEntry: manual,
                    adjusted: service.toDecimal(r.AdjustedQuantity),
                    suggested: service.toDecimal(r.SuggestedQuantity),
                    uom: r.UnitOfMeasure || null,
                    formula: r.Formula == null ? "" : String(r.Formula),
                    workshop: (caps.mainWorkshop ? r[caps.mainWorkshop] : null) || r.MainWorkshop || "",
                    descr: (caps.posDescr ? r[caps.posDescr] : null) || r.PositionDescription || "",
                    pastMeasurement: r.PastMeasurement != null ? String(r.PastMeasurement) : null,
                    raw: r
                };
                rowCache.set(key, row);
                return row;
            });
        }

        /**
         * Reads source rows with the optional fields (MainWorkshop,
         * PositionDescription, PastMeasurement) included in $select. If the
         * service rejects them (property not supported), the read is retried
         * once with the base fields only - so the report works against both
         * the updated and the old projection without failing.
         */
        function readSourceRowsWithOptional(params, caps) {
            var optional = ["MainWorkshop"];
            if (caps.posDescr && optional.indexOf(caps.posDescr) < 0) {
                optional.push(caps.posDescr);
            } else if (optional.indexOf("PositionDescription") < 0) {
                optional.push("PositionDescription");
            }
            if (caps.pastMeasurement && optional.indexOf(caps.pastMeasurement) < 0) {
                optional.push(caps.pastMeasurement);
            } else if (optional.indexOf("PastMeasurement") < 0) {
                optional.push("PastMeasurement");
            }
            var base = ["Plant", "Pos", "ValidDate", "ManualEntry",
                "SuggestedQuantity", "AdjustedQuantity", "UnitOfMeasure", "Formula"];
            var withOptional = base.concat(optional);
            return service.readSourceRows(Object.assign({}, params, { selectFields: withOptional }))
                .catch(function () {
                    return service.readSourceRows(Object.assign({}, params, { selectFields: base }));
                });
        }

        /** Same fallback logic for the all-positions range read. */
        function readSourceRowsRangeWithOptional(plant, fromDate, toDate, caps) {
            var optional = ["MainWorkshop"];
            if (caps.posDescr && optional.indexOf(caps.posDescr) < 0) {
                optional.push(caps.posDescr);
            } else if (optional.indexOf("PositionDescription") < 0) {
                optional.push("PositionDescription");
            }
            if (caps.pastMeasurement && optional.indexOf(caps.pastMeasurement) < 0) {
                optional.push(caps.pastMeasurement);
            } else if (optional.indexOf("PastMeasurement") < 0) {
                optional.push("PastMeasurement");
            }
            var base = ["Plant", "Pos", "ValidDate", "ManualEntry",
                "SuggestedQuantity", "AdjustedQuantity", "UnitOfMeasure", "Formula"];
            return service.readSourceRowsRange(plant, fromDate, toDate, base.concat(optional))
                .catch(function () {
                    return service.readSourceRowsRange(plant, fromDate, toDate, base);
                });
        }

        function rowsByPosition(rows) {
            var byPos = new Map();
            rows.forEach(function (r) {
                if (!byPos.has(r.pos)) {
                    byPos.set(r.pos, []);
                }
                byPos.get(r.pos).push(r);
            });
            byPos.forEach(function (list) {
                list.sort(function (a, b) {
                    return a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 :
                        (a.manualEntry === b.manualEntry ? 0 : (a.manualEntry ? 1 : -1));
                });
            });
            return byPos;
        }

        // ------------------------------------------------------------------
        // Per-period calculation for one position
        // ------------------------------------------------------------------

        /**
         * Computes the four variants + notes for one position over one
         * period [rangeStart..rangeEnd].
         *
         * @param {object} params { pos, posRows, refIndex, abapComponentsByDate,
         *                          rangeStart, rangeEnd, descrNotExposed }
         * @returns {object} calculation result with display values and notes
         */
        function calculatePositionPeriod(params) {
            var notes = [];
            var posRows = params.posRows || [];
            var inRange = posRows.filter(function (r) {
                return r.dateIso >= params.rangeStart && r.dateIso <= params.rangeEnd;
            });

            var out = {
                pos: params.pos,
                workshop: "",
                descr: "",
                uom: "",
                pastMeasurement: null,
                formula: "",
                adjJs: "", sugJs: "", adjAbap: "", sugAbap: "",
                status: "NOT CALCULATED",
                state: "None",
                notes: notes,
                detail: null
            };

            if (inRange.length === 0) {
                out.status = "NO DATA";
                out.state = "None";
                notes.push("NO DATA");
                return out;
            }

            // display attributes: last non-empty workshop/description in the
            // period (the last row may not carry them on every position)
            var lastRow = inRange[inRange.length - 1];
            inRange.forEach(function (r) {
                if (!out.workshop && r.workshop) {
                    out.workshop = r.workshop;
                }
                if (!out.descr && r.descr) {
                    out.descr = r.descr;
                }
            });
            out.uom = lastRow.uom || "";
            out.pastMeasurement = lastRow.pastMeasurement;
            if (!params.descrNotExposed && !out.descr && params.caps && params.caps.metadataAvailable && !params.caps.posDescr) {
                out.descr = "";
            }

            // formula handling
            var formulas = [];
            inRange.forEach(function (r) {
                if (r.formula && formulas.indexOf(r.formula) < 0) {
                    formulas.push(r.formula);
                }
            });
            if (formulas.length === 0) {
                out.status = "NO FORMULA";
                out.state = "None";
                notes.push("NO FORMULA");
                return out;
            }
            out.formula = formulas[0];
            if (formulas.length > 1) {
                notes.push("FORMULA CHANGED DURING PERIOD");
                out.status = "FORMULA CHANGED";
                out.state = "Warning";
                return out;
            }

            // JS parse
            var parse = formulaParser.parseFormula(out.formula);
            var jsTerms = parse.status === "SUPPORTED" ? parse.terms : [];
            if (parse.status === "SYNTAX_ERROR") {
                notes.push("JS PARSER: SYNTAX ERROR");
            } else if (parse.status === "UNSUPPORTED") {
                notes.push("JS PARSER: UNSUPPORTED EXPRESSION");
            }

            // ABAP components for the latest parent row key
            var abapKey = lastRow.dateIso + "|" + (lastRow.manualEntry ? "true" : "false");
            var abapComponents = (params.abapComponentsByDate && params.abapComponentsByDate[abapKey]) || [];
            if (abapComponents.length === 0) {
                notes.push("ABAP COMPONENTS NOT FOUND");
            }

            // structural comparison (independent of numeric evaluation)
            var comparison = formulaEvaluator.compareComponents(jsTerms, abapComponents);
            if (comparison.status === "PARSE_MISMATCH") {
                notes.push("JS / ABAP COMPONENT MISMATCH");
            }

            // reference positions: union of both representations
            var refPositions = [];
            jsTerms.forEach(function (t) {
                if (refPositions.indexOf(t.refPosition) < 0) {
                    refPositions.push(t.refPosition);
                }
            });
            abapComponents.forEach(function (c) {
                if (c.refPosition && refPositions.indexOf(c.refPosition) < 0) {
                    refPositions.push(c.refPosition);
                }
            });

            // resolve period-change values per reference (adjusted + suggested)
            var self = this;
            var refValues = {}; // refPos -> {adjusted: {status,value,uom}, suggested: {...}}
            var missingRefs = [];
            var ambiguousRefs = [];
            refPositions.forEach(function (refPos) {
                var refRows = params.refIndex.rowsByPos.get([PLANT, refPos].join("|")) || [];
                var adj = monthlyAggregator.periodChange(refRows, params.rangeStart, params.rangeEnd);
                var sug = monthlyAggregator.periodChange(
                    refRows.map(function (r) { return Object.assign({}, r, { adjusted: r.suggested }); }),
                    params.rangeStart, params.rangeEnd);
                refValues[refPos] = {
                    adjusted: adj.status === "EVALUATED"
                        ? { status: "RESOLVED", value: adj.value, uom: (adj.lastRow || {}).uom }
                        : { status: adj.status === "NO_DATA" ? "MISSING_REFERENCE" : "MISSING_REFERENCE",
                            reason: adj.notes.join("; ") || "No source data for the period" },
                    suggested: sug.status === "EVALUATED"
                        ? { status: "RESOLVED", value: sug.value, uom: (sug.lastRow || {}).uom }
                        : { status: "MISSING_REFERENCE",
                            reason: sug.notes.join("; ") || "No source data for the period" }
                };
                if (adj.status !== "EVALUATED") {
                    missingRefs.push(refPos);
                    if (adj.notes.length) {
                        notes.push("REFERENCE " + refPos + ": " + adj.notes[0].toUpperCase());
                    }
                }
                if (adj.manualRowsInMonth > 0) {
                    notes.push("AMBIGUOUS REFERENCE ROW (MANUAL ENTRY): " + refPos);
                }
            });

            function makeResolver(basis) {
                return function (refPos) {
                    var v = refValues[refPos] && refValues[refPos][basis];
                    if (!v) {
                        return { status: "MISSING_REFERENCE", reason: "Reference not fetched" };
                    }
                    return v;
                };
            }

            var evalAdjJs = formulaEvaluator.evaluateComponents(jsTerms, makeResolver("adjusted"));
            var evalSugJs = formulaEvaluator.evaluateComponents(jsTerms, makeResolver("suggested"));
            var evalAdjAbap = formulaEvaluator.evaluateComponents(abapComponents, makeResolver("adjusted"));
            var evalSugAbap = formulaEvaluator.evaluateComponents(abapComponents, makeResolver("suggested"));

            function fmt(v) {
                return v == null ? "" : v.toString();
            }
            out.adjJs = fmt(evalAdjJs.value);
            out.sugJs = fmt(evalSugJs.value);
            out.adjAbap = fmt(evalAdjAbap.value);
            out.sugAbap = fmt(evalSugAbap.value);

            if (evalAdjJs.status === "UOM_MISMATCH" || evalAdjAbap.status === "UOM_MISMATCH") {
                notes.push("MIXED / INCOMPATIBLE UNITS");
            }
            if (missingRefs.length) {
                notes.push("REFERENCE POSITION MISSING: " + missingRefs.join(", "));
            }

            // overall row status: provisional whenever anything was calculated
            var anyValue = out.adjJs !== "" || out.sugJs !== "" || out.adjAbap !== "" || out.sugAbap !== "";
            if (anyValue) {
                out.status = "PROVISIONAL";
                out.state = "Information";
                notes.push("P(position) RULE NOT VERIFIED");
            } else {
                out.status = "NOT CALCULATED";
                out.state = "Warning";
            }
            if (comparison.status === "MATCH" && !missingRefs.length && parse.status === "SUPPORTED" && abapComponents.length > 0) {
                // structural match - keep the provisional status but note it
                notes.push("JS / ABAP COMPONENTS MATCH");
            }

            out.detail = {
                formula: out.formula,
                parseStatus: parse.status,
                parseError: parse.error || null,
                jsTerms: jsTerms,
                abapComponents: abapComponents,
                comparison: comparison,
                refValues: refValues,
                lastRowKey: abapKey
            };
            return out;
        }

        // ------------------------------------------------------------------
        // Report 1: current month, all positions
        // ------------------------------------------------------------------

        /**
         * Builds the current-month all-positions report.
         *
         * @param {object} params { year, month (1-12) } - defaults to now
         * @returns {Promise<object>} { rows, kpis, rangeStart, rangeEnd,
         *                              latestSourceDate, caps, contextWindow }
         */
        function buildCurrentMonthReport(params) {
            var now = new Date();
            var year = params && params.year ? params.year : now.getFullYear();
            var month = params && params.month ? params.month : now.getMonth() + 1;
            var range = monthRange(year, month);
            var contextStart = isoAddDays(range.start, -CONTEXT_DAYS_BEFORE);
            clearCache();

            var caps = detectCapabilities();
            var descrNotExposed = caps.metadataAvailable && !caps.posDescr;

            return readSourceRowsRangeWithOptional(PLANT, contextStart, range.end, caps)
                .then(function (rawRows) {
                    var rows = normalizeSourceRows(rawRows, caps);
                    var byPos = rowsByPosition(rows);

                    // latest source date actually found within the month
                    var latest = null;
                    rows.forEach(function (r) {
                        if (r.dateIso >= range.start && r.dateIso <= range.end &&
                            (latest === null || r.dateIso > latest)) {
                            latest = r.dateIso;
                        }
                    });

                    // phase 2: ABAP components for ALL parent positions in range
                    return service.readRefComponentsRange(PLANT, null, range.start, range.end)
                        .then(function (refRows) {
                            var componentsByPos = {};
                            (refRows || []).forEach(function (r) {
                                var pos = r.pos;
                                if (!componentsByPos[pos]) {
                                    componentsByPos[pos] = {};
                                }
                                var key = service.toIsoDate(r.valid_date) + "|" + (r.manual_entry === true ? "true" : "false");
                                if (!componentsByPos[pos][key]) {
                                    componentsByPos[pos][key] = [];
                                }
                                componentsByPos[pos][key].push({
                                    seq: r.seq,
                                    sign: r.sign || "",
                                    refPosition: r.ref_position || "",
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
                            Object.keys(componentsByPos).forEach(function (pos) {
                                Object.keys(componentsByPos[pos]).forEach(function (k) {
                                    componentsByPos[pos][k].sort(function (a, b) { return a.seq - b.seq; });
                                });
                            });

                            // phase 3: unique reference positions across all formulas
                            var collectTimer = perf.startStage(null, "Collect reference positions");
                            var refPositions = [];
                            byPos.forEach(function (posRows, pos) {
                                posRows.forEach(function (r) {
                                    if (!r.formula) {
                                        return;
                                    }
                                    var p = formulaParser.parseFormula(r.formula);
                                    if (p.status === "SUPPORTED") {
                                        p.terms.forEach(function (t) {
                                            if (refPositions.indexOf(t.refPosition) < 0) {
                                                refPositions.push(t.refPosition);
                                            }
                                        });
                                    }
                                });
                            });
                            perf.endStage(collectTimer, { positions: refPositions.length });

                            var refFetch;
                            if (refPositions.length === 0) {
                                refFetch = Promise.resolve([]);
                            } else {
                                refFetch = service.readSourceRows({
                                    plant: PLANT,
                                    positions: refPositions,
                                    fromDate: contextStart,
                                    toDate: range.end
                                });
                            }

                            return refFetch.then(function (refRawRows) {
                                // buildSourceIndex expects RAW OData rows and does its
                                // own normalization (double-normalizing here would drop
                                // ValidDate and crash toIsoDate)
                                var indexTimer = perf.startStage(null, "Build source index");
                                var refIndex = service.buildSourceIndex(refRawRows);
                                perf.endStage(indexTimer, { rows: refRawRows.length });

                                var calcTimer = perf.startStage(null, "Calculate positions");
                                var reportRows = [];
                                byPos.forEach(function (posRows, pos) {
                                    var calc = calculatePositionPeriod({
                                        pos: pos,
                                        posRows: posRows,
                                        refIndex: refIndex,
                                        abapComponentsByDate: componentsByPos[pos] || {},
                                        rangeStart: range.start,
                                        rangeEnd: range.end,
                                        caps: caps,
                                        descrNotExposed: descrNotExposed
                                    });
                                    calc.descrNotExposed = descrNotExposed;
                                    if (descrNotExposed) {
                                        calc.notes.push("DESCRIPTION NOT EXPOSED BY SERVICE");
                                    }
                                    reportRows.push(calc);
                                });
                                perf.endStage(calcTimer, { positions: reportRows.length });

                                // sort by workshop, then position
                                reportRows.sort(function (a, b) {
                                    return (a.workshop || "").localeCompare(b.workshop || "") ||
                                        a.pos.localeCompare(b.pos);
                                });

                                var kpis = {
                                    positions: reportRows.length,
                                    withValues: reportRows.filter(function (r) { return r.adjJs !== "" || r.adjAbap !== ""; }).length,
                                    withErrors: reportRows.filter(function (r) {
                                        return r.notes.some(function (n) {
                                            return /MISSING|MISMATCH|ERROR|UNSUPPORTED|CHANGED/.test(n);
                                        });
                                    }).length,
                                    noFormula: reportRows.filter(function (r) { return r.status === "NO FORMULA"; }).length
                                };

                                return {
                                    rows: reportRows,
                                    kpis: kpis,
                                    rangeStart: range.start,
                                    rangeEnd: range.end,
                                    latestSourceDate: latest,
                                    caps: caps,
                                    contextWindow: contextStart,
                                    plant: PLANT
                                };
                            });
                        });
                });
        }

        // ------------------------------------------------------------------
        // Report 2: one position, 12 months of a year
        // ------------------------------------------------------------------

        var MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];

        /**
         * Builds the 12-month report for one position.
         *
         * @param {object} params { pos, year }
         * @returns {Promise<object>} { months: [12 rows], header, caps }
         */
        function buildYearReport(params) {
            var pos = params.pos;
            var year = params.year;
            var yearStart = year + "-01-01";
            var yearEnd = year + "-12-31";
            var contextStart = isoAddDays(yearStart, -CONTEXT_DAYS_BEFORE);
            clearCache();

            var caps = detectCapabilities();
            var descrNotExposed = caps.metadataAvailable && !caps.posDescr;

            // the position's own rows for the whole year (+ opening context);
            // optional fields included with fallback for old projections
            return readSourceRowsWithOptional({
                plant: PLANT,
                positions: [pos],
                fromDate: contextStart,
                toDate: yearEnd
            }, caps).then(function (rawRows) {
                var posRows = normalizeSourceRows(rawRows, caps);
                var byMonth = new Map();
                posRows.forEach(function (r) {
                    var m = parseInt(r.dateIso.substring(5, 7), 10);
                    if (!byMonth.has(m)) {
                        byMonth.set(m, []);
                    }
                    byMonth.get(m).push(r);
                });

                // ABAP components for the position over the year
                return service.readRefComponentsRange(PLANT, pos, yearStart, yearEnd)
                    .then(function (refRows) {
                        var componentsByDate = {};
                        (refRows || []).forEach(function (r) {
                            var key = service.toIsoDate(r.valid_date) + "|" + (r.manual_entry === true ? "true" : "false");
                            if (!componentsByDate[key]) {
                                componentsByDate[key] = [];
                            }
                            componentsByDate[key].push({
                                seq: r.seq,
                                sign: r.sign || "",
                                refPosition: r.ref_position || "",
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
                        Object.keys(componentsByDate).forEach(function (k) {
                            componentsByDate[k].sort(function (a, b) { return a.seq - b.seq; });
                        });

                        // unique reference positions across all month formulas
                        var refPositions = [];
                        posRows.forEach(function (r) {
                            if (!r.formula) {
                                return;
                            }
                            var p = formulaParser.parseFormula(r.formula);
                            if (p.status === "SUPPORTED") {
                                p.terms.forEach(function (t) {
                                    if (refPositions.indexOf(t.refPosition) < 0) {
                                        refPositions.push(t.refPosition);
                                    }
                                });
                            }
                        });

                        var refFetch;
                        if (refPositions.length === 0) {
                            refFetch = Promise.resolve([]);
                        } else {
                            refFetch = service.readSourceRows({
                                plant: PLANT,
                                positions: refPositions,
                                fromDate: contextStart,
                                toDate: yearEnd
                            });
                        }

                        return refFetch.then(function (refRawRows) {
                            // raw rows in, buildSourceIndex normalizes internally
                            var refIndex = service.buildSourceIndex(refRawRows);

                            var months = [];
                            for (var m = 1; m <= 12; m++) {
                                var range = monthRange(year, m);
                                var monthRows = byMonth.get(m) || [];
                                var calc;
                                if (monthRows.length === 0) {
                                    calc = {
                                        pos: pos, workshop: "", descr: "", uom: "",
                                        pastMeasurement: null, formula: "",
                                        adjJs: "", sugJs: "", adjAbap: "", sugAbap: "",
                                        status: "NO DATA", state: "None",
                                        notes: ["NO DATA"], detail: null
                                    };
                                } else {
                                    calc = calculatePositionPeriod({
                                        pos: pos,
                                        posRows: posRows,
                                        refIndex: refIndex,
                                        abapComponentsByDate: componentsByDate,
                                        rangeStart: range.start,
                                        rangeEnd: range.end,
                                        caps: caps,
                                        descrNotExposed: descrNotExposed
                                    });
                                    if (descrNotExposed) {
                                        calc.notes.push("DESCRIPTION NOT EXPOSED BY SERVICE");
                                    }
                                }
                                calc.month = m;
                                calc.monthLabel = MONTH_NAMES[m - 1] + " " + year;
                                months.push(calc);
                            }

                            // header context from the latest available row
                            var lastRow = posRows.length ? posRows[posRows.length - 1] : null;
                            var header = {
                                pos: pos,
                                descr: lastRow ? lastRow.descr : "",
                                workshop: lastRow ? lastRow.workshop : "",
                                uom: lastRow ? (lastRow.uom || "") : "",
                                descrNotExposed: descrNotExposed,
                                year: year
                            };

                            return { months: months, header: header, caps: caps, plant: PLANT };
                        });
                    });
            });
        }

        return {
            buildCurrentMonthReport: buildCurrentMonthReport,
            buildYearReport: buildYearReport,
            detectCapabilities: detectCapabilities,
            clearCache: clearCache,
            PLANT: PLANT
        };
    }

    return {
        createReportService: createReportService,
        PLANT: PLANT
    };
});
