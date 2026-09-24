/** /conversations — chat list, threads, sending, unread counts. */
'use strict';

const express = require('express');
const { asyncHandler, page } = require('../lib/http');
const { validate, str, optStr } = require('../lib/validate');
const {
  listConversations,
  unreadCount,
  openDirect,
  createGroup,
  listMessages,
  sendMessage,
} = require('../services/chat');

function conversationsRoutes() {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json(listConversations(req.app.locals.db, req.user.id));
    }),
  );

  router.get(
    '/unread-count',
    asyncHandler(async (req, res) => {
      res.json(unreadCount(req.app.locals.db, req.user.id));
    }),
  );

  router.post(
    '/direct',
    asyncHandler(async (req, res) => {
      const { user_id } = validate(bag => ({ user_id: str(req.body?.user_id, 'user_id', bag) }));
      res.status(201).json(openDirect(req.app.locals.db, req.user, user_id));
    }),
  );

  router.post(
    '/group',
    asyncHandler(async (req, res) => {
      const { title, member_ids } = validate(bag => ({
        title: str(req.body?.title, 'title', bag, { min: 1, max: 160 }),
        member_ids: Array.isArray(req.body?.member_ids) ? req.body.member_ids : [],
      }));
      res.status(201).json(createGroup(req.app.locals.db, req.user, title, member_ids));
    }),
  );

  router.get(
    '/:id/messages',
    asyncHandler(async (req, res) => {
      const { limit } = page(req, { defaultLimit: 100, maxLimit: 300 });
      const before = req.query.before ? String(req.query.before) : null;
      res.json(listMessages(req.app.locals.db, req.user, req.params.id, { limit, before }));
    }),
  );

  router.post(
    '/:id/messages',
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        text: str(req.body?.text, 'text', bag, { max: 8000 }) || '',
        attachment_paths: Array.isArray(req.body?.attachment_paths)
          ? req.body.attachment_paths.map(String)
          : null,
        linked_task_id: optStr(req.body?.linked_task_id, 'linked_task_id', bag),
        linked_student_id: optStr(req.body?.linked_student_id, 'linked_student_id', bag),
        linked_school_id: optStr(req.body?.linked_school_id, 'linked_school_id', bag),
        linked_visit_id: optStr(req.body?.linked_visit_id, 'linked_visit_id', bag),
      }));
      res.status(201).json(sendMessage(req.app.locals.db, req.user, req.params.id, input));
    }),
  );

  return router;
}

module.exports = { conversationsRoutes };
