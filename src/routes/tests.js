/** /tests — selection tests: subjects, assign, marks, finalize, decisions. */
'use strict';

const express = require('express');
const { asyncHandler, page, q } = require('../lib/http');
const { validate, str, optStr, num, enumOf, isoDate } = require('../lib/validate');
const { requireAdmin } = require('../middleware/auth');
const {
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
  DECISIONS,
} = require('../services/tests');

function subjectsInput(body, bag) {
  const list = Array.isArray(body?.subjects) ? body.subjects : [];
  if (!list.length) return [];
  return list.map((s, i) => {
    const name = str(s?.name, `subjects[${i}].name`, bag, { min: 1, max: 120 });
    const maxMarks = num(s?.max_marks, `subjects[${i}].max_marks`, bag, { min: 0.5, max: 1000, required: true });
    const passing =
      s?.passing_marks === undefined || s?.passing_marks === null || s?.passing_marks === ''
        ? null
        : num(s.passing_marks, `subjects[${i}].passing_marks`, bag, { min: 0, max: 1000 });
    return { name, max_marks: maxMarks, passing_marks: passing };
  });
}

function testsRoutes() {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { limit, offset } = page(req, { defaultLimit: 50, maxLimit: 200 });
      res.json(listTests(req.app.locals.db, { status: q(req, 'status'), limit, offset }));
    }),
  );

  router.post(
    '/',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        name: str(req.body?.name, 'name', bag, { min: 2, max: 200 }),
        description: optStr(req.body?.description, 'description', bag, { max: 2000 }),
        passing_percentage: num(req.body?.passing_percentage, 'passing_percentage', bag, { min: 0, max: 100 }) ?? 50,
        scheduled_date: isoDate(req.body?.scheduled_date, 'scheduled_date', bag),
        subjects: subjectsInput(req.body, bag),
      }));
      if (!input.subjects.length) {
        const { badRequest } = require('../lib/errors');
        throw badRequest('Add at least one subject.');
      }
      res.status(201).json(createTest(req.app.locals.db, req.user, input, { ip: req.ip }));
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      res.json(getTest(req.app.locals.db, req.params.id));
    }),
  );

  router.patch(
    '/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        name: req.body?.name !== undefined ? str(req.body.name, 'name', bag, { min: 2, max: 200 }) : undefined,
        description: req.body?.description !== undefined ? optStr(req.body.description, 'description', bag, { max: 2000 }) : undefined,
        passing_percentage:
          req.body?.passing_percentage !== undefined
            ? num(req.body.passing_percentage, 'passing_percentage', bag, { min: 0, max: 100 })
            : undefined,
        scheduled_date: req.body?.scheduled_date !== undefined ? isoDate(req.body.scheduled_date, 'scheduled_date', bag) : undefined,
        status: req.body?.status !== undefined ? enumOf(req.body.status, 'status', bag, ['draft', 'scheduled', 'completed', 'finalized']) : undefined,
        subjects: req.body?.subjects !== undefined ? subjectsInput(req.body, bag) : undefined,
      }));
      res.json(updateTest(req.app.locals.db, req.user, req.params.id, input, { ip: req.ip }));
    }),
  );

  router.post(
    '/:id/assign',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const student_ids = Array.isArray(req.body?.student_ids) ? req.body.student_ids.map(String) : [];
      res.json(assignStudents(req.app.locals.db, req.user, req.params.id, student_ids, { ip: req.ip }));
    }),
  );

  router.post(
    '/:id/marks/:studentId',
    asyncHandler(async (req, res) => {
      const marks = Array.isArray(req.body?.marks)
        ? req.body.marks.map(m => ({ subject_id: String(m.subject_id), obtained_marks: m.obtained_marks }))
        : [];
      if (!marks.length) {
        const { badRequest } = require('../lib/errors');
        throw badRequest('Provide at least one subject mark.');
      }
      res.json(enterMarks(req.app.locals.db, req.user, req.params.id, req.params.studentId, marks, { ip: req.ip }));
    }),
  );

  router.get(
    '/:id/scores/:studentId',
    asyncHandler(async (req, res) => {
      res.json({ score: scoreFor(req.app.locals.db, req.params.id, req.params.studentId) });
    }),
  );

  router.post(
    '/:id/finalize/:studentId',
    asyncHandler(async (req, res) => {
      res.json(finalizeScore(req.app.locals.db, req.user, req.params.id, req.params.studentId, { ip: req.ip }));
    }),
  );

  router.post(
    '/:id/absent/:studentId',
    asyncHandler(async (req, res) => {
      res.json(markAbsent(req.app.locals.db, req.user, req.params.id, req.params.studentId, { ip: req.ip }));
    }),
  );

  router.post(
    '/:id/decision/:studentId',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { decision, remarks } = validate(bag => ({
        decision: enumOf(req.body?.decision, 'decision', bag, DECISIONS),
        remarks: optStr(req.body?.remarks, 'remarks', bag, { max: 1000 }),
      }));
      res.json(decide(req.app.locals.db, req.user, req.params.id, req.params.studentId, decision, remarks, { ip: req.ip }));
    }),
  );

  return router;
}

module.exports = { testsRoutes };
