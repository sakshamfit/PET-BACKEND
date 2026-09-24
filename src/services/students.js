/**
 * Students — registration with duplicate detection, lifecycle transitions,
 * canonical profile. Shared by the students router, the offline /sync
 * replay, and website-form conversion, so all three paths behave exactly
 * the same (docs/PET contract: existing records are never auto-merged).
 */
'use strict';

const { ApiError, notFound, badRequest } = require('../lib/errors');
const { uuid, now, petStudentId } = require('../lib/ids');
const { tx } = require('../db');
const { logAction } = require('../lib/audit');
const { toStudent } = require('./serialize');

const STATUS_FLOW = {
  registered: ['test_scheduled'],
  test_scheduled: ['test_completed'],
  test_completed: ['under_evaluation'],
  under_evaluation: ['selected', 'waitlisted', 'not_selected'],
  selected: ['enrolled'],
  waitlisted: ['selected', 'not_selected', 'enrolled'],
  not_selected: ['registered', 'inactive'],
  enrolled: [],
  inactive: ['registered'],
};

/** Decisions only a Main Admin may record (the UI hides these from employees). */
const ADMIN_ONLY_TARGETS = new Set(['selected', 'waitlisted', 'not_selected', 'enrolled']);

const normalizeName = name =>
  String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

const normalizePhone = phone => {
  const raw = String(phone || '').replace(/[^\d+]/g, '');
  if (!raw) return null;
  // 91XXXXXXXXXX / 0XXXXXXXXXX → local 10-digit form for comparison.
  const digits = raw.replace(/^\+?91/, '').replace(/^0/, '');
  return digits || null;
};

/**
 * Candidates that look like the same person, each with human reasons the
 * registration screen prints under "Matched:".
 */
function findDuplicates(db, input) {
  const name = normalizeName(input.name);
  const parentPhone = normalizePhone(input.parent_phone);
  const studentPhone = normalizePhone(input.student_phone);
  const candidates = new Map(); // id → { row, reasons:Set }

  const add = (row, reason) => {
    if (input.exclude_id && row.id === input.exclude_id) return;
    if (!candidates.has(row.id)) candidates.set(row.id, { row, reasons: new Set() });
    candidates.get(row.id).reasons.add(reason);
  };

  if (name) {
    // Compare on normalized name in SQL-friendly fashion: LIKE on the raw
    // name catches most rows; exact filter happens in JS below at office-PC
    // scale (thousands of students), so we pull all names once if needed.
    const firstWord = name.split(' ')[0];
    const rows = db
      .prepare(
        `SELECT * FROM students
          WHERE LOWER(REPLACE(REPLACE(name, '  ', ' '), ' ', ' ')) LIKE ?
             OR LOWER(name) LIKE ?`,
      )
      .all(`%${name}%`, `%${firstWord}%`);
    for (const row of rows) if (normalizeName(row.name) === name) add(row, 'same name');
  }

  if (parentPhone) {
    for (const row of db
      .prepare(`SELECT * FROM students WHERE parent_phone IS NOT NULL AND parent_phone <> ''`)
      .all()) {
      if (normalizePhone(row.parent_phone) === parentPhone) add(row, 'same parent phone');
    }
  }
  if (studentPhone) {
    for (const row of db
      .prepare(`SELECT * FROM students WHERE student_phone IS NOT NULL AND student_phone <> ''`)
      .all()) {
      if (normalizePhone(row.student_phone) === studentPhone) add(row, 'same student phone');
    }
  }
  if (input.school_id && input.dob) {
    for (const row of db
      .prepare('SELECT * FROM students WHERE school_id = ? AND dob = ?')
      .all(input.school_id, input.dob)) {
      add(row, 'same school & date of birth');
    }
  } else if (input.school_id && name) {
    for (const row of db.prepare('SELECT * FROM students WHERE school_id = ?').all(input.school_id)) {
      if (normalizeName(row.name) === name) add(row, 'same school & name');
    }
  }

  return [...candidates.values()].map(({ row, reasons }) => ({
    id: row.id,
    pet_student_id: row.pet_student_id,
    name: row.name,
    school_name: row.school_name ?? null,
    status: row.status,
    parent_phone: row.parent_phone ?? null,
    reasons: [...reasons],
  }));
}

