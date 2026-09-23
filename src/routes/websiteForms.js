/** /website-forms — lead intake from the public site (Main Admin work). */
'use strict';

const express = require('express');
const { asyncHandler, page, q } = require('../lib/http');
const { validate, str, enumOf } = require('../lib/validate');
const { requireAdmin } = require('../middleware/auth');
const {
  listSubmissions,
  assignSubmission,
  setSubmissionStatus,
  convertSubmission,
  STATUSES,
} = require('../services/websiteForms');

function websiteFormsRoutes() {
  const router = express.Router();
  router.use(requireAdmin);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { limit, offset } = page(req, { defaultLimit: 50, maxLimit: 200 });
      res.json(listSubmissions(req.app.locals.db, { status: q(req, 'status'), limit, offset }));
    }),
  );

  router.post(
    '/:id/assign',
    asyncHandler(async (req, res) => {
      const { assigned_to_user_id } = validate(bag => ({
        assigned_to_user_id: str(req.body?.assigned_to_user_id, 'assigned_to_user_id', bag),
      }));
      res.json(assignSubmission(req.app.locals.db, req.user, req.params.id, assigned_to_user_id, { ip: req.ip }));
    }),
  );

  router.post(
    '/:id/status',
    asyncHandler(async (req, res) => {
      const status = validate(bag => enumOf(req.body?.status, 'status', bag, STATUSES));
      res.json(setSubmissionStatus(req.app.locals.db, req.user, req.params.id, status, { ip: req.ip }));
    }),
  );

  router.post(
    '/:id/convert',
    asyncHandler(async (req, res) => {
      const options = {
        overrides: req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : {},
        acknowledge_duplicates: !!req.body?.acknowledge_duplicates,
      };
      res.json(convertSubmission(req.app.locals.db, req.user, req.params.id, options, { ip: req.ip }));
    }),
  );

  return router;
}

module.exports = { websiteFormsRoutes };
