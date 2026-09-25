#!/usr/bin/env node
/**
 * Prepare a safe, client-ready PET showcase.
 *
 * This command is intentionally conservative:
 *   - it builds the bundled SPA only when it is missing;
 *   - it seeds demo data only when the database is completely empty;
 *   - it never overwrites an existing database.
 *
 * Use `npm run showcase` on a fresh deployment, then open the server URL.
 * For an existing database, use `npm run seed-demo -- --force` only when you
 * explicitly want to layer the demo records on top of it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { migrate } = require('../src/schema');

const ROOT = path.resolve(__dirname, '..');
const SPA_INDEX = path.join(ROOT, 'public', 'app', 'index.html');

function runNode(script, args = []) {
  execFileSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
}

function databaseIsEmpty(config) {
  // `:memory:` is useful for tests, but is not a meaningful showcase target.
  if (config.dbPath === ':memory:') return false;

  const db = openDatabase(config.dbPath);
  try {
    migrate(db);
    const users = Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
    const students = Number(db.prepare('SELECT COUNT(*) AS c FROM students').get().c);
    const schools = Number(db.prepare('SELECT COUNT(*) AS c FROM schools').get().c);
    return users === 0 && students === 0 && schools === 0;
  } finally {
    db.close();
  }
}

function main() {
  console.log('── PET client showcase setup ───────────────────────');

  if (!fs.existsSync(SPA_INDEX)) {
    console.log('Bundled frontend not found; building it now.');
    runNode('scripts/build-frontend.js');
  } else {
    console.log('Bundled frontend already present.');
  }

  const config = resolveConfig();
  if (databaseIsEmpty(config)) {
    console.log('Database is empty; loading the safe demo dataset.');
    runNode('scripts/seed-demo.js');
  } else {
    console.log(`Existing database detected at ${config.dbPath}; demo seed skipped.`);
    console.log('No records were changed. Run `npm run seed-demo -- --force` only intentionally.');
  }

  console.log('');
  console.log(`Showcase URL: http://localhost:${config.port}`);
  console.log('Demo admin:   admin@pet.local / PetAdmin123!');
  console.log('Demo staff:   ravi@pet.local / Employee123!');
  console.log('');
  console.log('For a public showcase, put the server behind HTTPS and point');
  console.log('software.plusoneco.in at it. See docs/SHOWCASE.md.');
}

main();
