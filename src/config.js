/**
 * Configuration — one module, pure data, no side effects beyond reading .env.
 *
 * Why hand-rolled .env parsing: the office PC install must survive with the
 * minimum possible dependency surface (the old repo's `npm ci` died on native
 * modules — see the frontend README). Node's built-ins cover everything here.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Minimal .env loader: KEY=VALUE lines, `#` comments, optional quotes. */
function loadDotEnv(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveConfig(rootDir = path.join(__dirname, '..')) {
  loadDotEnv(path.join(rootDir, '.env'));

  const isTest = process.env.NODE_ENV === 'test' || !!process.env.PET_TEST_MODE;
  const env = process.env.NODE_ENV || 'development';

  const dbPath = process.env.PET_DB_PATH || (isTest ? ':memory:' : './data/pet.db');
  const filesDir = process.env.PET_FILES_DIR || './data/files';

  return {
    rootDir,
    env,
    isTest,
    isProd: env === 'production',
    port: int(process.env.PORT, 8080),
    host: process.env.HOST || '0.0.0.0',
    /** Comma-separated allowlist; `*` or empty ⇒ allow any origin (dev). */
    corsOrigins: (process.env.CORS_ORIGINS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    jwtSecret: process.env.PET_JWT_SECRET || '',
    accessTtlSeconds: int(process.env.PET_ACCESS_TTL_SECONDS, 900),
    refreshTtlDays: int(process.env.PET_REFRESH_TTL_DAYS, 30),
    dbPath: path.isAbsolute(dbPath) ? dbPath : path.resolve(rootDir, dbPath),
    filesDir: path.isAbsolute(filesDir) ? filesDir : path.resolve(rootDir, filesDir),
    maxUploadBytes: int(process.env.PET_MAX_UPLOAD_BYTES, 15 * 1024 * 1024),
    adminEmail: process.env.PET_ADMIN_EMAIL || '',
    adminPassword: process.env.PET_ADMIN_PASSWORD || '',
    authRateLimit: int(process.env.PET_AUTH_RATE_LIMIT, 30),
    trustProxy: bool(process.env.PET_TRUST_PROXY, false),
    /** Built SPA dropped here is served at `/` next to the API. */
    spaDir: path.resolve(rootDir, process.env.PET_SPA_DIR || './public/app'),
  };
}

module.exports = { resolveConfig, loadDotEnv };
