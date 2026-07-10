'use strict';

// dotenv only needed locally — Vercel injects env vars natively
if (!process.env.VERCEL) require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { randomBytes } = require('crypto');

const createOrderRouter   = require('./api/create-order');
const verifyPaymentRouter = require('./api/verify-payment');

const app        = express();
const START_TIME = Date.now();
const VERSION    = '1.0.0';

process.on('uncaughtException',  (err)    => console.error('[FATAL] uncaughtException',  err.message, err.stack));
process.on('unhandledRejection', (reason) => console.error('[FATAL] unhandledRejection', String(reason)));

// ── Request ID + timing ───────────────────────────────────────────────────────
app.use((req, _res, next) => {
  req.requestId = `rid_${randomBytes(6).toString('hex')}`;
  req.startTime = Date.now();
  console.info(`[REQ] ${req.requestId} ${req.method} ${req.path}`);
  next();
});

// ── CORS ──────────────────────────────────────────────────────────────────────
const corsMiddleware = cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] });
app.use(corsMiddleware);
app.options('*', corsMiddleware);

// ── JSON body parser (compiled once, reused on every request) ─────────────────
const jsonParser = express.json({ limit: '10kb' });
app.use((req, res, next) => {
  jsonParser(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, error: 'Request body contains invalid JSON.', requestId: req.requestId });
    next();
  });
});

// ── Health check ──────────────────────────────────────────────────────────────
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

// ── Feature routers ───────────────────────────────────────────────────────────
app.use('/api', createOrderRouter);
app.use('/api', verifyPaymentRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  console.warn(`[404] ${req.requestId} ${req.originalUrl}`);
  res.status(404).json({ success: false, error: 'Route not found.', requestedPath: req.originalUrl, requestId: req.requestId });
});

// ── Global error handler ──────────────────────────────────────────────────────
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

// ── Local dev server ──────────────────────────────────────────────────────────
if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => console.info(`[SERVER] Running on http://localhost:${PORT}`));
}

module.exports = app;
