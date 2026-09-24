/**
 * Auth — login, refresh (with rotation + reuse detection), logout,
 * change-password. Refresh tokens are opaque random strings stored only as
 * SHA-256 hashes; access tokens are short-lived JWTs.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const { asyncHandler } = require('../lib/http');
const { validate, email: vEmail, str } = require('../lib/validate');
const { ApiError, unauthorized, forbidden, badRequest } = require('../lib/errors');
const { signJwt } = require('../lib/jwt');
const { sha256, now } = require('../lib/ids');
const { verifyPassword, hashPassword, assertPasswordPolicy } = require('../lib/password');
const { logAction } = require('../lib/audit');
const { toUser } = require('../services/serialize');
const { rateLimit } = require('../middleware/ratelimit');

function issueAccessToken(config, user) {
  return signJwt(
    { sub: user.id, role: user.role, jti: crypto.randomUUID(), typ: 'access' },
    config.jwtSecret,
    config.accessTtlSeconds,
  );
}

function newRefreshToken(db, config, user, familyId = null) {
  const raw = `prt_${crypto.randomBytes(48).toString('base64url')}`;
  const family = familyId || crypto.randomUUID();
  const expires = new Date(Date.now() + config.refreshTtlDays * 86400_000).toISOString();
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), user.id, sha256(raw), family, expires, now());
  return { raw, family };
}

function sessionPayload(config, db, user, familyId = null) {
  const { raw, family } = newRefreshToken(db, config, user, familyId);
  return {
    access_token: issueAccessToken(config, user),
    token_type: 'Bearer',
    expires_in: config.accessTtlSeconds,
    refresh_token: raw,
    user: toUser(user),
    __family: family,
  };
}

function publicSession(config, db, user, familyId = null) {
  const payload = sessionPayload(config, db, user, familyId);
  delete payload.__family;
  return payload;
}

function authRoutes(config) {
  const router = express.Router();
  const db = req => req.app.locals.db;

  const loginLimiter = rateLimit({
    windowMs: 60_000,
    max: config.authRateLimit,
    keyFn: req => `login:${req.ip}`,
  });

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const { email, password } = validate(bag => ({
        email: vEmail(req.body?.email, 'email', bag),
        password: str(req.body?.password, 'password', bag, { min: 1, trim: false }),
      }));

      const database = db(req);
      const user = database.prepare('SELECT * FROM users WHERE email = ?').get(email);
      const ok = user && verifyPassword(password, user.password_hash);
      if (!ok) {
        logAction(database, {
          action: 'PET_LOGIN_FAILED',
          metadata: { email },
          ip: req.ip,
        });
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Wrong email or password.');
      }
      if (user.status !== 'ACTIVE') {
        throw forbidden('This account has been disabled. Contact the Main Admin.');
      }
      logAction(database, {
        actorId: user.id,
        actorLabel: user.name,
        action: 'PET_LOGIN_SUCCESS',
        targetType: 'user',
        targetId: user.id,
        ip: req.ip,
      });
      res.json(publicSession(config, database, user));
    }),
  );

  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const token = String(req.body?.refresh_token || '');
      if (!token) throw unauthorized('Missing refresh token.');
      const database = db(req);
      const row = database.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(sha256(token));
      if (!row) throw unauthorized('Refresh token is not valid.');

      if (row.revoked_at) {
        // Reuse of an already-rotated token ⇒ assume theft, kill the family.
        database
          .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
          .run(now(), row.family_id);
        throw unauthorized('Session expired. Please sign in again.');
      }
      if (row.expires_at < now()) throw unauthorized('Session expired. Please sign in again.');

      const user = database.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
      if (!user) throw unauthorized('Your account no longer exists.');
      if (user.status !== 'ACTIVE') throw forbidden('This account has been disabled.');

      database
        .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?')
        .run(now(), row.id);

      res.json(publicSession(config, database, user, row.family_id));
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const token = String(req.body?.refresh_token || '');
      if (token) {
        db(req)
          .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
          .run(now(), sha256(token));
      }
      res.json({ ok: true });
    }),
  );

  router.post(
    '/change-password',
    asyncHandler(async (req, res) => {
      const { current_password, new_password } = validate(bag => ({
        current_password: str(req.body?.current_password, 'current_password', bag, { trim: false }),
        new_password: str(req.body?.new_password, 'new_password', bag, { min: 8, max: 200, trim: false }),
      }));
      assertPasswordPolicy(new_password);

      const database = db(req);
      // Identity comes from the access token when present, otherwise from
      // email+current_password is NOT enough — the frontend always sends
      // Authorization here, so require it.
      const header = req.get('authorization') || '';
      const bearer = header.split(' ')[1];
      if (!bearer) throw unauthorized();
      const { verifyJwt, ApiExpired } = require('../lib/jwt');
      let payload;
      try {
        payload = verifyJwt(bearer, config.jwtSecret, { expectedType: 'access' });
      } catch (err) {
        if (err instanceof ApiExpired) throw new ApiError(401, 'TOKEN_EXPIRED', err.message);
        throw err;
      }
      const user = database.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
      if (!user) throw unauthorized('Your account no longer exists.');

      if (!verifyPassword(current_password, user.password_hash)) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.', {
          fields: { current_password: 'Incorrect.' },
        });
      }
      if (current_password === new_password) {
        throw badRequest('Choose a password you have not used before.');
      }

      database
        .prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
        .run(hashPassword(new_password), now(), user.id);
      // Password change revokes every session (the UI then re-logs-in).
      database
        .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(now(), user.id);
      logAction(database, {
        actorId: user.id,
        actorLabel: user.name,
        action: 'PET_PASSWORD_CHANGED',
        targetType: 'user',
        targetId: user.id,
        ip: req.ip,
      });
      res.json({ changed: true, re_login_required: true });
    }),
  );

  return router;
}

module.exports = { authRoutes, issueAccessToken, publicSession };
