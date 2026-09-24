/**
 * Attendance — check-in/out are idempotent (the button can be hammered on a
 * flaky connection; `alreadyCheckedIn/Out` tells the UI to stop).
 */
'use strict';

const { badRequest, notFound } = require('../lib/errors');
const { uuid, now, today } = require('../lib/ids');
const { tx } = require('../db');
const { logAction } = require('../lib/audit');
const { toAttendance } = require('./serialize');

function rowFor(db, employeeId, date = today()) {
  return db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, date);
}

function todayRecord(db, employeeId) {
  const row = rowFor(db, employeeId);
  return { record: row ? toAttendance(row) : null };
}

function checkIn(db, user, geo = {}, { ip = null } = {}) {
  return tx(db, () => {
    const date = today();
    const ts = now();
    const existing = rowFor(db, user.id, date);
    if (existing && existing.check_in_at) {
      return { record: toAttendance(existing), alreadyCheckedIn: true };
    }
    if (existing) {
      db.prepare(
        'UPDATE attendance SET check_in_at = ?, latitude = ?, longitude = ?, updated_at = ? WHERE id = ?',
      ).run(ts, geo.latitude ?? null, geo.longitude ?? null, ts, existing.id);
    } else {
      db.prepare(
        `INSERT INTO attendance (id, employee_id, employee_name, date, check_in_at, status,
                                 latitude, longitude, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'present', ?, ?, ?, ?)`,
      ).run(uuid(), user.id, user.name, date, ts, geo.latitude ?? null, geo.longitude ?? null, ts, ts);
    }
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_ATTENDANCE_CHECK_IN',
      targetType: 'attendance',
      targetId: user.id,
      metadata: { date },
      ip,
    });
    return { record: toAttendance(rowFor(db, user.id, date)), alreadyCheckedIn: false };
  });
}

function checkOut(db, user, geo = {}, { ip = null } = {}) {
  return tx(db, () => {
    const date = today();
    const ts = now();
    const existing = rowFor(db, user.id, date);
    if (!existing) throw badRequest('Check in before checking out.');
    if (existing.check_out_at) {
      return { record: toAttendance(existing), alreadyCheckedOut: true };
    }
    db.prepare(
      'UPDATE attendance SET check_out_at = ?, updated_at = ? WHERE id = ?',
    ).run(ts, ts, existing.id);
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_ATTENDANCE_CHECK_OUT',
      targetType: 'attendance',
      targetId: user.id,
      metadata: { date },
      ip,
    });
    return { record: toAttendance(rowFor(db, user.id, date)), alreadyCheckedOut: false };
  });
}

/** Manual mark (Main Admin): today or any date, upsert. */
function markAttendance(db, actor, input, { ip = null } = {}) {
  return tx(db, () => {
    const employee = db.prepare('SELECT * FROM users WHERE id = ?').get(String(input.employee_id));
    if (!employee) throw notFound('Employee not found.');
    const date = input.date || today();
    const ts = now();
    const existing = rowFor(db, employee.id, date);
    if (existing) {
      db.prepare(
        'UPDATE attendance SET status = ?, remarks = ?, updated_at = ? WHERE id = ?',
      ).run(input.status, input.remarks ?? existing.remarks, ts, existing.id);
    } else {
      db.prepare(
        `INSERT INTO attendance (id, employee_id, employee_name, date, status, remarks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(uuid(), employee.id, employee.name, date, input.status, input.remarks ?? null, ts, ts);
    }
    logAction(db, {
      actorId: actor.id,
      actorLabel: actor.name,
      action: 'PET_ATTENDANCE_MARKED',
      targetType: 'attendance',
      targetId: employee.id,
      metadata: { date, status: input.status },
      ip,
    });
    return { record: toAttendance(rowFor(db, employee.id, date)) };
  });
}

function listAttendance(db, { employee_id = null, from = null, to = null, month = null, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];
  if (employee_id) {
    where.push('a.employee_id = ?');
    params.push(employee_id);
  }
  if (from) {
    where.push('a.date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('a.date <= ?');
    params.push(to);
  }
  if (month) {
    where.push('a.date LIKE ?');
    params.push(`${month}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM attendance a ${clause}`).get(...params).c);
  const rows = db
    .prepare(`SELECT * FROM attendance a ${clause} ORDER BY a.date DESC, a.check_in_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { total, attendance: rows.map(toAttendance) };
}

/** Month summary — one row per employee with per-status day counts. */
function monthSummary(db, month) {
  const rows = db
    .prepare(
      `SELECT a.employee_id, a.employee_name,
              SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
              SUM(CASE WHEN a.status = 'absent'   THEN 1 ELSE 0 END) AS absent,
              SUM(CASE WHEN a.status = 'leave'    THEN 1 ELSE 0 END) AS leave_days,
              SUM(CASE WHEN a.status = 'half_day' THEN 1 ELSE 0 END) AS half_day,
              SUM(CASE WHEN a.status = 'late'     THEN 1 ELSE 0 END) AS late,
              COUNT(*) AS days
         FROM attendance a
        WHERE a.date LIKE ?
        GROUP BY a.employee_id, a.employee_name
        ORDER BY a.employee_name`,
    )
    .all(`${month}%`);
  return {
    month,
    summary: rows.map(r => ({
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      present: Number(r.present),
      absent: Number(r.absent),
      leave: Number(r.leave_days),
      half_day: Number(r.half_day),
      late: Number(r.late),
      days: Number(r.days),
    })),
  };
}

module.exports = { todayRecord, checkIn, checkOut, markAttendance, listAttendance, monthSummary, rowFor };
