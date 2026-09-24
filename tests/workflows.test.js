/**
 * Workflow tests: chat, attendance, test pipeline, enrollment, website
 * forms, uploads/files, offline sync idempotency, dashboards & reports,
 * and cross-role permission boundaries.
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
  TINY_PNG_BASE64,
} = require('./helpers');

let ctx;
let admin;
let emp;

before(async () => {
  ctx = await startServer();
  admin = await login(ctx.base, ADMIN_EMAIL, ADMIN_PASSWORD);
  emp = await createEmployee(ctx.base, admin.access_token, { name: 'Chat Partner' });
});

after(async () => {
  await ctx.close();
});

// ── Chat ─────────────────────────────────────────────────────────────────────

test('direct conversation: opens idempotently, messages, unread counts', async () => {
  const open1 = await api(ctx.base, 'POST', '/api/conversations/direct', {
    token: admin.access_token,
    body: { user_id: emp.user.id },
  });
  assert.equal(open1.status, 201);
  const convoId = open1.json.conversation.id;

  const open2 = await api(ctx.base, 'POST', '/api/conversations/direct', {
    token: admin.access_token,
    body: { user_id: emp.user.id },
  });
  assert.equal(open2.json.conversation.id, convoId, 'same direct thread on reopen');

  const sent = await api(ctx.base, 'POST', `/api/conversations/${convoId}/messages`, {
    token: admin.access_token,
    body: { text: 'Please register 5 students in Rampur today.' },
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.message.sender_name, 'Main Admin');

  // Employee sees it + unread badge.
  const empList = await api(ctx.base, 'GET', '/api/conversations', {
    token: emp.session.access_token,
  });
  const thread = empList.json.conversations.find(c => c.id === convoId);
  assert.ok(thread, 'employee sees the conversation');
  assert.equal(thread.unread_count, 1);
  assert.equal(thread.last_message, 'Please register 5 students in Rampur today.');

  const unread = await api(ctx.base, 'GET', '/api/conversations/unread-count', {
    token: emp.session.access_token,
  });
  assert.equal(unread.json.unread, 1);

  // Opening the thread marks it read.
  const messages = await api(ctx.base, 'GET', `/api/conversations/${convoId}/messages`, {
    token: emp.session.access_token,
  });
  assert.equal(messages.json.messages.length, 1);
  const unreadAfter = await api(ctx.base, 'GET', '/api/conversations/unread-count', {
    token: emp.session.access_token,
  });
  assert.equal(unreadAfter.json.unread, 0);

  // Non-members cannot read the thread.
  const outsider = await createEmployee(ctx.base, admin.access_token, { name: 'Outsider' });
  const denied = await api(ctx.base, 'GET', `/api/conversations/${convoId}/messages`, {
    token: outsider.session.access_token,
  });
  assert.equal(denied.status, 403);
});

test('group conversation with linked student chip data', async () => {
  const student = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body: { name: 'Linked Student Kid', acknowledge_duplicates: true },
  });
  const group = await api(ctx.base, 'POST', '/api/conversations/group', {
    token: admin.access_token,
    body: { title: 'Azamgarh Team', member_ids: [emp.user.id] },
  });
  assert.equal(group.status, 201);
  assert.equal(group.json.conversation.type, 'group');
  assert.equal(group.json.conversation.title, 'Azamgarh Team');
  assert.equal(group.json.conversation.members.length, 2);

  const sent = await api(ctx.base, 'POST', `/api/conversations/${group.json.conversation.id}/messages`, {
    token: admin.access_token,
    body: { text: 'Follow up on this one', linked_student_id: student.json.student.id },
  });
  assert.equal(sent.json.message.linked_student_id, student.json.student.id);
});

// ── Attendance ───────────────────────────────────────────────────────────────

test('check-in/out are idempotent; monthly summary is admin-only', async () => {
  const in1 = await api(ctx.base, 'POST', '/api/attendance/check-in', {
    token: emp.session.access_token,
    body: { latitude: 26.85, longitude: 80.95 },
  });
  assert.equal(in1.status, 200);
  assert.equal(in1.json.alreadyCheckedIn, false);
  assert.equal(in1.json.record.status, 'present');
  assert.ok(in1.json.record.check_in_at);

  const in2 = await api(ctx.base, 'POST', '/api/attendance/check-in', {
    token: emp.session.access_token,
    body: {},
  });
  assert.equal(in2.json.alreadyCheckedIn, true);

  const today = await api(ctx.base, 'GET', '/api/me/attendance/today', {
    token: emp.session.access_token,
  });
  assert.ok(today.json.record);

  const out = await api(ctx.base, 'POST', '/api/attendance/check-out', {
    token: emp.session.access_token,
    body: {},
  });
  assert.equal(out.json.alreadyCheckedOut, false);
  assert.ok(out.json.record.check_out_at);

  const out2 = await api(ctx.base, 'POST', '/api/attendance/check-out', {
    token: emp.session.access_token,
    body: {},
  });
  assert.equal(out2.json.alreadyCheckedOut, true);

  // Employee cannot see others' attendance or the summary.
  const empSummary = await api(ctx.base, 'GET', '/api/attendance/summary', {
    token: emp.session.access_token,
  });
  assert.equal(empSummary.status, 403);
  const empList = await api(ctx.base, 'GET', '/api/attendance', {
    token: emp.session.access_token,
  });
  assert.equal(empList.status, 200);
  assert.ok(empList.json.attendance.every(a => a.employee_id === emp.user.id));

  const month = new Date().toISOString().slice(0, 7);
  const summary = await api(ctx.base, 'GET', `/api/attendance/summary?month=${month}`, {
    token: admin.access_token,
  });
  assert.equal(summary.status, 200);
  assert.ok(summary.json.summary.some(r => r.employee_id === emp.user.id && r.present >= 1));

  // Manual mark (admin only).
  const marked = await api(ctx.base, 'POST', '/api/attendance/mark', {
    token: admin.access_token,
    body: { employee_id: emp.user.id, date: '2026-01-05', status: 'leave', remarks: 'sick leave' },
  });
  assert.equal(marked.status, 200);
  assert.equal(marked.json.record.status, 'leave');
  const empMark = await api(ctx.base, 'POST', '/api/attendance/mark', {
    token: emp.session.access_token,
    body: { employee_id: emp.user.id, date: '2026-01-06', status: 'present' },
  });
  assert.equal(empMark.status, 403);
});

// ── Tests pipeline ───────────────────────────────────────────────────────────

test('test lifecycle: assign → marks → finalize → decision drives student status', async () => {
  const student = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body: { name: 'Examination Candidate', acknowledge_duplicates: true },
  });
  const studentId = student.json.student.id;
  await api(ctx.base, 'POST', `/api/students/${studentId}/status`, {
    token: admin.access_token,
    body: { to_status: 'test_scheduled' },
  });

  const empAttempt = await api(ctx.base, 'POST', '/api/tests', {
    token: emp.session.access_token,
    body: {
      name: 'Should be admin only',
      subjects: [{ name: 'Math', max_marks: 100 }],
    },
  });
  assert.equal(empAttempt.status, 403);

  const created = await api(ctx.base, 'POST', '/api/tests', {
    token: admin.access_token,
    body: {
      name: 'Entrance Test — Autumn',
      description: 'Math + English',
      passing_percentage: 50,
      scheduled_date: '2026-10-10',
      subjects: [
        { name: 'Mathematics', max_marks: 100, passing_marks: 35 },
        { name: 'English', max_marks: 50, passing_marks: 20 },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.test.status, 'scheduled');
  assert.equal(created.json.test.subjects.length, 2);
  const testId = created.json.test.id;
  const [math, english] = created.json.test.subjects;

  const assigned = await api(ctx.base, 'POST', `/api/tests/${testId}/assign`, {
    token: admin.access_token,
    body: { student_ids: [studentId] },
  });
  assert.deepEqual(assigned.json.assigned, [studentId]);

  const dupAssign = await api(ctx.base, 'POST', `/api/tests/${testId}/assign`, {
    token: admin.access_token,
    body: { student_ids: [studentId, 'missing-student'] },
  });
  assert.deepEqual(dupAssign.json.skipped, [studentId]);
  assert.equal(dupAssign.json.errors.length, 1);

  // Premature finalize must fail.
  await api(ctx.base, 'POST', `/api/tests/${testId}/marks/${studentId}`, {
    token: admin.access_token,
    body: { marks: [{ subject_id: math.id, obtained_marks: 80 }] },
  });
  const premature = await api(ctx.base, 'POST', `/api/tests/${testId}/finalize/${studentId}`, {
    token: admin.access_token,
    body: {},
  });
  assert.equal(premature.status, 400);

  // Over-max marks rejected.
  const over = await api(ctx.base, 'POST', `/api/tests/${testId}/marks/${studentId}`, {
    token: admin.access_token,
    body: { marks: [{ subject_id: math.id, obtained_marks: 140 }] },
  });
  assert.equal(over.status, 400);

  // Employee may enter marks (test-taking staff), completes the sheet.
  const entered = await api(ctx.base, 'POST', `/api/tests/${testId}/marks/${studentId}`, {
    token: emp.session.access_token,
    body: {
      marks: [
        { subject_id: math.id, obtained_marks: 80 },
        { subject_id: english.id, obtained_marks: 40 },
      ],
    },
  });
  assert.equal(entered.status, 200);
  const score = entered.json.score;
  assert.equal(score.total_obtained, 120);
  assert.equal(score.total_max, 150);
  assert.equal(score.percentage, 80);
  assert.equal(score.complete, true);
  assert.equal(score.suggested_result, 'eligible');

  const finalized = await api(ctx.base, 'POST', `/api/tests/${testId}/finalize/${studentId}`, {
    token: admin.access_token,
    body: {},
  });
  assert.equal(finalized.status, 200);
  assert.equal(finalized.json.score.finalized, true);

  // Finalizing advanced the lifecycle: test_scheduled → test_completed.
  const after = await api(ctx.base, 'GET', `/api/students/${studentId}`, {
    token: admin.access_token,
  });
  assert.equal(after.json.student.status, 'test_completed');

  // Failing score suggestion.
  const failStudent = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body: { name: 'Low Scorer Child', acknowledge_duplicates: true },
  });
  await api(ctx.base, 'POST', `/api/tests/${testId}/assign`, {
    token: admin.access_token,
    body: { student_ids: [failStudent.json.student.id] },
  });
  const low = await api(ctx.base, 'POST', `/api/tests/${testId}/marks/${failStudent.json.student.id}`, {
    token: admin.access_token,
    body: {
      marks: [
        { subject_id: math.id, obtained_marks: 10 },
        { subject_id: english.id, obtained_marks: 5 },
      ],
    },
  });
  assert.equal(low.json.score.percentage, 10);
  assert.equal(low.json.score.suggested_result, 'not_eligible');

  // Decision (admin only) → student status flips to selected.
  const decision = await api(ctx.base, 'POST', `/api/tests/${testId}/decision/${studentId}`, {
    token: admin.access_token,
    body: { decision: 'selected', remarks: 'top scorer' },
  });
  assert.equal(decision.status, 200);
  assert.equal(decision.json.student.status, 'selected');

  const empDecision = await api(ctx.base, 'POST', `/api/tests/${testId}/decision/${studentId}`, {
    token: emp.session.access_token,
    body: { decision: 'waitlisted' },
  });
  assert.equal(empDecision.status, 403);

  const detail = await api(ctx.base, 'GET', `/api/tests/${testId}`, { token: admin.access_token });
  assert.equal(detail.json.assignments.length, 2);
  assert.equal(detail.json.test.status, 'completed');
});

// ── Enrollment ───────────────────────────────────────────────────────────────

test('enrollment advances to enrolled and syncs student status', async () => {
  const student = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body: { name: 'Enrolment Path Kid', acknowledge_duplicates: true },
  });
  const id = student.json.student.id;

  const empStart = await api(ctx.base, 'POST', `/api/enrollments/${id}/start`, {
    token: emp.session.access_token,
    body: {},
  });
  assert.equal(empStart.status, 403);

  const started = await api(ctx.base, 'POST', `/api/enrollments/${id}/start`, {
    token: admin.access_token,
    body: { notes: 'docs pending' },
  });
  assert.equal(started.status, 200);
  assert.equal(started.json.enrollment.stage, 'follow_up');
  assert.equal(started.json.enrollment.status, 'active');

  await api(ctx.base, 'POST', `/api/enrollments/${id}/stage`, {
    token: admin.access_token,
    body: { stage: 'documents' },
  });
  await api(ctx.base, 'POST', `/api/enrollments/${id}/stage`, {
    token: admin.access_token,
    body: { stage: 'verification' },
  });
  const done = await api(ctx.base, 'POST', `/api/enrollments/${id}/stage`, {
    token: admin.access_token,
    body: { stage: 'enrolled', notes: 'all clear' },
  });
  assert.equal(done.json.enrollment.status, 'completed');
  assert.ok(done.json.enrollment.enrolled_at);

  const profile = await api(ctx.base, 'GET', `/api/students/${id}/profile`, {
    token: admin.access_token,
  });
  assert.equal(profile.json.student.status, 'enrolled');
  assert.equal(profile.json.enrollment.stage, 'enrolled');

  const list = await api(ctx.base, 'GET', '/api/enrollments?status=completed', {
    token: admin.access_token,
  });
  assert.ok(list.json.total >= 1);

  // Withdraw path on a second student.
  const s2 = await api(ctx.base, 'POST', '/api/students', {
    token: admin.access_token,
    body: { name: 'Withdrawn Kid', acknowledge_duplicates: true },
  });
  await api(ctx.base, 'POST', `/api/enrollments/${s2.json.student.id}/start`, { token: admin.access_token, body: {} });
  const withdrawn = await api(ctx.base, 'POST', `/api/enrollments/${s2.json.student.id}/withdraw`, {
    token: admin.access_token,
    body: { reason: 'moved to another city' },
  });
  assert.equal(withdrawn.json.enrollment.status, 'withdrawn');
});

// ── Website forms ────────────────────────────────────────────────────────────

test('website form convert → student (admin only)', async () => {
  // Seed a submission the way the public site would.
  const forms = require('../src/services/websiteForms');
  const { submission } = forms.createSubmission(ctx.db, {
    form_type: 'student_registration',
    name: 'Website Lead Child',
    phone: '9800001111',
    email: 'lead@example.com',
    payload: { current_class: '7', district: 'Jaunpur', parent_name: 'Lead Parent' },
  });

  const empList = await api(ctx.base, 'GET', '/api/website-forms', { token: emp.session.access_token });
  assert.equal(empList.status, 403);

  const list = await api(ctx.base, 'GET', '/api/website-forms?status=new', { token: admin.access_token });
  assert.equal(list.status, 200);
  assert.ok(list.json.submissions.some(s => s.id === submission.id));

  const assigned = await api(ctx.base, 'POST', `/api/website-forms/${submission.id}/assign`, {
    token: admin.access_token,
    body: { assigned_to_user_id: emp.user.id },
  });
  assert.equal(assigned.json.submission.status, 'assigned');
  assert.equal(assigned.json.submission.assigned_to_user_name, 'Chat Partner');

  const inProgress = await api(ctx.base, 'POST', `/api/website-forms/${submission.id}/status`, {
    token: admin.access_token,
    body: { status: 'in_progress' },
  });
  assert.equal(inProgress.json.submission.status, 'in_progress');

  const converted = await api(ctx.base, 'POST', `/api/website-forms/${submission.id}/convert`, {
    token: admin.access_token,
    body: {},
  });
  assert.equal(converted.status, 200);
  assert.equal(converted.json.student.name, 'Website Lead Child');
  assert.equal(converted.json.student.registration_source, 'website');
  assert.equal(converted.json.student.current_class, '7');
  assert.equal(converted.json.form.status, 'converted');
  assert.equal(converted.json.form.converted_student_id, converted.json.student.id);

  const again = await api(ctx.base, 'POST', `/api/website-forms/${submission.id}/convert`, {
    token: admin.access_token,
    body: {},
  });
  assert.equal(again.status, 409);
});

// ── Uploads & files ──────────────────────────────────────────────────────────

test('upload → register field media → authenticated file fetch (+ traversal blocked)', async () => {
  const school = await api(ctx.base, 'POST', '/api/schools', {
    token: admin.access_token,
    body: { name: 'Photo Ops School', city: 'Ghaziabad' },
  });
  const visit = await api(ctx.base, 'POST', '/api/field-visits/start', {
    token: admin.access_token,
    body: { school_id: school.json.school.id, purpose: 'photo documentation' },
  });
  const visitId = visit.json.visit.id;

  const upload = await api(ctx.base, 'POST', '/api/uploads', {
    token: admin.access_token,
    body: {
      category: 'field-visits',
      fileName: 'photo.jpg',
      mimeType: 'image/png',
      dataBase64: TINY_PNG_BASE64,
    },
  });
  assert.equal(upload.status, 201);
  assert.ok(upload.json.relative_path.startsWith('field-visits/'));
  assert.ok(upload.json.size > 0);

  const media = await api(ctx.base, 'POST', '/api/media/field', {
    token: admin.access_token,
    body: {
      visit_id: visitId,
      relative_path: upload.json.relative_path,
      original_name: 'photo.jpg',
      caption: 'School gate',
      type: 'photo',
    },
  });
  assert.equal(media.status, 201);
  assert.equal(media.json.media.status, 'ready');
  assert.equal(media.json.media.uploaded_by_user_name, 'Main Admin');

  const detail = await api(ctx.base, 'GET', `/api/field-visits/${visitId}`, {
    token: admin.access_token,
  });
  assert.equal(detail.json.media.length, 1);

  // Authenticated fetch of the actual bytes.
  const file = await fetch(`${ctx.base}/api/files/${upload.json.relative_path}`, {
    headers: { authorization: `Bearer ${admin.access_token}` },
  });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.length, upload.json.size);

  // No token → 401. Traversal → 400/404, never file system escape.
  const anon = await fetch(`${ctx.base}/api/files/${upload.json.relative_path}`);
  assert.equal(anon.status, 401);
  const evil = await fetch(
    `${ctx.base}/api/files/${encodeURIComponent('../../package.json')}`,
    { headers: { authorization: `Bearer ${admin.access_token}` } },
  );
  assert.ok([400, 404].includes(evil.status), `traversal blocked (got ${evil.status})`);

  await api(ctx.base, 'POST', `/api/field-visits/${visitId}/end`, {
    token: admin.access_token,
    body: { report: 'photos attached' },
  });

  // Unsupported mime refused.
  const badMime = await api(ctx.base, 'POST', '/api/uploads', {
    token: admin.access_token,
    body: { category: 'documents', fileName: 'x.exe', mimeType: 'application/x-msdownload', dataBase64: 'AAAA' },
  });
  assert.equal(badMime.status, 415);
});

// ── Offline sync ─────────────────────────────────────────────────────────────

test('/sync replays operations exactly once (idempotency keys)', async () => {
  const operations = [
    {
      idempotency_key: 'q-sync-test-1',
      type: 'student.register',
      payload: { name: 'Offline Queued Kid', parent_phone: '9855556666', acknowledge_duplicates: true },
    },
    {
      idempotency_key: 'q-sync-test-2',
      type: 'attendance.check_in',
      payload: { latitude: 26.8, longitude: 80.9 },
    },
    {
      idempotency_key: 'q-sync-bad-type',
      type: 'nonsense.op',
      payload: {},
    },
  ];

  const push1 = await api(ctx.base, 'POST', '/api/sync', {
    token: emp.session.access_token,
    body: { operations },
  });
  assert.equal(push1.status, 200);
  assert.equal(push1.json.results.length, 3);
  const [r1, r2, r3] = push1.json.results;
  assert.equal(r1.status, 'ok');
  assert.equal(r2.status, 'ok');
  assert.equal(r3.status, 'error');
  assert.equal(r3.code, 'UNSUPPORTED_OPERATION');

  // Replay the SAME batch — everything must dedupe (even the rejection).
  const push2 = await api(ctx.base, 'POST', '/api/sync', {
    token: emp.session.access_token,
    body: { operations },
  });
  assert.equal(push2.status, 200);
  for (const entry of push2.json.results) {
    assert.equal(entry.deduplicated, true, `${entry.idempotency_key} deduplicated`);
  }
  assert.equal(push2.json.results[0].status, 'ok');
  assert.equal(push2.json.results[2].status, 'error');

  // Exactly one student was created despite two pushes.
  const search = await api(ctx.base, 'GET', '/api/students?q=Offline Queued Kid', {
    token: admin.access_token,
  });
  assert.equal(search.json.total, 1);

  // Missing keys → whole-batch validation error.
  const badBatch = await api(ctx.base, 'POST', '/api/sync', {
    token: emp.session.access_token,
    body: { operations: [{ type: 'student.register', payload: {} }] },
  });
  assert.equal(badBatch.status, 400);
});

// ── Dashboards, search, settings ─────────────────────────────────────────────

test('employee /me/dashboard payload shape', async () => {
  const dash = await api(ctx.base, 'GET', '/api/me/dashboard', { token: emp.session.access_token });
  assert.equal(dash.status, 200);
  for (const key of [
    'my_tasks', 'active_visit', 'attendance_today', 'unread_messages',
    'unread_notifications', 'my_students', 'recent_visits',
  ]) {
    assert.ok(key in dash.json, `missing ${key}`);
  }
  assert.ok(Array.isArray(dash.json.my_tasks));
});

test('admin dashboard KPIs + pipeline + activity', async () => {
  const dash = await api(ctx.base, 'GET', '/api/reports/dashboard', { token: admin.access_token });
  assert.equal(dash.status, 200);
  assert.ok(dash.json.kpis.registered_students >= 5);
  assert.ok(dash.json.kpis.active_employees >= 2);
  assert.equal(dash.json.pipeline.length, 9);
  assert.ok(dash.json.recent_activity.length >= 1);
  assert.ok(dash.json.recent_activity[0].action.startsWith('PET_'));
  assert.ok(dash.json.generated_at);

  const empDash = await api(ctx.base, 'GET', '/api/reports/dashboard', {
    token: emp.session.access_token,
  });
  assert.equal(empDash.status, 403);
});

test('global search finds across entities; activity + organization settings', async () => {
  const found = await api(ctx.base, 'GET', '/api/search?q=Enrolment Path', {
    token: admin.access_token,
  });
  assert.equal(found.status, 200);
  assert.ok(found.json.students.length >= 1);

  const foundSchool = await api(ctx.base, 'GET', '/api/search?q=Photo Ops', {
    token: admin.access_token,
  });
  assert.ok(foundSchool.json.schools.length >= 1);

  const activity = await api(ctx.base, 'GET', '/api/activity?limit=5', { token: admin.access_token });
  assert.equal(activity.status, 200);
  assert.ok(activity.json.total >= 1);

  const empActivity = await api(ctx.base, 'GET', '/api/activity', { token: emp.session.access_token });
  assert.equal(empActivity.status, 403);

  const patched = await api(ctx.base, 'PATCH', '/api/settings/organization', {
    token: admin.access_token,
    body: { org_name: 'Purvanchal Education Trust', phone: '0542-000000' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.organization.org_name, 'Purvanchal Education Trust');

  const got = await api(ctx.base, 'GET', '/api/settings/organization', { token: admin.access_token });
  assert.equal(got.json.organization.org_name, 'Purvanchal Education Trust');

  const empPatch = await api(ctx.base, 'PATCH', '/api/settings/organization', {
    token: emp.session.access_token,
    body: { org_name: 'hacker' },
  });
  assert.equal(empPatch.status, 403);
});

test('notifications: unread appears after assignment, read marks clear', async () => {
  // emp was assigned a task earlier in this file? create one now.
  await api(ctx.base, 'POST', '/api/tasks', {
    token: admin.access_token,
    body: { title: 'Notify about this task', assigned_to_user_id: emp.user.id },
  });
  const list = await api(ctx.base, 'GET', '/api/me/notifications', {
    token: emp.session.access_token,
  });
  assert.equal(list.status, 200);
  assert.ok(list.json.unread >= 1);
  assert.ok(list.json.notifications.some(n => n.title === 'New task assigned'));

  const read = await api(ctx.base, 'POST', '/api/me/notifications/read', {
    token: emp.session.access_token,
    body: {},
  });
  assert.equal(read.json.read, true);
  const after = await api(ctx.base, 'GET', '/api/me/notifications', {
    token: emp.session.access_token,
  });
  assert.equal(after.json.unread, 0);
});
