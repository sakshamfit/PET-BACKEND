/** /schools — directory CRUD + archive + profile. */
'use strict';

const express = require('express');
const { asyncHandler, page, q } = require('../lib/http');
const { validate, str, optStr, num, phone: vPhone } = require('../lib/validate');
const {
  listSchools,
  getSchool,
  schoolProfile,
  createSchool,
  updateSchool,
  archiveSchool,
} = require('../services/schools');

function schoolFields(body, bag, { partial = false } = {}) {
  const opt = (fn, key, ...rest) => (partial && body?.[key] === undefined ? undefined : fn(body?.[key], key, bag, ...rest));
  return {
    name: partial ? (body?.name !== undefined ? str(body.name, 'name', bag, { min: 2, max: 200 }) : undefined) : str(body?.name, 'name', bag, { min: 2, max: 200 }),
    address: opt(optStr, 'address', { max: 400 }),
    locality: opt(optStr, 'locality', { max: 160 }),
    city: opt(optStr, 'city', { max: 120 }),
    district: opt(optStr, 'district', { max: 120 }),
    state: opt(optStr, 'state', { max: 120 }),
    phone: opt(vPhone, 'phone'),
    contact_person_name: opt(optStr, 'contact_person_name', { max: 160 }),
    contact_person_phone: opt(vPhone, 'contact_person_phone'),
    latitude: opt(num, 'latitude', { min: -90, max: 90 }),
    longitude: opt(num, 'longitude', { min: -180, max: 180 }),
    notes: opt(optStr, 'notes', { max: 4000 }),
  };
}

function schoolsRoutes() {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { limit, offset } = page(req, { defaultLimit: 50, maxLimit: 200 });
      res.json(listSchools(req.app.locals.db, { q: q(req, 'q'), status: q(req, 'status'), limit, offset }));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = validate(bag => schoolFields(req.body, bag));
      res.status(201).json(createSchool(req.app.locals.db, req.user, input, { ip: req.ip }));
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      res.json({ school: getSchool(req.app.locals.db, req.params.id) });
    }),
  );

  router.get(
    '/:id/profile',
    asyncHandler(async (req, res) => {
      res.json(schoolProfile(req.app.locals.db, req.params.id));
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const input = validate(bag => schoolFields(req.body, bag, { partial: true }));
      res.json(updateSchool(req.app.locals.db, req.user, req.params.id, input, { ip: req.ip }));
    }),
  );

  router.post(
    '/:id/archive',
    asyncHandler(async (req, res) => {
      res.json(archiveSchool(req.app.locals.db, req.user, req.params.id, { ip: req.ip }));
    }),
  );

  return router;
}

module.exports = { schoolsRoutes };
