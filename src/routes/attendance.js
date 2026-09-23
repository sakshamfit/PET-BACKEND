/** /attendance — punches are idempotent; marking/summary are Main Admin. */
'use strict';

const express = require('express');
const { asyncHandler, page, q } = require('../lib/http');
const { validate, enumOf, isoDate, optStr, num } = require('../lib/validate');
const { forbidden } = require('../lib/errors');
const { requireAdmin } = require('../middleware/auth');
const { checkIn, checkOut, markAttendance, listAttendance, monthSummary } = require('../services/attendance');

const ATT_STATUSES = ['present', 'absent', 'leave', 'half_day', 'late'];

function attendanceRoutes() {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { limit, offset } = page(req, { defaultLimit: 50, maxLimit: 300 });
      let employeeId = q(req, 'employee_id');
      if (req.user.role !== 'main_admin') {
        if (employeeId && employeeId !== req.user.id) {
          throw forbidden('You can only view your own attendance.');
        }
        employeeId = req.user.id;
      }
      res.json(
        listAttendance(req.app.locals.db, {
          employee_id: employeeId,
          from: q(req, 'from'),
          to: q(req, 'to'),
          month: q(req, 'month'),
          limit,
          offset,
        }),
      );
    }),
  );

  router.post(
    '/check-in',
    asyncHandler(async (req, res) => {
      const geo = validate(bag => ({
        latitude: num(req.body?.latitude, 'latitude', bag, { min: -90, max: 90 }),
        longitude: num(req.body?.longitude, 'longitude', bag, { min: -180, max: 180 }),
      }));
      res.json(checkIn(req.app.locals.db, req.user, geo, { ip: req.ip }));
    }),
  );

  router.post(
    '/check-out',
    asyncHandler(async (req, res) => {
      const geo = validate(bag => ({
        latitude: num(req.body?.latitude, 'latitude', bag, { min: -90, max: 90 }),
        longitude: num(req.body?.longitude, 'longitude', bag, { min: -180, max: 180 }),
      }));
      res.json(checkOut(req.app.locals.db, req.user, geo, { ip: req.ip }));
    }),
  );

  router.post(
    '/mark',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        employee_id: require('../lib/validate').str(req.body?.employee_id, 'employee_id', bag),
        date: isoDate(req.body?.date, 'date', bag) || new Date().toISOString().slice(0, 10),
        status: enumOf(req.body?.status, 'status', bag, ATT_STATUSES),
        remarks: optStr(req.body?.remarks, 'remarks', bag, { max: 500 }),
      }));
      res.json(markAttendance(req.app.locals.db, req.user, input, { ip: req.ip }));
    }),
  );

  router.get(
    '/summary',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const month =
        q(req, 'month') || new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) {
        const { badRequest } = require('../lib/errors');
        throw badRequest('month must be YYYY-MM.');
      }
      res.json(monthSummary(req.app.locals.db, month));
    }),
  );

  return router;
}

module.exports = { attendanceRoutes };
