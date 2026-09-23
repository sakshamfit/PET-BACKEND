/**
 * CORS without a package.
 *
 * The API uses `Authorization: Bearer` headers (no cookies), so allowing an
 * origin is simply echoing it back. Allowed origins come from CORS_ORIGINS;
 * empty means dev mode (any origin), a list means exact-match only. Requests
 * with no Origin (same-origin, curl, health probes) pass through untouched —
 * CORS is a browser rule, not an auth rule.
 */
'use strict';

function isOriginAllowed(origin, allowed) {
  if (!origin) return true;
  if (allowed.length === 0) return true;
  if (allowed.includes('*')) return true;
  return allowed.includes(origin);
}

function cors(allowedOrigins) {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (isOriginAllowed(origin, allowedOrigins)) {
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes('*') && allowedOrigins.length === 1 ? '*' : origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Pet-Client',
      );
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

module.exports = { cors, isOriginAllowed };
