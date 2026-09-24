/** /field-visits — start/detail/patch/end workspace. */
'use strict';

const express = require('express');
const { asyncHandler, page, q } = require('../lib/http');
const { validate, str, optStr, intNum, num } = require('../lib/validate');
const { notFound, forbidden } = require('../lib/errors');
const {
  listVisits,
  startVisit,
  updateVisit,
  endVisit,
  visitDetail,
} = require('../services/visits');

function fieldVisitsRoutes() {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { limit, offset } = page(req, { defaultLimit: 50, maxLimit: 200 });
      const employeeId =
        req.user.role === 'main_admin' ? q(req, 'employee_id') : q(req, 'employee_id') || req.user.id;
      res.json(
        listVisits(req.app.locals.db, {
          status: q(req, 'status'),
          school_id: q(req, 'school_id'),
          employee_id: employeeId,
          q: q(req, 'q'),
          limit,
          offset,
        }),
      );
    }),
  );

  router.post(
    '/start',
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        school_id: str(req.body?.school_id, 'school_id', bag),
        purpose: optStr(req.body?.purpose, 'purpose', bag, { max: 300 }),
        latitude: num(req.body?.latitude, 'latitude', bag, { min: -90, max: 90 }),
        longitude: num(req.body?.longitude, 'longitude', bag, { min: -180, max: 180 }),
      }));
      res.status(201).json(startVisit(req.app.locals.db, req.user, input, { ip: req.ip }));
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      res.json(visitDetail(req.app.locals.db, req.user, req.params.id));
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        purpose: req.body?.purpose !== undefined ? optStr(req.body.purpose, 'purpose', bag, { max: 300 }) : undefined,
        notes: req.body?.notes !== undefined ? optStr(req.body.notes, 'notes', bag, { max: 4000 }) : undefined,
        report: req.body?.report !== undefined ? optStr(req.body.report, 'report', bag, { max: 8000 }) : undefined,
        students_contacted:
          req.body?.students_contacted !== undefined
            ? intNum(req.body.students_contacted, 'students_contacted', bag, { min: 0, max: 100000 })
            : undefined,
        documents_collected:
          req.body?.documents_collected !== undefined
            ? intNum(req.body.documents_collected, 'documents_collected', bag, { min: 0, max: 100000 })
            : undefined,
      }));
      const db = req.app.locals.db;
      const visit = db.prepare('SELECT * FROM field_visits WHERE id = ?').get(String(req.params.id));
      if (!visit) throw notFound('Visit not found.');
      if (visit.employee_id !== req.user.id && req.user.role !== 'main_admin') {
        throw forbidden('Only the visiting employee or a Main Admin can edit this visit.');
      }
      res.json(updateVisit(db, req.user, req.params.id, input, { ip: req.ip }));
    }),
  );

  router.post(
    '/:id/end',
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        report: optStr(req.body?.report, 'report', bag, { max: 8000 }),
        notes: optStr(req.body?.notes, 'notes', bag, { max: 4000 }),
        students_contacted: intNum(req.body?.students_contacted, 'students_contacted', bag, { min: 0, max: 100000 }),
        documents_collected: intNum(req.body?.documents_collected, 'documents_collected', bag, { min: 0, max: 100000 }),
        latitude: num(req.body?.latitude, 'latitude', bag, { min: -90, max: 90 }),
        longitude: num(req.body?.longitude, 'longitude', bag, { min: -180, max: 180 }),
      }));
      res.json(
        endVisit(req.app.locals.db, req.user, req.params.id, input, { ip: req.ip, isAdmin: req.user.role === 'main_admin' }),
      );
    }),
  );

  return router;
}

module.exports = { fieldVisitsRoutes };
