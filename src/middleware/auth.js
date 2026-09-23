/**
 * Authentication middleware.
 *
 * Security model (mirrors the frontend's comments in services/petApi.ts):
 *  • access tokens are short-lived JWTs verified here on every request;
 *  • the user row is re-read each request, so disabling an account or
 *    resetting access takes effect immediately — no stale role claims;
 *  • refresh tokens live only in the DB as SHA-256 hashes, never logged.
 */
'use strict';

const { verifyJwt, ApiExpired } = require('../lib/jwt');
const { unauthorized, forbidden, notFound } = require('../lib/errors');
const { asyncHandler } = require('../lib/http');

/** Require a valid access token; attaches `req.user`. */
const authenticate = (config) =>
  asyncHandler(async (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (!token || scheme?.toLowerCase() !== 'bearer') throw unauthorized();

    let payload;
    try {
      payload = verifyJwt(token, config.jwtSecret, { expectedType: 'access' });
    } catch (err) {
      if (err instanceof ApiExpired) {
        const { ApiError } = require('../lib/errors');
        throw new ApiError(401, 'TOKEN_EXPIRED', err.message);
      }
      throw err;
    }

    const user = req.app.locals.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(payload.sub);
    if (!user) throw unauthorized('Your account no longer exists.');
    if (user.status !== 'ACTIVE') throw forbidden('This account has been disabled.');

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      employee_code: user.employee_code,
      department: user.department,
      must_change_password: !!user.must_change_password,
    };
    next();
  });

/** Main Admin only. */
function requireAdmin(req, res, next) {
  if (!req.user) throw unauthorized();
  if (req.user.role !== 'main_admin') {
    throw forbidden('Main Admin access required.');
  }
  next();
}

/** Load a user row by `req.params.id`, 404 when missing. */
function loadUserOr404(db, id) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(String(id || ''));
  if (!user) throw notFound('Employee not found.');
  return user;
}

module.exports = { authenticate, requireAdmin, loadUserOr404 };
