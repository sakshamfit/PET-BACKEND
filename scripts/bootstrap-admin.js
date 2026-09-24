#!/usr/bin/env node
/**
 * Bootstrap (or reset) the Main Admin account.
 *
 *   npm run bootstrap-admin -- --email admin@pet.org --password 'Secret123'
 *   npm run bootstrap-admin -- --email admin@pet.org            # temp password printed once
 *
 * Flags:
 *   --email <addr>      required
 *   --password <pw>     optional; omit to mint a one-time password
 *   --name <display>    optional (default "Main Admin")
 *   --permanent         keep the given password as-is (no forced change)
 *   --reset             overwrite the password of an existing admin
 */
'use strict';

const { resolveConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { migrate } = require('../src/schema');
const { upsertMainAdmin } = require('../src/services/employees');
const { generateTempPassword, assertPasswordPolicy } = require('../src/lib/password');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email || process.env.PET_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: npm run bootstrap-admin -- --email admin@pet.org [--password <pw>] [--permanent]');
    process.exit(1);
  }

  const config = resolveConfig();
  const db = openDatabase(config.dbPath);
  migrate(db);

  const existing = db.prepare(`SELECT * FROM users WHERE role = 'main_admin' AND email = ?`).get(email);
  if (existing && !args.reset) {
    console.log(`Main admin <${email}> already exists (status ${existing.status}).`);
    console.log('Use --reset to replace its password.');
    db.close();
    return;
  }

  let password = args.password ? String(args.password) : null;
  let minted = false;
  if (!password) {
    password = generateTempPassword();
    minted = true;
  } else {
    assertPasswordPolicy(password);
  }

  const mustChange = !args.permanent && (minted || !!args.password);
  const { user, created } = upsertMainAdmin(db, {
    email,
    password,
    name: args.name ? String(args.name) : 'Main Admin',
    mustChange: mustChange,
  });

  console.log(`${created ? 'Created' : 'Updated'} Main Admin:`);
  console.log(`  email:   ${user.email}`);
  console.log(`  code:    ${user.employee_code}`);
  console.log(`  change password at first sign-in: ${user.must_change_password ? 'YES' : 'no'}`);
  if (minted) {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log(`  │  One-time password (shown once): ${password.padEnd(16)} │`);
    console.log('  └──────────────────────────────────────────────┘');
    console.log('  Send it to the admin now — it cannot be looked up later.');
  }
  db.close();
}

main();
