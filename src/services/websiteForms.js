/**
 * Website form submissions (leads from the public site) — assign, progress,
 * convert into a student record (with the same duplicate guard as the app).
 */
'use strict';

const { ApiError, notFound, badRequest } = require('../lib/errors');
const { uuid, now } = require('../lib/ids');
const { tx } = require('../db');
const { logAction } = require('../lib/audit');
const { toSubmission } = require('./serialize');
const { registerStudent } = require('./students');

const STATUSES = ['new', 'assigned', 'in_progress', 'converted', 'closed'];
const FORM_TYPES = ['student_registration', 'enquiry', 'volunteer', 'school_partnership', 'contact'];

function listSubmissions(db, { status = null, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    db.prepare(`SELECT COUNT(*) AS c FROM website_form_submissions ${clause}`).get(...params).c,
  );
  const rows = db
    .prepare(
      `SELECT * FROM website_form_submissions ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return { total, submissions: rows.map(toSubmission) };
}

/** Ingest used by the public site / seed script. */
function createSubmission(db, input) {
  const ts = now();
  const id = uuid();
  const formType = FORM_TYPES.includes(input.form_type) ? input.form_type : 'enquiry';
  db.prepare(
    `INSERT INTO website_form_submissions (id, form_type, name, phone, email, payload, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
  ).run(
    id,
    formType,
    String(input.name || '').trim() || 'Anonymous',
    String(input.phone || '').trim(),
    input.email ? String(input.email).trim() : null,
    input.payload ? JSON.stringify(input.payload) : null,
    ts,
    ts,
  );
  return { submission: toSubmission(db.prepare('SELECT * FROM website_form_submissions WHERE id = ?').get(id)) };
}

function assignSubmission(db, actor, id, assigneeId, { ip = null } = {}) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM website_form_submissions WHERE id = ?').get(String(id));
    if (!row) throw notFound('Submission not found.');
    const assignee = db.prepare('SELECT * FROM users WHERE id = ?').get(String(assigneeId || ''));
    if (!assignee) throw badRequest('Employee not found.');
    const ts = now();
    db.prepare(
      `UPDATE website_form_submissions
          SET assigned_to_user_id = ?, assigned_to_user_name = ?,
              status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END,
              updated_at = ?
        WHERE id = ?`,
    ).run(assignee.id, assignee.name, ts, row.id);
    logAction(db, {
      actorId: actor.id,
      actorLabel: actor.name,
      action: 'PET_FORM_ASSIGNED',
      targetType: 'website_form',
      targetId: row.id,
      metadata: { assignee: assignee.name },
      ip,
    });
    return { submission: toSubmission(db.prepare('SELECT * FROM website_form_submissions WHERE id = ?').get(row.id)) };
  });
}

function setSubmissionStatus(db, actor, id, status, { ip = null } = {}) {
  return tx(db, () => {
    if (!STATUSES.includes(status)) throw badRequest(`Unknown status '${status}'.`);
    const row = db.prepare('SELECT * FROM website_form_submissions WHERE id = ?').get(String(id));
    if (!row) throw notFound('Submission not found.');
    if (status === 'converted') throw badRequest('Use the convert action to turn this into a student.');
    db.prepare('UPDATE website_form_submissions SET status = ?, updated_at = ? WHERE id = ?').run(
      status,
      now(),
      row.id,
    );
    logAction(db, {
      actorId: actor.id,
      actorLabel: actor.name,
      action: 'PET_FORM_STATUS_CHANGED',
      targetType: 'website_form',
      targetId: row.id,
      metadata: { status },
      ip,
    });
    return { submission: toSubmission(db.prepare('SELECT * FROM website_form_submissions WHERE id = ?').get(row.id)) };
  });
}

/** Map form payload keys → StudentRegistrationInput fields. */
function inputFromSubmission(row, overrides = {}) {
  const payload = row.payload ? JSON.parse(row.payload) : {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (payload[k] !== undefined && payload[k] !== null && payload[k] !== '') return payload[k];
    }
    return null;
  };
  return {
    name: String(overrides.name ?? payload.name ?? row.name ?? '').trim(),
    dob: overrides.dob ?? pick('dob', 'date_of_birth') ?? null,
    age: overrides.age ?? pick('age') ?? null,
    gender: overrides.gender ?? pick('gender') ?? null,
    student_phone: overrides.student_phone ?? pick('student_phone', 'phone') ?? null,
    parent_name: overrides.parent_name ?? pick('parent_name', 'guardian_name') ?? null,
    parent_phone: overrides.parent_phone ?? pick('parent_phone', 'guardian_phone') ?? row.phone ?? null,
    parent_relation: overrides.parent_relation ?? pick('parent_relation') ?? null,
    school_id: overrides.school_id ?? pick('school_id') ?? null,
    school_name: overrides.school_name ?? pick('school_name', 'school') ?? null,
    school_address: overrides.school_address ?? pick('school_address') ?? null,
    locality: overrides.locality ?? pick('locality', 'area') ?? null,
    city: overrides.city ?? pick('city') ?? null,
    district: overrides.district ?? pick('district') ?? null,
    state: overrides.state ?? pick('state') ?? null,
    current_class: overrides.current_class ?? pick('current_class', 'class', 'grade') ?? null,
    previous_school: overrides.previous_school ?? pick('previous_school') ?? null,
    address: overrides.address ?? pick('address') ?? null,
    notes: overrides.notes ?? pick('notes', 'message') ?? null,
    acknowledge_duplicates: !!overrides.acknowledge_duplicates,
    registration_source: 'website',
  };
}

function convertSubmission(db, actor, id, options = {}, { ip = null } = {}) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM website_form_submissions WHERE id = ?').get(String(id));
    if (!row) throw notFound('Submission not found.');
    if (row.status === 'converted') throw new ApiError(409, 'ALREADY_CONVERTED', 'This submission was already converted.');
    const { registration_source: source, ...studentInput } = inputFromSubmission(
      row,
      options.overrides || {},
    );
    if (!studentInput.name) throw badRequest('A student name is required to convert this submission.');

    const { student, duplicates } = registerStudent(
      db,
      actor,
      studentInput,
      { source, ip },
    );

    db.prepare(
      `UPDATE website_form_submissions
          SET status = 'converted', converted_student_id = ?, updated_at = ?
        WHERE id = ?`,
    ).run(student.id, now(), row.id);
    logAction(db, {
      actorId: actor.id,
      actorLabel: actor.name,
      action: 'PET_FORM_CONVERTED',
      targetType: 'website_form',
      targetId: row.id,
      metadata: { student_id: student.id, duplicates: duplicates.length },
      ip,
    });
    return {
      form: toSubmission(db.prepare('SELECT * FROM website_form_submissions WHERE id = ?').get(row.id)),
      student,
      duplicates,
    };
  });
}

module.exports = {
  STATUSES,
  FORM_TYPES,
  listSubmissions,
  createSubmission,
  assignSubmission,
  setSubmissionStatus,
  convertSubmission,
};
