#!/usr/bin/env node
/**
 * Build the PET frontend into `public/app` so THIS server can serve the
 * whole product from one origin (SPA + /api + /health, no CORS needed).
 *
 *   node scripts/build-frontend.mjs            # clone (first run) + build
 *   PET_FRONTEND_DIR=/path/to/PET node scripts/build-frontend.mjs
 *
 * What it does:
 *   1. clones sakshamfit/PET (or uses PET_FRONTEND_DIR when you already
 *      have a checkout — CI / air-gapped office PC);
 *   2. applies two one-line fixes that exist in the frontend repo today
 *      and would break the dashboard at runtime (see FIXES below) — each
 *      is idempotent, so an upstream fix means it silently no-ops;
 *   3. `npm ci` + `vite build` with an empty PET_API_BASE, which bakes
 *      same-origin `/api` into the bundle — exactly what this server
 *      exposes;
 *   4. copies dist/ → public/app/ (gitignored; regenerated any time).
 *
 * The result: open http://<host>:<port>/ and the login screen talks to
 * the API on the same origin. `/build-info.json` powers the frontend's
 * update banner; `/health` powers its connect-screen probe.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'app');
const FRONTEND_URL = process.env.PET_FRONTEND_URL || 'https://github.com/sakshamfit/PET.git';

/**
 * Upstream frontend fixes (sakshamfit/PET, pet-web/src/App.tsx):
 *   1. LoginPage declares `onLoggedIn` but App passes `onLogin` — after a
 *      successful sign-in the callback is undefined and throws (login still
 *      lands via auth listeners, but the error is surfaced to the user).
 *   2. Both dashboards declare a required `navigate` prop; App renders them
 *      without one, so every navigation button on the home screen dies with
 *      "navigate is not a function".
 * Remove a FIX line once the frontend repo carries the fix itself.
 */
const FIXES = [
  {
    file: path.join('pet-web', 'src', 'App.tsx'),
    why: 'LoginPage expects onLoggedIn, App passes onLogin',
    from: '<LoginPage onLogin={() => setSignedIn(true)} />',
    to: '<LoginPage onLoggedIn={() => setSignedIn(true)} />',
  },
  {
    file: path.join('pet-web', 'src', 'App.tsx'),
    why: 'dashboards require a navigate prop',
    from: '{route === \'dashboard\' && (isAdmin ? <AdminDashboardPage /> : <EmployeeDashboard />)}',
    to: '{route === \'dashboard\' && (isAdmin ? <AdminDashboardPage navigate={navigate} /> : <EmployeeDashboard navigate={navigate} />)}',
  },
];

function run(cmd, args, opts = {}) {
  process.stdout.write(`  $ ${cmd} ${args.join(' ')}\n`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function ensureFrontendSource() {
  const dir = process.env.PET_FRONTEND_DIR
    ? path.resolve(process.env.PET_FRONTEND_DIR)
    : path.join(ROOT, 'data', 'frontend-src');

  if (fs.existsSync(path.join(dir, 'package.json'))) {
    console.log(`frontend source: ${dir} (existing checkout)`);
    return dir;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  console.log(`frontend source: cloning ${FRONTEND_URL} → ${dir}`);
  run('git', ['clone', '--depth', '1', FRONTEND_URL, dir]);
  return dir;
}

function applyFixes(sourceDir) {
  for (const fix of FIXES) {
    const file = path.join(sourceDir, fix.file);
    const before = fs.readFileSync(file, 'utf8');
    if (before.includes(fix.to)) {
      console.log(`fix already present: ${fix.why}`);
      continue;
    }
    if (!before.includes(fix.from)) {
      console.warn(`WARN: could not apply fix (${fix.why}) — upstream may have changed ${fix.file}`);
      continue;
    }
    fs.writeFileSync(file, before.replace(fix.from, fix.to));
    console.log(`applied fix: ${fix.why}`);
  }
}

function build(sourceDir) {
  if (!fs.existsSync(path.join(sourceDir, 'node_modules'))) {
    run('npm', ['ci', '--no-fund', '--no-audit'], { cwd: sourceDir });
  }
  // Empty PET_API_BASE ⇒ the bundle uses same-origin /api (runtime.ts).
  run('npm', ['run', 'build'], { cwd: sourceDir, env: { ...process.env, PET_API_BASE: '' } });
}

function publish(sourceDir) {
  const dist = path.join(sourceDir, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error(`frontend build produced no index.html at ${dist}`);
  }
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.cpSync(dist, OUT_DIR, { recursive: true });
  const info = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'build-info.json'), 'utf8'));
  console.log(`published → ${OUT_DIR}`);
  console.log(`  build_id: ${info.build_id}`);
  console.log(`  api:      ${info.api} (same-origin /api when "not-configured")`);
}

function main() {
  console.log('── PET frontend build ─────────────────────────────');
  const sourceDir = ensureFrontendSource();
  applyFixes(sourceDir);
  build(sourceDir);
  publish(sourceDir);
  console.log('Done. Restart the server to pick it up: npm start');
}

main();
