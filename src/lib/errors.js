/**
 * API errors — the wire shape is fixed by the frontend:
 *   { "error": { "code": "...", "message": "...", "details"?: {...} } }
 * `code` is what the client branches on (POSSIBLE_DUPLICATES, UNAUTHORIZED…).
 */
'use strict';

class ApiError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code machine-readable code
   * @param {string} message human message (shown verbatim in the UI)
   * @param {object} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    const error = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

const badRequest = (message, details) => new ApiError(400, 'VALIDATION_ERROR', message, details);
const unauthorized = (message = 'Authentication required.') =>
  new ApiError(401, 'UNAUTHORIZED', message);
const forbidden = (message = 'You do not have permission to do that.') =>
  new ApiError(403, 'FORBIDDEN', message);
const notFound = (message = 'Not found.') => new ApiError(404, 'NOT_FOUND', message);
const conflict = (code, message, details) => new ApiError(409, code, message, details);
const rateLimited = (message = 'Too many attempts. Try again in a minute.') =>
  new ApiError(429, 'RATE_LIMITED', message);
const internal = (message = 'Something went wrong on the server.') =>
  new ApiError(500, 'INTERNAL', message);

module.exports = {
  ApiError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  rateLimited,
  internal,
};
