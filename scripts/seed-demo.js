#!/usr/bin/env node
/**
 * Demo seed — enough realistic data to walk every screen of the PET
 * frontend without touching production. Safe to re-run: it refuses when
 * the database already has students unless --force is passed (and --force
 * never deletes users).
 *
 *   npm run seed-demo
 *
 * Demo credentials printed at the end.
 */
'use strict';

const { resolveConfig } = require('../src/config');
const { openDatabase, tx } = require('../src/db');
const { migrate } = require('../src/schema');
const { upsertMainAdmin, createEmployee } = require('../src/services/employees');
const { registerStudent, changeStudentStatus } = require('../src/services/students');
const { createSchool } = require('../src/services/schools');
const { startVisit, endVisit } = require('../src/services/visits');
const { createTask, changeTaskStatus } = require('../src/services/tasks');
const { openDirect, sendMessage, createGroup } = require('../src/services/chat');
const { checkIn } = require('../src/services/attendance');
const { createTest, assignStudents, enterMarks, finalizeScore, decide, startEnrollment, advanceEnrollment } = require('../src/services/tests');
const { createSubmission } = require('../src/services/websiteForms');
const { saveOrganization } = require('../src/services/reports');

const ADMIN_EMAIL = 'admin@pet.local';
const ADMIN_PASSWORD = 'PetAdmin123!';

const SCHOOLS = [
  ['Gyan Niketan Inter College', 'Swaroop Nagar', 'Kanpur', 'Kanpur'],
  ['Saraswati Vidya Mandir', 'Bhawani Ghat', 'Varanasi', 'Varanasi'],
  ['Rampur Primary School', 'Rampur', 'Azamgarh', 'Azamgarh'],
  ['St. Mary\'s Convent', 'Civil Lines', 'Prayagraj', 'Prayagraj'],
  ['Netaji Subhash Public School', 'Kotwali', 'Jaunpur', 'Jaunpur'],
  ['Bal Bharati Vidyalaya', 'Nehru Nagar', 'Ghaziabad', 'Ghaziabad'],
];

const STUDENTS = [
  ['Aarav Sharma', 'male', '2011-04-12', '7', 'Rampur', '9811100001', '9811100002'],
  ['Vivaan Gupta', 'male', '2010-09-01', '8', 'Rampur', '9811100003', '9811100004'],
  ['Aditya Verma', 'male', '2012-01-20', '6', 'Swaroop Nagar', '9811100005', '9811100006'],
  ['Saanvi Patel', 'female', '2011-06-15', '7', 'Bhawani Ghat', '9811100007', '9811100008'],
  ['Ishaan Singh', 'male', '2009-11-30', '9', 'Civil Lines', '9811100009', '9811100010'],
  ['Ananya Mishra', 'female', '2010-02-18', '8', 'Kotwali', '9811100011', '9811100012'],
  ['Kabir Yadav', 'male', '2012-07-07', '6', 'Nehru Nagar', '9811100013', '9811100014'],
  ['Diya Chauhan', 'female', '2011-12-25', '7', 'Rampur', '9811100015', '9811100016'],
  ['Rohan Tiwari', 'male', '2010-05-05', '8', 'Swaroop Nagar', '9811100017', '9811100018'],
  ['Meera Saxena', 'female', '2009-08-22', '9', 'Civil Lines', '9811100019', '9811100020'],
  ['Arjun Nishad', 'male', '2012-03-14', '6', 'Bhawani Ghat', '9811100021', '9811100022'],
  ['Priya Kanojia', 'female', '2011-10-10', '7', 'Kotwali', '9811100023', '9811100024'],
];

