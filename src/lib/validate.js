/**
 * Validation — deliberately tiny and dependency-free.
 * Collect every problem first so the user sees all of them at once instead
 * of fixing one field per round-trip.
 */
'use strict';

const { ApiError } = require('./errors');

class Bag {
  constructor() {
    this.fields = {};
    this.has = false;
  }

  add(field, message) {
    this.fields[field] = message;
    this.has = true;
    return undefined;
  }

  throwIfAny(prefix = 'Please fix the highlighted fields.') {
    if (this.has) throw new ApiError(400, 'VALIDATION_ERROR', prefix, { fields: this.fields });
  }
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Required string. */
function str(value, field, bag, { min = 0, max = 10000, trim = true } = {}) {
  if (isBlank(value)) return bag.add(field, 'This field is required.');
  if (typeof value !== 'string') return bag.add(field, 'Must be text.');
  const v = trim ? value.trim() : value;
  if (v.length < min) return bag.add(field, `Must be at least ${min} characters.`);
  if (v.length > max) return bag.add(field, `Must be at most ${max} characters.`);
  return v;
}

/** Optional string → trimmed string or null. */
function optStr(value, field, bag, opts = {}) {
  if (isBlank(value)) return null;
  return str(value, field, bag, opts);
}

function email(value, field, bag) {
  const v = str(value, field, bag, { max: 254 });
  if (v === undefined) return undefined;
  const lower = v.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) {
    return bag.add(field, 'Enter a valid email address.');
  }
  return lower;
}

function enumOf(value, field, bag, allowed) {
  if (isBlank(value)) return bag.add(field, 'This field is required.');
  if (!allowed.includes(value)) return bag.add(field, `Must be one of: ${allowed.join(', ')}.`);
  return value;
}

function optEnum(value, field, bag, allowed) {
  if (isBlank(value)) return null;
  return enumOf(value, field, bag, allowed);
}

function intNum(value, field, bag, { min = -Infinity, max = Infinity, required = false } = {}) {
  if (isBlank(value)) {
    if (required) return bag.add(field, 'This field is required.');
    return null;
  }
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return bag.add(field, 'Must be a whole number.');
  if (n < min || n > max) return bag.add(field, `Must be between ${min} and ${max}.`);
  return n;
}

function num(value, field, bag, { min = -Infinity, max = Infinity, required = false } = {}) {
  if (isBlank(value)) {
    if (required) return bag.add(field, 'This field is required.');
    return null;
  }
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return bag.add(field, 'Must be a number.');
  if (n < min || n > max) return bag.add(field, `Must be between ${min} and ${max}.`);
  return n;
}

function phone(value, field, bag) {
  if (isBlank(value)) return null;
  const v = String(value).trim();
  if (!/^[+\d][\d\s-]{6,18}$/.test(v)) return bag.add(field, 'Enter a valid phone number.');
  return v;
}

function isoDate(value, field, bag) {
  if (isBlank(value)) return null;
  const v = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    return bag.add(field, 'Use the format YYYY-MM-DD.');
  }
  return v;
}

function bool(value, field, bag, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) return bag.add(field, 'This field is required.');
    return null;
  }
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return !!value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return bag.add(field, 'Must be true or false.');
}

/** Run `fn` with a fresh bag, throw one aggregated error if anything failed. */
function validate(fn) {
  const bag = new Bag();
  const result = fn(bag);
  bag.throwIfAny();
  return result;
}

module.exports = {
  Bag,
  validate,
  str,
  optStr,
  email,
  enumOf,
  optEnum,
  intNum,
  num,
  phone,
  isoDate,
  bool,
  isBlank,
};
