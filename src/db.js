/**
 * SQLite driver adapter.
 *
 * The PET server runs in two very different environments:
 *   1. office PC (Windows, Node 20, often no VS Build Tools) — where the old
 *      repo's hard dependency on better-sqlite3 made `npm ci` fail;
 *   2. CI / dev machines on modern Node.
 *
 * So we probe drivers at runtime instead of hard-depending on one:
 *   better-sqlite3  → preferred: native, fastest, battle-tested
 *   node:sqlite     → built into Node ≥22.5 (no install at all)
 *   node-sqlite3-wasm → pure WASM fallback; installs anywhere, no compiler
 *
 * All three are wrapped behind one tiny interface:
 *   db.prepare(sql) → { run(...p), get(...p), all(...p) }
 *   db.exec(sql)    → run multi-statement SQL
 *   db.close()
 * `run` always returns { changes, lastInsertRowid }.
 * Only positional `?` parameters are used — the WASM driver lacks named binds.
 */
'use strict';

const path = require('path');
const fs = require('fs');

// Node ≥22 announces `node:sqlite` with an ExperimentalWarning on require.
// Operators don't act on it; filter exactly that warning, globally, once.
(() => {
  const originalEmit = process.emit;
  process.emit = function patchedEmit(name, data, ...rest) {
    if (
      name === 'warning' &&
      data &&
      data.name === 'ExperimentalWarning' &&
      typeof data.message === 'string' &&
      data.message.includes('SQLite')
    ) {
      return false;
    }
    return originalEmit.call(this, name, data, ...rest);
  };
})();

/** @type {{name: string, open: (file: string) => any}[]} */
const DRIVERS = [
  {
    name: 'better-sqlite3',
    open(file) {
      // eslint-disable-next-line global-require
      const Database = require('better-sqlite3');
      return wrapBetterSqlite(new Database(file));
    },
  },
  {
    name: 'node:sqlite',
    open(file) {
      // Node ≥22 ships SQLite as an experimental builtin. The warning is
      // noise for operators — suppress exactly that one, nothing else.
      const originalEmit = process.emit;
      process.emit = function patchedEmit(name, data, ...rest) {
        if (
          name === 'warning' &&
          data &&
          data.name === 'ExperimentalWarning' &&
          typeof data.message === 'string' &&
          data.message.includes('SQLite')
        ) {
          return false;
        }
        return originalEmit.call(this, name, data, ...rest);
      };
      try {
        // eslint-disable-next-line global-require
        const { DatabaseSync } = require('node:sqlite');
        return wrapNodeSqlite(new DatabaseSync(file));
      } finally {
        process.emit = originalEmit;
      }
    },
  },
  {
    name: 'node-sqlite3-wasm',
    open(file) {
      // eslint-disable-next-line global-require
      const { Database } = require('node-sqlite3-wasm');
      return wrapWasm(new Database(file));
    },
  },
];

function normalizeArgs(args) {
  const arr = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  // Drivers disagree on booleans/undefined; normalize to what SQLite accepts.
  return arr.map(a => {
    if (typeof a === 'boolean') return a ? 1 : 0;
    if (a === undefined) return null;
    return a;
  });
}

function normalizeInfo(info) {
  if (!info) return { changes: 0, lastInsertRowid: 0 };
  return {
    changes: Number(info.changes ?? 0),
    lastInsertRowid: Number(info.lastInsertRowid ?? 0),
  };
}

function wrapBetterSqlite(db) {
  return {
    driver: 'better-sqlite3',
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: (...args) => normalizeInfo(stmt.run(...normalizeArgs(args))),
        get: (...args) => stmt.get(...normalizeArgs(args)),
        all: (...args) => stmt.all(...normalizeArgs(args)),
      };
    },
    exec: sql => db.exec(sql),
    pragma: sql => db.pragma(sql),
    close: () => db.close(),
  };
}

function wrapNodeSqlite(db) {
  return {
    driver: 'node:sqlite',
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: (...args) => normalizeInfo(stmt.run(...normalizeArgs(args))),
        get: (...args) => stmt.get(...normalizeArgs(args)),
        all: (...args) => stmt.all(...normalizeArgs(args)),
      };
    },
    exec: sql => db.exec(sql),
    pragma(sql) {
      // PRAGMA x = y returns no row; PRAGMA x returns the value.
      try {
        const row = db.prepare(`PRAGMA ${sql}`).get();
        return row ? Object.values(row)[0] : undefined;
      } catch {
        db.exec(`PRAGMA ${sql}`);
        return undefined;
      }
    },
    close: () => db.close(),
  };
}

function wrapWasm(db) {
  return {
    driver: 'node-sqlite3-wasm',
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: (...args) => normalizeInfo(stmt.run(normalizeArgs(args))),
        get: (...args) => stmt.get(normalizeArgs(args)),
        all: (...args) => stmt.all(normalizeArgs(args)),
        finalize: () => {
          try {
            stmt.finalize();
          } catch {
            /* already finalized */
          }
        },
      };
    },
    exec: sql => db.exec(sql),
    pragma(sql) {
      try {
        const row = db.get(`PRAGMA ${sql}`);
        return row ? Object.values(row)[0] : undefined;
      } catch {
        db.exec(`PRAGMA ${sql}`);
        return undefined;
      }
    },
    close: () => db.close(),
  };
}

let activeDriverName = null;

/**
 * Open the database, apply pragmas, and return the adapter.
 * @param {string} file absolute path or ':memory:'
 * @param {{prefer?: string}} [opts]
 */
function openDatabase(file, opts = {}) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const candidates = DRIVERS.slice();
  if (opts.prefer) {
    candidates.sort((a, b) => (a.name === opts.prefer ? -1 : b.name === opts.prefer ? 1 : 0));
  }

  let lastErr;
  for (const driver of candidates) {
    let db;
    try {
      db = driver.open(file);
    } catch (err) {
      lastErr = err;
      continue;
    }
    activeDriverName = driver.name;
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 8000');
      db.pragma('synchronous = NORMAL');
    } catch {
      /* pragmas are best-effort (memory DBs reject journal_mode=WAL) */
    }
    db.driver = driver.name;
    return db;
  }
  throw new Error(
    `No SQLite driver available (tried ${DRIVERS.map(d => d.name).join(', ')}). ` +
      `Last error: ${lastErr && lastErr.message}`,
  );
}

function activeDriver() {
  return activeDriverName;
}

/**
 * Transaction helper with savepoint-based nesting. Every public mutation in
 * the API runs inside `tx()` so a half-applied state can never be observed.
 */
function tx(db, fn) {
  if (db.__txDepth === undefined) db.__txDepth = 0;
  if (db.__txDepth === 0) {
    db.exec('BEGIN IMMEDIATE');
    db.__txDepth = 1;
    try {
      const result = fn();
      db.exec('COMMIT');
      db.__txDepth = 0;
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* connection may already be rolled back */
      }
      db.__txDepth = 0;
      throw err;
    }
  }
  const name = `sp_${db.__txDepth}`;
  db.exec(`SAVEPOINT ${name}`);
  db.__txDepth += 1;
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    db.__txDepth -= 1;
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      /* ignore */
    }
    db.__txDepth -= 1;
    throw err;
  }
}

module.exports = { openDatabase, tx, activeDriver, DRIVERS };
