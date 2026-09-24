/** POST /sync — offline queue replay with per-key idempotency. */
'use strict';

const express = require('express');
const { asyncHandler } = require('../lib/http');
const { badRequest } = require('../lib/errors');
const { pushOperations, OPERATION_TYPES } = require('../services/sync');

function syncRoutes() {
  const router = express.Router();

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const operations = req.body?.operations;
      if (!Array.isArray(operations)) throw badRequest('`operations` must be an array.');
      if (operations.length > 200) throw badRequest('Push at most 200 operations per batch.');
      for (const op of operations) {
        if (!op || typeof op !== 'object') throw badRequest('Each operation must be an object.');
        // Missing key = malformed queue entry (the client always generates
        // one) → reject the batch. Unknown *types* are per-entry errors so a
        // single bad item never blocks the rest of the queue.
        if (!op.idempotency_key) throw badRequest('Each operation needs an idempotency_key.');
      }
      res.json(pushOperations(req.app.locals.db, req.user, operations, { ip: req.ip }));
    }),
  );

  return router;
}

module.exports = { syncRoutes };
