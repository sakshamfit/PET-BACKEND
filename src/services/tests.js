/**
 * Tests & enrollment — the selection pipeline:
 *   test → assign students → enter marks → finalize → decision (admin)
 *   enrollment: follow_up → documents → verification → enrolled (or withdraw)
 */
'use strict';

const { ApiError, notFound, badRequest, forbidden } = require('../lib/errors');
const { uuid, now } = require('../lib/ids');
const { tx } = require('../db');
const { logAction } = require('../lib/audit');
const { notify } = require('../lib/notify');
const { toTest, toSubject, toEnrollment } = require('./serialize');
const { computeScoreFor, changeStudentStatus, STATUS_FLOW, ADMIN_ONLY_TARGETS } = require('./students');

function withSubjects(db, test) {
  const subjects = db
    .prepare('SELECT * FROM test_subjects WHERE test_id = ? ORDER BY sort_order, name')
    .all(test.id);
  return { ...test, subjects: subjects.map(toSubject) };
}

function listTests(db, { status = null, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM tests ${clause}`).get(...params).c);
  const rows = db
    .prepare(`SELECT * FROM tests ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { total, tests: rows.map(r => toTest(withSubjects(db, r))) };
}

function getTest(db, id) {
  const row = db.prepare('SELECT * FROM tests WHERE id = ?').get(String(id || ''));
  if (!row) throw notFound('Test not found.');
  const test = withSubjects(db, row);
  const assignments = db
    .prepare(
      `SELECT a.*, s.name AS student_name, s.pet_student_id, s.status AS student_status
         FROM test_assignments a JOIN students s ON s.id = a.student_id
        WHERE a.test_id = ? ORDER BY s.name COLLATE NOCASE`,
    )
    .all(row.id)
    .map(a => {
      const score = computeScoreFor(db, a.id, test.passing_percentage);
      return {
        id: a.id,
        student_id: a.student_id,
        student_name: a.student_name,
        pet_student_id: a.pet_student_id,
        student_status: a.student_status,
        status: a.status,
        decision: a.decision,
        decision_remarks: a.decision_remarks,
        finalized_at: a.finalized_at,
        score,
      };
    });
  return { test, assignments };
}

function createTest(db, user, input, { ip = null } = {}) {
  return tx(db, () => {
    if (!Array.isArray(input.subjects) || input.subjects.length === 0) {
      throw badRequest('Add at least one subject.');
    }
    const ts = now();
    const id = uuid();
    db.prepare(
      `INSERT INTO tests (id, name, description, passing_percentage, scheduled_date, status,
                          created_by_user_id, created_by_user_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.description ?? null,
      input.passing_percentage ?? 50,
      input.scheduled_date ?? null,
      input.scheduled_date ? 'scheduled' : 'draft',
      user.id,
      user.name,
      ts,
      ts,
    );
    let order = 0;
    const insertSubject = db.prepare(
      'INSERT INTO test_subjects (id, test_id, name, max_marks, passing_marks, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const s of input.subjects) {
      insertSubject.run(uuid(), id, s.name, s.max_marks, s.passing_marks ?? null, order);
      order += 1;
    }
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_TEST_CREATED',
      targetType: 'test',
      targetId: id,
      metadata: { name: input.name, subjects: input.subjects.length },
      ip,
    });
    return { test: toTest(withSubjects(db, db.prepare('SELECT * FROM tests WHERE id = ?').get(id))) };
  });
}

function updateTest(db, user, id, input, { ip = null } = {}) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM tests WHERE id = ?').get(String(id));
    if (!row) throw notFound('Test not found.');
    const sets = [];
    const params = [];
    for (const key of ['name', 'description', 'passing_percentage', 'scheduled_date', 'status']) {
      if (input[key] === undefined) continue;
      sets.push(`${key} = ?`);
      params.push(input[key]);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(now());
      db.prepare(`UPDATE tests SET ${sets.join(', ')} WHERE id = ?`).run(...params, row.id);
    }
    if (Array.isArray(input.subjects) && input.subjects.length) {
      db.prepare('DELETE FROM test_subjects WHERE test_id = ?').run(row.id);
      let order = 0;
      const insertSubject = db.prepare(
        'INSERT INTO test_subjects (id, test_id, name, max_marks, passing_marks, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const s of input.subjects) {
        insertSubject.run(uuid(), row.id, s.name, s.max_marks, s.passing_marks ?? null, order);
        order += 1;
      }
    }
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_TEST_UPDATED',
      targetType: 'test',
      targetId: row.id,
      ip,
    });
    return { test: toTest(withSubjects(db, db.prepare('SELECT * FROM tests WHERE id = ?').get(row.id))) };
  });
}

function assignStudents(db, user, id, studentIds = [], { ip = null } = {}) {
  return tx(db, () => {
    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(String(id));
    if (!test) throw notFound('Test not found.');
    const assigned = [];
    const skipped = [];
    const errors = [];
    const already = db
      .prepare('SELECT student_id FROM test_assignments WHERE test_id = ?')
      .all(test.id)
      .map(r => r.student_id);
    const ts = now();
    for (const rawId of [...new Set(studentIds.map(String))]) {
      if (already.includes(rawId)) {
        skipped.push(rawId);
        continue;
      }
      const student = db.prepare('SELECT id FROM students WHERE id = ?').get(rawId);
      if (!student) {
        errors.push({ student_id: rawId, message: 'Student not found.' });
        continue;
      }
      db.prepare(
        'INSERT INTO test_assignments (id, test_id, student_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(uuid(), test.id, rawId, 'assigned', ts);
      assigned.push(rawId);
    }
    if (assigned.length && test.status === 'draft') {
      db.prepare(`UPDATE tests SET status = 'scheduled', updated_at = ? WHERE id = ?`).run(ts, test.id);
    }
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_TEST_ASSIGNED',
      targetType: 'test',
      targetId: test.id,
      metadata: { assigned: assigned.length, skipped: skipped.length },
      ip,
    });
    return { assigned, skipped, errors };
  });
}

function assignmentOf(db, testId, studentId) {
  const row = db
    .prepare('SELECT * FROM test_assignments WHERE test_id = ? AND student_id = ?')
    .get(String(testId), String(studentId));
  if (!row) throw notFound('That student is not assigned to this test.');
  return row;
}

function enterMarks(db, user, testId, studentId, marks = [], { ip = null } = {}) {
  return tx(db, () => {
    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(String(testId));
    if (!test) throw notFound('Test not found.');
    const assignment = assignmentOf(db, testId, studentId);
    if (assignment.status === 'finalized') {
      throw badRequest('Marks are locked — this score was already finalized.');
    }
    const validSubjects = db.prepare('SELECT * FROM test_subjects WHERE test_id = ?').all(test.id);
    const upsert = db.prepare(
      `INSERT INTO test_marks (id, assignment_id, subject_id, obtained_marks) VALUES (?, ?, ?, ?)
       ON CONFLICT (assignment_id, subject_id) DO UPDATE SET obtained_marks = excluded.obtained_marks`,
    );
    for (const m of marks) {
      const subject = validSubjects.find(s => s.id === String(m.subject_id));
      if (!subject) throw badRequest(`Unknown subject '${m.subject_id}'.`);
      const value = Number(m.obtained_marks);
      if (!Number.isFinite(value) || value < 0) throw badRequest('Marks must be zero or more.');
      if (value > Number(subject.max_marks)) {
        throw badRequest(`${subject.name}: marks cannot exceed ${subject.max_marks}.`);
      }
      upsert.run(uuid(), assignment.id, subject.id, value);
    }
    if (assignment.status === 'absent') {
      db.prepare(`UPDATE test_assignments SET status = 'assigned' WHERE id = ?`).run(assignment.id);
    }
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_TEST_MARKS_ENTERED',
      targetType: 'test',
      targetId: test.id,
      metadata: { student_id: studentId, marks: marks.length },
      ip,
    });
    return { score: scoreFor(db, testId, studentId) };
  });
}

function scoreFor(db, testId, studentId) {
  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(String(testId));
  if (!test) throw notFound('Test not found.');
  const assignment = assignmentOf(db, testId, studentId);
  const score = computeScoreFor(db, assignment.id, test.passing_percentage);
  return {
    test_id: test.id,
    student_id: studentId,
    ...score,
    assignment_status: assignment.status,
    decision: assignment.decision,
    finalized: assignment.status === 'finalized',
  };
}

function finalizeScore(db, user, testId, studentId, { ip = null } = {}) {
  return tx(db, () => {
    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(String(testId));
    if (!test) throw notFound('Test not found.');
    const assignment = assignmentOf(db, testId, studentId);
    if (assignment.status === 'finalized') return { score: scoreFor(db, testId, studentId) };
    const score = computeScoreFor(db, assignment.id, test.passing_percentage);
    if (!score.complete) {
      throw badRequest('Enter marks for every subject before finalizing.');
    }
    const ts = now();
    db.prepare(`UPDATE test_assignments SET status = 'finalized', finalized_at = ? WHERE id = ?`).run(
      ts,
      assignment.id,
    );
    // Everything finalized/absent? The test itself is done.
    const remaining = Number(
      db
        .prepare(`SELECT COUNT(*) AS c FROM test_assignments WHERE test_id = ? AND status = 'assigned'`)
        .get(test.id).c,
    );
    if (remaining === 0) {
      db.prepare(`UPDATE tests SET status = 'completed', updated_at = ? WHERE id = ?`).run(ts, test.id);
    }
    // Nudge the student's lifecycle forward once a result exists.
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    if (student && student.status === 'test_scheduled') {
      changeStudentStatus(db, user, studentId, 'test_completed', 'Test finalized');
    }
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_TEST_SCORE_FINALIZED',
      targetType: 'test',
      targetId: test.id,
      metadata: { student_id: studentId, percentage: score.percentage },
      ip,
    });
    return { score: scoreFor(db, testId, studentId) };
  });
}

function markAbsent(db, user, testId, studentId, { ip = null } = {}) {
  return tx(db, () => {
    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(String(testId));
    if (!test) throw notFound('Test not found.');
    const assignment = assignmentOf(db, testId, studentId);
    if (assignment.status === 'finalized') throw badRequest('Already finalized.');
    db.prepare(`UPDATE test_assignments SET status = 'absent' WHERE id = ?`).run(assignment.id);
    db.prepare('DELETE FROM test_marks WHERE assignment_id = ?').run(assignment.id);
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_TEST_ABSENT_MARKED',
      targetType: 'test',
      targetId: test.id,
      metadata: { student_id: studentId },
      ip,
    });
    return { ok: true, student_id: studentId, status: 'absent' };
  });
}

const DECISIONS = ['selected', 'waitlisted', 'not_selected'];

function decide(db, user, testId, studentId, decision, remarks = null, { ip = null } = {}) {
  return tx(db, () => {
    if (user.role !== 'main_admin') {
      throw forbidden('Only the Main Admin can record selection decisions.');
    }
    if (!DECISIONS.includes(decision)) throw badRequest(`Unknown decision '${decision}'.`);
    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(String(testId));
    if (!test) throw notFound('Test not found.');
    const assignment = assignmentOf(db, testId, studentId);
    db.prepare('UPDATE test_assignments SET decision = ?, decision_remarks = ? WHERE id = ?').run(
      decision,
      remarks,
      assignment.id,
    );
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    if (student && student.status !== decision) {
      const allowed = STATUS_FLOW[student.status] || [];
      if (allowed.includes(decision)) {
        changeStudentStatus(db, user, studentId, decision, remarks || `Decision in ${test.name}`);
      } else if (ADMIN_ONLY_TARGETS.has(decision)) {
        // Decision overrides a stuck pipeline step — force it with history.
        const ts = now();
        db.prepare('UPDATE students SET status = ?, updated_at = ? WHERE id = ?').run(decision, ts, studentId);
        db.prepare(
          `INSERT INTO student_status_history
             (id, student_id, from_status, to_status, changed_by_user_id, changed_by_user_name, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(uuid(), studentId, student.status, decision, user.id, user.name, remarks, ts);
      } else {
        throw new ApiError(400, 'INVALID_TRANSITION', `Cannot move ${student.status} → ${decision}.`);
      }
    }
    notify(db, {
      userId: student.registered_by_user_id,
      title: `Student ${decision.replace('_', ' ')}`,
      message: `${student.name} (${student.pet_student_id})`,
      type: 'student',
      linkType: 'student',
      linkId: studentId,
    });
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_TEST_DECISION_RECORDED',
      targetType: 'student',
      targetId: studentId,
      metadata: { decision, test: test.name, remarks },
      ip,
    });
    return {
      student: require('./serialize').toStudent(
        db.prepare('SELECT * FROM students WHERE id = ?').get(studentId),
      ),
    };
  });
}

