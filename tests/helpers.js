/**
 * Integration-test harness: boots a real Express app on an ephemeral port
 * with an in-memory database, seeds a Main Admin, and exposes a tiny API
 * client. Kept dependency-free (node:test + global fetch).
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.PET_TEST_MODE = '1';

const { resolveConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { migrate } = require('../src/schema');
const { createApp } = require('../src/app');
const { upsertMainAdmin } = require('../src/services/employees');

const ADMIN_EMAIL = 'admin@pet.test';
const ADMIN_PASSWORD = 'AdminPass1!';

/** 1×1 transparent PNG — used by upload tests. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function startServer() {
  const config = resolveConfig();
  const db = openDatabase(':memory:');
  migrate(db);
  const adminSeed = upsertMainAdmin(db, {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    mustChange: false,
  });
  const app = createApp({ config, db });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    db,
    config,
    adminSeed,
    async close() {
      await new Promise(resolve => server.close(resolve));
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

async function api(base, method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON (file downloads) */
  }
  return { status: res.status, json, headers: res.headers, raw: res };
}

async function login(base, email, password) {
  const r = await api(base, 'POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) {
    throw new Error(`login failed ${r.status}: ${JSON.stringify(r.json)}`);
  }
  return r.json;
}

/** Create an employee through the API and sign in as them. */
async function createEmployee(base, adminToken, overrides = {}) {
  const created = await api(base, 'POST', '/api/employees', {
    token: adminToken,
    body: {
      name: overrides.name || 'Field Employee',
      email: overrides.email || `emp${Date.now()}${Math.floor(Math.random() * 1000)}@pet.test`,
      phone: overrides.phone || '9876543210',
      department: overrides.department || 'Field Ops',
    },
  });
  if (created.status !== 201) {
    throw new Error(`employee create failed ${created.status}: ${JSON.stringify(created.json)}`);
  }
  const tempPassword = created.json.temporaryPassword;
  const session = await login(base, created.json.user.email, tempPassword);
  return { user: created.json.user, tempPassword, session };
}

module.exports = {
  startServer,
  api,
  login,
  createEmployee,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  TINY_PNG_BASE64,
};
