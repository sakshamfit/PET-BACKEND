/**
 * Offline sync executor (docs/PET/11).
 *
 * Field staff lose connectivity mid-visit; every mutation they take is
 * queued on the device with a client-generated `idempotency_key` and pushed
 * here in batches when the signal returns.
 *
 * Guarantees:
 *   • per (user, key) exactly-once — the first result (ok or error) is
 *     stored and replayed verbatim on retries (`deduplicated: true`);
 *   • each operation runs in its own transaction, so one bad item never
 *     poisons the batch;
 *   • operations reuse the very same services as the live endpoints, so
 *     offline and online paths cannot diverge.
 */
'use strict';

const { uuid, now, sha256 } = require('../lib/ids');
const { ApiError } = require('../lib/errors');
const { registerStudent } = require('./students');
const { checkIn, checkOut } = require('./attendance');
const { startVisit, endVisit } = require('./visits');
const { createTask, changeTaskStatus } = require('./tasks');
const { registerFieldMedia, registerStudentDocument } = require('./uploads');

const OPERATION_TYPES = [
  'student.register',
  'attendance.check_in',
  'attendance.check_out',
  'visit.start',
  'visit.end',
  'task.create',
  'task.status',
  'media.register',
];

function previousResult(db, userId, key) {
  return db
    .prepare('SELECT * FROM sync_idempotency WHERE user_id = ? AND idempotency_key = ?')
    .get(userId, key);
}

function storeResult(db, userId, key, type, status, result) {
  db.prepare(
    `INSERT INTO sync_idempotency (id, user_id, idempotency_key, type, status, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, idempotency_key)
       DO UPDATE SET status = excluded.status, result = excluded.result`,
  ).run(uuid(), userId, key, type, status, result === undefined ? null : JSON.stringify(result), now());
}

function applyOperation(db, user, op, ctx) {
  const payload = op.payload || {};
  switch (op.type) {
    case 'student.register':
      return registerStudent(db, user, payload, { source: 'field_app', ip: ctx.ip });

    case 'attendance.check_in':
      return checkIn(db, user, { latitude: payload.latitude, longitude: payload.longitude }, { ip: ctx.ip });

    case 'attendance.check_out':
      return checkOut(db, user, { latitude: payload.latitude, longitude: payload.longitude }, { ip: ctx.ip });

    case 'visit.start':
      return startVisit(
        db,
        user,
        { school_id: payload.school_id, purpose: payload.purpose, latitude: payload.latitude, longitude: payload.longitude },
        { ip: ctx.ip },
      );

    case 'visit.end':
      return endVisit(db, user, payload.visit_id || payload.id, payload, { ip: ctx.ip });

    case 'task.create':
      return createTask(db, user, payload, { ip: ctx.ip });

    case 'task.status':
      return changeTaskStatus(db, user, payload.task_id || payload.id, payload.status, payload.note ?? null, {
        ip: ctx.ip,
      });

    case 'media.register':
      return payload.student_id
        ? registerStudentDocument(db, user, payload)
        : registerFieldMedia(db, user, payload);

    default: {
      const err = new ApiError(400, 'UNSUPPORTED_OPERATION', `Unknown sync operation '${op.type}'.`);
      err.status = 400;
      throw err;
    }
  }
}

/**
 * @param {Array<{idempotency_key: string, type: string, payload: object}>} operations
 * @returns {{results: Array, processed_at: string}}
 */
function pushOperations(db, user, operations, { ip = null } = {}) {
  const results = [];
  for (const op of operations) {
    const key = String(op.idempotency_key || '').trim();
    if (!key) {
      results.push({
        idempotency_key: '',
        status: 'error',
        code: 'VALIDATION_ERROR',
        message: 'idempotency_key is required.',
      });
      continue;
    }

    // Replays win first — a stored rejection is replayed verbatim too, so a
    // client spinning on a bad entry sees a stable answer.
    const previous = previousResult(db, user.id, key);
    if (previous) {
      results.push({
        idempotency_key: key,
        status: previous.status,
        deduplicated: true,
        ...(previous.result ? { result: JSON.parse(previous.result) } : {}),
      });
      continue;
    }

    if (!OPERATION_TYPES.includes(op.type)) {
      const message = `Unknown sync operation '${op.type}'.`;
      storeResult(db, user.id, key, op.type, 'error', { code: 'UNSUPPORTED_OPERATION', message });
      results.push({
        idempotency_key: key,
        status: 'error',
        code: 'UNSUPPORTED_OPERATION',
        message,
      });
      continue;
    }

    try {
      const result = applyOperation(db, user, { ...op, idempotency_key: key }, { ip });
      storeResult(db, user.id, key, op.type, 'ok', { result });
      results.push({ idempotency_key: key, status: 'ok', result });
    } catch (err) {
      const code = err && err.code ? err.code : 'INTERNAL';
      const message = err && err.message ? err.message : 'Operation failed.';
      // Persist the failure too: a deterministic rejection (validation,
      // duplicate…) will never succeed on retry, and the queue should stop
      // spinning on it. Transient DB errors stay unstored so retry works.
      if (err instanceof ApiError && err.status < 500) {
        storeResult(db, user.id, key, op.type, 'error', { code, message, details: err.details });
      }
      results.push({ idempotency_key: key, status: 'error', code, message });
    }
  }
  return { results, processed_at: now() };
}

module.exports = { pushOperations, OPERATION_TYPES, sha256 };
