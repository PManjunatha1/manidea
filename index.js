'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const createOrderRouter   = require('./api/create-order');
const verifyPaymentRouter = require('./api/verify-payment');

const app        = express();
const START_TIME = Date.now();
const VERSION    = '1.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS-LEVEL SAFETY NETS
// Catches anything that escapes all other handlers.
// Logs the error but keeps the process alive on Vercel serverless.
// ─────────────────────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection', String(reason));
});

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST LOGGER
// Stamps every request with a unique ID and start time.
// Used by all downstream handlers for tracing.
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  req.requestId  = `rid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  req.startTime  = Date.now();
  console.info(`[REQ] ${req.requestId} ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// CORS
// Allows all origins. Tighten origin list when you go to production.
// ─────────────────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.options('*', cors());

// ─────────────────────────────────────────────────────────────────────────────
// JSON BODY PARSER
// Wrapped manually so a malformed JSON body returns 400 JSON,
// never an Express HTML error page.
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  express.json({ limit: '10kb' })(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        success:   false,
        error:     'Request body contains invalid JSON.',
        requestId: req.requestId
      });
    }
    next();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /
// Permanent health-check. Shape never changes.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.status(200).json({
    success:     true,
    server:      'ManIdea Payment Backend',
    status:      'ONLINE',
    version:     VERSION,
    environment: process.env.CASHFREE_ENV === 'PRODUCTION' ? 'Production' : 'Sandbox',
    uptime:      `${Math.floor((Date.now() - START_TIME) / 1000)}s`,
    timestamp:   new Date().toISOString(),
    health:      'Healthy'
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api
// Permanent API index. Shape never changes.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api', (_req, res) => {
  res.status(200).json({
    success:       true,
    status:        'API ONLINE',
    version:       VERSION,
    createOrder:   'POST /api/create-order',
    verifyPayment: 'POST /api/verify-payment',
    documentation: 'Available'
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE ROUTERS
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api', createOrderRouter);
app.use('/api', verifyPaymentRouter);

// ─────────────────────────────────────────────────────────────────────────────
// 404 HANDLER
// Every unknown route returns JSON. "Cannot GET /x" never appears.
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  console.warn(`[404] ${req.requestId} ${req.originalUrl}`);
  res.status(404).json({
    success:       false,
    error:         'Route not found.',
    requestedPath: req.originalUrl,
    requestId:     req.requestId
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL ERROR HANDLER
// Catches every error passed via next(err) from any route.
// Never exposes stack traces. Never returns HTML.
// The 4-argument signature is required by Express to treat this as an
// error handler — do not remove _next.
// ─────────────────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const elapsed = req.startTime ? `${Date.now() - req.startTime}ms` : 'n/a';
  console.error(`[ERROR] ${req.requestId} ${err.message} (${elapsed})`);
  res.status(err.status || 500).json({
    success:   false,
    error:     err.expose ? err.message : 'Internal server error.',
    requestId: req.requestId
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL DEV SERVER
// Only starts when running locally. Vercel ignores this block entirely.
// ─────────────────────────────────────────────────────────────────────────────
if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => console.info(`[SERVER] Running on http://localhost:${PORT}`));
}

// Vercel requires the app to be exported as the default export.
module.exports = app;
