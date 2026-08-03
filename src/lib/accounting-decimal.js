'use strict';

/*
 * Accounting fixed-scale decimal model.
 *
 * Quantities and unit costs are represented as signed BigInt values with an
 * explicit scale. Allocation values are rounded HALF_AWAY_FROM_ZERO to two
 * decimal places. Mongo rows store the canonical decimal strings; JavaScript
 * Number fields are retained only as non-authoritative UI compatibility data.
 */
const QUANTITY_SCALE = 6;
const UNIT_COST_SCALE = 6;
const MONEY_SCALE = 2;
const ROUNDING_MODE = 'HALF_AWAY_FROM_ZERO';

function fail(value) {
  const error = new Error(`Invalid accounting decimal: ${String(value)}`);
  error.code = 'ACCOUNTING_DECIMAL_INVALID';
  throw error;
}

function plainDecimal(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value == null || value === '') return '0';
  let text = String(value).trim().replace(/[,،\s]/g, '');
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) fail(value);
  if (!/[eE]/.test(text)) return text;
  const number = Number(text);
  if (!Number.isFinite(number)) fail(value);
  text = number.toLocaleString('en-US', {
    useGrouping:false,
    maximumSignificantDigits:21
  });
  if (/[eE]/.test(text)) fail(value);
  return text;
}

function pow10(scale) {
  return 10n ** BigInt(scale);
}

function divideRounded(numerator, denominator) {
  if (denominator === 0n) fail('division-by-zero');
  const negative = (numerator < 0n) !== (denominator < 0n);
  let n = numerator < 0n ? -numerator : numerator;
  let d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;
  const remainder = n % d;
  if (remainder * 2n >= d) quotient += 1n;
  return negative ? -quotient : quotient;
}

function parse(value, scale) {
  const text = plainDecimal(value);
  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const padded = (fraction + '0'.repeat(scale + 1)).slice(0, scale + 1);
  let scaled = BigInt(whole || '0') * pow10(scale) + BigInt(padded.slice(0, scale) || '0');
  if (Number(padded[scale] || 0) >= 5) scaled += 1n;
  return negative ? -scaled : scaled;
}

function rescale(value, fromScale, toScale) {
  if (fromScale === toScale) return value;
  if (fromScale < toScale) return value * pow10(toScale - fromScale);
  return divideRounded(value, pow10(fromScale - toScale));
}

function multiply(left, leftScale, right, rightScale, outputScale) {
  return rescale(left * right, leftScale + rightScale, outputScale);
}

function format(value, scale, trim = false) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = pow10(scale);
  const whole = absolute / base;
  const fraction = (absolute % base).toString().padStart(scale, '0');
  const suffix = scale ? `.${trim ? fraction.replace(/0+$/, '') : fraction}` : '';
  const normalized = suffix === '.' ? '' : suffix;
  return `${negative ? '-' : ''}${whole}${normalized}`;
}

function toNumber(value, scale) {
  return Number(format(value, scale, true));
}

function allocation(quantity, unitCost) {
  const quantityScaled = parse(quantity, QUANTITY_SCALE);
  const unitCostScaled = parse(unitCost, UNIT_COST_SCALE);
  const valueScaled = multiply(quantityScaled, QUANTITY_SCALE, unitCostScaled, UNIT_COST_SCALE, MONEY_SCALE);
  return {
    quantityScaled,
    unitCostScaled,
    valueScaled,
    quantityExact:format(quantityScaled, QUANTITY_SCALE),
    unitCostExact:format(unitCostScaled, UNIT_COST_SCALE),
    allocationValueExact:format(valueScaled, MONEY_SCALE)
  };
}

function sumExact(values, scale) {
  return values.reduce((sum, value) => sum + parse(value, scale), 0n);
}

module.exports = {
  QUANTITY_SCALE,
  UNIT_COST_SCALE,
  MONEY_SCALE,
  ROUNDING_MODE,
  parse,
  format,
  rescale,
  multiply,
  divideRounded,
  allocation,
  sumExact,
  toNumber
};