function main() {
  const config = resolveConfig();
  const db = openDatabase(config.dbPath);
  migrate(db);

  const existingStudents = Number(db.prepare('SELECT COUNT(*) AS c FROM students').get().c);
  const force = process.argv.includes('--force');
  if (existingStudents > 0 && !force) {
    console.log(`Database already has ${existingStudents} students — nothing to do.`);
    console.log('Pass --force to add the demo dataset on top (users are never touched).');
    db.close();
    return;
  }

  // ── People ────────────────────────────────────────────────────────────────
  const adminResult = upsertMainAdmin(db, {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    name: 'Demo Main Admin',
    mustChange: false,
  });
  const admin = adminResult.user;

  const empDefs = [
    { name: 'Ravi Yadav', email: 'ravi@pet.local', department: 'Field Ops — Kanpur' },
    { name: 'Sunita Devi', email: 'sunita@pet.local', department: 'Field Ops — Varanasi' },
    { name: 'Imran Qureshi', email: 'imran@pet.local', department: 'Field Ops — Azamgarh' },
  ];
  const employees = empDefs.map(
    d =>
      createEmployee(db, admin, {
        name: d.name,
        email: d.email,
        department: d.department,
        phone: '9876500000',
        password: 'Employee123!',
      }).user,
  );

  saveOrganization(db, admin, {
    org_name: 'Purvanchal Education Trust',
    motto: 'Education for every child in the Purvanchal belt',
    phone: '0542-2000000',
    email: 'contact@pet.local',
    address: 'Civil Lines, Varanasi, Uttar Pradesh',
  });

  // ── Schools ───────────────────────────────────────────────────────────────
  const schools = SCHOOLS.map(([name, locality, city, district]) =>
    createSchool(db, admin, { name, locality, city, district, state: 'Uttar Pradesh' }).school,
  );

  // ── Students across the pipeline ─────────────────────────────────────────
  const lifecycle = [
    'registered', 'registered', 'test_scheduled', 'test_completed',
    'under_evaluation', 'selected', 'selected', 'waitlisted',
    'not_selected', 'enrolled', 'registered', 'inactive',
  ];
  const students = STUDENTS.map(([name, gender, dob, currentClass, locality, studentPhone, parentPhone], i) => {
    const school = schools[i % schools.length];
    const { student } = registerStudent(db, employees[i % employees.length], {
      name,
      gender,
      dob,
      current_class: currentClass,
      locality,
      district: school.district,
      city: school.city,
      state: 'Uttar Pradesh',
      school_id: school.id,
      student_phone: studentPhone,
      parent_phone: parentPhone,
      parent_name: `${name.split(' ')[0]}'s parent`,
      acknowledge_duplicates: true,
      notes: i === 0 ? 'Topped the written test last season.' : null,
    });
    return student;
  });

  // Push each along the documented lifecycle (best effort per status).
  const pathTo = (student, target) => {
    const routes = {
      registered: [],
      test_scheduled: ['test_scheduled'],
      test_completed: ['test_scheduled', 'test_completed'],
      under_evaluation: ['test_scheduled', 'test_completed', 'under_evaluation'],
      selected: ['test_scheduled', 'test_completed', 'under_evaluation', 'selected'],
      waitlisted: ['test_scheduled', 'test_completed', 'under_evaluation', 'waitlisted'],
      not_selected: ['test_scheduled', 'test_completed', 'under_evaluation', 'not_selected'],
      enrolled: ['test_scheduled', 'test_completed', 'under_evaluation', 'selected', 'enrolled'],
      inactive: ['test_scheduled', 'test_completed', 'under_evaluation', 'not_selected', 'inactive'],
    };
    let current = 'registered';
    for (const step of routes[target] || []) {
      const r = changeStudentStatus(db, admin, student.id, step, 'demo seed');
      current = r.status;
    }
    return current;
  };
  students.forEach((s, i) => pathTo(s, lifecycle[i]));

  // ── Attendance today (admin + first employee) ────────────────────────────
  checkIn(db, admin, { latitude: 26.85, longitude: 80.95 });
  checkIn(db, { id: employees[0].id, name: employees[0].name, role: 'employee' }, {});

  // ── A field visit + linked task ──────────────────────────────────────────
  const fieldUser = { id: employees[0].id, name: employees[0].name, role: 'employee' };
  const visit = startVisit(db, fieldUser, {
    school_id: schools[2].id,
    purpose: 'Student identification drive',
    latitude: 26.1,
    longitude: 83.5,
  }).visit;
  registerStudent(db, fieldUser, {
    name: 'Visit Day Fresh Kid',
    school_id: schools[2].id,
    visit_id: visit.id,
    current_class: '5',
    acknowledge_duplicates: true,
  });

  const task1 = createTask(db, admin, {
    title: 'Collect caste certificates from Rampur families',
    assigned_to_user_id: employees[0].id,
    priority: 'high',
    due_date: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10),
    school_id: schools[2].id,
  }).task;
  changeTaskStatus(db, fieldUser, task1.id, 'accepted');
  changeTaskStatus(db, fieldUser, task1.id, 'in_progress');

  createTask(db, admin, {
    title: 'Photograph the new classroom block',
    assigned_to_user_id: employees[1].id,
    priority: 'normal',
    school_id: schools[0].id,
  });

  createTask(db, { id: employees[2].id, name: employees[2].name, role: 'employee' }, {
    title: 'Verify 5 admission forms',
    assigned_to_user_id: employees[0].id,
    priority: 'low',
  });

  // ── Chat ─────────────────────────────────────────────────────────────────
  const dm = openDirect(db, admin, employees[0].id).conversation;
  sendMessage(db, admin, dm.id, { text: 'How many registrations today in Rampur?' });
  sendMessage(db, fieldUser, dm.id, { text: 'Six so far — heading to the junior wing next.' });
  const group = createGroup(db, admin, 'Purvanchal Field Leads', employees.map(e => e.id)).conversation;
  sendMessage(db, admin, group.id, { text: 'Weekly sync at 5 PM. Bring your visit reports.' });

  // ── A test with marks ────────────────────────────────────────────────────
  const test = createTest(db, admin, {
    name: 'Entrance Test — Autumn 2026',
    description: 'Mathematics + English screening',
    passing_percentage: 50,
    scheduled_date: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10),
    subjects: [
      { name: 'Mathematics', max_marks: 100, passing_marks: 35 },
      { name: 'English', max_marks: 50, passing_marks: 20 },
    ],
  }).test;
  const candidates = students.slice(0, 5).map(s => s.id);
  assignStudents(db, admin, test.id, candidates);
  const [math, english] = test.subjects;
  enterMarks(db, admin, test.id, candidates[0], [
    { subject_id: math.id, obtained_marks: 84 },
    { subject_id: english.id, obtained_marks: 41 },
  ]);
  finalizeScore(db, admin, test.id, candidates[0]);
  decide(db, admin, test.id, candidates[0], 'selected', 'Demo seed result');
  enterMarks(db, admin, test.id, candidates[1], [
    { subject_id: math.id, obtained_marks: 22 },
    { subject_id: english.id, obtained_marks: 14 },
  ]);

  // ── Enrollment ───────────────────────────────────────────────────────────
  const enrolledKid = students.find(s => lifecycle[students.indexOf(s)] === 'enrolled') || students[9];
  try {
    startEnrollment(db, admin, enrolledKid.id, 'demo enrollment');
    advanceEnrollment(db, admin, enrolledKid.id, 'documents');
    advanceEnrollment(db, admin, enrolledKid.id, 'verification');
    advanceEnrollment(db, admin, enrolledKid.id, 'enrolled', 'all verified');
  } catch {
    /* student may already be enrolled by the lifecycle push */
  }

  // ── Website forms ────────────────────────────────────────────────────────
  createSubmission(db, {
    form_type: 'student_registration',
    name: 'Aditi Srivastava',
    phone: '9899900001',
    email: 'aditi@example.com',
    payload: { current_class: '6', district: 'Varanasi', parent_name: 'R. Srivastava', notes: 'Wants morning batch' },
  });
  createSubmission(db, {
    form_type: 'school_partnership',
    name: 'Saraswati Vidya Mandir (Principal)',
    phone: '9899900002',
    payload: { message: 'Interested in your after-school program' },
  });

  console.log('Demo dataset ready.');
  console.log('');
  console.log('  Main Admin     admin@pet.local / PetAdmin123!');
  console.log('  Field employees (ravi|sunita|imran)@pet.local / Employee123!');
  console.log('');
  console.log(`  students=${db.prepare('SELECT COUNT(*) AS c FROM students').get().c}` +
    ` schools=${db.prepare('SELECT COUNT(*) AS c FROM schools').get().c}` +
    ` tasks=${db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c}` +
    ` visits=${db.prepare('SELECT COUNT(*) AS c FROM field_visits').get().c}`);
  db.close();
}

main();
