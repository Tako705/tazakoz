'use strict';
/* ---------- constants ---------- */
const REGIONS = { astana:'Астана', almaty:'Алматы', shymkent:'Шымкент' };
const CATS = {
  dump:  { icon:'🗑️', years:[5,450], threat:{ru:'почва, грунтовые воды',kk:'топырақ, жер асты суы'} },
  water: { icon:'💧', years:[10,100], threat:{ru:'рыба, питьевая вода',kk:'балық, ауыз су'} },
  air:   { icon:'🏭', years:[1,30],  threat:{ru:'дыхание жителей района',kk:'аудан тұрғындарының тыныс алуы'} },
  trees: { icon:'🌳', years:[15,60], threat:{ru:'воздух, тень, почва',kk:'ауа, көлеңке, топырақ'} }
};
const ROUTES = { dump:'akimat', trees:'akimat', water:'ecom', air:'ecom' }; // preview only; the server decides
const STATUS_FLOW = ['new','review','confirmed','fined'];
const AI_CONF_MIN = 0.55;
const KEY = 'tazakoz.v2';
const DONE = ['confirmed','fined'];

/* ---------- state ---------- */
const fresh = () => ({ lang:'ru', role:'citizen', me:'u' + Math.random().toString(36).slice(2, 10), key:'', notifs:[], known:{}, outbox:[] });
let S;
try { S = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
if (!S || !S.me) S = fresh();
S.outbox = S.outbox || []; S.known = S.known || {}; S.notifs = S.notifs || [];
let D = { mine:[], pub:{ total:0, confirmed:0, regions:{} }, all:[] };
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Storage full'); } };
const t = k => (I18N[S.lang] && I18N[S.lang][k]) || I18N.ru[k] || k;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = s => document.querySelector(s);
const fmt = ts => new Date(ts).toLocaleString(S.lang === 'kk' ? 'kk-KZ' : 'ru-RU', { dateStyle:'short', timeStyle:'short' });

let tab = 'home', draft = null, agFilter = 'all';
const newDraft = () => ({ cat:null, img:null, hash:null, lat:null, lng:null, region:'astana', comment:'', ai:null, geoMsg:'' });

function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ---------- helpers ---------- */
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i += 37) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
// Client-side preview only (so the user sees the AI result before sending); the server re-classifies authoritatively.
function classify(cat, hash) {
  const n = parseInt(hash, 36) || 1;
  return { cat, sev: 1 + (n % 3), conf: Math.min(.97, Math.round((0.45 + (n % 55) / 100) * 100) / 100) };
}
function shrink(file) {
  return new Promise((res, rej) => {
    if (file.type.startsWith('video/')) return rej(new Error('video'));
    const r = new FileReader();
    r.onload = () => {
      const im = new Image();
      im.onload = () => {
        const k = Math.min(1, 800 / Math.max(im.width, im.height)), c = document.createElement('canvas');
        c.width = im.width * k; c.height = im.height * k; c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', .7));
      };
      im.onerror = rej; im.src = r.result;
    };
    r.onerror = rej; r.readAsDataURL(file);
  });
}

