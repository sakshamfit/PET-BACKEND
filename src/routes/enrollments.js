/** /enrollments — post-selection pipeline (Main Admin driven). */
'use strict';

const express = require('express');
const { asyncHandler, page, q } = require('../lib/http');
const { validate, optStr, enumOf } = require('../lib/validate');
const { requireAdmin } = require('../middleware/auth');
const {
  listEnrollments,
  getEnrollment,
  startEnrollment,
  advanceEnrollment,
  withdrawEnrollment,
  STAGES,
} = require('../services/tests');

function enrollmentsRoutes() {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { limit, offset } = page(req, { defaultLimit: 50, maxLimit: 200 });
      res.json(listEnrollments(req.app.locals.db, { status: q(req, 'status'), limit, offset }));
    }),
  );

  router.get(
    '/:studentId',
    asyncHandler(async (req, res) => {
      res.json(getEnrollment(req.app.locals.db, req.params.studentId));
    }),
  );

  router.post(
    '/:studentId/start',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { notes } = validate(bag => ({ notes: optStr(req.body?.notes, 'notes', bag, { max: 4000 }) }));
      res.json(startEnrollment(req.app.locals.db, req.user, req.params.studentId, notes, { ip: req.ip }));
    }),
  );

  router.post(
    '/:studentId/stage',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { stage, notes } = validate(bag => ({
        stage: enumOf(req.body?.stage, 'stage', bag, STAGES),
        notes: optStr(req.body?.notes, 'notes', bag, { max: 4000 }),
      }));
      res.json(advanceEnrollment(req.app.locals.db, req.user, req.params.studentId, stage, notes, { ip: req.ip }));
    }),
  );

  router.post(
    '/:studentId/withdraw',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { reason } = validate(bag => ({ reason: optStr(req.body?.reason, 'reason', bag, { max: 1000 }) }));
      res.json(withdrawEnrollment(req.app.locals.db, req.user, req.params.studentId, reason, { ip: req.ip }));
    }),
  );

  return router;
}

module.exports = { enrollmentsRoutes };
