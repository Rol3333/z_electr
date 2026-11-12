/*!
 * zelectr/parser/formulaParser.js
 *
 * Recursive-descent parser for electricity-counter balancing formulas.
 *
 * Grammar (v1 supported subset):
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/') factor)*
 *   factor  := ('+' | '-') factor | primary
 *   primary := NUMBER | P(reference) | '(' expr ')' | FUNC '(' ... ')'
 *
 * The parser builds a full AST and requires the ENTIRE token stream to be
 * consumed (regression case 4: a malformed formula must be a syntax error,
 * never a partial parse). Linearization into reference terms is delegated to
 * linearizeExpression.js; this module assembles the public parse result.
 *
 * Public entry point: parseFormula(formula) -> parse result object
 * (see section 5.4 of the development brief for the contract).
 */
sap.ui.define([
    "zelectr/parser/formulaTokenizer",
    "zelectr/parser/linearizeExpression"
], function (Tokenizer, Linearizer) {
    "use strict";

    var TOKEN = Tokenizer.TOKEN;

    /**
     * Parses a formula and linearizes it into ordered reference terms.
     *
     * @param {string} formula raw formula text
     * @returns {object} parse result:
     *   { status, formula, terms, warnings, error, ast }
     *   status: SUPPORTED | UNSUPPORTED | SYNTAX_ERROR | EMPTY
     */
    function parseFormula(formula) {
        var raw = formula == null ? "" : String(formula);
        var result = {
            status: "SUPPORTED",
            formula: raw,
            terms: [],
            warnings: [],
            error: null,
            ast: null
        };

        if (raw.trim() === "") {
            result.status = "EMPTY";
            return result;
        }

        var tokens;
        try {
            tokens = Tokenizer.tokenize(raw);
        } catch (e) {
            result.status = "SYNTAX_ERROR";
            result.error = "Tokenizer failure: " + e.message;
            return result;
        }

        var invalid = tokens.filter(function (t) { return t.type === TOKEN.INVALID; });
        if (invalid.length > 0) {
            result.status = "SYNTAX_ERROR";
            result.error = "Invalid character(s) in formula: '" +
                invalid.map(function (t) { return t.value; }).join("', '") + "'";
            return result;
        }

        var parser = new Parser(tokens, raw);
        var ast;
        try {
            ast = parser.parseExpression();
            if (parser.pos < tokens.length) {
                var t = tokens[parser.pos];
                result.status = "SYNTAX_ERROR";
                result.error = "Unexpected token '" + t.value + "' at position " + t.start +
                    " - the whole formula must be a single valid expression";
                return result;
            }
        } catch (e) {
            result.status = "SYNTAX_ERROR";
            result.error = e.message;
            return result;
        }

        result.ast = ast;

        var lin = Linearizer.linearize(ast);
        if (lin.status === "UNSUPPORTED") {
            result.status = "UNSUPPORTED";
            result.error = lin.reason;
            return result;
        }

        result.terms = lin.terms;
        result.warnings = lin.warnings || [];
        return result;
    }

    // ----------------------------------------------------------------------

    function Parser(tokens, source) {
        this.tokens = tokens;
        this.source = source;
        this.pos = 0;
    }

    Parser.prototype.peek = function () {
        return this.pos < this.tokens.length ? this.tokens[this.pos] : null;
    };

    Parser.prototype.next = function () {
        var t = this.peek();
        if (t) {
            this.pos++;
        }
        return t;
    };

    Parser.prototype.expect = function (type, what) {
        var t = this.peek();
        if (!t) {
            throw new Error("Unexpected end of formula - expected " + what);
        }
        if (t.type !== type) {
            throw new Error("Expected " + what + " but found '" + t.value + "' at position " + t.start);
        }
        this.pos++;
        return t;
    };

    /** expr := term (('+' | '-') term)* */
    Parser.prototype.parseExpression = function () {
        var left = this.parseTerm();
        var t = this.peek();
        while (t && (t.type === TOKEN.PLUS || t.type === TOKEN.MINUS)) {
            this.next();
            var right = this.parseTerm();
            left = { type: "bin", op: t.value, left: left, right: right };
            t = this.peek();
        }
        return left;
    };

    /** term := factor (('*' | '/') factor)* */
    Parser.prototype.parseTerm = function () {
        var left = this.parseFactor();
        var t = this.peek();
        while (t && (t.type === TOKEN.STAR || t.type === TOKEN.SLASH)) {
            this.next();
            var right = this.parseFactor();
            left = { type: "bin", op: t.value, left: left, right: right };
            t = this.peek();
        }
        return left;
    };

    /** factor := ('+' | '-') factor | primary */
    Parser.prototype.parseFactor = function () {
        var t = this.peek();
        if (t && (t.type === TOKEN.PLUS || t.type === TOKEN.MINUS)) {
            this.next();
            var operand = this.parseFactor();
            return { type: "unary", op: t.value, operand: operand };
        }
        return this.parsePrimary();
    };

    /** primary := NUMBER | REF | '(' expr ')' | FUNC '(' ... ')' */
    Parser.prototype.parsePrimary = function () {
        var t = this.next();
        if (!t) {
            throw new Error("Unexpected end of formula - a number, P(...) reference or parenthesized expression was expected");
        }
        switch (t.type) {
            case TOKEN.NUMBER:
                return { type: "num", value: t.value, start: t.start, end: t.end };
            case TOKEN.REF:
                if (t.value === "") {
                    throw new Error("Empty P() reference at position " + t.start);
                }
                return { type: "ref", name: t.value, start: t.start, end: t.end };
            case TOKEN.LPAREN: {
                var inner = this.parseExpression();
                this.expect(TOKEN.RPAREN, "a closing parenthesis ')'");
                return { type: "group", operand: inner, start: t.start, end: inner.end };
            }
            case TOKEN.FUNC:
                // consume the argument list loosely; semantics are unsupported
                this.consumeBalanced();
                return { type: "func", name: t.value, start: t.start, end: t.end };
            case TOKEN.IDENT:
                throw new Error("Unknown identifier '" + t.value + "' at position " + t.start +
                    " - only P(...) references, numbers and + - * / ( ) are allowed");
            default:
                throw new Error("Unexpected token '" + t.value + "' at position " + t.start);
        }
    };

    /** Skips a balanced parenthesized argument list (for unsupported FUNC). */
    Parser.prototype.consumeBalanced = function () {
        this.expect(TOKEN.LPAREN, "'(' after function name");
        var depth = 1;
        while (depth > 0) {
            var t = this.next();
            if (!t) {
                throw new Error("Unexpected end of formula inside function arguments");
            }
            if (t.type === TOKEN.LPAREN) {
                depth++;
            } else if (t.type === TOKEN.RPAREN) {
                depth--;
            }
        }
    };

    return {
        parseFormula: parseFormula
    };
});
