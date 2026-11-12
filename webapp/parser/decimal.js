/*!
 * zelectr/parser/decimal.js
 *
 * Small exact-decimal arithmetic helper used by the formula parser and the
 * calculation engine. It is intentionally dependency-free: values are stored
 * as a BigInt mantissa plus an integer scale, i.e. value = mantissa / 10^scale.
 *
 * Why: JavaScript numbers (IEEE 754 doubles) cannot represent values such as
 * 0.66 or 13252.120 exactly. The brief (section 5.3) requires that decimal
 * literals are parsed without losing precision prematurely and that
 * contributions are never rounded before the final sum. BigInt arithmetic
 * keeps every intermediate value exact; only division introduces a bounded,
 * documented rounding step (see DIV_PRECISION).
 *
 * Supported surface (only what the parser/calculation engine needs):
 *   Decimal.fromString("0,66") / Decimal.fromNumber(20) / Decimal.zero()
 *   add, sub, mul, div, neg, abs, cmp, isZero, isNegative
 *   toString()   - exact, no exponent, trailing zeros trimmed
 *   toNumber()   - for UI binding only (may lose precision, display boundary)
 */
sap.ui.define([], function () {
    "use strict";

    /**
     * Scale used for division results. Division is the only operation that
     * can produce an infinite decimal expansion; results are truncated (not
     * rounded) to this many fractional digits, which is far beyond the
     * precision exposed by the OData service (max scale 6 on Contribution).
     */
    var DIV_PRECISION = 12;

    function pow10(n) {
        var r = 1n;
        var b = 10n;
        while (n > 0) {
            if (n & 1) {
                r *= b;
            }
            b *= b;
            n >>= 1;
        }
        return r;
    }

    function gcd(a, b) {
        a = a < 0n ? -a : a;
        b = b < 0n ? -b : b;
        while (b) {
            var t = a % b;
            a = b;
            b = t;
        }
        return a;
    }

    /**
     * A decimal value: mantissa / 10^scale. Never construct directly;
     * use the factory functions.
     *
     * @param {bigint} mantissa signed mantissa
     * @param {number} scale    non-negative number of fractional digits
     * @constructor
     */
    function Decimal(mantissa, scale) {
        this.mantissa = mantissa;
        this.scale = scale;
    }

    /**
     * Creates a Decimal from a string with dot or comma decimal separator.
     * Leading/trailing whitespace is ignored. Underscores are not accepted.
     *
     * @param {string} s raw literal, e.g. "0,66", "-13.252120", "20"
     * @returns {module:zelectr/parser/decimal} exact decimal value
     * @throws {Error} if the string is not a valid decimal literal
     */
    Decimal.fromString = function (s) {
        var str = String(s).trim();
        var match = /^([+-]?)(\d*)(?:[.,](\d*))?$/.exec(str);
        if (!match || (match[2] === "" && (match[3] === undefined || match[3] === ""))) {
            throw new Error("Not a valid decimal literal: '" + s + "'");
        }
        var sign = match[1] === "-" ? -1n : 1n;
        var intPart = match[2] || "0";
        var fracPart = match[3] || "";
        var mantissa = sign * BigInt(intPart + fracPart);
        return new Decimal(mantissa, fracPart.length);
    };

    /**
     * Creates a Decimal from a JavaScript number. Only intended for
     * integer-ish inputs (multipliers coming from UI state); the number is
     * converted via its shortest round-tripping string representation.
     *
     * @param {number} n number to convert
     * @returns {module:zelectr/parser/decimal} exact decimal value
     */
    Decimal.fromNumber = function (n) {
        if (typeof n !== "number" || !isFinite(n)) {
            throw new Error("Not a finite number: " + n);
        }
        return Decimal.fromString(String(n));
    };

    Decimal.zero = function () {
        return new Decimal(0n, 0);
    };

    Decimal.fromBigInt = function (bigintValue, scale) {
        return new Decimal(bigintValue, scale || 0);
    };

    /** Aligns two decimals to the larger scale. */
    function align(a, b) {
        var scale = Math.max(a.scale, b.scale);
        return [
            a.mantissa * pow10(scale - a.scale),
            b.mantissa * pow10(scale - b.scale),
            scale
        ];
    }

    Decimal.prototype.add = function (other) {
        var a = align(this, other);
        return new Decimal(a[0] + a[1], a[2]);
    };

    Decimal.prototype.sub = function (other) {
        var a = align(this, other);
        return new Decimal(a[0] - a[1], a[2]);
    };

    Decimal.prototype.mul = function (other) {
        return new Decimal(this.mantissa * other.mantissa, this.scale + other.scale);
    };

    /**
     * Divides this value by another. The result is truncated to
     * DIV_PRECISION fractional digits (documented bounded rounding).
     *
     * @param {module:zelectr/parser/decimal} other divisor
     * @returns {module:zelectr/parser/decimal} quotient
     * @throws {Error} on division by zero
     */
    Decimal.prototype.div = function (other) {
        if (other.isZero()) {
            throw new Error("Division by zero");
        }
        // Scale the dividend so the quotient carries DIV_PRECISION fractional
        // digits beyond the natural scales of both operands.
        var targetScale = this.scale + DIV_PRECISION;
        var scaledDividend = this.mantissa * pow10(targetScale - this.scale + other.scale);
        var quotient = scaledDividend / other.mantissa; // BigInt division truncates toward zero
        return new Decimal(quotient, targetScale);
    };

    Decimal.prototype.neg = function () {
        return new Decimal(-this.mantissa, this.scale);
    };

    Decimal.prototype.abs = function () {
        return new Decimal(this.mantissa < 0n ? -this.mantissa : this.mantissa, this.scale);
    };

    /**
     * Compares this value with another.
     *
     * @param {module:zelectr/parser/decimal} other value to compare with
     * @returns {number} -1, 0 or 1
     */
    Decimal.prototype.cmp = function (other) {
        var a = align(this, other);
        if (a[0] < a[1]) {
            return -1;
        }
        if (a[0] > a[1]) {
            return 1;
        }
        return 0;
    };

    Decimal.prototype.isZero = function () {
        return this.mantissa === 0n;
    };

    Decimal.prototype.isNegative = function () {
        return this.mantissa < 0n;
    };

    /**
     * Exact string representation without exponent notation, trailing zeros
     * in the fractional part trimmed ("0.660" -> "0.66", "20" -> "20").
     *
     * @returns {string} decimal string with dot separator
     */
    Decimal.prototype.toString = function () {
        var mantissa = this.mantissa;
        var sign = mantissa < 0n ? "-" : "";
        mantissa = mantissa < 0n ? -mantissa : mantissa;
        var s = mantissa.toString();
        if (this.scale === 0) {
            return sign + s;
        }
        while (s.length <= this.scale) {
            s = "0" + s;
        }
        var intPart = s.substring(0, s.length - this.scale);
        var fracPart = s.substring(s.length - this.scale).replace(/0+$/, "");
        return fracPart.length ? sign + intPart + "." + fracPart : sign + intPart;
    };

    /**
     * Converts to a JavaScript number for UI display only. This is a display
     * boundary conversion and may lose precision; internal calculations never
     * pass through this method.
     *
     * @returns {number} approximate double value
     */
    Decimal.prototype.toNumber = function () {
        return parseFloat(this.toString());
    };

    /**
     * Reduces the fraction mantissa/10^scale to lowest terms and returns it
     * as { num: bigint, den: bigint }. Used for diagnostics/explanations.
     *
     * @returns {object} numerator/denominator pair
     */
    Decimal.prototype.toFraction = function () {
        var den = pow10(this.scale);
        var num = this.mantissa;
        var g = gcd(num, den);
        if (g > 1n) {
            num /= g;
            den /= g;
        }
        return { num: num, den: den };
    };

    return Decimal;
});
