/** /employees — Main Admin team management. One-time passwords surface once. */
'use strict';

const express = require('express');
const { asyncHandler } = require('../lib/http');
const { validate, str, email: vEmail, phone: vPhone, isoDate, enumOf } = require('../lib/validate');
const { requireAdmin } = require('../middleware/auth');
const {
  listEmployees,
  createEmployee,
  updateEmployee,
  setEmployeeStatus,
  resetEmployeeAccess,
} = require('../services/employees');
const { page, q } = require('../lib/http');

function employeesRoutes() {
  const router = express.Router();
  router.use(requireAdmin);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { limit, offset } = page(req, { defaultLimit: 50, maxLimit: 500 });
      res.json(listEmployees(req.app.locals.db, { q: q(req, 'q'), status: q(req, 'status'), limit, offset }));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        name: str(req.body?.name, 'name', bag, { min: 2, max: 120 }),
        email: vEmail(req.body?.email, 'email', bag),
        phone: vPhone(req.body?.phone, 'phone', bag),
        department: str(req.body?.department, 'department', bag, { max: 120 }) ?? null,
        joining_date: isoDate(req.body?.joining_date, 'joining_date', bag),
      }));
      const result = createEmployee(req.app.locals.db, req.user, input, { ip: req.ip });
      res.status(201).json({
        user: result.user,
        temporaryPassword: result.temporaryPassword || result.__temp,
      });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        name: req.body?.name !== undefined ? str(req.body.name, 'name', bag, { min: 2, max: 120 }) : undefined,
        email: req.body?.email !== undefined ? vEmail(req.body.email, 'email', bag) : undefined,
        phone: req.body?.phone !== undefined ? vPhone(req.body.phone, 'phone', bag) : undefined,
        department:
          req.body?.department !== undefined
            ? req.body.department === null || req.body.department === ''
              ? null
              : str(req.body.department, 'department', bag, { max: 120 })
            : undefined,
      }));
      res.json(updateEmployee(req.app.locals.db, req.user, req.params.id, input, { ip: req.ip }));
    }),
  );

  router.post(
    '/:id/status',
    asyncHandler(async (req, res) => {
      const status = validate(bag => enumOf(req.body?.status, 'status', bag, ['ACTIVE', 'DISABLED']));
      res.json(setEmployeeStatus(req.app.locals.db, req.user, req.params.id, status, { ip: req.ip }));
    }),
  );

  router.post(
    '/:id/reset-access',
    asyncHandler(async (req, res) => {
      res.json(resetEmployeeAccess(req.app.locals.db, req.user, req.params.id, { ip: req.ip }));
    }),
  );

  return router;
}

module.exports = { employeesRoutes };
