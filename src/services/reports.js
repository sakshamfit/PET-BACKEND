/**
 * Reports — admin KPI dashboard, employee home payload, global search,
 * organization settings. These power the two dashboards' first paint, so
 * they favor straightforward counts over cleverness.
 */
'use strict';

const { notFound } = require('../lib/errors');
const { now } = require('../lib/ids');
const { logAction } = require('../lib/audit');
const {
  toUser,
  toStudent,
  toSchool,
  toTask,
  toVisit,
  toAttendance,
  toSubmission,
} = require('./serialize');
const { parseJson } = require('../lib/http');
const { today } = require('../lib/ids');

const ALL_STATUSES = [
  'registered', 'test_scheduled', 'test_completed', 'under_evaluation',
  'selected', 'waitlisted', 'not_selected', 'enrolled', 'inactive',
];

const count = (db, sql, ...params) => Number(db.prepare(sql).get(...params).c);

function adminDashboard(db) {
  const t = today();
  const kpis = {
    registered_students: count(db, 'SELECT COUNT(*) AS c FROM students'),
    tests_completed: count(
      db,
      `SELECT COUNT(*) AS c FROM test_assignments WHERE status = 'finalized'`,
    ),
    selected_students: count(
      db,
      `SELECT COUNT(*) AS c FROM students WHERE status IN ('selected', 'waitlisted', 'enrolled')`,
    ),
    enrolled_students: count(db, `SELECT COUNT(*) AS c FROM students WHERE status = 'enrolled'`),
    active_employees: count(db, `SELECT COUNT(*) AS c FROM users WHERE status = 'ACTIVE'`),
    todays_field_visits: count(db, 'SELECT COUNT(*) AS c FROM field_visits WHERE started_at >= ?', `${t}T00:00:00`),
    pending_tasks: count(
      db,
      `SELECT COUNT(*) AS c FROM tasks WHERE status NOT IN ('completed', 'cancelled')`,
    ),
    new_website_forms: count(db, `SELECT COUNT(*) AS c FROM website_form_submissions WHERE status = 'new'`),
  };

  const pipeline = ALL_STATUSES.map(status => ({
    status,
    count: count(db, 'SELECT COUNT(*) AS c FROM students WHERE status = ?', status),
  }));

  const live_visits = db
    .prepare(`SELECT * FROM field_visits WHERE status = 'active' ORDER BY started_at ASC`)
    .all()
    .map(toVisit);

  const task_queue = db
    .prepare(
      `SELECT * FROM tasks WHERE status NOT IN ('completed', 'cancelled')
        ORDER BY created_at DESC LIMIT 10`,
    )
    .all()
    .map(toTask);

  const overdue_tasks = count(
    db,
    `SELECT COUNT(*) AS c FROM tasks
      WHERE status NOT IN ('completed', 'cancelled') AND due_date IS NOT NULL AND due_date < ?`,
    t,
  );

  const attendance_today = db
    .prepare('SELECT * FROM attendance WHERE date = ? ORDER BY check_in_at ASC')
    .all(t)
    .map(toAttendance);

  const recent_registrations = db
    .prepare('SELECT * FROM students ORDER BY created_at DESC LIMIT 8')
    .all()
    .map(toStudent);

  const website_forms = db
    .prepare('SELECT * FROM website_form_submissions ORDER BY created_at DESC LIMIT 8')
    .all()
    .map(toSubmission);

  const recentActivity = require('../lib/audit').listActivity(db, { limit: 10 });

  return {
    kpis,
    pipeline,
    live_visits,
    task_queue,
    overdue_tasks,
    attendance_today,
    recent_registrations,
    website_forms,
    recent_activity: recentActivity.activity,
    generated_at: now(),
  };
}

