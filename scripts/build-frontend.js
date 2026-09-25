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
 *   2. applies the checked-in PET polish overrides (responsive layout,
 *      no mobile input zoom, and complete task/student screens);
 *   3. applies the small compatibility fixes that exist in the frontend repo
 *      today and would otherwise hurt the hosted server build (see FIXES
 *      below) — each is idempotent, so an upstream fix silently no-ops;
 *   4. `npm ci` + `vite build` with an empty PET_API_BASE, which bakes
 *      same-origin `/api` into the bundle — exactly what this server
 *      exposes;
 *   5. copies dist/ → public/app/ (the small production bundle is tracked so
 *      a fresh checkout is immediately deployable).
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
 * Upstream frontend fixes (sakshamfit/PET):
 *   1. LoginPage declares `onLoggedIn` but App passes `onLogin` — after a
 *      successful sign-in the callback is undefined and throws (login still
 *      lands via auth listeners, but the error is surfaced to the user).
 *   2. Both dashboards declare a required `navigate` prop; App renders them
 *      without one, so every navigation button on the home screen dies with
 *      "navigate is not a function".
 *   3. Vite marks every build as a static-host build, which displays a
 *      misleading "Connect to your PET server" form even when this server is
 *      serving the SPA and API from the same origin.
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
  {
    file: 'vite.config.ts',
    why: 'same-origin server builds must not show the remote-server connect form',
    from: '__PET_HOSTED_STATIC__: JSON.stringify(true),',
    to: '__PET_HOSTED_STATIC__: JSON.stringify(false),',
  },
  {
    file: path.join('pet-web', 'src', 'pages', 'Login.tsx'),
    why: 'remove the server connection option from the hosted login screen',
    from: "import { ServerConnection } from '../connect';\n",
    to: '',
  },
  {
    file: path.join('pet-web', 'src', 'pages', 'Login.tsx'),
    why: 'remove the server connection option from the hosted login screen',
    from: '        <ServerConnection />\n',
    to: '',
  },
  {
    file: path.join('pet-web', 'src', 'pages', 'Login.tsx'),
    why: 'remove the hosted login connection status pill',
    from: '          <ConnectionPill />\n',
    to: '',
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

const POLISH_OVERRIDES = [
  path.join('pet-web', 'src', 'index.css'),
  path.join('pet-web', 'src', 'App.tsx'),
  path.join('pet-web', 'src', 'pages', 'Tasks.tsx'),
  path.join('pet-web', 'src', 'pages', 'Students.tsx'),
];

/**
 * Keep the client-facing polish in this repository even though the upstream
 * frontend is maintained separately. These files are copied before the small
 * compatibility replacements below, so a fresh deployment gets the same UI
 * as the checked-in production bundle.
 */
function applyPolishOverrides(sourceDir) {
  for (const relative of POLISH_OVERRIDES) {
    const override = path.join(ROOT, 'frontend-overrides', relative);
    const target = path.join(sourceDir, relative);
    if (!fs.existsSync(override)) throw new Error(`Missing frontend override: ${override}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(override, target);
    console.log(`applied PET polish: ${relative}`);
  }
}

function applyFixes(sourceDir) {
  for (const fix of FIXES) {
    const file = path.join(sourceDir, fix.file);
    const before = fs.readFileSync(file, 'utf8');
    const alreadyApplied = fix.to === '' ? !before.includes(fix.from) : before.includes(fix.to);
    if (alreadyApplied) {
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
  applyPolishOverrides(sourceDir);
  applyFixes(sourceDir);
  build(sourceDir);
  publish(sourceDir);
  console.log('Done. Restart the server to pick it up: npm start');
}

main();
