'use strict';
// Demo mode for static hosting (GitHub Pages): if the real backend is unreachable, /api/* is emulated in localStorage.
(() => {
  const realFetch = window.fetch.bind(window);
  const DB = 'tazakoz.demo.db', KEY = 'demo-inspector';
  const ROUTES = { dump:'akimat', trees:'akimat', water:'ecom', air:'ecom' };
  let backend; // undefined = unknown, true/false after probe
  const probe = () => backend !== undefined ? Promise.resolve(backend)
    : realFetch('/api/health').then(r => r.ok && (r.headers.get('content-type') || '').includes('json')).catch(() => false).then(v => (backend = v));

  const load = () => {
    try { const d = JSON.parse(localStorage.getItem(DB)); if (d && d.cases) return d; } catch (e) {}
    const now = Date.now(), day = 864e5;
    const rows = [['astana','dump','confirmed',3],['astana','trees','confirmed',9],['astana','air','review',1],['almaty','dump','confirmed',5],
      ['almaty','water','confirmed',12],['almaty','air','confirmed',20],['almaty','dump','confirmed',2],['shymkent','dump','confirmed',7],
      ['shymkent','water','review',1],['almaty','trees','new',0]];
    return { seq: 1010, sent: {}, cases: rows.map(([region, cat, status, ago], i) => ({ id:'TK-' + (1001 + i), user:'demo-other', region, cat, sev:2, conf:.8,
      agency:ROUTES[cat], status, created:now - ago * day, updated:now - ago * day + 72e5, comment:'', inspNote:null, needsModeration:false, img:null, lat:null, lng:null, hash:'seed' + i })) };
  };
  const store = d => { try { localStorage.setItem(DB, JSON.stringify(d)); } catch (e) {} };
  const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json' } });
  const strip = c => ({ ...c, img: null, lat: null, lng: null });
  const sha = s => { let h = 5381; for (let i = 0; i < s.length; i += 7) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };

  function mock(path, method, headers, body) {
    const d = load(), user = headers['X-User-Id'], insp = headers['X-Inspector-Key'] === KEY;
    if (path === '/api/public') {
      const since = Date.now() - 30 * 864e5, regions = { astana:0, almaty:0, shymkent:0 };
      d.cases.filter(c => ['confirmed','fined'].includes(c.status) && c.created > since).forEach(c => regions[c.region]++);
      return json(200, { total: d.cases.length, confirmed: d.cases.filter(c => ['confirmed','fined'].includes(c.status)).length, regions });
    }
    if (path === '/api/cases' && method === 'GET') return json(200, d.cases.filter(c => c.user === user).sort((a, b) => b.created - a.created).map(strip));
    if (path === '/api/cases' && method === 'POST') {
      const now = Date.now(), recent = (d.sent[user] || []).filter(x => now - x < 60000);
      if (recent.length >= 3) return json(429, { error: 'rate_limited' });
      const hash = sha(body.img || body.hash || '');
      if (d.cases.some(c => c.hash === hash)) return json(409, { error: 'duplicate' });
      const n = parseInt(hash, 16) || 1, conf = Math.min(.97, Math.round((0.45 + (n % 55) / 100) * 100) / 100);
      const c = { id:'TK-' + (++d.seq), user, region:body.region, cat:body.cat, sev:1 + (n % 3), conf, agency:ROUTES[body.cat], status:'new', created:now, updated:now,
        comment:String(body.comment || '').slice(0, 500), inspNote:null, needsModeration:conf < .55, img:body.img || null, lat:body.lat, lng:body.lng, hash };
      d.cases.push(c); recent.push(now); d.sent[user] = recent; store(d);
      return json(201, strip(c));
    }
    if (path.startsWith('/api/inspector/')) {
      if (!insp) return json(401, { error: 'bad_key' });
      if (path === '/api/inspector/cases') return json(200, [...d.cases].sort((a, b) => a.created - b.created));
      const m = path.match(/^\/api\/inspector\/cases\/(TK-\d+)$/);
      if (m && method === 'PATCH') {
        const c = d.cases.find(x => x.id === m[1]); if (!c) return json(404, { error: 'not_found' });
        if (body.status === 'fined' && c.status !== 'confirmed') return json(409, { error: 'not_confirmed' });
        c.status = body.status; c.updated = Date.now(); if (body.note) c.inspNote = String(body.note).slice(0, 300); c.needsModeration = false;
        store(d); return json(200, strip(c));
      }
      if (path === '/api/inspector/flag') return json(200, { ok: true });
    }
    return json(404, { error: 'not_found' });
  }

  window.fetch = async (url, opt = {}) => {
    if (typeof url !== 'string' || !url.startsWith('/api')) return realFetch(url, opt);
    if (await probe()) return realFetch(url, opt);
    let body = {}; try { body = opt.body ? JSON.parse(opt.body) : {}; } catch (e) {}
    return mock(url.split('?')[0], (opt.method || 'GET').toUpperCase(), opt.headers || {}, body);
  };
})();
