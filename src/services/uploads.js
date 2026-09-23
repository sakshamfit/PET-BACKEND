/**
 * Uploads — base64-in-JSON (the frontend sends `dataBase64` through the
 * normal JSON pipeline, no multipart anywhere), files on disk under
 * PET_FILES_DIR, served back through an authenticated /files route.
 *
 * Path safety: `relative_path` is generated here (never client-supplied
 * beyond the category), and `resolveExisting` rejects anything that leaves
 * the files root (`..`, absolute paths, symlink escapes).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ApiError, badRequest, notFound } = require('../lib/errors');
const { uuid, now } = require('../lib/ids');
const { tx } = require('../db');
const { toMedia, toDocument } = require('./serialize');

const CATEGORIES = ['students', 'schools', 'field-visits', 'documents'];

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'text/plain': 'txt',
};

const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime]));

function assertCategory(category) {
  if (!CATEGORIES.includes(category)) {
    throw badRequest(`Unknown upload category '${category}'.`);
  }
  return category;
}

function decodeBase64(dataBase64) {
  const raw = String(dataBase64 || '');
  const cleaned = raw.includes(',') && raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  if (!/^[A-Za-z0-9+/=\r\n]*$/.test(cleaned)) {
    throw badRequest('Upload data is not valid base64.');
  }
  const buf = Buffer.from(cleaned, 'base64');
  if (!buf.length) throw badRequest('Upload is empty.');
  return buf;
}

/**
 * Write a decoded buffer under the category folder.
 * @returns {relative_path, size}
 */
function saveBuffer(config, category, buffer, mimeType) {
  assertCategory(category);
  const max = config.maxUploadBytes;
  if (buffer.length > max) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Files must be under ${Math.floor(max / 1024 / 1024)} MB.`);
  }
  const ext = MIME_EXT[mimeType];
  if (!ext) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA', `Unsupported file type '${mimeType}'.`);
  }
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const rel = path.posix.join(category, String(d.getUTCFullYear()), p(d.getUTCMonth() + 1), `${uuid()}.${ext}`);
  const abs = path.join(config.filesDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return { relative_path: rel, size: buffer.length };
}

function saveBase64(config, { category, fileName, mimeType, dataBase64 }) {
  const mime = mimeType || 'application/octet-stream';
  const buffer = decodeBase64(dataBase64);
  return saveBuffer(config, category, buffer, mime);
}

/** Resolve a stored relative_path to disk, refusing anything outside. */
function resolveExisting(config, relativePath) {
  const rel = String(relativePath || '');
  if (!rel || rel.includes('\0')) throw badRequest('Invalid file path.');
  const root = path.resolve(config.filesDir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw badRequest('Invalid file path.');
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw notFound('File not found.');
  return abs;
}

function contentTypeFor(absPath) {
  const ext = path.extname(absPath).slice(1).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

/** Directories are restricted to ones the API actually writes into. */
function ensureRegisteredPath(config, relativePath) {
  const rel = String(relativePath || '');
  const [head] = rel.split('/');
  if (!CATEGORIES.includes(head)) throw badRequest('Unknown file category in path.');
  resolveExisting(config, rel); // throws 404 when the bytes were never uploaded
  return rel;
}

function registerFieldMedia(db, user, input) {
  return tx(db, () => {
    if (input.relative_path) ensureRegisteredPathForWrite(configFromDb(db), input.relative_path);
    if (input.visit_id) {
      const v = db.prepare('SELECT id FROM field_visits WHERE id = ?').get(input.visit_id);
      if (!v) throw badRequest('Visit not found.');
    }
    if (input.school_id) {
      const s = db.prepare('SELECT id FROM schools WHERE id = ?').get(input.school_id);
      if (!s) throw badRequest('School not found.');
    }
    const id = uuid();
    db.prepare(
      `INSERT INTO field_media (id, visit_id, school_id, uploaded_by_user_id, uploaded_by_user_name,
                                type, relative_path, original_name, caption, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.visit_id ?? null,
      input.school_id ?? null,
      user.id,
      user.name,
      input.type || 'photo',
      input.relative_path ?? null,
      input.original_name ?? null,
      input.caption ?? null,
      input.relative_path ? 'ready' : 'pending_upload',
      now(),
    );
    if (input.visit_id) {
      db.prepare('UPDATE field_visits SET updated_at = ? WHERE id = ?').run(now(), input.visit_id);
    }
    return { media: toMedia(db.prepare('SELECT * FROM field_media WHERE id = ?').get(id)) };
  });
}

function registerStudentDocument(db, user, input) {
  return tx(db, () => {
    if (input.relative_path) ensureRegisteredPathForWrite(configFromDb(db), input.relative_path);
    const student = db.prepare('SELECT id FROM students WHERE id = ?').get(String(input.student_id || ''));
    if (!student) throw badRequest('Student not found.');
    const id = uuid();
    db.prepare(
      `INSERT INTO student_documents (id, student_id, uploaded_by_user_id, uploaded_by_user_name,
                                      type, relative_path, original_name, caption, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      student.id,
      user.id,
      user.name,
      input.type || 'document',
      input.relative_path ?? null,
      input.original_name ?? null,
      input.caption ?? null,
      input.relative_path ? 'ready' : 'pending_upload',
      now(),
    );
    return { document: toDocument(db.prepare('SELECT * FROM student_documents WHERE id = ?').get(id)) };
  });
}

/**
 * The media routers receive only `relative_path`, not a config — the app
 * attaches `app.locals.config`, and services get it through this tiny
 * indirection set by routes/uploads.js at boot.
 */
let ACTIVE_CONFIG = null;
function setUploadConfig(config) {
  ACTIVE_CONFIG = config;
}
function configFromDb() {
  if (!ACTIVE_CONFIG) throw badRequest('Upload storage is not configured.');
  return ACTIVE_CONFIG;
}
function ensureRegisteredPathForWrite(config, relativePath) {
  const rel = String(relativePath || '');
  const [head] = rel.split('/');
  if (!CATEGORIES.includes(head)) throw badRequest('Unknown file category in path.');
  resolveExisting(config, rel);
  return rel;
}

module.exports = {
  CATEGORIES,
  MIME_EXT,
  saveBase64,
  saveBuffer,
  resolveExisting,
  contentTypeFor,
  registerFieldMedia,
  registerStudentDocument,
  setUploadConfig,
};
