'use strict';
// Server-side enforcement for DC Quality Reports: sessions, per-user data scope, write guards, per-warehouse stock check.
// Uses the same wh-core.js as the front-end, so server and app can never disagree on balances or scope.
const crypto = require('crypto');
const W = require('./wh-core.js');

const SCOPED = ['temps', 'ncr', 'returns', 'complaints', 'flow', 'batches', 'ops', 'veh', 'capa', 'recall', 'rcv', 'mvs', 'lt'];
// Everyone else's collections ('prods', 'audit', ...) keep their current behaviour.

// ---- password verification (same algorithm as the app: v2$salt$hash, or the legacy 32-bit hash)
function hderive(pw, salt) {
  let h = crypto.createHash('sha256').update(salt + '|' + pw, 'utf8').digest();
  const p = Buffer.from(pw + '|' + salt, 'utf8');
  for (let i = 0; i < 6000; i++) h = crypto.createHash('sha256').update(Buffer.concat([h, p])).digest();
  return h.toString('hex');
}
function legacyH(s) { let h = 5381; for (const c of s) h = ((h * 33) ^ c.codePointAt(0)) >>> 0; return h.toString(36); }
function verifyPassword(user, pw) {
  const st = String((user && user.p) || '');
  if (typeof pw !== 'string' || !pw) return false;
  if (st.startsWith('v2$')) {
    const x = st.split('$');
    if (x.length !== 3) return false;
    const a = Buffer.from(hderive(pw, x[1])), b = Buffer.from(x[2]);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return st === legacyH(pw);
}

// ---- sessions: HMAC-signed, 12 hours, bound to the username (role/group are re-read from the database on every request)
const SESSION_MS = 12 * 3600 * 1000;
const b64 = b => Buffer.from(b).toString('base64url');
function signSession(secret, u, now) {
  const body = b64(JSON.stringify({ u, exp: (now || Date.now()) + SESSION_MS }));
  const sig = crypto.createHmac('sha256', secret + '|session').update(body).digest('base64url');
  return body + '.' + sig;
}
function readSession(secret, token, now) {
  if (typeof token !== 'string' || token.length > 600) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secret + '|session').update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || typeof p.u !== 'string' || !(p.exp > (now || Date.now()))) return null;
    return p.u;
  } catch (_e) { return null; }
}

const isPriv = u => W.whPriv(u);
const ownFn = u => r => !!r && (r.bu ? r.bu === u.u : r.by === u.n);

// ---- what a session user may read
function filterState(state, user) {
  if (!user || isPriv(user)) return state;                      // Admin / QMgr: everything (unchanged)
  const own = ownFn(user), cx = W.whCtx(state), out = { ...state };
  for (const k of SCOPED) {
    if (!Array.isArray(state[k])) continue;
    if (k === 'batches') {
      out.batches = state.batches.map(b => {
        if (b.contrib && b.contrib.length) {
          const m = b.contrib.filter(c => W.whCanSeeContrib(state, user, b, c, own));
          if (!m.length) return null;
          const sum = key => String(+m.reduce((a, y) => a + (+y[key] || 0), 0).toFixed(3));
          return { ...b, contrib: m, qty: sum('qty'), q2: sum('q2'), kg: sum('kg') };
        }
        return W.whCanSeeContrib(state, user, b, b, own) ? b : null;
      }).filter(Boolean);
    } else out[k] = state[k].filter(r => W.whCanSee(state, user, k, r, cx, own));
  }
  // other accounts' password hashes are never sent to a non-admin session
  out.users = (state.users || []).map(x => x.u === user.u ? x : (() => { const { p: _p, ...rest } = x; return rest; })());
  return out;
}

