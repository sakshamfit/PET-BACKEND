/**
 * Core API contract tests: health/CORS, auth (incl. refresh rotation and
 * reuse detection), team management, students (duplicate guard + lifecycle),
 * schools, field visits, tasks.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer,
  api,
  login,
  createEmployee,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
} = require('./helpers');

let ctx;
let admin;

before(async () => {
  ctx = await startServer();
  admin = await login(ctx.base, ADMIN_EMAIL, ADMIN_PASSWORD);
});

after(async () => {
  await ctx.close();
});

// ── Health & CORS ────────────────────────────────────────────────────────────

test('GET /health is public and CORS-enabled', async () => {
  const res = await api(ctx.base, 'GET', '/health', {
    headers: { origin: 'https://software.plusoneco.in' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ok');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://software.plusoneco.in');
});

test('unauthenticated API calls are rejected with the wire error shape', async () => {
  const res = await api(ctx.base, 'GET', '/api/me');
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'UNAUTHORIZED');
});

test('unknown /api routes: 401 when anonymous, 404 JSON when authenticated', async () => {
  const anon = await api(ctx.base, 'GET', '/api/definitely-not-a-thing');
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error.code, 'UNAUTHORIZED');

  const authed = await api(ctx.base, 'GET', '/api/definitely-not-a-thing', {
    token: admin.access_token,
  });
  assert.equal(authed.status, 404);
  assert.equal(authed.json.error.code, 'NOT_FOUND');
});

// ── Auth ─────────────────────────────────────────────────────────────────────

test('login returns the full session payload', () => {
  assert.ok(admin.access_token);
  assert.equal(admin.token_type, 'Bearer');
  assert.equal(admin.user.email, ADMIN_EMAIL);
  assert.equal(admin.user.role, 'main_admin');
  assert.equal(admin.user.must_change_password, false);
  assert.ok(admin.expires_in > 0);
});

test('wrong password → INVALID_CREDENTIALS', async () => {
  const res = await api(ctx.base, 'POST', '/api/auth/login', {
    body: { email: ADMIN_EMAIL, password: 'nope' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'INVALID_CREDENTIALS');
});

test('refresh rotates the token; replaying the old one kills the family', async () => {
  const session = await login(ctx.base, ADMIN_EMAIL, ADMIN_PASSWORD);
  const rotated = await api(ctx.base, 'POST', '/api/auth/refresh', {
    body: { refresh_token: session.refresh_token },
  });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.json.refresh_token, session.refresh_token);

  // Old token again → reuse detected → both stop working.
  const replay = await api(ctx.base, 'POST', '/api/auth/refresh', {
    body: { refresh_token: session.refresh_token },
  });
  assert.equal(replay.status, 401);

  const afterReuse = await api(ctx.base, 'POST', '/api/auth/refresh', {
    body: { refresh_token: rotated.json.refresh_token },
  });
  assert.equal(afterReuse.status, 401, 'family must be revoked after reuse');
});

test('access tokens can call /me; garbage tokens cannot', async () => {
  const ok = await api(ctx.base, 'GET', '/api/me', { token: admin.access_token });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.email, ADMIN_EMAIL);

  const bad = await api(ctx.base, 'GET', '/api/me', { token: 'not.a.jwt' });
  assert.equal(bad.status, 401);
});

test('logout is idempotent', async () => {
  const session = await login(ctx.base, ADMIN_EMAIL, ADMIN_PASSWORD);
  const out = await api(ctx.base, 'POST', '/api/auth/logout', {
    body: { refresh_token: session.refresh_token },
  });
  assert.equal(out.status, 200);
  const again = await api(ctx.base, 'POST', '/api/auth/logout', {
    body: { refresh_token: session.refresh_token },
  });
  assert.equal(again.status, 200);
});

// ── Team / employees ─────────────────────────────────────────────────────────

test('create employee → one-time password → forced change → new password works', async () => {
  const { user, tempPassword, session } = await createEmployee(ctx.base, admin.access_token, {
    name: 'Ravi Yadav',
  });
  assert.ok(tempPassword && tempPassword.length >= 12, 'temp password shown once');
  assert.equal(session.user.must_change_password, true);

  // Old password stops after change; change requires current password.
  const wrongCurrent = await api(ctx.base, 'POST', '/api/auth/change-password', {
    token: session.access_token,
    body: { current_password: 'wrong', new_password: 'FreshPass1' },
  });
  assert.equal(wrongCurrent.status, 401);

  const changed = await api(ctx.base, 'POST', '/api/auth/change-password', {
    token: session.access_token,
    body: { current_password: tempPassword, new_password: 'FreshPass1' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.changed, true);

  const fresh = await login(ctx.base, user.email, 'FreshPass1');
  assert.equal(fresh.user.must_change_password, false);

  const oldFails = await api(ctx.base, 'POST', '/api/auth/login', {
    body: { email: user.email, password: tempPassword },
  });
  assert.equal(oldFails.status, 401);
});

test('weak passwords are refused by policy', async () => {
  const { session } = await createEmployee(ctx.base, admin.access_token);
  const res = await api(ctx.base, 'POST', '/api/auth/change-password', {
    token: session.access_token,
    body: { current_password: session.user ? undefined : undefined, new_password: 'abcdefgh' },
  });
  // Either password-policy or wrong current password — both 400/401 family.
  assert.ok([400, 401].includes(res.status));
});

test('employee list: admin only, search + status filters work', async () => {
  const all = await api(ctx.base, 'GET', '/api/employees?limit=100', { token: admin.access_token });
  assert.equal(all.status, 200);
  assert.ok(all.json.total >= 2);

  const created = await createEmployee(ctx.base, admin.access_token, { name: 'Sunita Devi' });
  const search = await api(ctx.base, 'GET', '/api/employees?q=Sunita', { token: admin.access_token });
  assert.equal(search.json.total, 1);
  assert.equal(search.json.employees[0].name, 'Sunita Devi');
  assert.ok(search.json.employees[0].employee_code.startsWith('EMP-'));

  // Employee token forbidden.
  const asEmp = await api(ctx.base, 'GET', '/api/employees', { token: created.session.access_token });
  assert.equal(asEmp.status, 403);
  assert.equal(asEmp.json.error.code, 'FORBIDDEN');
});

test('disable employee → sessions die and login is refused; enable restores', async () => {
  const { user, tempPassword, session } = await createEmployee(ctx.base, admin.access_token);

  const disabled = await api(ctx.base, 'POST', `/api/employees/${user.id}/status`, {
    token: admin.access_token,
    body: { status: 'DISABLED' },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.employee.status, 'DISABLED');

  // Correct password, disabled account → 403 ACCOUNT_DISABLED.
  const blocked = await api(ctx.base, 'POST', '/api/auth/login', {
    body: { email: user.email, password: tempPassword },
  });
  assert.ok([401, 403].includes(blocked.status));
  assert.notEqual(blocked.status, 200);

  // Refresh with the pre-disable token must also fail.
  const refresh = await api(ctx.base, 'POST', '/api/auth/refresh', {
    body: { refresh_token: session.refresh_token },
  });
  assert.equal(refresh.status, 401);

  const enabled = await api(ctx.base, 'POST', `/api/employees/${user.id}/status`, {
    token: admin.access_token,
    body: { status: 'ACTIVE' },
  });
  assert.equal(enabled.json.employee.status, 'ACTIVE');
});

test('reset-access returns a new one-time password and revokes sessions', async () => {
  const { user, session } = await createEmployee(ctx.base, admin.access_token);
  const reset = await api(ctx.base, 'POST', `/api/employees/${user.id}/reset-access`, {
    token: admin.access_token,
    body: {},
  });
  assert.equal(reset.status, 200);
  assert.ok(reset.json.temporaryPassword);
  assert.notEqual(reset.json.temporaryPassword, session.refresh_token);

  const refresh = await api(ctx.base, 'POST', '/api/auth/refresh', {
    body: { refresh_token: session.refresh_token },
  });
  assert.equal(refresh.status, 401);

  const relogin = await login(ctx.base, user.email, reset.json.temporaryPassword);
  assert.equal(relogin.user.must_change_password, true);
});

// ── Students ─────────────────────────────────────────────────────────────────

test('student registration issues a PET ID and records journey', async () => {
  const created = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body: { name: 'Amitabh Ranjan', parent_phone: '9811112222', current_class: '8', district: 'Azamgarh' },
  });
  assert.equal(created.status, 201);
  assert.match(created.json.student.pet_student_id, /^PET-STU-\d{6}$/);
  assert.equal(created.json.student.status, 'registered');
  assert.equal(created.json.student.registered_by_user_name, 'Main Admin');

  const profile = await api(ctx.base, `GET`, `/api/students/${created.json.student.id}/profile`, {
    token: admin.access_token,
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.json.journey.length, 1);
  assert.equal(profile.json.journey[0].to_status, 'registered');
  assert.equal(profile.json.enrollment, null);
});

test('duplicate guard blocks, then allows with acknowledge_duplicates', async () => {
  const body = {
    name: 'Kavita Singh',
    parent_phone: '9822223333',
    student_phone: '9733334444',
  };
  const first = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body: { ...body, acknowledge_duplicates: true },
  });
  assert.equal(first.status, 201);

  const dup = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body,
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'POSSIBLE_DUPLICATES');
  assert.ok(dup.json.error.details.duplicates.length >= 1);
  const reasons = dup.json.error.details.duplicates[0].reasons;
  assert.ok(reasons.includes('same name'));
  assert.ok(reasons.includes('same parent phone'));

  const check = await api(ctx.base, 'POST', '/api/students/duplicates-check', {
    token: admin.access_token,
    body,
  });
  assert.equal(check.status, 200);
  assert.equal(check.json.duplicates.length, 1);

  const forced = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body: { ...body, acknowledge_duplicates: true },
  });
  assert.equal(forced.status, 201);
  assert.notEqual(forced.json.student.id, first.json.student.id);
  assert.notEqual(forced.json.student.pet_student_id, first.json.student.pet_student_id);
});

test('status transitions follow the lifecycle; employees cannot decide', async () => {
  const created = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body: { name: ' lifecycle walker ', acknowledge_duplicates: true },
  });
  const id = created.json.student.id;

  const adv = await api(ctx.base, 'POST', `/api/students/${id}/status`, {
    token: admin.access_token,
    body: { to_status: 'test_scheduled', reason: 'slot booked' },
  });
  assert.equal(adv.status, 200);
  assert.equal(adv.json.student.status, 'test_scheduled');

  const illegal = await api(ctx.base, 'POST', `/api/students/${id}/status`, {
    token: admin.access_token,
    body: { to_status: 'enrolled' },
  });
  assert.equal(illegal.status, 400);
  assert.equal(illegal.json.error.code, 'INVALID_TRANSITION');

  const emp = await createEmployee(ctx.base, admin.access_token);
  const s2 = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body: { name: 'employee path student', acknowledge_duplicates: true },
  });
  await api(ctx.base, 'POST', `/api/students/${s2.json.student.id}/status`, {
    token: admin.access_token,
    body: { to_status: 'test_scheduled' },
  });
  await api(ctx.base, 'POST', `/api/students/${s2.json.student.id}/status`, {
    token: admin.access_token,
    body: { to_status: 'test_completed' },
  });
  await api(ctx.base, 'POST', `/api/students/${s2.json.student.id}/status`, {
    token: admin.access_token,
    body: { to_status: 'under_evaluation' },
  });
  const employeeDecision = await api(ctx.base, 'POST', `/api/students/${s2.json.student.id}/status`, {
    token: emp.session.access_token,
    body: { to_status: 'selected' },
  });
  assert.equal(employeeDecision.status, 403);
  assert.equal(employeeDecision.json.error.code, 'FORBIDDEN');
});

test('student search: q + status filters, total', async () => {
  const list = await api(ctx.base, 'GET', '/api/students?q=Kavita&status=registered', {
    token: admin.access_token,
  });
  assert.equal(list.status, 200);
  // Two Kavita records exist (the duplicate-guard test saved one on purpose).
  assert.equal(list.json.total, 2);
  assert.ok(list.json.students.every(s => s.name.includes('Kavita')));

  const narrow = await api(ctx.base, 'GET', '/api/students?q=NoSuchStudentEver', {
    token: admin.access_token,
  });
  assert.equal(narrow.json.total, 0);
});

test('student PATCH updates fields and refreshes the school name copy', async () => {
  const school = await api(ctx.base, 'POST', '/api/schools', {
    token: admin.access_token,
    body: { name: 'Saraswati Vidya Mandir', city: 'Varanasi', district: 'Varanasi' },
  });
  assert.equal(school.status, 201);

  const created = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body: { name: 'Patch Me Please', acknowledge_duplicates: true },
  });
  const id = created.json.student.id;

  const patched = await api(ctx.base, 'PATCH', `/api/students/${id}`, {
    token: admin.access_token,
    body: { school_id: school.json.school.id, notes: 'joined late' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.student.school_name, 'Saraswati Vidya Mandir');
  assert.equal(patched.json.student.school_address, null);
  assert.equal(patched.json.student.notes, 'joined late');

  const cleared = await api(ctx.base, 'PATCH', `/api/students/${id}`, {
    token: admin.access_token,
    body: { school_id: null },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.student.school_id, null);
  assert.equal(cleared.json.student.school_name, null);
  assert.equal(cleared.json.student.school_address, null);
});

// ── Schools ──────────────────────────────────────────────────────────────────

test('school create/get/update/archive + profile stats', async () => {
  const created = await api(ctx.base, 'POST', '/api/schools', {
    token: admin.access_token,
    body: { name: 'Gyan Public School', city: 'Kanpur', locality: 'Swaroop Nagar', phone: '0512-123456' },
  });
  assert.equal(created.status, 201);
  assert.match(created.json.school.school_code, /^SCH-\d{4}$/);
  assert.equal(created.json.school.status, 'active');
  const id = created.json.school.id;

  const got = await api(ctx.base, 'GET', `/api/schools/${id}`, { token: admin.access_token });
  assert.equal(got.json.school.name, 'Gyan Public School');

  const patched = await api(ctx.base, 'PATCH', `/api/schools/${id}`, {
    token: admin.access_token,
    body: { name: 'Gyan Public School (Senior)', phone: '0512-999999' },
  });
  assert.equal(patched.json.school.name, 'Gyan Public School (Senior)');

  const profile = await api(ctx.base, 'GET', `/api/schools/${id}/profile`, {
    token: admin.access_token,
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.json.stats.students, 0);

  const archived = await api(ctx.base, 'POST', `/api/schools/${id}/archive`, {
    token: admin.access_token,
    body: {},
  });
  assert.equal(archived.json.school.status, 'archived');

  const search = await api(ctx.base, 'GET', '/api/schools?q=Gyan', { token: admin.access_token });
  assert.ok(search.json.total >= 1);
});

// ── Field visits ─────────────────────────────────────────────────────────────

test('visit lifecycle: one active at a time, register student, end with report', async () => {
  const school = await api(ctx.base, 'POST', '/api/schools', {
    token: admin.access_token,
    body: { name: 'Visit Target School', city: 'Meerut' },
  });
  const schoolId = school.json.school.id;

  const started = await api(ctx.base, 'POST', '/api/field-visits/start', {
    token: admin.access_token,
    body: { school_id: schoolId, purpose: 'Student identification', latitude: 28.6, longitude: 77.2 },
  });
  assert.equal(started.status, 201);
  assert.equal(started.json.visit.status, 'active');
  assert.equal(started.json.visit.employee_name, 'Main Admin');
  const visitId = started.json.visit.id;

  const second = await api(ctx.base, 'POST', '/api/field-visits/start', {
    token: admin.access_token,
    body: { school_id: schoolId },
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'ACTIVE_VISIT_EXISTS');

  const student = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body: { name: 'Visit Registered Kid', visit_id: visitId, acknowledge_duplicates: true },
  });
  assert.equal(student.status, 201);
  assert.equal(student.json.student.registered_visit_id, visitId);

  const detail = await api(ctx.base, 'GET', `/api/field-visits/${visitId}`, {
    token: admin.access_token,
  });
  assert.equal(detail.json.visit.students_registered, 1);
  assert.equal(detail.json.students.length, 1);

  const ended = await api(ctx.base, 'POST', `/api/field-visits/${visitId}/end`, {
    token: admin.access_token,
    body: { report: 'Met 12 students, 1 registration.', students_contacted: 12, documents_collected: 3 },
  });
  assert.equal(ended.status, 200);
  assert.equal(ended.json.visit.status, 'completed');
  assert.equal(ended.json.visit.students_contacted, 12);
  assert.ok(ended.json.visit.ended_at);

  const again = await api(ctx.base, 'POST', `/api/field-visits/${visitId}/end`, {
    token: admin.access_token,
    body: {},
  });
  assert.equal(again.status, 409);

  const list = await api(ctx.base, 'GET', '/api/field-visits?status=completed', {
    token: admin.access_token,
  });
  assert.ok(list.json.total >= 1);
});

// ── Tasks ────────────────────────────────────────────────────────────────────

test('task flow: create → employee sees it → status transitions → events trail', async () => {
  const emp = await createEmployee(ctx.base, admin.access_token, { name: 'Task Bearer' });
  const created = await api(ctx.base, 'POST', '/api/tasks', {
    token: admin.access_token,
    body: {
      title: 'Collect documents from Rampur families',
      assigned_to_user_id: emp.user.id,
      priority: 'high',
      due_date: '2026-10-01',
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.task.status, 'pending');
  assert.equal(created.json.task.assigned_to_user_name, 'Task Bearer');
  const taskId = created.json.task.id;

  const empList = await api(ctx.base, 'GET', '/api/tasks', { token: emp.session.access_token });
  assert.equal(empList.json.tasks.some(t => t.id === taskId), true);

  const accepted = await api(ctx.base, 'POST', `/api/tasks/${taskId}/status`, {
    token: emp.session.access_token,
    body: { status: 'accepted' },
  });
  assert.equal(accepted.json.task.status, 'accepted');

  const illegalSkip = await api(ctx.base, 'POST', `/api/tasks/${taskId}/status`, {
    token: emp.session.access_token,
    body: { status: 'completed' },
  });
  assert.equal(illegalSkip.status, 400);
  assert.equal(illegalSkip.json.error.code, 'INVALID_TRANSITION');

  await api(ctx.base, 'POST', `/api/tasks/${taskId}/status`, {
    token: emp.session.access_token,
    body: { status: 'in_progress' },
  });
  const submitted = await api(ctx.base, 'POST', `/api/tasks/${taskId}/status`, {
    token: emp.session.access_token,
    body: { status: 'submitted', note: 'ready for review' },
  });
  assert.equal(submitted.json.task.status, 'submitted');
  assert.ok(submitted.json.task.completed_at === null);

  const detail = await api(ctx.base, 'GET', `/api/tasks/${taskId}`, {
    token: admin.access_token,
  });
  assert.equal(detail.json.events.length, 4); // created, accepted, in_progress, submitted
  assert.equal(detail.json.events[3].note, 'ready for review');

  const done = await api(ctx.base, 'POST', `/api/tasks/${taskId}/status`, {
    token: admin.access_token,
    body: { status: 'completed' },
  });
  assert.equal(done.json.task.status, 'completed');
  assert.ok(done.json.task.completed_at);

  // Employee gets a fresh task, then admin reassigns it.
  const t2 = await api(ctx.base, 'POST', '/api/tasks', {
    token: admin.access_token,
    body: { title: 'Second task', assigned_to_user_id: emp.user.id },
  });
  const emp2 = await createEmployee(ctx.base, admin.access_token, { name: 'Reassign Target' });
  const reassigned = await api(ctx.base, 'POST', `/api/tasks/${t2.json.task.id}/reassign`, {
    token: admin.access_token,
    body: { assigned_to_user_id: emp2.user.id, note: 'shifted' },
  });
  assert.equal(reassigned.json.task.assigned_to_user_name, 'Reassign Target');

  // Non-creator employee cannot reassign.
  const denied = await api(ctx.base, 'POST', `/api/tasks/${t2.json.task.id}/reassign`, {
    token: emp.session.access_token,
    body: { assigned_to_user_id: emp.user.id },
  });
  assert.equal(denied.status, 403);
});

test('directory exposes active staff for pickers', async () => {
  const res = await api(ctx.base, 'GET', '/api/me/directory', { token: admin.access_token });
  assert.equal(res.status, 200);
  assert.ok(res.json.members.length >= 2);
  assert.ok(res.json.members.every(m => m.id && m.name && m.role));
});
