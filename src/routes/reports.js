/** /reports · /search · /activity · /settings/organization — admin insight. */
'use strict';

const express = require('express');
const { asyncHandler, page, q } = require('../lib/http');
const { requireAdmin } = require('../middleware/auth');
const { adminDashboard, globalSearch, getOrganization, saveOrganization } = require('../services/reports');
const { listActivity } = require('../lib/audit');

function reportsRoutes() {
  const router = express.Router();

  router.get(
    '/reports/dashboard',
    requireAdmin,
    asyncHandler(async (req, res) => {
      res.json(adminDashboard(req.app.locals.db));
    }),
  );

  router.get(
    '/search',
    asyncHandler(async (req, res) => {
      res.json(globalSearch(req.app.locals.db, q(req, 'q')));
    }),
  );

  router.get(
    '/activity',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { limit, offset } = page(req, { defaultLimit: 50, maxLimit: 200 });
      res.json(listActivity(req.app.locals.db, { limit, offset }));
    }),
  );

  router.get(
    '/settings/organization',
    asyncHandler(async (req, res) => {
      res.json(getOrganization(req.app.locals.db));
    }),
  );

  router.patch(
    '/settings/organization',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const input =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      delete input.created_at;
      delete input.updated_at;
      res.json(saveOrganization(req.app.locals.db, req.user, input, { ip: req.ip }));
    }),
  );

  return router;
}

module.exports = { reportsRoutes };
