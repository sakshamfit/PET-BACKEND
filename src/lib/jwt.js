/**
 * JWT (HS256) implemented on `crypto` only.
 *
 * Why not jsonwebtoken: the office PC install story is "two packages or
 * fewer" (see the repo README). HMAC-SHA256 JWTs are ~60 lines and every
 * failure mode here is explicit: bad signature, wrong type, expired.
 *
 * Claims:
 *   access  → { sub: userId, typ: 'access',  jti, role, iat, exp }
 *   refresh → { sub: userId, typ: 'refresh', jti, fam, iat, exp }
 */
'use strict';

const crypto = require('crypto');
const { unauthorized } = require('./errors');

const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = str => Buffer.from(str, 'base64url');

function signJwt(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64u(JSON.stringify(header));
  const data = b64u(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${data}`).digest('base64url');
  return `${head}.${data}.${sig}`;
}

function verifyJwt(token, secret, { expectedType } = {}) {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw unauthorized('Malformed token.');
  }
  const [head, data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(`${head}.${data}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw unauthorized('Invalid token.');
  }
  let payload;
  try {
    payload = JSON.parse(fromB64u(data).toString('utf8'));
    const header = JSON.parse(fromB64u(head).toString('utf8'));
    if (header.alg !== 'HS256') throw new Error('alg');
  } catch {
    throw unauthorized('Invalid token.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    throw new ApiExpired();
  }
  if (expectedType && payload.typ !== expectedType) {
    throw unauthorized('Invalid token type.');
  }
  return payload;
}

/** Distinct error so callers can map to TOKEN_EXPIRED vs UNAUTHORIZED. */
class ApiExpired extends Error {
  constructor() {
    super('Your session has expired. Please sign in again.');
    this.name = 'TokenExpired';
    this.status = 401;
    this.code = 'TOKEN_EXPIRED';
  }
}

module.exports = { signJwt, verifyJwt, ApiExpired };
