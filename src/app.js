/**
 * Express application factory.
 *
 * Layout (top → bottom):
 *   /health            — l.origin root, unauthenticated (the connect screen
 *                        probes this exactly — see petApiBase.healthUrlFor)
 *   /api               — JSON body parser → resource routers → API 404
 *   /build-info.json   — build descriptor for the update banner
 *   /                  — optional built SPA (`public/app`), single-page fallback
 *   errorHandler       — wire-format failures: {error:{code,message,details}}
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { cors } = require('./middleware/cors');
const { errorHandler, apiNotFound } = require('./middleware/error');
const { createApiRouter } = require('./routes/index');
const { setUploadConfig } = require('./services/uploads');
const pkg = require('../package.json');

function createApp({ config, db }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  app.locals.config = config;
  app.locals.db = db;
  setUploadConfig(config);

  // CORS covers /health too — the static (Vercel) build probes it cross-origin.
  app.use(cors(config.corsOrigins));

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'pet-backend',
      version: pkg.version,
      driver: db.driver || 'unknown',
      uptime_seconds: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
  });

  // Base64 uploads ride the JSON pipeline; 30 MB covers a 15 MB file b64-encoded.
  app.use('/api', express.json({ limit: '30mb' }));
  app.use('/api', createApiRouter(config));
  app.use('/api', apiNotFound);

  // Build descriptor for the frontend's update banner.
  app.get('/build-info.json', (req, res) => {
    const candidates = [
      path.join(config.spaDir, 'build-info.json'),
      path.join(config.rootDir, 'public', 'build-info.json'),
    ];
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        res.type('json').send(fs.readFileSync(file, 'utf8'));
        return;
      }
    }
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No build descriptor deployed.' } });
  });

  // Optional: serve the built SPA when present (office-server deployment).
  if (fs.existsSync(config.spaDir)) {
    app.use(
      express.static(config.spaDir, {
        index: false,
        maxAge: '1h',
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.get('*', (req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path === '/health') return next();
      res.sendFile(path.join(config.spaDir, 'index.html'), err => {
        if (err) next();
      });
    });
  }

  app.use(errorHandler(config));
  return app;
}

module.exports = { createApp };
