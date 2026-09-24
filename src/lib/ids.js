/** IDs and human-readable sequential codes. */
'use strict';

const crypto = require('crypto');

function uuid() {
  return crypto.randomUUID();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Next value of a named counter, atomic under the caller's transaction.
 * Used for PET-STU-000123 / SCH-0001 / EMP-0001 style codes.
 */
function nextCounter(db, name) {
  db.prepare('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING').run(name);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(name);
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
  return Number(row.value);
}

function petStudentId(db) {
  return `PET-STU-${String(nextCounter(db, 'pet_student')).padStart(6, '0')}`;
}

function schoolCode(db) {
  return `SCH-${String(nextCounter(db, 'school')).padStart(4, '0')}`;
}

function employeeCode(db) {
  return `EMP-${String(nextCounter(db, 'employee')).padStart(4, '0')}`;
}

function now() {
  return new Date().toISOString();
}

/**
 * Calendar date in the SERVER's local timezone (attendance.date, due dates).
 * Not UTC: the office PC lives in IST and "today" must match the wall clock
 * of the people punching in.
 */
function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = { uuid, sha256, nextCounter, petStudentId, schoolCode, employeeCode, now, today };