/**
 * Insert a student. Throws 409 POSSIBLE_DUPLICATES unless the caller has
 * `acknowledge_duplicates` (the screen's "Not a duplicate — save new").
 * @returns {{student: object, duplicates: object[]}}
 */
function registerStudent(db, user, input, { source = 'field_app', ip = null } = {}) {
  return tx(db, () => {
    const duplicates = findDuplicates(db, {
      name: input.name,
      parent_phone: input.parent_phone,
      student_phone: input.student_phone,
      school_id: input.school_id,
      dob: input.dob,
    });

    if (duplicates.length && !input.acknowledge_duplicates) {
      throw new ApiError(409, 'POSSIBLE_DUPLICATES', 'Possible duplicate students found.', {
        duplicates,
      });
    }

    let schoolName = input.school_name ?? null;
    let schoolAddress = input.school_address ?? null;
    if (input.school_id) {
      const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(input.school_id);
      if (!school) throw badRequest('Linked school not found.');
      schoolName = school.name;
      schoolAddress = school.address ?? schoolAddress;
    }

    const ts = now();
    const id = uuid();
    const petId = petStudentId(db);
    const visitId = input.visit_id ?? null;
    let registeredVisit = null;
    if (visitId) {
      registeredVisit = db.prepare('SELECT * FROM field_visits WHERE id = ?').get(visitId);
      if (!registeredVisit) throw badRequest('Linked visit not found.');
    }

    db.prepare(
      `INSERT INTO students (
         id, pet_student_id, name, photo_path, dob, age, gender, student_phone,
         parent_name, parent_phone, parent_relation, school_id, school_name, school_address,
         locality, city, district, state, current_class, previous_school, address,
         status, registration_source, registered_by_user_id, registered_by_user_name,
         registration_date, registered_visit_id, notes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 'registered', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      petId,
      input.name,
      input.photo_path ?? null,
      input.dob ?? null,
      input.age ?? null,
      input.gender ?? null,
      input.student_phone ?? null,
      input.parent_name ?? null,
      input.parent_phone ?? null,
      input.parent_relation ?? null,
      input.school_id ?? null,
      schoolName,
      schoolAddress,
      input.locality ?? null,
      input.city ?? null,
      input.district ?? null,
      input.state ?? null,
      input.current_class ?? null,
      input.previous_school ?? null,
      input.address ?? null,
      source,
      user.id,
      user.name,
      ts,
      visitId,
      input.notes ?? null,
      ts,
      ts,
    );

    db.prepare(
      `INSERT INTO student_status_history
         (id, student_id, from_status, to_status, changed_by_user_id, changed_by_user_name, reason, created_at)
       VALUES (?, ?, NULL, 'registered', ?, ?, ?, ?)`,
    ).run(uuid(), id, user.id, user.name, input.notes ? 'Registered with notes' : null, ts);

    if (registeredVisit) {
      db.prepare(
        `UPDATE field_visits SET students_registered = students_registered + 1, updated_at = ?
          WHERE id = ?`,
      ).run(ts, registeredVisit.id);
    }

    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_STUDENT_REGISTERED',
      targetType: 'student',
      targetId: id,
      metadata: { pet_student_id: petId, name: input.name, source, duplicates: duplicates.length },
      ip,
    });

    const row = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    return { student: toStudent(row), duplicates };
  });
}

/** Validate + apply a status transition; history row + audit for free. */
function changeStudentStatus(db, user, studentId, toStatus, reason = null, { ip = null } = {}) {
  return tx(db, () => {
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(String(studentId));
    if (!student) throw notFound('Student not found.');
    if (student.status === toStatus) return toStudent(student);

    const allowed = STATUS_FLOW[student.status] || [];
    if (!allowed.includes(toStatus)) {
      throw new ApiError(400, 'INVALID_TRANSITION', `Cannot move from ${student.status} to ${toStatus}.`, {
        from: student.status,
        to: toStatus,
        allowed,
      });
    }
    if (ADMIN_ONLY_TARGETS.has(toStatus) && user.role !== 'main_admin') {
      throw new ApiError(403, 'FORBIDDEN', 'Only the Main Admin can record selection decisions.');
    }

    const ts = now();
    db.prepare('UPDATE students SET status = ?, updated_at = ? WHERE id = ?').run(toStatus, ts, student.id);
    db.prepare(
      `INSERT INTO student_status_history
         (id, student_id, from_status, to_status, changed_by_user_id, changed_by_user_name, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(uuid(), student.id, student.status, toStatus, user.id, user.name, reason, ts);

    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_STUDENT_STATUS_CHANGED',
      targetType: 'student',
      targetId: student.id,
      metadata: { from: student.status, to: toStatus, reason },
      ip,
    });

    return toStudent(db.prepare('SELECT * FROM students WHERE id = ?').get(student.id));
  });
}

