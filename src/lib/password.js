/**
 * Passwords — scrypt from `node:crypto` (no native build step).
 *
 * Storage format: `scrypt$N$r$p$salt_b64$hash_b64` so parameters can be
 * raised later without invalidating existing hashes (verify reads them back
 * out of the string).
 *
 * Policy mirrors the login screen's helper text: "At least 8 characters,
 * one letter and one number."
 */
'use strict';

const crypto = require('crypto');
const { ApiError } = require('./errors');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Throws ApiError(400, PASSWORD_POLICY) when the password is too weak. */
function assertPasswordPolicy(password, field = 'new_password') {
  const value = String(password ?? '');
  const problems = [];
  if (value.length < 8) problems.push('at least 8 characters');
  if (!/[a-zA-Z]/.test(value)) problems.push('at least one letter');
  if (!/\d/.test(value)) problems.push('at least one number');
  if (problems.length) {
    throw new ApiError(400, 'PASSWORD_POLICY', `Password needs ${problems.join(', ')}.`, {
      fields: { [field]: `Needs ${problems.join(', ')}.` },
    });
  }
  return value;
}

/**
 * One-time password shown exactly once by the Team screen.
 * Guaranteed to satisfy the policy by construction (letter + digit).
 */
function generateTempPassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (let i = 0; i < 12; i += 1) out += all[bytes[i] % all.length];
  out += letters[bytes[12] % letters.length];
  out += digits[bytes[13] % digits.length];
  return out;
}

module.exports = { hashPassword, verifyPassword, assertPasswordPolicy, generateTempPassword };
