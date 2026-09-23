/**
 * Employees / Team — Main Admin provisioning. The one-time password leaves
 * this module exactly once (in the HTTP response) and is never persisted in
 * readable form; only its scrypt hash is stored.
 */
'use strict';

const { ApiError, notFound, badRequest } = require('../lib/errors');
const { uuid, now, employeeCode, sha256 } = require('../lib/ids');
const { tx } = require('../db');
const { hashPassword, assertPasswordPolicy, generateTempPassword } = require('../lib/password');
const { logAction } = require('../lib/audit');
const { toUser } = require('./serialize');

function listEmployees(db, { q = null, status = null, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];
  if (q) {
    where.push(`(LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(COALESCE(employee_code,'')) LIKE ?
                 OR LOWER(COALESCE(department,'')) LIKE ?)`);
    const like = `%${q.toLowerCase()}%`;
    params.push(like, like, like, like);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM users ${clause}`).get(...params).c);
  const rows = db
    .prepare(`SELECT * FROM users ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { total, employees: rows.map(toUser) };
}

function createEmployee(db, actor, input, { ip = null } = {}) {
  return tx(db, () => {
    const existing = db
      .prepare('SELECT id FROM users WHERE email = ?')
      .get(String(input.email).toLowerCase());
    if (existing) {
      throw new ApiError(409, 'EMAIL_TAKEN', 'An account with that email already exists.');
    }
    // No password supplied (the Team screen never sends one) ⇒ mint a
    // one-time password that is returned exactly once in this response.
    const temporaryPassword = input.password || generateTempPassword();
    if (input.password) assertPasswordPolicy(input.password, 'password');

    const ts = now();
    const id = uuid();
    const code = employeeCode(db);
    db.prepare(
      `INSERT INTO users (id, name, email, phone, role, employee_code, status, department,
                          joining_date, must_change_password, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'employee', ?, 'ACTIVE', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      String(input.email).toLowerCase(),
      input.phone ?? null,
      code,
      input.department ?? null,
      input.joining_date ?? null,
      input.password ? 0 : 1,
      hashPassword(temporaryPassword),
      ts,
      ts,
    );

    logAction(db, {
      actorId: actor.id,
      actorLabel: actor.name,
      action: 'PET_EMPLOYEE_CREATED',
      targetType: 'user',
      targetId: id,
      metadata: { name: input.name, email: input.email, employee_code: code },
      ip,
    });

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return { user: toUser(row), temporaryPassword, row };
  });
}

function updateEmployee(db, actor, id, input, { ip = null } = {}) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(String(id));
    if (!row) throw notFound('Employee not found.');

    const email = input.email !== undefined && input.email !== null ? String(input.email).toLowerCase() : row.email;
    if (email !== row.email) {
      const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(email, row.id);
      if (clash) throw new ApiError(409, 'EMAIL_TAKEN', 'An account with that email already exists.');
    }

    const ts = now();
    const name = input.name !== undefined && input.name !== null ? String(input.name).trim() : row.name;
    db.prepare(
      `UPDATE users SET name = ?, email = ?, phone = ?, department = ?, updated_at = ? WHERE id = ?`,
    ).run(
      name,
      email,
      input.phone !== undefined ? input.phone : row.phone,
      input.department !== undefined ? input.department : row.department,
      ts,
      row.id,
    );

    // Keep denormalized display names honest wherever they are copied.
    if (name !== row.name) {
      db.prepare('UPDATE tasks SET assigned_to_user_name = ? WHERE assigned_to_user_id = ?').run(name, row.id);
      db.prepare('UPDATE tasks SET created_by_user_name = ? WHERE created_by_user_id = ?').run(name, row.id);
      db.prepare('UPDATE field_visits SET employee_name = ? WHERE employee_id = ?').run(name, row.id);
      db.prepare('UPDATE attendance SET employee_name = ? WHERE employee_id = ?').run(name, row.id);
      db.prepare('UPDATE website_form_submissions SET assigned_to_user_name = ? WHERE assigned_to_user_id = ?').run(name, row.id);
      db.prepare('UPDATE enrollments SET started_by_user_name = ? WHERE started_by_user_id = ?').run(name, row.id);
      db.prepare('UPDATE student_status_history SET changed_by_user_name = ? WHERE changed_by_user_id = ?').run(name, row.id);
      db.prepare('UPDATE chat_messages SET sender_name = ? WHERE sender_id = ?').run(name, row.id);
      db.prepare('UPDATE task_events SET actor_user_name = ? WHERE actor_user_id = ?').run(name, row.id);
      db.prepare('UPDATE field_media SET uploaded_by_user_name = ? WHERE uploaded_by_user_id = ?').run(name, row.id);
      db.prepare('UPDATE student_documents SET uploaded_by_user_name = ? WHERE uploaded_by_user_id = ?').run(name, row.id);
      db.prepare('UPDATE tests SET created_by_user_name = ? WHERE created_by_user_id = ?').run(name, row.id);
    }

    logAction(db, {
      actorId: actor.id,
      actorLabel: actor.name,
      action: 'PET_EMPLOYEE_UPDATED',
      targetType: 'user',
      targetId: row.id,
      metadata: { name, email },
      ip,
    });

    return { employee: toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id)) };
  });
}

function setEmployeeStatus(db, actor, id, status, { ip = null } = {}) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(String(id));
    if (!row) throw notFound('Employee not found.');
    if (row.id === actor.id && status === 'DISABLED') {
      throw badRequest('You cannot disable your own account.');
    }
    const ts = now();
    db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, row.id);
    if (status === 'DISABLED') {
      // "Signed out immediately": kill every refresh session on the spot.
      db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
        ts,
        row.id,
      );
    }
    logAction(db, {
      actorId: actor.id,
      actorLabel: actor.name,
      action: status === 'DISABLED' ? 'PET_EMPLOYEE_DISABLED' : 'PET_EMPLOYEE_ENABLED',
      targetType: 'user',
      targetId: row.id,
      metadata: { name: row.name },
      ip,
    });
    return { employee: toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id)) };
  });
}

/**
 * Reset access: fresh one-time password + revoke everything, returned once.
 * The password hash written here is a placeholder — login is impossible
 * until a real password is set? No: the temp password IS the real hash;
 * `must_change_password` forces the change at first sign-in.
 */
function resetEmployeeAccess(db, actor, id, { ip = null, generate = true } = {}) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(String(id));
    if (!row) throw notFound('Employee not found.');
    const temporaryPassword = generate ? require('../lib/password').generateTempPassword() : null;
    const ts = now();
    db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?',
    ).run(hashPassword(temporaryPassword), ts, row.id);
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
      ts,
      row.id,
    );
    logAction(db, {
      actorId: actor.id,
      actorLabel: actor.name,
      action: 'PET_EMPLOYEE_ACCESS_RESET',
      targetType: 'user',
      targetId: row.id,
      metadata: { name: row.name },
      ip,
    });
    return { user: toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id)), temporaryPassword };
  });
}

/** Used by the bootstrap CLI + first-boot env bootstrap. */
function upsertMainAdmin(db, { email, password, name = 'Main Admin', mustChange = true }) {
  const lower = String(email).toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(lower);
  if (existing) {
    if (password) {
      db.prepare(
        'UPDATE users SET password_hash = ?, role = ?, status = ?, must_change_password = ?, updated_at = ? WHERE id = ?',
      ).run(hashPassword(password), 'main_admin', 'ACTIVE', mustChange ? 1 : 0, now(), existing.id);
    }
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
    return { user: toUser(row), created: false };
  }
  const ts = now();
  const id = uuid();
  db.prepare(
    `INSERT INTO users (id, name, email, role, employee_code, status, must_change_password,
                        password_hash, created_at, updated_at)
     VALUES (?, ?, ?, 'main_admin', ?, 'ACTIVE', ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    lower,
    employeeCode(db),
    mustChange ? 1 : 0,
    hashPassword(password),
    ts,
    ts,
  );
  logAction(db, {
    actorId: id,
    actorLabel: name,
    action: 'PET_ADMIN_BOOTSTRAPPED',
    targetType: 'user',
    targetId: id,
    metadata: { email: lower },
  });
  return { user: toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)), created: true };
}

module.exports = {
  listEmployees,
  createEmployee,
  updateEmployee,
  setEmployeeStatus,
  resetEmployeeAccess,
  upsertMainAdmin,
  sha256,
};
