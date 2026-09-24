/**
 * /uploads · /media/* · /files/*
 *
 * Upload flow (the frontend never uses multipart):
 *   1. POST /uploads  {category, fileName, mimeType, dataBase64}
 *        → {relative_path, size}          (bytes land on disk)
 *   2. POST /media/field|student {relative_path, …}
 *        → the DB row that points at those bytes
 *   3. GET  /files/<relative_path>        (authenticated; <img src> via blob)
 */
'use strict';

const fs = require('fs');
const express = require('express');
const { asyncHandler } = require('../lib/http');
const { validate, str, optStr, enumOf } = require('../lib/validate');
const { badRequest } = require('../lib/errors');
const {
  CATEGORIES,
  saveBase64,
  resolveExisting,
  contentTypeFor,
  registerFieldMedia,
  registerStudentDocument,
} = require('../services/uploads');

function uploadsRoutes(config) {
  const router = express.Router();

  router.post(
    '/uploads',
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        category: enumOf(req.body?.category, 'category', bag, CATEGORIES),
        fileName: str(req.body?.fileName, 'fileName', bag, { max: 255 }),
        mimeType: str(req.body?.mimeType, 'mimeType', bag, { max: 120 }),
        dataBase64: str(req.body?.dataBase64, 'dataBase64', bag, { max: 40_000_000, trim: false }),
      }));
      const saved = saveBase64(config, input);
      res.status(201).json(saved);
    }),
  );

  router.post(
    '/media/field',
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        visit_id: optStr(req.body?.visit_id, 'visit_id', bag),
        school_id: optStr(req.body?.school_id, 'school_id', bag),
        type: req.body?.type !== undefined ? enumOf(req.body.type, 'type', bag, ['photo', 'document', 'video']) : 'photo',
        relative_path: optStr(req.body?.relative_path, 'relative_path', bag, { max: 500 }),
        original_name: optStr(req.body?.original_name, 'original_name', bag, { max: 255 }),
        caption: optStr(req.body?.caption, 'caption', bag, { max: 1000 }),
      }));
      res.status(201).json(registerFieldMedia(req.app.locals.db, req.user, input));
    }),
  );

  router.post(
    '/media/student',
    asyncHandler(async (req, res) => {
      const input = validate(bag => ({
        student_id: str(req.body?.student_id, 'student_id', bag),
        type: req.body?.type !== undefined ? enumOf(req.body.type, 'type', bag, ['photo', 'document', 'other']) : 'document',
        relative_path: optStr(req.body?.relative_path, 'relative_path', bag, { max: 500 }),
        original_name: optStr(req.body?.original_name, 'original_name', bag, { max: 255 }),
        caption: optStr(req.body?.caption, 'caption', bag, { max: 1000 }),
      }));
      res.status(201).json(registerStudentDocument(req.app.locals.db, req.user, input));
    }),
  );

  // Wildcard file serving — path is resolved inside the files root only.
  router.get(
    '/files/*',
    asyncHandler(async (req, res) => {
      const rel = req.params[0] || '';
      if (!rel) throw badRequest('Invalid file path.');
      const abs = resolveExisting(config, rel);
      res.setHeader('Content-Type', contentTypeFor(abs));
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Length', String(fs.statSync(abs).size));
      fs.createReadStream(abs).pipe(res);
    }),
  );

  return router;
}

module.exports = { uploadsRoutes };
