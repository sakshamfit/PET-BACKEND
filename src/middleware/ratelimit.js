/**
 * In-memory sliding-window limiter for credential endpoints.
 * Office-PC scale (~30 staff) means a process-local map is enough; nothing
 * is persisted and memory is pruned on each sweep.
 */
'use strict';

const { rateLimited } = require('../lib/errors');

function rateLimit({ windowMs = 60_000, max = 30, keyFn }) {
  const hits = new Map();
  let lastSweep = Date.now();

  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, list] of hits) {
      const fresh = list.filter(t => now - t < windowMs);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  }

  return (req, res, next) => {
    if (max <= 0) return next();
    const now = Date.now();
    sweep(now);
    const key = keyFn ? keyFn(req) : req.ip || 'unknown';
    const list = hits.get(key) || [];
    const recent = list.filter(t => now - t < windowMs);
    if (recent.length >= max) {
      const retry = Math.ceil((windowMs - (now - recent[0])) / 1000);
      res.setHeader('Retry-After', String(Math.max(retry, 1)));
      return next(rateLimited('Too many attempts. Try again in a minute.'));
    }
    recent.push(now);
    hits.set(key, recent);
    return next();
  };
}

module.exports = { rateLimit };
