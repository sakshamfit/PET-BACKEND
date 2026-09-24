/**
 * Server entry — config → database → migrate → (optional) admin bootstrap
 * → listen. One file to reason about when the office PC misbehaves.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveConfig } = require('./config');
const { openDatabase, activeDriver } = require('./db');
const { migrate } = require('./schema');
const { createApp } = require('./app');
const { upsertMainAdmin } = require('./services/employees');

/** JWT secret: env value, else a persisted per-install key in the data dir. */
function resolveJwtSecret(config) {
  if (config.jwtSecret && config.jwtSecret.length >= 16) return config.jwtSecret;
  if (config.isTest) return 'pet-test-secret-fixed-not-for-production';
  const file = path.join(path.dirname(config.dbPath), 'jwt.secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* first boot */
  }
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600 });
  console.warn(
    `[pet] PET_JWT_SECRET not set — generated a persistent key at ${file}. ` +
      'Set PET_JWT_SECRET in .env for reproducible sessions across reinstalls.',
  );
  return generated;
}

function maybeBootstrapAdmin(config, db) {
  if (!config.adminEmail) return;
  const existingAdmin = db
    .prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'main_admin'`)
    .get().c;
  if (Number(existingAdmin) > 0) return;
  const password = config.adminPassword || crypto.randomBytes(9).toString('base64url');
  const { created } = upsertMainAdmin(db, {
    email: config.adminEmail,
    password,
    mustChange: true,
  });
  if (created) {
    console.log(`[pet] Bootstrapped Main Admin <${config.adminEmail}> from PET_ADMIN_* env.`);
    if (!config.adminPassword) {
      console.log(`[pet] One-time password (shown once): ${password}`);
    }
  }
}

function start(overrides = {}) {
  const config = { ...resolveConfig(), ...overrides };
  config.jwtSecret = config.jwtSecret || resolveJwtSecret(config);

  const db = openDatabase(config.dbPath);
  migrate(db);
  maybeBootstrapAdmin(config, db);

  const app = createApp({ config, db });
  const server = app.listen(config.port, config.host, () => {
    console.log(
      `[pet] PET backend listening on http://${config.host}:${config.port} ` +
        `(driver=${activeDriver()}, env=${config.env}, db=${config.dbPath})`,
    );
  });

  const shutdown = () => {
    console.log('[pet] shutting down…');
    server.close(() => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, server, db, config };
}

if (require.main === module) {
  start();
}

module.exports = { start, resolveJwtSecret, maybeBootstrapAdmin };