// ── Enrollment ───────────────────────────────────────────────────────────────

const STAGES = ['follow_up', 'documents', 'verification', 'enrolled'];

function listEnrollments(db, { status = null, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];
  if (status) {
    where.push('e.status = ?');
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM enrollments e ${clause}`).get(...params).c);
  const rows = db
    .prepare(
      `SELECT e.*, s.name AS student_name, s.pet_student_id
         FROM enrollments e JOIN students s ON s.id = e.student_id
         ${clause} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return {
    total,
    enrollments: rows.map(r => ({ ...toEnrollment(r), student_name: r.student_name, pet_student_id: r.pet_student_id })),
  };
}

function getEnrollment(db, studentId) {
  const row = db.prepare('SELECT * FROM enrollments WHERE student_id = ?').get(String(studentId));
  if (!row) throw notFound('Enrollment not found.');
  return { enrollment: toEnrollment(row) };
}

function startEnrollment(db, user, studentId, notes = null, { ip = null } = {}) {
  return tx(db, () => {
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(String(studentId));
    if (!student) throw notFound('Student not found.');
    const existing = db.prepare('SELECT * FROM enrollments WHERE student_id = ?').get(student.id);
    if (existing && existing.status === 'active') {
      throw new ApiError(409, 'ENROLLMENT_EXISTS', 'This student already has an active enrollment.');
    }
    const ts = now();
    if (existing) {
      db.prepare(
        `UPDATE enrollments SET stage = 'follow_up', status = 'active', notes = ?, started_by_user_id = ?,
                started_by_user_name = ?, verified_by_user_id = NULL, enrolled_at = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(notes, user.id, user.name, ts, existing.id);
    } else {
      db.prepare(
        `INSERT INTO enrollments (id, student_id, stage, status, notes, started_by_user_id,
                                  started_by_user_name, created_at, updated_at)
         VALUES (?, ?, 'follow_up', 'active', ?, ?, ?, ?, ?)`,
      ).run(uuid(), student.id, notes, user.id, user.name, ts, ts);
    }
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_ENROLLMENT_STARTED',
      targetType: 'student',
      targetId: student.id,
      metadata: { notes },
      ip,
    });
    return getEnrollment(db, student.id);
  });
}

function advanceEnrollment(db, user, studentId, stage, notes = null, { ip = null } = {}) {
  return tx(db, () => {
    if (!STAGES.includes(stage)) throw badRequest(`Unknown stage '${stage}'.`);
    const row = db.prepare('SELECT * FROM enrollments WHERE student_id = ?').get(String(studentId));
    if (!row || row.status !== 'active') throw notFound('No active enrollment for this student.');
    const ts = now();
    const isFinal = stage === 'enrolled';
    db.prepare(
      `UPDATE enrollments SET stage = ?, status = ?, notes = COALESCE(?, notes),
              enrolled_at = ?, verified_by_user_id = ?, updated_at = ? WHERE id = ?`,
    ).run(
      stage,
      isFinal ? 'completed' : 'active',
      notes,
      isFinal ? ts : row.enrolled_at,
      stage === 'verification' || isFinal ? user.id : row.verified_by_user_id,
      ts,
      row.id,
    );
    if (isFinal) {
      const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
      if (student && student.status !== 'enrolled') {
        const allowed = STATUS_FLOW[student.status] || [];
        if (allowed.includes('enrolled')) {
          changeStudentStatus(db, user, studentId, 'enrolled', 'Enrollment completed');
        } else {
          const nowTs = now();
          db.prepare('UPDATE students SET status = ?, updated_at = ? WHERE id = ?').run('enrolled', nowTs, studentId);
          db.prepare(
            `INSERT INTO student_status_history
               (id, student_id, from_status, to_status, changed_by_user_id, changed_by_user_name, reason, created_at)
             VALUES (?, ?, ?, 'enrolled', ?, ?, 'Enrollment completed', ?)`,
          ).run(uuid(), studentId, student.status, user.id, user.name, nowTs);
        }
      }
    }
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_ENROLLMENT_STAGE_CHANGED',
      targetType: 'student',
      targetId: studentId,
      metadata: { stage },
      ip,
    });
    return getEnrollment(db, studentId);
  });
}

function withdrawEnrollment(db, user, studentId, reason = null, { ip = null } = {}) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM enrollments WHERE student_id = ?').get(String(studentId));
    if (!row) throw notFound('Enrollment not found.');
    const ts = now();
    db.prepare(`UPDATE enrollments SET status = 'withdrawn', notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`).run(
      reason,
      ts,
      row.id,
    );
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    if (student && student.status !== 'inactive') {
      const allowed = STATUS_FLOW[student.status] || [];
      if (allowed.includes('inactive')) {
        changeStudentStatus(db, user, studentId, 'inactive', reason || 'Enrollment withdrawn');
      } else {
        db.prepare('UPDATE students SET status = ?, updated_at = ? WHERE id = ?').run('inactive', ts, studentId);
        db.prepare(
          `INSERT INTO student_status_history
             (id, student_id, from_status, to_status, changed_by_user_id, changed_by_user_name, reason, created_at)
           VALUES (?, ?, ?, 'inactive', ?, ?, ?, ?)`,
        ).run(uuid(), studentId, student.status, user.id, user.name, reason, ts);
      }
    }
    logAction(db, {
      actorId: user.id,
      actorLabel: user.name,
      action: 'PET_ENROLLMENT_WITHDRAWN',
      targetType: 'student',
      targetId: studentId,
      metadata: { reason },
      ip,
    });
    return getEnrollment(db, studentId);
  });
}

module.exports = {
  listTests,
  getTest,
  createTest,
  updateTest,
  assignStudents,
  enterMarks,
  scoreFor,
  finalizeScore,
  markAbsent,
  decide,
  listEnrollments,
  getEnrollment,
  startEnrollment,
  advanceEnrollment,
  withdrawEnrollment,
  STAGES,
  DECISIONS,
};
