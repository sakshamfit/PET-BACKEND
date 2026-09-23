/**
 * Field visits — one active visit per employee (the dashboard's "visit in
 * progress" banner assumes it), GPS captured at both ends.
 */
'use strict';

const { ApiError, notFound, badRequest } = require('../lib/errors');
const { uuid, now } = require('../lib/ids');
const { tx } = require('../db');
const { logAction } = require('../lib/audit');
const { toVisit, toMedia, toStudent, toTask } = require('./serialize');

function listVisits(db, { status = null, school_id = null, employee_id = null, q = null, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];
  if (status) {
    where.push('v.status = ?');
    params.push(status);
  }
  if (school_id) {
    where.push('v.school_id = ?');
    params.push(school_id);
  }
  if (employee_id) {
    where.push('v.employee_id = ?');
    params.push(employee_id);
  }
  if (q) {
    where.push('(LOWER(v.school_name) LIKE ? OR LOWER(v.employee_name) LIKE ?)');
    params.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM field_visits v ${clause}`).get(...params).c);
  const rows = db
    .prepare(`SELECT v.* FROM field_visits v ${clause} ORDER BY v.started_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { total, visits: rows.map(toVisit) };
}

function activeVisitOf(db, employeeId) {
  const row = db
    .prepare(`SELECT * FROM field_visits WHERE employee_id = ? AND status = 'active' LIMIT 1`)
    .get(employeeId);
  return row ? toVisit(row) : null;
}

function startVisit(db, user, input, { ip = null } = {}) {
  return tx(db, () => {
    const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(String(input.school_id || ''));
    if (!school) throw badRequest('School not found.');
    if (school.status === 'archived') throw badRequest('That school is archived.');

    const existing = db
      .prepare(`SELECT * FROM field_visits WHERE employee_id = ? AND status = 'active'`)
      .get(user.id);
    if (existing) {
      throw new ApiError(409, 'ACTIVE_VISIT_EXISTS', 'You already have a visit in progress. End it first.', {
        visit_id: existing.id,
        school_name: existing.school_name,
      });
    }

    const ts = now();
    const id = uuid();
    db.prepare(
      `INSERT INTO field_visits (id, school_id, school_name, employee_id, employee_name, purpose,
                                 status, started_at, start_latitude, start_longitude, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      school.id,
      school.name,
      user.id,
      user.name,
      input.purpose ?? null,
      ts,
      input.latitude ?? null,
      input.longitude ?? null,
      ts,
      ts,
    );
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_VISIT_STARTED',
      targetType: 'field_visit',
      targetId: id,
      metadata: { school: school.name },
      ip,
    });
    return { visit: toVisit(db.prepare('SELECT * FROM field_visits WHERE id = ?').get(id)) };
  });
}

function updateVisit(db, user, id, input, { ip = null } = {}) {
  return tx(db, () => {
    const visit = db.prepare('SELECT * FROM field_visits WHERE id = ?').get(String(id));
    if (!visit) throw notFound('Visit not found.');
    const editable = {
      purpose: input.purpose,
      notes: input.notes,
      report: input.report,
      students_contacted: input.students_contacted,
      documents_collected: input.documents_collected,
    };
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(editable)) {
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      params.push(value === null ? null : typeof value === 'number' ? value : value);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(now());
      db.prepare(`UPDATE field_visits SET ${sets.join(', ')} WHERE id = ?`).run(...params, visit.id);
    }
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_VISIT_UPDATED',
      targetType: 'field_visit',
      targetId: visit.id,
      metadata: { fields: Object.keys(editable).filter(k => editable[k] !== undefined) },
      ip,
    });
    return { visit: toVisit(db.prepare('SELECT * FROM field_visits WHERE id = ?').get(visit.id)) };
  });
}

function endVisit(db, user, id, input = {}, { ip = null, isAdmin = false } = {}) {
  return tx(db, () => {
    const visit = db.prepare('SELECT * FROM field_visits WHERE id = ?').get(String(id));
    if (!visit) throw notFound('Visit not found.');
    if (visit.employee_id !== user.id && !isAdmin && user.role !== 'main_admin') {
      throw new ApiError(403, 'FORBIDDEN', 'Only the visiting employee or a Main Admin can end this visit.');
    }
    if (visit.status !== 'active') {
      throw new ApiError(409, 'VISIT_NOT_ACTIVE', 'This visit is already finished.');
    }
    const ts = now();
    db.prepare(
      `UPDATE field_visits
          SET status = 'completed', ended_at = ?, end_latitude = ?, end_longitude = ?,
              report = COALESCE(?, report),
              notes = COALESCE(?, notes),
              students_contacted = COALESCE(?, students_contacted),
              documents_collected = COALESCE(?, documents_collected),
              updated_at = ?
        WHERE id = ?`,
    ).run(
      ts,
      input.latitude ?? null,
      input.longitude ?? null,
      input.report ?? null,
      input.notes ?? null,
      input.students_contacted ?? null,
      input.documents_collected ?? null,
      ts,
      visit.id,
    );
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_VISIT_ENDED',
      targetType: 'field_visit',
      targetId: visit.id,
      metadata: { school: visit.school_name },
      ip,
    });
    return { visit: toVisit(db.prepare('SELECT * FROM field_visits WHERE id = ?').get(visit.id)) };
  });
}

function visitDetail(db, user, id) {
  const visit = db.prepare('SELECT * FROM field_visits WHERE id = ?').get(String(id));
  if (!visit) throw notFound('Visit not found.');
  const media = db
    .prepare('SELECT * FROM field_media WHERE visit_id = ? ORDER BY created_at DESC')
    .all(visit.id);
  const students = db
    .prepare(
      'SELECT * FROM students WHERE registered_visit_id = ? ORDER BY created_at DESC LIMIT 200',
    )
    .all(visit.id);
  const tasks = db.prepare('SELECT * FROM tasks WHERE visit_id = ? ORDER BY created_at DESC').all(visit.id);
  return {
    visit: toVisit(visit),
    media: media.map(toMedia),
    students: students.map(toStudent),
    tasks: tasks.map(toTask),
  };
}

module.exports = { listVisits, activeVisitOf, startVisit, updateVisit, endVisit, visitDetail };