/* ---------- api ---------- */
async function api(path, opt = {}) {
  const h = { 'X-User-Id': S.me };
  if (opt.body) h['Content-Type'] = 'application/json';
  if (opt.insp) h['X-Inspector-Key'] = S.key;
  let r;
  try { r = await fetch('/api' + path, { method: opt.method || 'GET', headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined }); }
  catch (e) { throw { net: true }; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw { status: r.status, error: j.error };
  return j;
}
const errMsg = e => e.error === 'duplicate' ? t('dupReject') : e.error === 'rate_limited' ? t('rate') : e.net ? t('queued') : 'Error: ' + (e.error || e.status);
const busy = () => ['INPUT','TEXTAREA','SELECT'].includes((document.activeElement || {}).tagName);

async function refresh(quiet) {
  try {
    if (S.role === 'inspector') D.all = await api('/inspector/cases', { insp:true });
    else D.mine = await api('/cases');
    D.pub = await api('/public');
  } catch (e) {
    if (e.status === 401 && S.role === 'inspector') { S.role = 'citizen'; S.key = ''; tab = 'home'; save(); toast('⛔ ' + (e.error || '')); return render(); }
    if (!quiet) toast(errMsg(e));
    return;
  }
  // status-change notifications (FR-13)
  D.mine.forEach(c => {
    if (S.known[c.id] && S.known[c.id] !== c.status) { S.notifs.push({ id:c.id, status:c.status, ts:Date.now() }); toast(`${t('notif')} ${c.id}: ${t('st_' + c.status)}`); }
    S.known[c.id] = c.status;
  });
  save();
  if (!quiet || !busy()) render();
}
// retry queue for submissions made while offline / rate limited
async function flushOutbox() {
  if (!S.outbox.length) return;
  const rest = [];
  for (const item of S.outbox) {
    try { const c = await api('/cases', { method:'POST', body:item }); toast(`${t('sent')} ${c.id}`); }
    catch (e) { if (e.net || e.status === 429) rest.push(item); else toast(errMsg(e)); }
  }
  S.outbox = rest; save(); refresh(true);
}

/* ---------- views ---------- */
const V = {};
function render() {
  document.documentElement.lang = S.lang;
  $('#lang').textContent = S.lang === 'ru' ? 'KK' : 'RU';
  $('#role').textContent = t(S.role === 'citizen' ? 'inspector' : 'citizen');
  const tabs = S.role === 'citizen'
    ? [['home','🏠','home'],['report','📷','report'],['map','🗺️','map'],['mine','📋','mine'],['profile','👤','profile']]
    : [['queue','📥','queue'],['stats','📊','stats'],['map','🗺️','map']];
  if (!tabs.some(x => x[0] === tab)) tab = tabs[0][0];
  $('#tabs').innerHTML = tabs.map(([id, ic, k]) => `<button data-tab="${id}" class="${tab === id ? 'on' : ''}" aria-current="${tab === id}"><span>${ic}</span>${t(k)}</button>`).join('');
  $('#view').innerHTML = V[tab]();
  bind();
}
const statusPill = s => `<span class="pill ${s === 'rejected' ? 'bad' : s === 'moreinfo' ? 'warn' : ''}">${t('st_' + s)}</span>`;
const steps = c => {
  const rej = c.status === 'rejected';
  const idx = rej ? 1 : Math.max(0, STATUS_FLOW.indexOf(c.status === 'moreinfo' ? 'review' : c.status));
  return `<div class="steps" aria-hidden="true">${STATUS_FLOW.map((_, i) => `<i class="${rej && i === 2 ? 'no' : i <= idx ? 'on' : ''}"></i>`).join('')}</div>`;
};
const caseCard = (c, insp) => `<div class="card">
  <div class="row" style="align-items:center"><b>${t('caseNo')} ${esc(c.id)} · ${CATS[c.cat].icon} ${t('cat_' + c.cat)}</b>${statusPill(c.status)}</div>
  ${steps(c)}
  <div class="muted">${REGIONS[c.region]} · ${fmt(c.created)} · ${t('agency')}: ${t('ag_' + c.agency)}</div>
  ${c.comment ? `<p>${esc(c.comment)}</p>` : ''}
  ${c.inspNote ? `<p class="muted">💬 ${esc(c.inspNote)}</p>` : ''}
  ${insp && c.img ? `<img class="thumb" alt="" src="${esc(c.img)}">` : ''}
  ${insp ? `<div class="muted">AI: ${t('sev' + c.sev)} · ${Math.round(c.conf * 100)}%${c.needsModeration ? ' ⚠️' : ''}</div>` : ''}</div>`;

V.home = () => {
  const fact = t('fact' + (1 + (new Date().getDate() % 4)));
  return `<div class="grid card"><div class="stat"><b>${D.pub.total}</b><span>${t('cases')}</span></div>
    <div class="stat"><b>${D.pub.confirmed}</b><span>${t('confirmed')}</span></div><div class="stat"><b>3</b><span>${t('pilot')}</span></div></div>
    <div class="card fact"><b>💡 ${t('factTitle')}</b><p>${fact}</p></div>
    <button class="btn big" data-go="report">${t('sendSignal')}</button>
    <div class="notice">${t('noVerdict')}</div>`;
};

V.report = () => {
  draft = draft || newDraft();
  const d = draft;
  const cats = Object.keys(CATS).map(k => `<button class="cat ${d.cat === k ? 'on' : ''}" data-cat="${k}"><i>${CATS[k].icon}</i>${t('cat_' + k)}</button>`).join('');
  let ai = '';
  if (d.ai) {
    const c = CATS[d.cat], [y0, y1] = c.years, years = y0 + Math.round((y1 - y0) * (d.ai.sev - 1) / 2);
    ai = `<div class="card"><h2>${t('aiResult')}</h2>
      <div>${t('category')}: <b>${c.icon} ${t('cat_' + d.cat)}</b></div>
      <div>${t('severity')}: <b>${t('sev' + d.ai.sev)}</b></div>
      <div>${t('confidence')}: <b>${Math.round(d.ai.conf * 100)}%</b></div>
      ${d.ai.conf < AI_CONF_MIN ? `<div class="notice">${t('lowConf')}</div>` : ''}
      <div class="card fact" style="margin-top:10px"><b>${t('impact')}</b><br>⏳ ${t('decomposes')}: ${years} ${t('years')}<br>⚠️ ${t('threat')}: ${c.threat[S.lang]}</div>
      <div>${t('routedTo')}: <b>${t('ag_' + ROUTES[d.cat])}</b></div>
      <label class="muted" for="cm">${t('comment')}</label><textarea id="cm" rows="2" maxlength="500">${esc(d.comment)}</textarea>
      <div class="notice">${t('disclaimer')}</div>
      <button class="btn" id="submit">${t('submit')}</button></div>`;
  }
  return `<h2>${t('report')}</h2>
  <div class="card"><b>${t('step1')}</b><div class="cats" style="margin-top:8px">${cats}</div>
  <b>${t('step2')}</b><input type="file" id="file" accept="image/*,video/*" capture="environment" style="display:block;margin:8px 0" aria-label="${t('pickMedia')}">
  ${d.img ? `<img class="prev" alt="" src="${d.img}">` : ''}
  <b>${t('step3')}</b><div class="muted" style="margin:4px 0">${fmt(Date.now())}</div>
  <button class="btn sec" id="geo">📍 ${t('geo')}</button>
  <div class="muted" role="status">${esc(d.geoMsg)}</div>
  <label class="muted" for="reg">${t('region')}</label>
  <select id="reg">${Object.entries(REGIONS).map(([k, v]) => `<option value="${k}" ${d.region === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
  <div style="height:10px"></div><button class="btn" id="analyze">${t('analyze')}</button></div>${ai}`;
};

V.mine = () => {
  const l = D.mine;
  return `<h2>${t('mine')}</h2>`
    + (S.outbox.length ? `<div class="notice">⏳ ${t('queued')} (${S.outbox.length})</div>` : '')
    + (l.length ? l.map(c => caseCard(c)).join('') : `<div class="card">${t('emptyCases')}</div><button class="btn" data-go="report">${t('sendSignal')}</button>`)
    + (S.notifs.length ? `<h2>🔔 ${t('notif')}</h2>` + S.notifs.slice(-5).reverse().map(n => `<div class="card muted">${fmt(n.ts)} · ${esc(n.id)} → ${t('st_' + n.status)}</div>`).join('') : '');
};

V.map = () => {
  const counts = Object.keys(REGIONS).map(r => [r, (D.pub.regions || {})[r] || 0]);
  const max = Math.max(1, ...counts.map(x => x[1]));
  return `<h2>${t('map')}</h2><div class="card map-bg">` + counts.map(([r, n]) =>
    `<button class="heat" data-region="${r}" aria-label="${REGIONS[r]}: ${n}"><span style="width:90px">${REGIONS[r]}</span><span class="bar"><div style="width:${n / max * 100}%"></div></span><b>${n}</b></button>`).join('')
    + `</div><div id="regd"></div><div class="notice">${t('mapNote')}</div>`;
};

V.profile = () => {
  const mine = D.mine, conf = mine.filter(c => DONE.includes(c.status)).length;
  const xp = mine.length + conf * 2, lvl = 1 + Math.floor(xp / 5);
  const B = [['b_first', mine.length >= 1], ['b_three', mine.length >= 3], ['b_conf', conf >= 1], ['b_five', conf >= 5]];
  return `<h2>${t('myStats')}</h2><div class="grid card"><div class="stat"><b>${mine.length}</b><span>${t('sentN')}</span></div>
   <div class="stat"><b>${conf}</b><span>${t('confN')}</span></div><div class="stat"><b>${lvl}</b><span>${t('level')}</span></div></div>
   <div class="card"><div class="bar" role="progressbar" aria-valuenow="${xp % 5}" aria-valuemax="5"><div style="width:${(xp % 5) * 20}%"></div></div>
   <p class="muted">${xp % 5}/5 → ${t('level')} ${lvl + 1}</p></div>
   <div class="card"><b>${t('badges')}</b><div class="badges" style="margin-top:8px">${B.map(([k, on]) => `<div class="badge ${on ? 'on' : ''}">🏅 ${t(k)}</div>`).join('')}</div></div>`;
};

V.queue = () => {
  const q = D.all.filter(c => ['new','review','moreinfo'].includes(c.status) && (agFilter === 'all' || c.agency === agFilter));
  const filter = `<select id="agf" aria-label="${t('agency')}"><option value="all">${t('allAg')}</option>${['akimat','ecom','prosec'].map(a => `<option value="${a}" ${agFilter === a ? 'selected' : ''}>${t('ag_' + a)}</option>`).join('')}</select>`;
  return `<h2>${t('queue')}</h2>${filter}<div style="height:10px"></div>` + (q.length ? q.map(c => caseCard(c, true) + `<div class="card" style="margin-top:-6px">
    <label class="muted" for="n-${c.id}">${t('inspComment')}</label><input type="text" id="n-${c.id}" maxlength="300">
    <div class="row" style="margin-top:8px"><button class="btn" data-act="confirmed" data-id="${c.id}">${t('confirm')}</button><button class="btn bad" data-act="rejected" data-id="${c.id}">${t('reject')}</button></div>
    <button class="btn warn" style="margin-top:8px" data-act="moreinfo" data-id="${c.id}">${t('more')}</button>
    ${c.user !== 'demo-other' ? `<button class="btn sec" style="margin-top:8px" data-flag="${esc(c.user)}">${t('flag')}</button>` : ''}</div>`).join('') : `<div class="card">${t('emptyQueue')}</div>`)
    + `<h2>${t('confirmed')}</h2>` + D.all.filter(c => c.status === 'confirmed').map(c => caseCard(c, true) + `<button class="btn sec" style="margin:-6px 0 12px" data-act="fined" data-id="${c.id}">${t('toProc')}</button>`).join('');
};

V.stats = () => {
  const all = D.all, done = all.filter(c => ['confirmed','rejected','fined'].includes(c.status));
  const ok = done.filter(c => c.status !== 'rejected').length;
  const avg = done.length ? Math.round(done.reduce((s, c) => s + (c.updated - c.created), 0) / done.length / 36e5) : 0;
  const by = {}; all.forEach(c => by[c.agency] = (by[c.agency] || 0) + 1);
  return `<h2>${t('stats')}</h2><div class="grid card"><div class="stat"><b>${all.length}</b><span>${t('cases')}</span></div>
   <div class="stat"><b>${avg}</b><span>${t('avgReact')}</span></div><div class="stat"><b>${done.length ? Math.round(ok / done.length * 100) : 0}%</b><span>${t('share')}</span></div></div>`
   + `<div class="card">${Object.entries(by).map(([a, n]) => `<div class="row"><span>${t('ag_' + a)}</span><b style="text-align:right">${n}</b></div>`).join('')}</div>`;
};

/* ---------- actions ---------- */
async function setStatus(id, status, note) {
  try { await api('/inspector/cases/' + id, { method:'PATCH', insp:true, body:{ status, note } }); await refresh(); }
  catch (e) { toast(errMsg(e)); }
}
async function submitDraft() {
  const d = draft;
  const body = { cat:d.cat, region:d.region, comment:d.comment, lat:d.lat, lng:d.lng, ...(d.img ? { img:d.img } : { hash:d.hash }) };
  try {
    const c = await api('/cases', { method:'POST', body });
    toast(`${t('sent')} ${c.id}`);
  } catch (e) {
    if (e.net) { S.outbox.push(body); save(); toast(t('queued')); }
    else return toast(errMsg(e));
  }
  draft = null; tab = 'mine'; refresh(true);
}

/* ---------- events ---------- */
function bind() {
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { tab = b.dataset.go; render(); });
  document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { draft.cat = b.dataset.cat; draft.ai = null; render(); });
  document.querySelectorAll('[data-region]').forEach(b => b.onclick = () => {
    const r = b.dataset.region, n = (D.pub.regions || {})[r] || 0;
    const lvl = n > 4 ? t('sev3') : n > 1 ? t('sev2') : t('sev1');
    $('#regd').innerHTML = `<div class="card"><b>${REGIONS[r]}</b><br>${t('regionDetail')}: <b>${n}</b><br>${t('load')}: <b>${lvl}</b></div>`;
  });
  const f = $('#file');
  if (f) f.onchange = async () => {
    const file = f.files[0]; if (!file) return;
    try { draft.img = await shrink(file); draft.hash = hashStr(draft.img); }
    catch (e) { draft.img = null; draft.hash = hashStr(file.name + file.size + file.lastModified); toast('🎬 ' + file.name); }
    draft.ai = null; render();
  };
  const g = $('#geo');
  if (g) g.onclick = () => {
    if (!navigator.geolocation) { draft.geoMsg = t('geoFail'); return render(); }
    navigator.geolocation.getCurrentPosition(p => { draft.lat = +p.coords.latitude.toFixed(4); draft.lng = +p.coords.longitude.toFixed(4); draft.geoMsg = `✅ ${t('geoOk')}`; render(); },
      () => { draft.geoMsg = t('geoFail'); render(); }, { timeout: 8000 });
  };
  const rg = $('#reg'); if (rg) rg.onchange = () => { draft.region = rg.value; };
  const an = $('#analyze');
  if (an) an.onclick = () => {
    if (!draft.cat) return toast(t('needCat'));
    if (!draft.hash) return toast(t('needMedia'));
    draft.ai = classify(draft.cat, draft.hash); render();
  };
  const cm = $('#cm'); if (cm) cm.oninput = () => { draft.comment = cm.value; };
  const sb = $('#submit'); if (sb) sb.onclick = submitDraft;
  const af = $('#agf'); if (af) af.onchange = () => { agFilter = af.value; render(); };
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
    const n = document.getElementById('n-' + b.dataset.id);
    setStatus(b.dataset.id, b.dataset.act, n && n.value.trim());
  });
  document.querySelectorAll('[data-flag]').forEach(b => b.onclick = async () => {
    try { await api('/inspector/flag', { method:'POST', insp:true, body:{ user:b.dataset.flag } }); toast('✔'); } catch (e) { toast(errMsg(e)); }
  });
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; render(); $('#view').focus(); } });
$('#lang').onclick = () => { S.lang = S.lang === 'ru' ? 'kk' : 'ru'; save(); render(); };
$('#role').onclick = () => {
  if (S.role === 'citizen') {
    const k = window.prompt('Inspector key');
    if (!k) return;
    S.key = k; S.role = 'inspector'; tab = 'queue';
  } else { S.role = 'citizen'; S.key = ''; tab = 'home'; }
  save(); render(); refresh();
};
window.addEventListener('online', () => { toast('✔ online'); flushOutbox(); });
setInterval(() => { if (document.visibilityState === 'visible') { flushOutbox(); refresh(true); } }, 15000);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
render(); flushOutbox(); refresh(true);