/** Paginated search used by the list screen and task/student pickers. */
function searchStudents(db, { q = null, status = null, school_id = null, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];
  if (q) {
    where.push(
      `(LOWER(s.name) LIKE ? OR LOWER(s.pet_student_id) LIKE ?
        OR REPLACE(COALESCE(s.parent_phone,''), ' ', '') LIKE ?
        OR REPLACE(COALESCE(s.student_phone,''), ' ', '') LIKE ?
        OR LOWER(COALESCE(s.parent_name,'')) LIKE ?
        OR LOWER(COALESCE(s.district,'')) LIKE ?
        OR LOWER(COALESCE(s.city,'')) LIKE ?)`,
    );
    const like = `%${q.toLowerCase()}%`;
    params.push(like, like, `%${q.replace(/\s/g, '')}%`, `%${q.replace(/\s/g, '')}%`, like, like, like);
  }
  if (status) {
    where.push('s.status = ?');
    params.push(status);
  }
  if (school_id) {
    where.push('s.school_id = ?');
    params.push(school_id);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    db.prepare(`SELECT COUNT(*) AS c FROM students s ${clause}`).get(...params).c,
  );
  const rows = db
    .prepare(`SELECT s.* FROM students s ${clause} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { total, students: rows.map(toStudent) };
}

/** Canonical profile screen payload. */
function studentProfile(db, studentId) {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(String(studentId));
  if (!student) throw notFound('Student not found.');

  const journey = db
    .prepare(
      `SELECT * FROM student_status_history WHERE student_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(student.id)
    .map(r => ({
      id: r.id,
      student_id: r.student_id,
      from_status: r.from_status,
      to_status: r.to_status,
      changed_by_user_id: r.changed_by_user_id,
      changed_by_user_name: r.changed_by_user_name,
      reason: r.reason,
      created_at: r.created_at,
    }));

  const tests = db
    .prepare(
      `SELECT t.name AS test_name, a.status AS assignment_status, a.decision AS evaluation_result,
              t.passing_percentage, t.id AS test_id, a.id AS assignment_id
         FROM test_assignments a JOIN tests t ON t.id = a.test_id
        WHERE a.student_id = ? ORDER BY t.created_at DESC`,
    )
    .all(student.id)
    .map(r => {
      const score = computeScoreFor(db, r.assignment_id, r.passing_percentage);
      return {
        test_id: r.test_id,
        test_name: r.test_name,
        assignment_status: r.assignment_status,
        percentage: score ? score.percentage : null,
        evaluation_result: r.evaluation_result || (score && score.complete ? score.suggested_result : null),
      };
    });

  const results = db
    .prepare(
      `SELECT sub.name AS subject, m.obtained_marks, sub.max_marks
         FROM test_marks m
         JOIN test_assignments a ON a.id = m.assignment_id
         JOIN test_subjects sub ON sub.id = m.subject_id
        WHERE a.student_id = ?`,
    )
    .all(student.id)
    .map(r => ({
      subject: r.subject,
      obtained_marks: Number(r.obtained_marks),
      max_marks: Number(r.max_marks),
    }));

  const enrollmentRow = db.prepare('SELECT * FROM enrollments WHERE student_id = ?').get(student.id);

  const documents = db
    .prepare('SELECT * FROM student_documents WHERE student_id = ? ORDER BY created_at DESC')
    .all(student.id);

  const tasks = db
    .prepare('SELECT * FROM tasks WHERE student_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(student.id);

  const visits = db
    .prepare(
      `SELECT * FROM field_visits WHERE id = ?
        UNION SELECT * FROM field_visits WHERE id IN (
          SELECT registered_visit_id FROM students WHERE id = ? AND registered_visit_id IS NOT NULL
        )`,
    )
    .all(student.registered_visit_id, student.id);

  const { toTask, toVisit, toEnrollment, toDocument } = require('./serialize');

  return {
    student: toStudent(student),
    journey,
    tests,
    results,
    enrollment: enrollmentRow ? toEnrollment(enrollmentRow) : null,
    documents: documents.map(toDocument),
    tasks: tasks.map(toTask),
    visits: visits.map(toVisit),
  };
}

/** Aggregate marks for one assignment (shared with the tests router). */
function computeScoreFor(db, assignmentId, passingPercentage) {
  const subjects = db
    .prepare(
      `SELECT sub.id, sub.name, sub.max_marks, sub.passing_marks, m.obtained_marks
         FROM test_subjects sub
         LEFT JOIN test_marks m ON m.subject_id = sub.id AND m.assignment_id = ?
        WHERE sub.test_id = (SELECT test_id FROM test_assignments WHERE id = ?)
        ORDER BY sub.sort_order, sub.name`,
    )
    .all(assignmentId, assignmentId);
  if (!subjects.length) return null;

  let totalObtained = 0;
  let totalMax = 0;
  let complete = true;
  let subjectPass = true;
  for (const s of subjects) {
    totalMax += Number(s.max_marks);
    if (s.obtained_marks === null || s.obtained_marks === undefined) {
      complete = false;
      continue;
    }
    const got = Number(s.obtained_marks);
    totalObtained += got;
    if (s.passing_marks !== null && s.passing_marks !== undefined && got < Number(s.passing_marks)) {
      subjectPass = false;
    }
  }
  const percentage = totalMax > 0 ? Math.round((totalObtained / totalMax) * 10000) / 100 : 0;
  const overall = percentage >= Number(passingPercentage ?? 0);
  return {
    subjects: subjects.map(s => ({
      subject_id: s.id,
      name: s.name,
      max_marks: Number(s.max_marks),
      passing_marks: s.passing_marks === null || s.passing_marks === undefined ? null : Number(s.passing_marks),
      obtained_marks:
        s.obtained_marks === null || s.obtained_marks === undefined ? null : Number(s.obtained_marks),
    })),
    total_obtained: Math.round(totalObtained * 100) / 100,
    total_max: totalMax,
    percentage,
    complete,
    suggested_result: complete && overall && subjectPass ? 'eligible' : 'not_eligible',
    passing_percentage: Number(passingPercentage ?? 0),
  };
}

module.exports = {
  STATUS_FLOW,
  ADMIN_ONLY_TARGETS,
  normalizeName,
  normalizePhone,
  findDuplicates,
  registerStudent,
  changeStudentStatus,
  searchStudents,
  studentProfile,
  computeScoreFor,
};
