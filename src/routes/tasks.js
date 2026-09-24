/** /tasks — list (role-scoped), create, status flow, reassign, detail+events. */
'use strict';

const express = require('express');
const { asyncHandler, page, q } = require('../lib/http');
const { validate, str, optStr, enumOf, isoDate } = require('../lib/validate');
const { notFound, forbidden } = require('../lib/errors');
const {
  listTasks,
  taskDetail,
  createTask,
  changeTaskStatus,
  reassignTask,
  PRIORITIES,
  STATUSES,
} = require('../services/tasks');

function tasksRoutes() {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { limit, offset } = page(req, { defaultLimit: 100, maxLimit: 300 });
      res.json(
        listTasks(req.app.locals.db, req.user, {
          status: q(req, 'status'),
          assigned_to_user_id: q(req, 'assigned_to_user_id'),
          limit,
          offset,
        }),
      );
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        title: str(req.body?.title, 'title', bag, { min: 2, max: 300 }),
        description: optStr(req.body?.description, 'description', bag, { max: 4000 }),
        assigned_to_user_id: str(req.body?.assigned_to_user_id, 'assigned_to_user_id', bag),
        priority: req.body?.priority ? enumOf(req.body.priority, 'priority', bag, PRIORITIES) : 'normal',
        due_date: isoDate(req.body?.due_date, 'due_date', bag),
        school_id: optStr(req.body?.school_id, 'school_id', bag),
        student_id: optStr(req.body?.student_id, 'student_id', bag),
        visit_id: optStr(req.body?.visit_id, 'visit_id', bag),
      }));
      res.status(201).json(createTask(req.app.locals.db, req.user, input, { ip: req.ip }));
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const detail = taskDetail(req.app.locals.db, req.params.id);
      const t = detail.task;
      if (
        req.user.role !== 'main_admin' &&
        t.assigned_to_user_id !== req.user.id &&
        t.created_by_user_id !== req.user.id
      ) {
        throw forbidden('You do not have access to this task.');
      }
      res.json(detail);
    }),
  );

  router.post(
    '/:id/status',
    asyncHandler(async (req, res) => {
      const { status, note } = validate(bag => ({
        status: enumOf(req.body?.status, 'status', bag, STATUSES),
        note: optStr(req.body?.note, 'note', bag, { max: 1000 }),
      }));
      res.json(changeTaskStatus(req.app.locals.db, req.user, req.params.id, status, note, { ip: req.ip }));
    }),
  );

  router.post(
    '/:id/reassign',
    asyncHandler(async (req, res) => {
      const { assigned_to_user_id, note } = validate(bag => ({
        assigned_to_user_id: str(req.body?.assigned_to_user_id, 'assigned_to_user_id', bag),
        note: optStr(req.body?.note, 'note', bag, { max: 1000 }),
      }));
      res.json(
        reassignTask(req.app.locals.db, req.user, req.params.id, assigned_to_user_id, note, { ip: req.ip }),
      );
    }),
  );

  return router;
}

module.exports = { tasksRoutes };
