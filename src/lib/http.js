/** HTTP helpers shared by every route. */
'use strict';

const { badRequest } = require('./errors');

/** Wrap async handlers so rejections reach the error middleware. */
const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/** Pagination from `limit`/`offset` query params, clamped to sane bounds. */
function page(req, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
  const rawOffset = Number.parseInt(String(req.query.offset ?? ''), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), maxLimit)
    : defaultLimit;
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
  return { limit, offset };
}

/** Trimmed query string param or null. */
function q(req, name) {
  const v = req.query[name];
  if (v === undefined || v === null || String(v).trim() === '') return null;
  return String(v).trim();
}

function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toJson(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Ensure a referenced entity exists, else 404 with a clear message. */
function mustExist(row, what) {
  if (!row) throw badRequest(`${what} not found.`);
  return row;
}

module.exports = { asyncHandler, page, q, parseJson, toJson, mustExist };
