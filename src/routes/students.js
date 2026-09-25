/** /students — search, register (duplicate-guarded), profile, status flow. */
'use strict';

const express = require('express');
const { asyncHandler, page, q } = require('../lib/http');
const {
  validate,
  str,
  optStr,
  intNum,
  enumOf,
  optEnum,
  phone: vPhone,
  isoDate,
} = require('../lib/validate');
const { notFound, badRequest } = require('../lib/errors');
const { now } = require('../lib/ids');
const { tx } = require('../db');
const { logAction } = require('../lib/audit');
const {
  findDuplicates,
  registerStudent,
  changeStudentStatus,
  searchStudents,
  studentProfile,
} = require('../services/students');
const { toStudent } = require('../services/serialize');

const STATUSES = [
  'registered', 'test_scheduled', 'test_completed', 'under_evaluation',
  'selected', 'waitlisted', 'not_selected', 'enrolled', 'inactive',
];

function parseRegistration(body, config) {
  return validate(bag => {
    const input = {
      name: str(body?.name, 'name', bag, { min: 2, max: 160 }),
      dob: isoDate(body?.dob, 'dob', bag),
      age: intNum(body?.age, 'age', bag, { min: 0, max: 120 }),
      gender: optEnum(body?.gender, 'gender', bag, ['male', 'female', 'other']),
      student_phone: vPhone(body?.student_phone, 'student_phone', bag),
      parent_name: optStr(body?.parent_name, 'parent_name', bag, { max: 160 }),
      parent_phone: vPhone(body?.parent_phone, 'parent_phone', bag),
      parent_relation: optStr(body?.parent_relation, 'parent_relation', bag, { max: 60 }),
      school_id: optStr(body?.school_id, 'school_id', bag),
      school_name: optStr(body?.school_name, 'school_name', bag, { max: 200 }),
      school_address: optStr(body?.school_address, 'school_address', bag, { max: 400 }),
      locality: optStr(body?.locality, 'locality', bag, { max: 160 }),
      city: optStr(body?.city, 'city', bag, { max: 120 }),
      district: optStr(body?.district, 'district', bag, { max: 120 }),
      state: optStr(body?.state, 'state', bag, { max: 120 }),
      current_class: optStr(body?.current_class, 'current_class', bag, { max: 40 }),
      previous_school: optStr(body?.previous_school, 'previous_school', bag, { max: 200 }),
      address: optStr(body?.address, 'address', bag, { max: 400 }),
      notes: optStr(body?.notes, 'notes', bag, { max: 4000 }),
      visit_id: optStr(body?.visit_id, 'visit_id', bag),
      acknowledge_duplicates: !!body?.acknowledge_duplicates,
      photo_data: body?.photo_data || null,
      __fields: bag.fields,
    };
    return input;
  });
}

/** Decode the optional inline photo before the transaction starts. */
function materializePhoto(config, photoData) {
  if (!photoData || !photoData.dataBase64) return null;
  const { saveBuffer } = require('../services/uploads');
  const raw = String(photoData.dataBase64);
  const cleaned = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const buffer = Buffer.from(cleaned, 'base64');
  return saveBuffer(config, 'students', buffer, photoData.mimeType || 'image/jpeg').relative_path;
}

