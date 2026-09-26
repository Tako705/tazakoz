'use strict';
// TazaKöz backend: zero dependencies. Requires Node >= 22.5 (node:sqlite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const INSPECTOR_KEY = process.env.INSPECTOR_KEY || 'demo-inspector';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'tazakoz.db');
const PUBLIC = path.join(__dirname, '..', 'public');

const REGIONS = ['astana', 'almaty', 'shymkent'];
const ROUTES = { dump: 'akimat', trees: 'akimat', water: 'ecom', air: 'ecom' }; // rule-based routing (PRD 9)
const STATUSES = ['new', 'review', 'confirmed', 'rejected', 'fined', 'moreinfo'];
const INSPECTOR_SET = ['confirmed', 'rejected', 'moreinfo', 'review', 'fined'];
const RATE_MAX = 3, RATE_WINDOW = 60000, MAX_BODY = 4 * 1024 * 1024;

/* ---------- db ---------- */
const db = new DatabaseSync(DB_FILE);
db.exec(`
CREATE TABLE IF NOT EXISTS cases(
  id TEXT PRIMARY KEY, user TEXT NOT NULL, region TEXT NOT NULL, cat TEXT NOT NULL, sev INTEGER, conf REAL,
  agency TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
  comment TEXT DEFAULT '', insp_note TEXT, img TEXT, lat REAL, lng REAL, hash TEXT, needs_moderation INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_user ON cases(user);
CREATE INDEX IF NOT EXISTS ix_hash ON cases(hash);
CREATE TABLE IF NOT EXISTS flagged(user TEXT PRIMARY KEY, ts INTEGER);
CREATE TABLE IF NOT EXISTS seq(k TEXT PRIMARY KEY, v INTEGER);
INSERT OR IGNORE INTO seq VALUES('case', 1000);`);

const nextId = () => { db.prepare("UPDATE seq SET v=v+1 WHERE k='case'").run(); return 'TK-' + db.prepare("SELECT v FROM seq WHERE k='case'").get().v; };

function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) n FROM cases').get().n) return;
  const now = Date.now(), d = 864e5;
  const rows = [['astana','dump','confirmed',3],['astana','trees','confirmed',9],['astana','air','review',1],['almaty','dump','confirmed',5],
    ['almaty','water','confirmed',12],['almaty','air','confirmed',20],['almaty','dump','confirmed',2],['shymkent','dump','confirmed',7],
    ['shymkent','water','review',1],['almaty','trees','new',0]];
  const ins = db.prepare('INSERT INTO cases(id,user,region,cat,sev,conf,agency,status,created,updated,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  rows.forEach(([r, c, s, ago], i) => ins.run(nextId(), 'demo-other', r, c, 2, .8, ROUTES[c], s, now - ago * d, now - ago * d + 72e5, 'seed' + i));
}
seedIfEmpty();

/* ---------- helpers ---------- */
const rowToCase = (r, withImg) => ({ id: r.id, user: r.user, region: r.region, cat: r.cat, sev: r.sev, conf: r.conf, agency: r.agency, status: r.status,
  created: r.created, updated: r.updated, comment: r.comment || '', inspNote: r.insp_note || null, needsModeration: !!r.needs_moderation,
  img: withImg ? r.img : null, lat: withImg ? r.lat : null, lng: withImg ? r.lng : null });

const rate = new Map();
function rateLimited(user) {
  const now = Date.now(), a = (rate.get(user) || []).filter(x => now - x < RATE_WINDOW);
  if (a.length >= RATE_MAX) { rate.set(user, a); return true; }
  a.push(now); rate.set(user, a); return false;
}
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
function classify(cat, hash) { // placeholder for a real CV model
  const n = parseInt(hash.slice(0, 8), 16) || 1;
  return { sev: 1 + (n % 3), conf: Math.min(0.97, Math.round((0.45 + (n % 55) / 100) * 100) / 100) };
}
const AI_CONF_MIN = 0.55;

function isDuplicate(b, hash) {
  if (db.prepare('SELECT 1 FROM cases WHERE hash=?').get(hash)) return true;
  if (b.lat == null || b.lng == null) return false;
  const since = Date.now() - 864e5;
  return !!db.prepare('SELECT 1 FROM cases WHERE cat=? AND region=? AND created>? AND ABS(lat-?)<0.0005 AND ABS(lng-?)<0.0005')
    .get(b.cat, b.region, since, b.lat, b.lng);
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject({ code: 413, msg: 'too_large' }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject({ code: 400, msg: 'bad_json' }); } });
    req.on('error', () => reject({ code: 400, msg: 'read_error' }));
  });
}
const isInspector = req => {
  const k = req.headers['x-inspector-key'] || '';
  return k.length === INSPECTOR_KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(INSPECTOR_KEY));
};
const userOf = req => { const u = String(req.headers['x-user-id'] || ''); return /^[a-z0-9_-]{4,40}$/i.test(u) ? u : null; };

