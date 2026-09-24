/**
 * Schools — directory + archive. Renames propagate to the denormalized
 * `school_name` copies on students and visits so lists stay truthful.
 */
'use strict';

const { ApiError, notFound } = require('../lib/errors');
const { uuid, now, schoolCode } = require('../lib/ids');
const { tx } = require('../db');
const { logAction } = require('../lib/audit');
const { toSchool, toVisit, toStudent } = require('./serialize');

function listSchools(db, { q = null, status = null, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];
  if (q) {
    where.push(
      `(LOWER(name) LIKE ? OR LOWER(school_code) LIKE ?
        OR LOWER(COALESCE(city,'')) LIKE ? OR LOWER(COALESCE(district,'')) LIKE ?
        OR LOWER(COALESCE(locality,'')) LIKE ?)`,
    );
    const like = `%${q.toLowerCase()}%`;
    params.push(like, like, like, like, like);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM schools ${clause}`).get(...params).c);
  const rows = db
    .prepare(`SELECT * FROM schools ${clause} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { total, schools: rows.map(toSchool) };
}

function getSchool(db, id) {
  const row = db.prepare('SELECT * FROM schools WHERE id = ?').get(String(id || ''));
  if (!row) throw notFound('School not found.');
  return toSchool(row);
}

function schoolProfile(db, id) {
  const school = getSchool(db, id);
  const stats = {
    students: Number(
      db.prepare('SELECT COUNT(*) AS c FROM students WHERE school_id = ?').get(school.id).c,
    ),
    active_visits: Number(
      db
        .prepare(`SELECT COUNT(*) AS c FROM field_visits WHERE school_id = ? AND status = 'active'`)
        .get(school.id).c,
    ),
    total_visits: Number(
      db.prepare('SELECT COUNT(*) AS c FROM field_visits WHERE school_id = ?').get(school.id).c,
    ),
  };
  const recent_visits = db
    .prepare('SELECT * FROM field_visits WHERE school_id = ? ORDER BY started_at DESC LIMIT 10')
    .all(school.id)
    .map(toVisit);
  const recent_students = db
    .prepare('SELECT * FROM students WHERE school_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(school.id)
    .map(toStudent);
  return { school, stats, recent_visits, recent_students };
}

function createSchool(db, user, input, { ip = null } = {}) {
  return tx(db, () => {
    const ts = now();
    const id = uuid();
    const code = schoolCode(db);
    db.prepare(
      `INSERT INTO schools (id, school_code, name, address, locality, city, district, state, phone,
                            contact_person_name, contact_person_phone, latitude, longitude, notes,
                            created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      code,
      input.name,
      input.address ?? null,
      input.locality ?? null,
      input.city ?? null,
      input.district ?? null,
      input.state ?? null,
      input.phone ?? null,
      input.contact_person_name ?? null,
      input.contact_person_phone ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      input.notes ?? null,
      user.id,
      ts,
      ts,
    );
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_SCHOOL_CREATED',
      targetType: 'school',
      targetId: id,
      metadata: { name: input.name, school_code: code },
      ip,
    });
    return { school: getSchool(db, id) };
  });
}

function updateSchool(db, user, id, input, { ip = null } = {}) {
  return tx(db, () => {
    const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(String(id));
    if (!school) throw notFound('School not found.');
    const allowed = [
      'name', 'address', 'locality', 'city', 'district', 'state', 'phone',
      'contact_person_name', 'contact_person_phone', 'latitude', 'longitude', 'notes',
    ];
    const sets = [];
    const params = [];
    const changed = [];
    for (const key of allowed) {
      if (input[key] === undefined) continue;
      sets.push(`${key} = ?`);
      params.push(input[key]);
      changed.push(key);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(now());
      db.prepare(`UPDATE schools SET ${sets.join(', ')} WHERE id = ?`).run(...params, school.id);
    }
    if (input.name !== undefined && input.name !== null && input.name !== school.name) {
      db.prepare('UPDATE students SET school_name = ? WHERE school_id = ?').run(input.name, school.id);
      db.prepare('UPDATE field_visits SET school_name = ? WHERE school_id = ?').run(input.name, school.id);
    }
    if (changed.length) {
      logAction(db, {
        actorId: user.id,
        actorLabel: user.name,
        action: 'PET_SCHOOL_UPDATED',
        targetType: 'school',
        targetId: school.id,
        metadata: { fields: changed },
        ip,
      });
    }
    return { school: getSchool(db, school.id) };
  });
}

function archiveSchool(db, user, id, { ip = null } = {}) {
  return tx(db, () => {
    const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(String(id));
    if (!school) throw notFound('School not found.');
    if (school.status === 'archived') return { school: toSchool(school) };
    db.prepare(`UPDATE schools SET status = 'archived', updated_at = ? WHERE id = ?`).run(now(), school.id);
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_SCHOOL_ARCHIVED',
      targetType: 'school',
      targetId: school.id,
      metadata: { name: school.name },
      ip,
    });
    return { school: getSchool(db, school.id) };
  });
}

module.exports = { listSchools, getSchool, schoolProfile, createSchool, updateSchool, archiveSchool };
