/**
 * API mount point — everything under /api.
 *
 * Order matters: /auth is public, then `authenticate` guards the rest, then
 * each resource router. Nothing outside this file decides which paths are
 * protected — one place, one audit trail.
 */
'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { authRoutes } = require('./auth');
const { meRoutes } = require('./me');
const { employeesRoutes } = require('./employees');
const { studentsRoutes } = require('./students');
const { schoolsRoutes } = require('./schools');
const { fieldVisitsRoutes } = require('./fieldVisits');
const { tasksRoutes } = require('./tasks');
const { conversationsRoutes } = require('./conversations');
const { attendanceRoutes } = require('./attendance');
const { testsRoutes } = require('./tests');
const { enrollmentsRoutes } = require('./enrollments');
const { websiteFormsRoutes } = require('./websiteForms');
const { uploadsRoutes } = require('./uploads');
const { syncRoutes } = require('./sync');
const { reportsRoutes } = require('./reports');

function createApiRouter(config) {
  const router = express.Router();

  // Public: login / refresh / logout (change-password requires a token and
  // checks it itself so a nearly-expired access token can still be used).
  router.use('/auth', authRoutes(config));

  router.use(authenticate(config));

  router.use('/me', meRoutes(config));
  router.use('/employees', employeesRoutes());
  router.use('/students', studentsRoutes(config));
  router.use('/schools', schoolsRoutes());
  router.use('/field-visits', fieldVisitsRoutes());
  router.use('/tasks', tasksRoutes());
  router.use('/conversations', conversationsRoutes());
  router.use('/attendance', attendanceRoutes());
  router.use('/tests', testsRoutes());
  router.use('/enrollments', enrollmentsRoutes());
  router.use('/website-forms', websiteFormsRoutes());
  router.use('/', uploadsRoutes(config));
  router.use('/sync', syncRoutes());
  router.use('/', reportsRoutes());

  return router;
}

module.exports = { createApiRouter };
