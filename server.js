'use strict';

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const SYNC_TOKEN = process.env.SYNC_TOKEN;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || 'https://saadsalama255-oss.github.io').split(',').map(x => x.trim()).filter(Boolean);

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable.');
  process.exit(1);
}
if (!SYNC_TOKEN || SYNC_TOKEN.length < 24) {
  console.error('Set SYNC_TOKEN to a random secret of at least 24 characters.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (CORS_ORIGIN.includes('*') || CORS_ORIGIN.includes(origin) ||
      (origin === 'https://saadsalama255-oss.github.io' && CORS_ORIGIN.includes('https://saadsalama255-oss.github.io')))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '5mb', strict: true }));

function requireToken(req, res, next) {
  const supplied = req.get('X-Sync-Token') || '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(SYNC_TOKEN);
  const crypto = require('crypto');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const COLLECTIONS = [
  'temps', 'ncr', 'returns', 'complaints', 'flow', 'batches', 'ops',
  'veh', 'capa', 'recall', 'prods', 'rcv', 'mvs', 'lt', 'audit'
];

function mergeState(remote, incoming) {
  const oldState = remote && typeof remote === 'object' ? remote : {};
  const newState = incoming && typeof incoming === 'object' ? incoming : {};
  const out = { ...oldState, ...newState };
  const deleted = {};
  for (const [bucket, ids] of Object.entries(oldState._deleted || {})) deleted[bucket] = { ...(ids || {}) };
  for (const [bucket, ids] of Object.entries(newState._deleted || {})) deleted[bucket] = { ...(deleted[bucket] || {}), ...(ids || {}) };
  out._deleted = deleted;

  for (const key of COLLECTIONS) {
    const oldRows = Array.isArray(oldState[key]) ? oldState[key] : [];
    const newRows = Array.isArray(newState[key]) ? newState[key] : [];
    const byId = new Map();

    for (const row of [...oldRows, ...newRows]) {
      if (!row || row.id == null) continue;
      const id = String(row.id);
      const tombstone = deleted[key] && deleted[key][id];
      const stamp = String(row._updatedAt || row.cr || '');
      if (tombstone && String(tombstone) >= stamp) continue;
      const prior = byId.get(id);
      const priorStamp = prior ? String(prior._updatedAt || prior.cr || '') : '';
      if (!prior || stamp >= priorStamp) byId.set(id, row);
    }
    out[key] = [...byId.values()];
  }

  // User records are identified by username, not a generated record id.
  const users = new Map();
  for (const user of [...(oldState.users || []), ...(newState.users || [])]) {
    if (!user || !user.u) continue;
    const prior = users.get(String(user.u));
    if (!prior || String(user._updatedAt || '') >= String(prior._updatedAt || '')) {
      users.set(String(user.u), user);
    }
  }
  if (oldState.users || newState.users) out.users = [...users.values()];

  // Keep the newest settings snapshot. Client edits should stamp _settingsUpdatedAt.
  if (oldState.set || newState.set) {
    out.set = String(newState._settingsUpdatedAt || '') >= String(oldState._settingsUpdatedAt || '')
      ? (newState.set || oldState.set)
      : (oldState.set || newState.set);
  }
  out._updatedAt = new Date().toISOString();
  return out;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS frozenguard_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    INSERT INTO frozenguard_state (id, state)
    VALUES (1, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'FrozenGuard API', time: new Date().toISOString() });
});

app.get('/api/state', requireToken, async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT state, updated_at FROM frozenguard_state WHERE id = 1');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ state: rows[0]?.state || {}, updatedAt: rows[0]?.updated_at || null });
  } catch (err) {
    next(err);
  }
});

app.post('/api/sync', requireToken, async (req, res, next) => {
  const incoming = req.body && req.body.state;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Expected JSON body: { "state": { ... } }' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent syncs so two devices cannot overwrite each other's changes.
    await client.query('SELECT pg_advisory_xact_lock(724190251)');
    const result = await client.query('SELECT state FROM frozenguard_state WHERE id = 1 FOR UPDATE');
    const merged = mergeState(result.rows[0]?.state || {}, incoming);
    await client.query(
      `INSERT INTO frozenguard_state (id, state, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [JSON.stringify(merged)]
    );
    await client.query('COMMIT');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, state: merged, updatedAt: new Date().toISOString() });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Serve the front-end from this service too, if index.html is included in the repository.
app.use(express.static(path.join(__dirname), {
  index: 'index.html',
  dotfiles: 'ignore',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  const status = err instanceof SyntaxError && 'body' in err ? 400 : 500;
  res.status(status).json({ error: status === 400 ? 'Invalid JSON' : 'Server error' });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`FrozenGuard server listening on ${PORT}`)))
  .catch(err => {
    console.error('Failed to initialize PostgreSQL:', err);
    process.exit(1);
  });

process.on('SIGTERM', async () => {
  await pool.end().catch(() => {});
  process.exit(0);
});
