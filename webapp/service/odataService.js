/*!
 * zelectr/service/odataService.js
 *
 * Read-only data access for the three entity sets of the OData V2 service
 * Z_BIND_ELECTR_CNT_001 (brief section 2/8):
 *
 *   Z_C_ELECR_VALIDATE      - parent position, formula, stored quantities
 *   Z_C_ELECR_VALIDATE_REF  - backend parsed formula components (lowercase keys)
 *   Z_I_ELECR_CNTR          - daily position quantities (source rows)
 *
 * Design notes:
 * - Wraps the callback-based v2 ODataModel.read() in Promises (read() does
 *   NOT return a native Promise).
 * - Follows server paging: if the response contains __next, the $skiptoken
   is extracted and the read is repeated - no unbounded $top is used.
 * - Edm.DateTime filters are built as datetime'yyyy-MM-ddT00:00:00'
 *   literals directly from calendar fields, so no JS Date/timezone
 *   conversion can shift a filter date to the previous/next day.
 * - String literals in $filter are escaped (apostrophes doubled).
 * - Reference-position source reads are chunked and executed with limited
 *   concurrency (default 3) instead of firing hundreds of requests.
 * - GET only; the model is configured read-only in the metadata.
 */
sap.ui.define([
    "zelectr/parser/decimal",
    "zelectr/service/performanceDiagnostics"
], function (Decimal, perf) {
    "use strict";

    var DEFAULT_CONCURRENCY = 3;
    var POSITIONS_PER_CHUNK = 8;

    function escapeLiteral(s) {
        return String(s).replace(/'/g, "''");
    }

    /** Builds an OData V2 datetime filter literal from calendar fields. */
    function dateTimeLiteral(year, month1based, day) {
        var m = String(month1based).padStart(2, "0");
        var d = String(day).padStart(2, "0");
        return "datetime'" + year + "-" + m + "-" + d + "T00:00:00'";
    }

    /**
     * Normalizes an Edm.DateTime value (already a JS Date on the v2 model)
     * to an ISO date string. Uses LOCAL calendar getters: SAP Gateway
     * serializes date-only values as midnight in the SERVER timezone; when
     * the browser timezone matches the server timezone (the supported
     * scenario for this app) local getters recover the intended calendar
     * date. Documented as a limitation in the README.
     *
     * @param {Date} oDate date from the OData response
     * @returns {string} "yyyy-MM-dd"
     */
    function toIsoDate(oDate) {
        return oDate.getFullYear() +
            "-" + String(oDate.getMonth() + 1).padStart(2, "0") +
            "-" + String(oDate.getDate()).padStart(2, "0");
    }

    /**
     * Creates the service facade.
     *
     * @param {sap.ui.model.odata.v2.ODataModel} oModel the shared V2 model
     * @returns {object} service facade
     */
    function createService(oModel) {

        /**
         * Promise wrapper around ODataModel.read with paging continuation.
         *
         * @param {string} sPath entity set path
         * @param {object} mUrlParameters URL parameters ($filter, $select...)
         * @returns {Promise<object[]>} all result rows across pages
         */
        function readAll(sPath, mUrlParameters) {
            var params = Object.assign({}, mUrlParameters);
            var allRows = [];
            var pageCount = 0;

            function readPage() {
                var pageStart = performance.now();
                return new Promise(function (resolve, reject) {
                    oModel.read(sPath, {
                        urlParameters: params,
                        success: function (oData) {
                            resolve(oData);
                        },
                        error: function (oError) {
                            var msg = "OData read failed for " + sPath;
                            if (oError && oError.message) {
                                msg += ": " + oError.message;
                            }
                            reject(new Error(msg));
                        }
                    });
                }).then(function (oData) {
                    pageCount++;
                    var pageRecords = (oData && Array.isArray(oData.results)) ? oData.results.length : 0;
                    if (oData && Array.isArray(oData.results)) {
                        allRows = allRows.concat(oData.results);
                    }
                    // server paging: follow __next via $skiptoken
                    var next = oData && oData.__next;
                    var hasNext = false;
                    if (next) {
                        var match = /([?&])\$skiptoken=([^&]*)/.exec(next);
                        if (match) {
                            hasNext = true;
                            params.$skiptoken = decodeURIComponent(match[2]);
                        }
                    }
                    // per-page diagnostics (counts/durations only, no URLs)
                    perf.logODataPage(null, {
                        pageIndex: pageCount,
                        durationMs: performance.now() - pageStart,
                        records: pageRecords,
                        hasNext: hasNext,
                        status: "success"
                    });
                    if (hasNext) {
                        return readPage();
                    }
                    return allRows;
                }).catch(function (err) {
                    perf.logError(null, "readAll page " + (pageCount + 1) + " (" + sPath + ")", err);
                    throw err;
                });
            }

            return readPage();
        }

        /**
         * Runs promise-producing functions with limited concurrency.
         *
         * @param {function[]} fns functions returning Promises
         * @param {number} limit max concurrent promises
         * @returns {Promise<object[]>} results in input order
         */
        function runWithConcurrency(fns, limit) {
            var results = new Array(fns.length);
            var index = 0;
            var active = 0;

            return new Promise(function (resolve, reject) {
                var failed = false;

                function launchNext() {
                    if (failed) {
                        return;
                    }
                    while (active < limit && index < fns.length) {
                        (function (i) {
                            active++;
                            fns[i]().then(function (res) {
                                results[i] = res;
                                active--;
                                if (index >= fns.length && active === 0) {
                                    resolve(results);
                                } else {
                                    launchNext();
                                }
                            }, function (err) {
                                failed = true;
                                reject(err);
                            });
                        })(index);
                        index++;
                    }
                    if (index >= fns.length && active === 0 && !failed) {
                        resolve(results);
                    }
                }

                if (fns.length === 0) {
                    resolve([]);
                } else {
                    launchNext();
                }
            });
        }

        /**
         * Reads parent rows (Z_C_ELECR_VALIDATE) for plant/position/month.
         * Plant and Pos carry sap:display-format="UpperCase"; if the exact
         * position returns nothing, the read is retried once with the
         * uppercased position (reported via posUsed so the UI can say so).
         *
         * @param {object} selection {plant, pos, year, month (1-12)}
         * @returns {Promise<object>} {rows, posUsed, filter}
         */
        function readParents(selection) {
            var opStart = performance.now();
            var pages = 0;
            function once(pos) {
                var lastDay = new Date(Date.UTC(selection.year, selection.month, 0)).getUTCDate();
                var filter = "Plant eq '" + escapeLiteral(selection.plant) + "'" +
                    " and Pos eq '" + escapeLiteral(pos) + "'" +
                    " and ValidDate ge " + dateTimeLiteral(selection.year, selection.month, 1) +
                    " and ValidDate le " + dateTimeLiteral(selection.year, selection.month, lastDay);
                return readAll("/Z_C_ELECR_VALIDATE", {
                    $filter: filter,
                    $select: "Plant,Pos,ValidDate,ManualEntry,Formula,UnitOfMeasure,StoredSuggestedQuantity,StoredAdjustedQuantity,ComputedQuantity",
                    $format: "json"
                }).then(function (rows) {
                    return { rows: rows, posUsed: pos, filter: filter };
                });
            }
            return once(selection.pos).then(function (res) {
                if (res.rows.length === 0 && selection.pos.toUpperCase() !== selection.pos) {
                    // uppercase retry - make it visible in diagnostics
                    var retryStart = performance.now();
                    perf.logODataOperation(null, {
                        label: "readParents (uppercase retry)",
                        entity: "/Z_C_ELECR_VALIDATE",
                        status: "retry",
                        records: res.rows.length
                    });
                    return once(selection.pos.toUpperCase()).then(function (retryRes) {
                        perf.logODataOperation(null, {
                            label: "readParents (uppercase retry result)",
                            entity: "/Z_C_ELECR_VALIDATE",
                            durationMs: performance.now() - retryStart,
                            records: retryRes.rows.length,
                            status: retryRes.rows.length ? "success" : "empty"
                        });
                        return retryRes;
                    });
                }
                return res;
            }).then(function (res) {
                perf.logODataOperation(null, {
                    label: "readParents",
                    entity: "/Z_C_ELECR_VALIDATE",
                    durationMs: performance.now() - opStart,
                    records: res.rows.length,
                    status: res.rows.length ? "success" : "empty"
                });
                return res;
            }).catch(function (err) {
                perf.logError(null, "readParents", err);
                throw err;
            });
        }

        /**
         * Reads backend parsed components (Z_C_ELECR_VALIDATE_REF) for the
         * same parent key range. Lowercase key property names per metadata.
         *
         * @param {object} selection {plant, pos, year, month (1-12)}
         * @returns {Promise<object[]>} raw component rows
         */
        function readRefComponents(selection) {
            var lastDay = new Date(Date.UTC(selection.year, selection.month, 0)).getUTCDate();
            return readRefComponentsRange(selection.plant, selection.pos,
                selection.year + "-" + String(selection.month).padStart(2, "0") + "-01",
                selection.year + "-" + String(selection.month).padStart(2, "0") + "-" + String(lastDay).padStart(2, "0"));
        }

        /**
         * Reads backend parsed components for a plant (optionally one
         * position) over an ISO date range.
         *
         * @param {string} plant plant id
         * @param {string|null} pos position id or null for all positions
         * @param {string} fromDate "yyyy-MM-dd"
         * @param {string} toDate "yyyy-MM-dd"
         * @returns {Promise<object[]>} raw component rows
         */
        function readRefComponentsRange(plant, pos, fromDate, toDate) {
            var opStart = performance.now();
            var from = parseIso(fromDate);
            var to = parseIso(toDate);
            var filter = "plant eq '" + escapeLiteral(plant) + "'" +
                (pos ? " and pos eq '" + escapeLiteral(pos) + "'" : "") +
                " and valid_date ge " + dateTimeLiteral(from.year, from.month, from.day) +
                " and valid_date le " + dateTimeLiteral(to.year, to.month, to.day);
            return readAll("/Z_C_ELECR_VALIDATE_REF", {
                $filter: filter,
                $select: "plant,pos,valid_date,manual_entry,seq,sign,ref_position,multiplier,divisor,UnitOfMeasure,RefSuggestedValue,RefAdjustedValue,Contribution,RefStatus",
                $format: "json"
            }).then(function (rows) {
                perf.logODataOperation(null, {
                    label: "readRefComponents",
                    entity: "/Z_C_ELECR_VALIDATE_REF",
                    durationMs: performance.now() - opStart,
                    records: rows.length,
                    status: rows.length ? "success" : "empty"
                });
                return rows;
            }).catch(function (err) {
                perf.logError(null, "readRefComponents", err);
                throw err;
            });
        }

        /**
         * Reads ALL source rows (Z_I_ELECR_CNTR) of a plant over an ISO date
         * range (no position filter) - used by the all-positions report.
         *
         * @param {string} plant plant id
         * @param {string} fromDate "yyyy-MM-dd"
         * @param {string} toDate "yyyy-MM-dd"
         * @param {string[]} selectFields property names to request
         * @returns {Promise<object[]>} raw source rows
         */
        function readSourceRowsRange(plant, fromDate, toDate, selectFields) {
            var opStart = performance.now();
            var from = parseIso(fromDate);
            var to = parseIso(toDate);
            var filter = "Plant eq '" + escapeLiteral(plant) + "'" +
                " and ValidDate ge " + dateTimeLiteral(from.year, from.month, from.day) +
                " and ValidDate le " + dateTimeLiteral(to.year, to.month, to.day);
            return readAll("/Z_I_ELECR_CNTR", {
                $filter: filter,
                $select: (selectFields || []).join(","),
                $format: "json"
            }).then(function (rows) {
                perf.logODataOperation(null, {
                    label: "readSourceRowsRange",
                    entity: "/Z_I_ELECR_CNTR",
                    durationMs: performance.now() - opStart,
                    records: rows.length,
                    status: rows.length ? "success" : "empty"
                });
                return rows;
            }).catch(function (err) {
                perf.logError(null, "readSourceRowsRange", err);
                throw err;
            });
        }

        /**
         * Reads source rows (Z_I_ELECR_CNTR) for the given reference
         * positions, plant and date range. Positions are chunked to keep
         * URLs short; chunks run with limited concurrency.
         *
         * @param {object} params {plant, positions: string[], fromDate: "yyyy-MM-dd", toDate: "yyyy-MM-dd"}
         * @returns {Promise<object[]>} raw source rows
         */
        function readSourceRows(params) {
            var opStart = performance.now();
            var positions = params.positions || [];
            var chunks = [];
            for (var i = 0; i < positions.length; i += POSITIONS_PER_CHUNK) {
                chunks.push(positions.slice(i, i + POSITIONS_PER_CHUNK));
            }
            var from = parseIso(params.fromDate);
            var to = parseIso(params.toDate);
            var selectFields = params.selectFields || [
                "Plant", "Pos", "ValidDate", "ManualEntry",
                "SuggestedQuantity", "AdjustedQuantity", "UnitOfMeasure", "Formula"
            ];
            var failedChunks = 0;
            var fns = chunks.map(function (chunk, chunkIndex) {
                return function () {
                    var chunkStart = performance.now();
                    var posFilter = chunk.map(function (p) {
                        return "Pos eq '" + escapeLiteral(p) + "'";
                    }).join(" or ");
                    var filter = "Plant eq '" + escapeLiteral(params.plant) + "'" +
                        " and (" + posFilter + ")" +
                        " and ValidDate ge " + dateTimeLiteral(from.year, from.month, from.day) +
                        " and ValidDate le " + dateTimeLiteral(to.year, to.month, to.day);
                    return readAll("/Z_I_ELECR_CNTR", {
                        $filter: filter,
                        $select: selectFields.join(","),
                        $format: "json"
                    }).then(function (rows) {
                        perf.logODataChunk(null, {
                            chunkIndex: chunkIndex + 1,
                            chunkTotal: chunks.length,
                            positions: chunk.length,
                            records: rows.length,
                            durationMs: performance.now() - chunkStart,
                            status: "success"
                        });
                        return rows;
                    }).catch(function (err) {
                        failedChunks++;
                        perf.logODataChunk(null, {
                            chunkIndex: chunkIndex + 1,
                            chunkTotal: chunks.length,
                            positions: chunk.length,
                            records: 0,
                            durationMs: performance.now() - chunkStart,
                            status: "failed"
                        });
                        throw err;
                    });
                };
            });
            return runWithConcurrency(fns, DEFAULT_CONCURRENCY).then(function (chunkResults) {
                var allRows = [].concat.apply([], chunkResults);
                perf.logODataOperation(null, {
                    label: "readSourceRows",
                    entity: "/Z_I_ELECR_CNTR",
                    durationMs: performance.now() - opStart,
                    records: allRows.length,
                    pages: undefined,
                    chunks: chunks.length,
                    chunkSize: POSITIONS_PER_CHUNK,
                    concurrency: DEFAULT_CONCURRENCY,
                    positions: positions.length,
                    status: failedChunks ? "partial (" + failedChunks + " failed chunks)" : "success"
                });
                return allRows;
            }).catch(function (err) {
                perf.logError(null, "readSourceRows", err);
                throw err;
            });
        }

        function parseIso(iso) {
            var parts = iso.split("-");
            return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10), day: parseInt(parts[2], 10) };
        }

        /**
         * Converts an Edm.Decimal string to an exact Decimal, tolerating
         * null/undefined and already-converted values.
         *
         * @param {string|number|null} v raw OData value
         * @returns {module:zelectr/parser/decimal|null} decimal or null
         */
        function toDecimal(v) {
            if (v === null || v === undefined || v === "") {
                return null;
            }
            try {
                return Decimal.fromString(String(v));
            } catch (e) {
                return null;
            }
        }

        /**
         * Builds the normalized in-memory source index used by the
         * reference resolver. Keeps ALL rows (automatic and manual) - no
         * duplicate discarding (brief 3.4/8.6).
         *
         * @param {object[]} rows raw Z_I_ELECR_CNTR rows
         * @returns {object} { byKey, byPosDate, rowsByPos }
         */
        function buildSourceIndex(rows) {
            var byKey = new Map();
            var byPosDate = new Map();
            var rowsByPos = new Map();

            (rows || []).forEach(function (r) {
                var iso = toIsoDate(r.ValidDate);
                var normalized = {
                    plant: r.Plant,
                    pos: r.Pos,
                    dateIso: iso,
                    date: r.ValidDate,
                    manualEntry: r.ManualEntry === true,
                    adjusted: toDecimal(r.AdjustedQuantity),
                    suggested: toDecimal(r.SuggestedQuantity),
                    uom: r.UnitOfMeasure || null,
                    formula: r.Formula || null,
                    raw: r
                };
                var key = [normalized.plant, normalized.pos, iso, normalized.manualEntry ? "true" : "false"].join("|");
                byKey.set(key, normalized);

                var posDateKey = [normalized.plant, normalized.pos, iso].join("|");
                if (!byPosDate.has(posDateKey)) {
                    byPosDate.set(posDateKey, []);
                }
                byPosDate.get(posDateKey).push(normalized);

                var posKey = [normalized.plant, normalized.pos].join("|");
                if (!rowsByPos.has(posKey)) {
                    rowsByPos.set(posKey, []);
                }
                rowsByPos.get(posKey).push(normalized);
            });

            // keep chronological order per position for previous-reading lookups
            rowsByPos.forEach(function (list) {
                list.sort(function (a, b) { return a.date.getTime() - b.date.getTime(); });
            });

            return { byKey: byKey, byPosDate: byPosDate, rowsByPos: rowsByPos };
        }

        return {
            readParents: readParents,
            readRefComponents: readRefComponents,
            readRefComponentsRange: readRefComponentsRange,
            readSourceRows: readSourceRows,
            readSourceRowsRange: readSourceRowsRange,
            buildSourceIndex: buildSourceIndex,
            toDecimal: toDecimal,
            toIsoDate: toIsoDate
        };
    }

    return {
        createService: createService,
        escapeLiteral: escapeLiteral,
        dateTimeLiteral: dateTimeLiteral
    };
});