/** GET /me/dashboard — the employee's "start work in seconds" payload. */
function meDashboard(db, user) {
  const my_tasks = db
    .prepare(
      `SELECT * FROM tasks WHERE assigned_to_user_id = ? AND status NOT IN ('completed', 'cancelled')
        ORDER BY created_at DESC LIMIT 10`,
    )
    .all(user.id)
    .map(toTask);

  const activeVisit = db
    .prepare(`SELECT * FROM field_visits WHERE employee_id = ? AND status = 'active' LIMIT 1`)
    .get(user.id);

  const attendance = db
    .prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?')
    .get(user.id, today());

  const unreadMessages = Number(
    db
      .prepare(
        `SELECT COALESCE(SUM(
           (SELECT COUNT(*) FROM chat_messages m
             WHERE m.conversation_id = c.id AND m.sender_id <> ?
               AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at))
         ), 0) AS c
           FROM conversations c
           JOIN conversation_members cm ON cm.conversation_id = c.id
          WHERE cm.user_id = ?`,
      )
      .get(user.id, user.id).c,
  );

  const unreadNotifications = Number(
    db
      .prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(user.id).c,
  );

  const my_students = db
    .prepare(
      `SELECT id, name, pet_student_id, school_name, status, created_at
         FROM students WHERE registered_by_user_id = ?
        ORDER BY created_at DESC LIMIT 10`,
    )
    .all(user.id)
    .map(r => ({
      id: r.id,
      name: r.name,
      pet_student_id: r.pet_student_id,
      school_name: r.school_name,
      status: r.status,
      created_at: r.created_at,
    }));

  const recent_visits = db
    .prepare(
      `SELECT id, school_name, status, started_at, ended_at, students_registered
         FROM field_visits WHERE employee_id = ?
        ORDER BY started_at DESC LIMIT 5`,
    )
    .all(user.id)
    .map(r => ({
      id: r.id,
      school_name: r.school_name,
      status: r.status,
      started_at: r.started_at,
      ended_at: r.ended_at,
      students_registered: r.students_registered,
    }));

  return {
    my_tasks,
    active_visit: activeVisit ? toVisit(activeVisit) : null,
    attendance_today: attendance ? toAttendance(attendance) : null,
    unread_messages: unreadMessages,
    unread_notifications: unreadNotifications,
    my_students,
    recent_visits,
  };
}

function globalSearch(db, rawQuery) {
  const q = String(rawQuery || '').trim();
  const like = `%${q.toLowerCase()}%`;
  if (!q) return { query: '', students: [], schools: [], employees: [], tasks: [] };

  const students = db
    .prepare(
      `SELECT * FROM students
        WHERE LOWER(name) LIKE ? OR LOWER(pet_student_id) LIKE ?
           OR REPLACE(COALESCE(parent_phone,''),' ','') LIKE ?
           OR LOWER(COALESCE(district,'')) LIKE ?
        ORDER BY created_at DESC LIMIT 8`,
    )
    .all(like, like, `%${q.replace(/\s/g, '')}%`, like)
    .map(s => ({
      id: s.id,
      pet_student_id: s.pet_student_id,
      name: s.name,
      status: s.status,
      school_name: s.school_name,
      district: s.district,
    }));

  const schools = db
    .prepare(
      `SELECT * FROM schools
        WHERE LOWER(name) LIKE ? OR LOWER(school_code) LIKE ? OR LOWER(COALESCE(city,'')) LIKE ?
        ORDER BY name LIMIT 8`,
    )
    .all(like, like, like)
    .map(toSchool);

  const employees = db
    .prepare(
      `SELECT * FROM users
        WHERE LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(COALESCE(employee_code,'')) LIKE ?
        ORDER BY name LIMIT 8`,
    )
    .all(like, like, like)
    .map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      employee_code: u.employee_code,
      status: u.status,
      department: u.department,
    }));

  const tasks = db
    .prepare(
      `SELECT * FROM tasks WHERE LOWER(title) LIKE ? OR LOWER(COALESCE(description,'')) LIKE ?
        ORDER BY created_at DESC LIMIT 8`,
    )
    .all(like, like)
    .map(toTask);

  return { query: q, students, schools, employees, tasks };
}

const ORG_KEY = 'organization';

function getOrganization(db) {
  const row = db.prepare('SELECT * FROM organization_settings WHERE key = ?').get(ORG_KEY);
  return { organization: row ? parseJson(row.value) : null };
}

function saveOrganization(db, actor, input, { ip = null } = {}) {
  const current = getOrganization(db).organization || {};
  const merged = { ...current, ...input };
  const ts = now();
  db.prepare(
    `INSERT INTO organization_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(ORG_KEY, JSON.stringify(merged), ts);
  logAction(db, {
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'PET_ORGANIZATION_UPDATED',
    targetType: 'settings',
    targetId: ORG_KEY,
    metadata: { fields: Object.keys(input) },
    ip,
  });
  return { organization: merged };
}

module.exports = { adminDashboard, meDashboard, globalSearch, getOrganization, saveOrganization, notFound };
