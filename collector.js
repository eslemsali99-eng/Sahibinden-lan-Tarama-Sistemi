// collector.js — toplayıcı + CRM backend. Turso (libSQL) async.
// Yerelde file:output/emlak.db, Render'da TURSO_URL'ye bağlanır (ekip senkron, 7/24 panel).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { init, all, get, run, batchWrite, upsertStatement } = require('./db');
const { parseTrDate, parsePrice, detectType, splitLocation, bestImage } = require('./lib');
const cfg = require('./config');
const notifier = require('./notifier');

const PORT = process.env.PORT || 7777;
const BASE = 'https://www.sahibinden.com';
const EXP = cfg.EXPIRY_ESTIMATE_DAYS;
const W = cfg.EXPIRY_WINDOW;
const daysLeft = (d) => (d == null ? null : Math.max(0, EXP - d));
const num = (v) => Number(v || 0);

// --- auth: env (Render) -> dosya (yerel) ---
const crypto = require('crypto');
let TEAM_PASS = process.env.TEAM_PASS || 'bircan';
let TOKEN = process.env.INGEST_TOKEN || '';
if (!process.env.TEAM_PASS) { try { TEAM_PASS = JSON.parse(fs.readFileSync(path.join(cfg.OUTPUT_DIR, 'auth.json'), 'utf8')).password || TEAM_PASS; } catch {} }
if (!process.env.INGEST_TOKEN) { try { TOKEN = fs.readFileSync(path.join(cfg.OUTPUT_DIR, '.token'), 'utf8').trim(); } catch {} }
const SID = crypto.createHash('sha256').update(TEAM_PASS + '::bircan').digest('hex').slice(0, 32);
const authed = (req) => (req.headers.cookie || '').includes('bircan_sid=' + SID);
const hasToken = (req) => (req.headers['x-token'] || '') === TOKEN;
const PUBLIC = ['/login', '/portfolio', '/musteri', '/api/portfolio', '/api/inquiry', '/harvester.js', '/kur', '/health'];
const TOKENR = ['/ingest', '/api/enrich', '/api/need-phone', '/api/need-check', '/api/mark-removed', '/api/mark-checked', '/api/notify-fresh', '/api/reconcile'];
const LOGIN_HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Giriş · Bircan Akın</title>
<style>body{font-family:-apple-system,Arial;background:#0b1020;color:#e7ecf6;display:flex;height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#151b30;padding:34px;border-radius:16px;border:1px solid #26304d;width:320px;text-align:center}
h2{color:#4f8cff;margin:0 0 18px}input{width:100%;padding:12px;border-radius:10px;border:1px solid #26304d;background:#0b1020;color:#fff;margin-bottom:12px;box-sizing:border-box}
button{width:100%;padding:12px;border:none;border-radius:10px;background:#4f8cff;color:#fff;font-weight:700;cursor:pointer}</style></head>
<body><form method="POST" action="/login"><h2>🏠 Bircan Akın CRM</h2><input type="password" name="password" placeholder="Ekip şifresi" autofocus><button>Giriş</button></form></body></html>`;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });
const sendJSON = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

function normalize(meta, x) {
  const { iso, days } = parseTrDate(x.dateTxt);
  const { semt, mahalle } = splitLocation(x.locTxt);
  let area = null, rooms = null;
  for (const v of (x.attrs || [])) {
    if (/\+/.test(v) && !rooms) rooms = v;
    else if (/^\d[\d.]*$/.test(v) && !area) area = parseInt(v.replace(/\./g, ''), 10);
  }
  const href = x.href || '';
  const category = /kiralik/i.test(href) ? 'Kiralık' : 'Satılık';
  return {
    id: String(x.id),
    url: href ? (href.startsWith('http') ? href : BASE + href) : null,
    title: x.title, price: parsePrice(x.priceTxt),
    district: meta.district, neighborhood: mahalle || semt,
    category, property_type: detectType(href, x.title, meta.baseType),
    seller_type: meta.sellerType === 'emlak-ofisinden' ? 'emlakci' : 'sahibinden',
    listing_date: iso, days_on_site: days, rooms, area_m2: area,
    image_url: bestImage(x.imgSrc), raw_json: JSON.stringify(x),
  };
}

async function handle(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const pathOnly = req.url.split('?')[0];

  if (pathOnly === '/health') { return sendJSON(res, 200, { ok: true }); }

  // login
  if (req.method === 'POST' && pathOnly === '/login') {
    const b = await readBody(req);
    const p = decodeURIComponent((b.match(/password=([^&]*)/) || [])[1] || '').replace(/\+/g, ' ');
    if (p === TEAM_PASS) { res.writeHead(302, { 'Set-Cookie': `bircan_sid=${SID}; Path=/; HttpOnly; Max-Age=2592000`, Location: '/' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML.replace('Ekip şifresi', 'Hatalı şifre — tekrar dene'));
  }

  // auth kapısı
  if (!PUBLIC.includes(pathOnly)) {
    if (!(authed(req) || (TOKENR.includes(pathOnly) && hasToken(req)))) {
      if (pathOnly.startsWith('/api') || pathOnly === '/ingest') return sendJSON(res, 401, { error: 'auth' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML);
    }
  }

  // --- ingest: yeni ilan + fiyat düşüşü tespiti ---
  if (req.method === 'POST' && pathOnly === '/ingest') {
    const body = await readBody(req);
    const { meta, rows } = JSON.parse(body);
    const recs = [];
    const ALLOWED = new Set(cfg.DISTRICTS.map((d) => d.name)); // sadece config'deki ilçeler (eski eklenti Yıldırım eklemesin)
    for (const x of rows) { if (!x || !x.id) continue; const rec = normalize(meta, x); if (rec.category === 'Kiralık') continue; if (!ALLOWED.has(rec.district)) continue; recs.push(rec); }
    let exMap = new Map();
    if (recs.length) {
      const ids = recs.map((r) => r.id);
      const ex = await all(`SELECT id, price, phone, contact_type FROM listings WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      exMap = new Map(ex.map((r) => [String(r.id), r]));
    }
    const fresh = [], drops = [], stmts = [];
    for (const rec of recs) {
      const old = exMap.get(rec.id);
      stmts.push(upsertStatement(rec));
      if (!old) fresh.push(rec);
      else if (old.price && rec.price && rec.price < old.price) drops.push({ ...rec, oldPrice: old.price, phone: old.phone, contact_type: old.contact_type });
    }
    await batchWrite(stmts);
    const total = num((await get('SELECT COUNT(*) c FROM listings')).c);
    // YENİ ilanların url'leri -> eklenti detaydan telefon/açıklama/görsel çeker, sonra enrich(notify:true) ile TELEFONLA bildirir
    const freshUrls = (meta.bulk ? [] : fresh).map((r) => ({ id: r.id, url: r.url }));
    sendJSON(res, 200, { ok: true, processed: recs.length, fresh: fresh.length, drops: drops.length, total, freshUrls });
    console.log(`+${recs.length} (${meta.district}) yeni:${fresh.length} düşüş:${drops.length} -> DB ${total}`);
    // yeni ilan bildirimi BURADA DEĞİL -> notify-fresh'te toplu+telefonlu. Fiyat düşüşü HER ZAMAN (nadir, önemli).
    if (drops.length) notifier.notifyPriceDrops(drops).catch(() => {});
    return;
  }

  // dashboard
  if (req.method === 'GET' && (pathOnly === '/' || pathOnly.startsWith('/index'))) {
    try { const html = fs.readFileSync(path.join(cfg.ROOT, 'dashboard.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
    catch { res.writeHead(500); return res.end('dashboard.html okunamadi'); }
  }

  if (req.method === 'GET' && pathOnly === '/api/listings') {
    const u = new URL(req.url, 'http://x');
    const seller = u.searchParams.get('seller');
    let rows;
    if (seller === 'emlakci') {
      rows = await all(`SELECT * FROM listings WHERE seller_type='emlakci' AND is_active=1 AND days_on_site BETWEEN ? AND ? ORDER BY days_on_site DESC`, [W.min, W.max]);
    } else if (seller === 'sahibinden') {
      rows = await all(`SELECT * FROM listings WHERE seller_type='sahibinden' AND is_active=1 ORDER BY days_on_site DESC`);
    } else {
      rows = await all('SELECT * FROM listings WHERE is_active=1');
    }
    rows.forEach((r) => (r.days_left = daysLeft(r.days_on_site)));
    return sendJSON(res, 200, rows);
  }

  if (req.method === 'GET' && pathOnly === '/api/stats') {
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const c = async (q, a = []) => num((await get(q, a)).c);
    const stats = {
      total: await c('SELECT COUNT(*) c FROM listings WHERE is_active=1 AND removed=0'),
      new24h: await c('SELECT COUNT(*) c FROM listings WHERE first_seen>=?', [cutoff]),
      expiring: await c('SELECT COUNT(*) c FROM listings WHERE is_active=1 AND days_on_site BETWEEN ? AND ?', [W.min, W.max]),
      portfolio: await c('SELECT COUNT(*) c FROM listings WHERE shared=1 AND is_active=1'),
      withPhone: await c("SELECT COUNT(*) c FROM listings WHERE phone IS NOT NULL AND phone!='' AND is_active=1"),
      inquiries: await c('SELECT COUNT(*) c FROM inquiries'),
      arananlar: await c("SELECT COUNT(*) c FROM listings WHERE status!='Yeni' AND is_active=1"),
      removed: await c('SELECT COUNT(*) c FROM listings WHERE removed=1'),
      needVerify: await c("SELECT COUNT(*) c FROM listings WHERE removed=1 AND (verify_status IS NULL OR verify_status='Teyit Bekliyor')"),
      districts: await c('SELECT COUNT(DISTINCT district) c FROM listings WHERE is_active=1'),
      byDistrict: await all('SELECT district, COUNT(*) c FROM listings WHERE is_active=1 GROUP BY district ORDER BY c DESC'),
      lastScrape: (await get('SELECT MAX(last_seen) m FROM listings')).m || null,
    };
    return sendJSON(res, 200, stats);
  }

  if (req.method === 'GET' && pathOnly === '/harvester.js') {
    try { const src = fs.readFileSync(path.join(cfg.ROOT, 'harvester.js')); res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }); return res.end(src); }
    catch { res.writeHead(500); return res.end('// harvester okunamadi'); }
  }

  // --- CRM: ilan alanı güncelle ---
  if (req.method === 'POST' && pathOnly === '/api/update') {
    const body = await readBody(req);
    const { id, fields, by } = JSON.parse(body);
    const allow = ['status', 'notes', 'assignee', 'shared', 'verify_status'];
    const sets = [], vals = [];
    for (const k of allow) if (k in fields) { sets.push(`${k}=?`); vals.push(fields[k]); }
    if ('shared' in fields && fields.shared) { sets.push('consent_date=?'); vals.push(new Date().toISOString()); }
    // durum/teyit değişiminde kim+ne zaman kaydet (hesap verebilirlik)
    if (('status' in fields) || ('verify_status' in fields)) { sets.push('status_by=?'); vals.push(by || ''); sets.push('status_at=?'); vals.push(new Date().toISOString()); }
    if (sets.length) { vals.push(String(id)); await run(`UPDATE listings SET ${sets.join(',')} WHERE id=?`, vals); }
    return sendJSON(res, 200, { ok: true });
  }

  // --- aktiflik kontrol: kontrol edilecek ilanlar ---
  if (req.method === 'GET' && pathOnly === '/api/need-check') {
    // STRATEJİ: dolmaya yakın (days_on_site yüksek = ~30 güne yakın) telefonsuz ilanları ÖNCE çek.
    // Çünkü yakında yayından kalkacaklar; kalkmadan telefonu yakalamalıyız + en motive satıcı onlar.
    const rows = await all("SELECT id,url,days_on_site FROM listings WHERE removed=0 AND is_active=1 AND (phone IS NULL OR phone='') AND contact_type IS NULL ORDER BY days_on_site DESC LIMIT 400");
    return sendJSON(res, 200, rows);
  }
  if (req.method === 'POST' && pathOnly === '/api/mark-checked') {
    const body = await readBody(req); const { ids } = JSON.parse(body); const now = new Date().toISOString();
    await batchWrite(ids.map((id) => ({ sql: 'UPDATE listings SET last_check=? WHERE id=?', args: [now, String(id)] })));
    return sendJSON(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathOnly === '/api/mark-removed') {
    const body = await readBody(req); const { ids } = JSON.parse(body); const now = new Date().toISOString();
    const fresh = [];
    for (const id of ids) {
      const r = await get('SELECT * FROM listings WHERE id=? AND removed=0', [String(id)]);
      if (r) { await run("UPDATE listings SET removed=1, removed_date=?, verify_status='Teyit Bekliyor', last_check=? WHERE id=?", [now, now, String(id)]); fresh.push(r); }
    }
    sendJSON(res, 200, { ok: true, removed: fresh.length });
    if (fresh.length) notifier.notifyRemoved(fresh).catch(() => {});
    console.log(`📭 ${fresh.length} ilan yayından kalktı (teyit bekliyor)`);
    return;
  }

  // --- ID EŞLEME: liste sayfasındaki güncel ID'ler vs DB -> eksilenler = yayından kalktı (detay fetch YOK) ---
  if (req.method === 'POST' && pathOnly === '/api/reconcile') {
    const body = await readBody(req); const { district, ids } = JSON.parse(body);
    if (!district || !Array.isArray(ids) || !ids.length) return sendJSON(res, 400, { error: 'district+ids gerekli' });
    const sset = new Set(ids.map(String));
    const dbRows = await all("SELECT * FROM listings WHERE district=? AND removed=0 AND is_active=1 AND seller_type='sahibinden'", [district]);
    const gone = dbRows.filter((r) => !sset.has(String(r.id)));
    const now = new Date().toISOString();
    for (const r of gone) await run("UPDATE listings SET removed=1, removed_date=?, verify_status='Teyit Bekliyor', last_check=? WHERE id=?", [now, now, String(r.id)]);
    sendJSON(res, 200, { ok: true, checked: dbRows.length, removed: gone.length });
    if (gone.length) notifier.notifyRemoved(gone).catch(() => {});
    console.log(`🔎 reconcile ${district}: ${gone.length} kalktı / ${dbRows.length} aktif`);
    return;
  }

  // --- yeni ilanlar TEK toplu bildirim (telefonlar çekildikten sonra) ---
  if (req.method === 'POST' && pathOnly === '/api/notify-fresh') {
    const body = await readBody(req); const { ids } = JSON.parse(body);
    if (ids && ids.length) {
      const sids = ids.map(String);
      const rows = await all(`SELECT * FROM listings WHERE id IN (${sids.map(() => '?').join(',')}) AND removed=0`, sids);
      if (rows.length) notifier.notifyNew(rows).catch(() => {});
      console.log(`🔔 toplu bildirim: ${rows.length} yeni ilan`);
    }
    return sendJSON(res, 200, { ok: true });
  }

  // --- telefon eksikleri / zenginleştirme ---
  if (req.method === 'GET' && pathOnly === '/api/need-phone') {
    const rows = await all("SELECT id,url FROM listings WHERE (phone IS NULL OR phone='') AND is_active=1 ORDER BY days_on_site DESC");
    return sendJSON(res, 200, rows);
  }
  if (req.method === 'POST' && pathOnly === '/api/enrich') {
    const body = await readBody(req); const e = JSON.parse(body);
    const imgs = e.images ? (typeof e.images === 'string' ? e.images : JSON.stringify(e.images)) : null;
    await run('UPDATE listings SET phone=COALESCE(?,phone), seller_name=COALESCE(?,seller_name), ownership_type=COALESCE(?,ownership_type), verified_owner=COALESCE(?,verified_owner), description=COALESCE(?,description), images=COALESCE(?,images), contact_type=COALESCE(?,contact_type) WHERE id=?',
      [e.phone || null, e.seller_name || null, e.ownership_type || null, (e.verified_owner == null ? null : (e.verified_owner ? 1 : 0)), e.description || null, imgs, e.contact_type || null, String(e.id)]);
    // yeni ilan: telefon/detay çekildikten sonra TELEFONLA birlikte bildir
    if (e.notify) { const row = await get('SELECT * FROM listings WHERE id=?', [String(e.id)]); if (row && !row.removed) notifier.notifyNew([row]).catch(() => {}); }
    return sendJSON(res, 200, { ok: true });
  }

  // --- müşteri portföyü (izinli) ---
  if (req.method === 'GET' && pathOnly === '/api/portfolio') {
    const rows = await all("SELECT id,url,title,price,district,neighborhood,category,property_type,rooms,area_m2,image_url,listing_date FROM listings WHERE shared=1 AND is_active=1 ORDER BY price DESC");
    return sendJSON(res, 200, rows);
  }
  if (req.method === 'POST' && pathOnly === '/api/inquiry') {
    const body = await readBody(req); const q = JSON.parse(body);
    await run('INSERT INTO inquiries (created_at,name,phone,email,message,lang,item_ids) VALUES (?,?,?,?,?,?,?)',
      [new Date().toISOString(), q.name || '', q.phone || '', q.email || '', q.message || '', q.lang || 'tr', JSON.stringify(q.item_ids || [])]);
    sendJSON(res, 200, { ok: true });
    console.log(`📩 Yeni talep: ${q.name} (${q.phone}) — ${(q.item_ids || []).length} ilan`);
    return;
  }
  if (req.method === 'GET' && pathOnly === '/api/inquiries') {
    const rows = await all('SELECT * FROM inquiries ORDER BY id DESC');
    return sendJSON(res, 200, rows);
  }

  if (req.method === 'GET' && (pathOnly === '/portfolio' || pathOnly === '/musteri')) {
    try { const html = fs.readFileSync(path.join(cfg.ROOT, 'portfolio.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
    catch { res.writeHead(500); return res.end('portfolio.html yok'); }
  }

  if (req.method === 'GET' && pathOnly === '/status') {
    const byType = await all('SELECT seller_type, COUNT(*) c FROM listings GROUP BY seller_type');
    const byDist = await all('SELECT district, COUNT(*) c FROM listings GROUP BY district');
    return sendJSON(res, 200, { byType, byDist });
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Sahibinden collector calisiyor.\nGET / (panel) | POST /ingest | GET /status');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error('handler hata:', e.message); try { sendJSON(res, 500, { error: e.message }); } catch {} });
});

init().then(() => {
  server.listen(PORT, () => console.log(`✅ Collector dinliyor: http://localhost:${PORT}  (DB: ${process.env.TURSO_URL ? 'Turso bulut' : 'yerel dosya'})`));
}).catch((e) => { console.error('DB init hata:', e.message); process.exit(1); });