// ---- what a session user may write: records outside their scope, settings, other users and most deletes are ignored
const NONADMIN_TOMB = new Set(['ops', 'batches']);
function guardIncoming(oldState, incoming, user) {
  if (!user) return incoming;                                   // legacy device token without a session (see REQUIRE_USER_SESSION)
  const out = { ...incoming }, dropped = {};
  const admin = user.r === 'Admin';
  if (!admin) {
    delete out.set; delete out._settingsUpdatedAt;
    const old = (oldState.users || []).find(x => x.u === user.u), mine = (incoming.users || []).find(x => x && x.u === user.u);
    out.users = (oldState.users || []).map(x => {
      if (x.u !== user.u || !mine) return x;
      return { ...x, p: typeof mine.p === 'string' && mine.p ? mine.p : x.p, n: typeof mine.n === 'string' && mine.n ? mine.n : x.n, _updatedAt: mine._updatedAt || x._updatedAt };
    });
    if (!old) out.users = oldState.users || [];
  }
  if (!isPriv(user)) {
    const own = ownFn(user), cx = W.whCtx({ mvs: [...(oldState.mvs || []), ...(incoming.mvs || [])] });
    for (const k of SCOPED) {
      if (!Array.isArray(out[k])) continue;
      const keep = [];
      for (const r of out[k]) {
        if (!r || r.id == null) continue;
        if (k === 'batches') {
          if (r.contrib && r.contrib.length) {
            const m = r.contrib.filter(c => W.whCanSeeContrib(oldState, user, r, c, own));
            if (m.length !== r.contrib.length) {
              dropped[k] = (dropped[k] || 0) + (r.contrib.length - m.length);
              if (!m.length) continue;
              keep.push({ ...r, contrib: m });
              continue;
            }
            keep.push(r);
          } else if (W.whCanSeeContrib(oldState, user, r, r, own)) keep.push(r);
          else dropped[k] = (dropped[k] || 0) + 1;
        } else if (W.whCanSee(oldState, user, k, r, cx, own)) keep.push(r);
        else dropped[k] = (dropped[k] || 0) + 1;
      }
      out[k] = keep;
    }
  }
  if (incoming._deleted && typeof incoming._deleted === 'object') {
    const d = {};
    for (const [bucket, ids] of Object.entries(incoming._deleted)) {
      if (admin || NONADMIN_TOMB.has(bucket)) d[bucket] = ids;
      else dropped['_deleted:' + bucket] = Object.keys(ids || {}).length;
    }
    out._deleted = d;
  }
  out.__dropped = dropped;
  return out;
}

// ---- per-warehouse stock enforcement (transactional: runs inside the sync transaction after the merge)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function enforceStock(oldState, merged) {
  const rejected = [];
  if (!Array.isArray(merged.ops) || !Array.isArray(merged.batches)) return rejected;
  const oldOps = new Map((oldState.ops || []).map(o => [String(o.id), o]));
  const needs = o => o.v3 && (o.type === 'صرف' || o.type === 'تحويل' || (o.type === 'تسوية' && +o.qty < 0));
  const cand = merged.ops.filter(o => needs(o) && !(oldOps.has(String(o.id)) && same(oldOps.get(String(o.id)), o)));
  if (!cand.length) return rejected;
  const candIds = new Set(cand.map(o => String(o.id)));
  const work = { ...merged, ops: merged.ops.filter(o => !candIds.has(String(o.id))) };
  cand.sort((a, b) => (String(a.date || '') + '|' + String(a.cr || '') + '|' + String(a.id)).localeCompare(String(b.date || '') + '|' + String(b.cr || '') + '|' + String(b.id)));
  for (const o of cand) {
    const b = work.batches.find(x => x.no === o.batch && x.prod === o.prod) || work.batches.find(x => x.no === o.batch);
    if (!b || !o.batch) { work.ops.push(o); continue; }         // unrecorded lot: nothing to verify against
    work.ops.push(o);
    const B = W.whLedger(work, b);
    const w = o.wh, bal = B[w] || 0;
    if (!w || bal < -1e-9) {
      work.ops.pop();
      const avail = Math.max(0, (W.whLedger(work, b)[w] || 0));
      rejected.push({ id: o.id, mid: o.mid, msg: !w ? 'لم تُحدَّد الثلاجة' : 'رصيد «' + w + '» للتشغيلة ' + o.batch + ' غير كافٍ (المتاح ' + +avail.toFixed(3) + '، المطلوب ' + +(+o.qty || 0).toFixed(3) + ')' });
    }
  }
  if (rejected.length) {
    const rj = new Set(rejected.map(r => String(r.id)));
    merged.ops = merged.ops.filter(o => !rj.has(String(o.id)));
  }
  return rejected;
}

module.exports = { SCOPED, hderive, legacyH, verifyPassword, signSession, readSession, filterState, guardIncoming, enforceStock, isPriv };
