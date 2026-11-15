// server.js — سيرفر مزامنة DC Quality Reports (مُحصَّن)
'use strict';

const express = require('express');
const crypto  = require('crypto');
const helmet  = require('helmet');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const PORT         = process.env.PORT || 3000;
const SYNC_TOKEN   = process.env.SYNC_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!SYNC_TOKEN || SYNC_TOKEN.length < 24) {
  console.error('FATAL: SYNC_TOKEN must be set and at least 24 chars');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /sslmode=require|render\.com|amazonaws/.test(DATABASE_URL)
    ? { rejectUnauthorized: false } : false,
  max: 10, idleTimeoutMillis: 30_000,
});

function safeEq(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

// CORS: إذا لم تُضبط ALLOWED_ORIGINS نسمح بنفس النطاق فقط
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (!ALLOWED_ORIGINS.length) return cb(null, false);
    return cb(null, ALLOWED_ORIGINS.includes(origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Sync-Token', 'If-Match'],
  exposedHeaders: ['ETag'],
  maxAge: 600,
}));

app.use(express.json({ limit: '12mb' }));

app.use('/api/', rateLimit({
  windowMs: 60_000, max: 240,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests' },
}));

function auth(req, res, next) {
  if (!safeEq(req.get('X-Sync-Token') || '', SYNC_TOKEN)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      state      JSONB   NOT NULL DEFAULT '{}'::jsonb,
      rev        BIGINT  NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(
    `INSERT INTO sync_state (id, state, rev) VALUES (1, '{}'::jsonb, 0)
     ON CONFLICT (id) DO NOTHING`);
}

app.get('/healthz', (req, res) => res.json({ ok: true, rev: undefined }));

app.get('/api/state', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT state, rev FROM sync_state WHERE id=1');
    const row = rows[0] || { state: {}, rev: 0 };
    res.set('ETag', `"${row.rev}"`);
    res.json({ state: row.state, rev: String(row.rev) });
  } catch (e) {
    console.error('GET /api/state', e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/api/sync', auth, async (req, res) => {
  const incoming = req.body && req.body.state;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'bad_state' });
  }
  // إذا كانت الحالة كبيرة جدًا ارفض بوضوح
  const size = JSON.stringify(incoming).length;
  if (size > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'state_too_large', size });
  }

  const ifMatch = req.get('If-Match');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT state, rev FROM sync_state WHERE id=1 FOR UPDATE');
    const cur = rows[0] || { state: {}, rev: 0 };
    const curRev = String(cur.rev);

    // كشف تعارض
    if (ifMatch && ifMatch.replace(/"/g, '') !== curRev) {
      await client.query('ROLLBACK');
      res.set('ETag', `"${curRev}"`);
      return res.status(409).json({ state: cur.state, rev: curRev });
    }

    const newRev = String(BigInt(curRev) + 1n);
    await client.query(
      `UPDATE sync_state SET state=$1::jsonb, rev=$2, updated_at=now() WHERE id=1`,
      [JSON.stringify(incoming), newRev]);
    await client.query('COMMIT');
    res.set('ETag', `"${newRev}"`);
    res.json({ state: incoming, rev: newRev });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /api/sync', e);
    res.status(500).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// error handler
app.use((err, req, res, next) => {
  console.error('unhandled', err);
  res.status(500).json({ error: 'internal' });
});

(async () => {
  try {
    await ensureTable();
    app.listen(PORT, () => console.log(`[fg] listening on ${PORT}`));
  } catch (e) {
    console.error('startup failed', e);
    process.exit(1);
  }
})();