/* ---------- api ---------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method;

  if (p === '/api/health') return send(res, 200, { ok: true });

  // public aggregated data only (PRD FR-1, FR-15/16): no addresses, no media, no user ids
  if (p === '/api/public' && m === 'GET') {
    const since = Date.now() - 30 * 864e5;
    const total = db.prepare('SELECT COUNT(*) n FROM cases').get().n;
    const confirmed = db.prepare("SELECT COUNT(*) n FROM cases WHERE status IN ('confirmed','fined')").get().n;
    const regions = {}; REGIONS.forEach(r => regions[r] = 0);
    db.prepare("SELECT region, COUNT(*) n FROM cases WHERE status IN ('confirmed','fined') AND created>? GROUP BY region").all(since)
      .forEach(r => regions[r.region] = r.n);
    return send(res, 200, { total, confirmed, regions });
  }

  if (p === '/api/cases' && m === 'GET') {
    const u = userOf(req); if (!u) return send(res, 401, { error: 'no_user' });
    const rows = db.prepare('SELECT * FROM cases WHERE user=? ORDER BY created DESC').all(u);
    return send(res, 200, rows.map(r => rowToCase(r, false)));
  }

  if (p === '/api/cases' && m === 'POST') {
    const u = userOf(req); if (!u) return send(res, 401, { error: 'no_user' });
    const b = await readJson(req);
    if (!ROUTES[b.cat]) return send(res, 400, { error: 'bad_category' });
    if (!REGIONS.includes(b.region)) return send(res, 400, { error: 'bad_region' });
    if (typeof b.img !== 'string' && typeof b.hash !== 'string') return send(res, 400, { error: 'no_media' });
    if (b.img && !/^data:image\/(jpeg|png|webp);base64,/.test(b.img)) return send(res, 400, { error: 'bad_media' });
    const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
    const lat = num(b.lat), lng = num(b.lng);
    const hash = sha(b.img || b.hash);
    if (rateLimited(u)) return send(res, 429, { error: 'rate_limited' });
    if (isDuplicate({ cat: b.cat, region: b.region, lat, lng }, hash)) return send(res, 409, { error: 'duplicate' });
    const ai = classify(b.cat, hash), now = Date.now(), id = nextId();
    db.prepare(`INSERT INTO cases(id,user,region,cat,sev,conf,agency,status,created,updated,comment,img,lat,lng,hash,needs_moderation)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, u, b.region, b.cat, ai.sev, ai.conf, ROUTES[b.cat], 'new', now, now, String(b.comment || '').slice(0, 500), b.img || null, lat, lng, hash, ai.conf < AI_CONF_MIN ? 1 : 0);
    return send(res, 201, rowToCase(db.prepare('SELECT * FROM cases WHERE id=?').get(id), false));
  }

  if (p.startsWith('/api/inspector/')) {
    if (!isInspector(req)) return send(res, 401, { error: 'bad_key' });
    if (p === '/api/inspector/cases' && m === 'GET')
      return send(res, 200, db.prepare('SELECT * FROM cases ORDER BY created ASC').all().map(r => rowToCase(r, true)));
    let mm;
    if ((mm = p.match(/^\/api\/inspector\/cases\/(TK-\d+)$/)) && m === 'PATCH') {
      const b = await readJson(req);
      if (!INSPECTOR_SET.includes(b.status)) return send(res, 400, { error: 'bad_status' });
      const cur = db.prepare('SELECT status FROM cases WHERE id=?').get(mm[1]);
      if (!cur) return send(res, 404, { error: 'not_found' });
      if (b.status === 'fined' && cur.status !== 'confirmed') return send(res, 409, { error: 'not_confirmed' });
      db.prepare('UPDATE cases SET status=?, updated=?, insp_note=COALESCE(?, insp_note), needs_moderation=0 WHERE id=?')
        .run(b.status, Date.now(), b.note ? String(b.note).slice(0, 300) : null, mm[1]);
      return send(res, 200, rowToCase(db.prepare('SELECT * FROM cases WHERE id=?').get(mm[1]), false));
    }
    if (p === '/api/inspector/flag' && m === 'POST') {
      const b = await readJson(req);
      if (typeof b.user !== 'string') return send(res, 400, { error: 'bad_user' });
      db.prepare('INSERT OR REPLACE INTO flagged VALUES(?,?)').run(b.user, Date.now()); // internal only, never public
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'not_found' });
}

/* ---------- static ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml' };
function serveStatic(req, res, url) {
  let f = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!f) f = 'index.html';
  const full = path.join(PUBLIC, f);
  if (!full.startsWith(PUBLIC + path.sep) && full !== PUBLIC) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (e && e.code) return send(res, e.code, { error: e.msg });
    console.error(e); send(res, 500, { error: 'server_error' });
  }
}).listen(PORT, () => console.log(`TazaKöz on http://localhost:${PORT}  (inspector key: ${INSPECTOR_KEY === 'demo-inspector' ? 'demo-inspector — set INSPECTOR_KEY in prod' : 'custom'})`));
