/**
 * Error boundary — converts anything thrown inside a route into the wire
 * shape the frontend parses in petApi.ts:
 *   { error: { code, message, details? } }
 * The last line of defence never leaks stack traces to clients; details go
 * to the server log instead.
 */
'use strict';

const { ApiError } = require('../lib/errors');

function errorHandler(config) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return;

    let apiErr;
    if (err instanceof ApiError) {
      apiErr = err;
    } else if (err && err.type === 'entity.too.large') {
      apiErr = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'That upload is too large.');
    } else if (err && err.type === 'entity.parse.failed') {
      apiErr = new ApiError(400, 'VALIDATION_ERROR', 'Request body is not valid JSON.');
    } else if (err && err.type === 'encoding.unsupported') {
      apiErr = new ApiError(400, 'VALIDATION_ERROR', 'Unsupported encoding.');
    } else if (err && err.code === 'LIMIT_FILE_SIZE') {
      apiErr = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'That upload is too large.');
    } else {
      // SQLite constraint violations: map the common ones to useful words.
      const msg = String(err && err.message);
      if (msg.includes('UNIQUE constraint failed')) {
        apiErr = new ApiError(409, 'CONFLICT', 'That record already exists.');
      } else if (msg.includes('FOREIGN KEY constraint failed')) {
        apiErr = new ApiError(409, 'CONFLICT', 'A linked record is missing.');
      } else {
        apiErr = new ApiError(500, 'INTERNAL', 'Something went wrong on the server.');
      }
    }

    if (apiErr.status >= 500) {
      console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    } else if (config && config.env === 'development') {
      console.warn(`[warn] ${req.method} ${req.originalUrl} → ${apiErr.code}: ${apiErr.message}`);
    }

    res.status(apiErr.status).json(apiErr.toJSON());
  };
}

/** Unknown 404 for API paths (so the SPA fallback never swallows /api/*). */
function apiNotFound(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No API route for ${req.method} ${req.path}.` },
  });
}

module.exports = { errorHandler, apiNotFound };
