/** /me — profile, employee dashboard, today's attendance, notifications, directory. */
'use strict';

const express = require('express');
const { asyncHandler } = require('../lib/http');
const { toUser } = require('../services/serialize');
const { todayRecord } = require('../services/attendance');
const { meDashboard } = require('../services/reports');
const { listNotifications, markRead } = require('../lib/notify');

function meRoutes(config) {
  const router = express.Router();
  const db = req => req.app.locals.db;

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const row = db(req).prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      res.json({ user: toUser(row) });
    }),
  );

  router.get(
    '/dashboard',
    asyncHandler(async (req, res) => {
      res.json(meDashboard(db(req), req.user));
    }),
  );

  router.get(
    '/attendance/today',
    asyncHandler(async (req, res) => {
      res.json(todayRecord(db(req), req.user.id));
    }),
  );

  router.get(
    '/notifications',
    asyncHandler(async (req, res) => {
      res.json(listNotifications(db(req), req.user.id));
    }),
  );

  router.post(
    '/notifications/read',
    asyncHandler(async (req, res) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
      res.json(markRead(db(req), req.user.id, ids));
    }),
  );

  router.get(
    '/directory',
    asyncHandler(async (req, res) => {
      const members = db(req)
        .prepare(
          `SELECT id, name, role, employee_code, department FROM users
            WHERE status = 'ACTIVE' ORDER BY name COLLATE NOCASE`,
        )
        .all()
        .map(r => ({
          id: r.id,
          name: r.name,
          role: r.role,
          employee_code: r.employee_code ?? null,
          department: r.department ?? null,
        }));
      res.json({ members });
    }),
  );

  return router;
}

module.exports = { meRoutes };
