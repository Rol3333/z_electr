/*!
 * zelectr/parser/formulaTokenizer.js
 *
 * Tokenizer for electricity-counter balancing formulas.
 *
 * Token types:
 *   NUMBER  - decimal literal, dot or comma fractional separator ("20", "0,66")
 *   REF     - a position reference including its P() wrapper ("P(bTP-13_k06)");
 *             the reference name is captured verbatim, hyphens included
 *   FUNC    - an unsupported function call opener ("IF(", "S(")
 *   IDENT   - any other identifier (always a syntax error at parser level)
 *   LPAREN / RPAREN
 *   PLUS / MINUS / STAR / SLASH
 *   COMMA   - argument separator (only valid inside unsupported function
 *             calls such as IF(...)/S(...); the parser rejects it elsewhere)
 *   INVALID - a character the formula language does not define
 *
 * Context rule for hyphens: a hyphen is part of a reference name only inside
 * P(...). Outside of P(...) it is always the subtraction operator. This keeps
 * "P(bTP-13_k06)" one reference while "P(A)-P(B)" stays a subtraction, and
 * satisfies regression case 5 ("P(position-name)") without ambiguity.
 */
sap.ui.define([], function () {
    "use strict";

    var TOKEN = {
        NUMBER: "NUMBER",
        REF: "REF",
        FUNC: "FUNC",
        IDENT: "IDENT",
        LPAREN: "LPAREN",
        RPAREN: "RPAREN",
        COMMA: "COMMA",
        PLUS: "PLUS",
        MINUS: "MINUS",
        STAR: "STAR",
        SLASH: "SLASH",
        INVALID: "INVALID"
    };

    function isDigit(ch) {
        return ch >= "0" && ch <= "9";
    }

    function isIdentStart(ch) {
        return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
    }

    function isRefChar(ch) {
        return isDigit(ch) || isIdentStart(ch) || ch === "-";
    }

    /**
     * Tokenizes the whole formula string.
     *
     * @param {string} formula raw formula text
     * @returns {object[]} array of tokens {type, value, start, end}
     *   (start/end are 0-based offsets into the formula string)
     */
    function tokenize(formula) {
        var tokens = [];
        var s = String(formula == null ? "" : formula);
        var i = 0;

        while (i < s.length) {
            var ch = s.charAt(i);

            // whitespace
            if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
                i++;
                continue;
            }

            var start = i;

            // number: digits with optional dot/comma fraction (only when a
            // digit follows the separator, so "P(A),P(B)" cannot merge)
            if (isDigit(ch)) {
                var j = i + 1;
                while (j < s.length && isDigit(s.charAt(j))) {
                    j++;
                }
                if ((s.charAt(j) === "." || s.charAt(j) === ",") && isDigit(s.charAt(j + 1))) {
                    j++; // separator
                    while (j < s.length && isDigit(s.charAt(j))) {
                        j++;
                    }
                }
                tokens.push({ type: TOKEN.NUMBER, value: s.substring(i, j), start: i, end: j });
                i = j;
                continue;
            }

            // identifier / function / reference
            if (isIdentStart(ch)) {
                var k = i + 1;
                while (k < s.length && (isDigit(s.charAt(k)) || isIdentStart(s.charAt(k)))) {
                    k++;
                }
                var name = s.substring(i, k);
                if (name === "P" && s.charAt(k) === "(") {
                    // reference: read the verbatim name inside P( ... )
                    var m = k + 1;
                    while (m < s.length && isRefChar(s.charAt(m))) {
                        m++;
                    }
                    if (s.charAt(m) === ")") {
                        tokens.push({
                            type: TOKEN.REF,
                            value: s.substring(k + 1, m),
                            start: i,
                            end: m + 1
                        });
                        i = m + 1;
                        continue;
                    }
                    // unterminated P( - emit a plain identifier so the parser
                    // reports a syntax error (never a partial parse)
                    tokens.push({ type: TOKEN.IDENT, value: name, start: i, end: k });
                    i = k;
                    continue;
                }
                if ((name === "IF" || name === "S") && s.charAt(k) === "(") {
                    tokens.push({ type: TOKEN.FUNC, value: name, start: i, end: k });
                    i = k;
                    continue;
                }
                tokens.push({ type: TOKEN.IDENT, value: name, start: i, end: k });
                i = k;
                continue;
            }

            // single-character tokens
            switch (ch) {
                case "(":
                    tokens.push({ type: TOKEN.LPAREN, value: ch, start: i, end: i + 1 });
                    break;
                case ")":
                    tokens.push({ type: TOKEN.RPAREN, value: ch, start: i, end: i + 1 });
                    break;
                case ",":
                    tokens.push({ type: TOKEN.COMMA, value: ch, start: i, end: i + 1 });
                    break;
                case "+":
                    tokens.push({ type: TOKEN.PLUS, value: ch, start: i, end: i + 1 });
                    break;
                case "-":
                    tokens.push({ type: TOKEN.MINUS, value: ch, start: i, end: i + 1 });
                    break;
                case "*":
                    tokens.push({ type: TOKEN.STAR, value: ch, start: i, end: i + 1 });
                    break;
                case "/":
                    tokens.push({ type: TOKEN.SLASH, value: ch, start: i, end: i + 1 });
                    break;
                default:
                    tokens.push({ type: TOKEN.INVALID, value: ch, start: i, end: i + 1 });
                    break;
            }
            i++;
        }

        return tokens;
    }

    return {
        TOKEN: TOKEN,
        tokenize: tokenize
    };
});