function studentsRoutes(config) {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { limit, offset } = page(req, { defaultLimit: 50, maxLimit: 200 });
      res.json(
        searchStudents(req.app.locals.db, {
          q: q(req, 'q'),
          status: q(req, 'status'),
          school_id: q(req, 'school_id'),
          limit,
          offset,
        }),
      );
    }),
  );

  router.post(
    '/duplicates-check',
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        name: str(req.body?.name, 'name', bag, { min: 1, max: 160 }),
        parent_phone: vPhone(req.body?.parent_phone, 'parent_phone', bag),
        student_phone: vPhone(req.body?.student_phone, 'student_phone', bag),
        school_id: optStr(req.body?.school_id, 'school_id', bag),
        dob: isoDate(req.body?.dob, 'dob', bag),
      }));
      res.json({ duplicates: findDuplicates(req.app.locals.db, input) });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = parseRegistration(req.body, config);
      input.photo_path = materializePhoto(config, input.photo_data);
      delete input.photo_data;
      delete input.__fields;
      const result = registerStudent(req.app.locals.db, req.user, input, { ip: req.ip });
      res.status(201).json(result);
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const row = req.app.locals.db.prepare('SELECT * FROM students WHERE id = ?').get(String(req.params.id));
      if (!row) throw notFound('Student not found.');
      res.json({ student: toStudent(row) });
    }),
  );

  router.get(
    '/:id/profile',
    asyncHandler(async (req, res) => {
      res.json(studentProfile(req.app.locals.db, req.params.id));
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const db = req.app.locals.db;
      const student = db.prepare('SELECT * FROM students WHERE id = ?').get(String(req.params.id));
      if (!student) throw notFound('Student not found.');

      const input = validate(bag => ({
        name: req.body?.name !== undefined ? str(req.body.name, 'name', bag, { min: 2, max: 160 }) : undefined,
        dob: req.body?.dob !== undefined ? isoDate(req.body.dob, 'dob', bag) : undefined,
        age: req.body?.age !== undefined ? intNum(req.body.age, 'age', bag, { min: 0, max: 120 }) : undefined,
        gender: req.body?.gender !== undefined ? optEnum(req.body.gender, 'gender', bag, ['male', 'female', 'other']) : undefined,
        student_phone: req.body?.student_phone !== undefined ? vPhone(req.body.student_phone, 'student_phone', bag) : undefined,
        parent_name: req.body?.parent_name !== undefined ? optStr(req.body.parent_name, 'parent_name', bag, { max: 160 }) : undefined,
        parent_phone: req.body?.parent_phone !== undefined ? vPhone(req.body.parent_phone, 'parent_phone', bag) : undefined,
        parent_relation: req.body?.parent_relation !== undefined ? optStr(req.body.parent_relation, 'parent_relation', bag, { max: 60 }) : undefined,
        school_id: req.body?.school_id !== undefined ? optStr(req.body.school_id, 'school_id', bag) : undefined,
        locality: req.body?.locality !== undefined ? optStr(req.body.locality, 'locality', bag, { max: 160 }) : undefined,
        city: req.body?.city !== undefined ? optStr(req.body.city, 'city', bag, { max: 120 }) : undefined,
        district: req.body?.district !== undefined ? optStr(req.body.district, 'district', bag, { max: 120 }) : undefined,
        state: req.body?.state !== undefined ? optStr(req.body.state, 'state', bag, { max: 120 }) : undefined,
        current_class: req.body?.current_class !== undefined ? optStr(req.body.current_class, 'current_class', bag, { max: 40 }) : undefined,
        previous_school: req.body?.previous_school !== undefined ? optStr(req.body.previous_school, 'previous_school', bag, { max: 200 }) : undefined,
        address: req.body?.address !== undefined ? optStr(req.body.address, 'address', bag, { max: 400 }) : undefined,
        notes: req.body?.notes !== undefined ? optStr(req.body.notes, 'notes', bag, { max: 4000 }) : undefined,
      }));

      const changed = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      if (Object.keys(changed).length) {
        if (Object.prototype.hasOwnProperty.call(changed, 'school_id')) {
          if (changed.school_id) {
            const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(changed.school_id);
            if (!school) throw badRequest('Linked school not found.');
            changed.school_name = school.name;
            changed.school_address = school.address ?? null;
          } else {
            // Clearing a school must also clear the denormalized display fields;
            // otherwise the list/profile keeps showing the old school name.
            changed.school_name = null;
            changed.school_address = null;
          }
        }
        const sets = Object.keys(changed).map(k => `${k} = ?`);
        const params = Object.values(changed);
        tx(db, () => {
          db.prepare(`UPDATE students SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(
            ...params,
            now(),
            student.id,
          );
          logAction(db, {
            actorId: req.user.id,
            actorLabel: req.user.name,
            action: 'PET_STUDENT_UPDATED',
            targetType: 'student',
            targetId: student.id,
            metadata: { fields: Object.keys(changed) },
            ip: req.ip,
          });
        });
      }
      res.json({ student: toStudent(db.prepare('SELECT * FROM students WHERE id = ?').get(student.id)) });
    }),
  );

  router.post(
    '/:id/status',
    asyncHandler(async (req, res) => {
      const { to_status, reason } = validate(bag => ({
        to_status: enumOf(req.body?.to_status, 'to_status', bag, STATUSES),
        reason: optStr(req.body?.reason, 'reason', bag, { max: 500 }),
      }));
      const student = changeStudentStatus(
        req.app.locals.db,
        req.user,
        req.params.id,
        to_status,
        reason,
        { ip: req.ip },
      );
      res.json({ student });
    }),
  );

  return router;
}

module.exports = { studentsRoutes, STATUSES };
