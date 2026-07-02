'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const createOrderRouter = require('./api/create-order');
const verifyPaymentRouter = require('./api/verify-payment');

const app = express();
const START_TIME = Date.now();

// ── Process-level guards ──────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException', { message: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection', { reason: String(reason) });
});

// ── Request logger ────────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  req._startTime = Date.now();
  req._requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  console.info('[REQ]', {
    requestId: req._requestId,
    method: req.method,
    path: req.path,
    timestamp: new Date().toISOString()
  });
  next();
});

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.options('*', cors());

// ── JSON body parser with error trap ─────────────────────────────────────────
app.use((req, res, next) => {
  express.json({ limit: '10kb' })(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        success: false,
        error: 'Invalid JSON in request body',
        requestId: req._requestId
      });
    }
    next();
  });
});

// ── Health / root ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.status(200).json({
    success: true,
    server: 'ManIdea Payment Backend',
    status: 'ONLINE',
    version: '1.0.0',
    environment: 'Sandbox',
    uptime: `${Math.floor((Date.now() - START_TIME) / 1000)}s`,
    timestamp: new Date().toISOString(),
    health: 'Healthy'
  });
});

// ── API info ──────────────────────────────────────────────────────────────────
app.get('/api', (_req, res) => {
  res.status(200).json({
    success: true,
    status: 'API ONLINE',
    version: '1.0.0',
    createOrder: 'POST /api/create-order',
    verifyPayment: 'POST /api/verify-payment',
    documentation: 'Available'
  });
});

// ── Feature routers ───────────────────────────────────────────────────────────
app.use('/api', createOrderRouter);
app.use('/api', verifyPaymentRouter);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  console.warn('[404]', { requestId: req._requestId, path: req.path });
  res.status(404).json({
    success: false,
    error: 'Route Not Found',
    requestedPath: req.originalUrl
  });
});

// ── Global error middleware ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const elapsed = req._startTime ? Date.now() - req._startTime : 0;
  console.error('[ERROR]', {
    requestId: req._requestId,
    path: req.path,
    message: err.message,
    elapsed: `${elapsed}ms`
  });
  res.status(err.status || 500).json({
    success: false,
    error: err.expose ? err.message : 'Internal Server Error',
    requestId: req._requestId
  });
});

// ── Local dev server (not used on Vercel) ─────────────────────────────────────
if (process.env.VERCEL !== '1') {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => console.info(`[SERVER] Listening on port ${PORT}`));
}

module.exports = app;
