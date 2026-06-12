// collector.js — yerel toplayici sunucu. Tarayicidan (gercek Chrome) gelen ilanlari SQLite'a yazar.
// Tarayici tarafindaki harvester ayni-origin fetch ile sayfalari ceker, buraya POST eder.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { db, upsertListing } = require('./db');
const { parseTrDate, parsePrice, detectType, splitLocation, bestImage } = require('./lib');
const cfg = require('./config');
const notifier = require('./notifier');
const priceStmt = db.prepare('SELECT price FROM listings WHERE id=?');

const PORT = 7777;
const BASE = 'https://www.sahibinden.com';
const EXP = cfg.EXPIRY_ESTIMATE_DAYS;
const W = cfg.EXPIRY_WINDOW;
const daysLeft = (d) => (d == null ? null : Math.max(0, EXP - d));

// --- auth: tek ekip sifresi (panel) + token (eklenti) ---
const crypto = require('crypto');
let TEAM_PASS = 'bircan', TOKEN = '';
try { TEAM_PASS = JSON.parse(fs.readFileSync(path.join(cfg.OUTPUT_DIR, 'auth.json'), 'utf8')).password || TEAM_PASS; } catch {}
try { TOKEN = fs.readFileSync(path.join(cfg.OUTPUT_DIR, '.token'), 'utf8').trim(); } catch {}
const SID = crypto.createHash('sha256').update(TEAM_PASS + '::bircan').digest('hex').slice(0, 32);
const authed = (req) => (req.headers.cookie || '').includes('bircan_sid=' + SID);
const hasToken = (req) => (req.headers['x-token'] || '') === TOKEN;
const PUBLIC = ['/login', '/portfolio', '/musteri', '/api/portfolio', '/api/inquiry', '/harvester.js', '/kur'];
const TOKENR = ['/ingest', '/api/enrich', '/api/need-phone'];
const LOGIN_HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Giriş · Bircan Akın</title>
<style>body{font-family:-apple-system,Arial;background:#0b1020;color:#e7ecf6;display:flex;height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#151b30;padding:34px;border-radius:16px;border:1px solid #26304d;width:320px;text-align:center}
h2{color:#4f8cff;margin:0 0 18px}input{width:100%;padding:12px;border-radius:10px;border:1px solid #26304d;background:#0b1020;color:#fff;margin-bottom:12px;box-sizing:border-box}
button{width:100%;padding:12px;border:none;border-radius:10px;background:#4f8cff;color:#fff;font-weight:700;cursor:pointer}</style></head>
<body><form method="POST" action="/login"><h2>🏠 Bircan Akın CRM</h2><input type="password" name="password" placeholder="Ekip şifresi" autofocus><button>Giriş</button></form></body></html>`;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // Chrome Private Network Access: https sayfadan http://localhost'a izin
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function normalize(meta, x) {
  const { iso, days } = parseTrDate(x.dateTxt);
  const { semt, mahalle } = splitLocation(x.locTxt);
  let area = null, rooms = null;
  for (const v of (x.attrs || [])) {
    if (/\+/.test(v) && !rooms) rooms = v;
    else if (/^\d[\d.]*$/.test(v) && !area) area = parseInt(v.replace(/\./g, ''), 10);
  }
  const href = x.href || '';
  const category = /kiralik/i.test(href) ? 'Kiralık' : 'Satılık'; // gercek txn href'ten
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

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // login
  if (req.method === 'POST' && req.url === '/login') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const p = decodeURIComponent((b.match(/password=([^&]*)/) || [])[1] || '').replace(/\+/g, ' ');
      if (p === TEAM_PASS) { res.writeHead(302, { 'Set-Cookie': `bircan_sid=${SID}; Path=/; HttpOnly; Max-Age=2592000`, Location: '/' }); res.end(); }
      else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(LOGIN_HTML.replace('Ekip şifresi', 'Hatalı şifre — tekrar dene')); }
    });
    return;
  }
  // auth kapisi: public degilse cookie veya token gerek
  const pathOnly = req.url.split('?')[0];
  if (!PUBLIC.includes(pathOnly)) {
    if (!(authed(req) || (TOKENR.includes(pathOnly) && hasToken(req)))) {
      if (pathOnly.startsWith('/api') || pathOnly === '/ingest') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"auth"}'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML);
    }
  }

  if (req.method === 'POST' && req.url === '/ingest') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { meta, rows } = JSON.parse(body);
        let n = 0; const fresh = []; const drops = [];
        const tx = db.transaction(() => {
          for (const x of rows) {
            if (!x || !x.id) continue;
            const rec = normalize(meta, x);
            if (rec.category === 'Kiralık') continue;
            const old = priceStmt.get(rec.id);
            upsertListing(rec); n++;
            if (!old) fresh.push(rec);
            else if (old.price && rec.price && rec.price < old.price) drops.push({ ...rec, oldPrice: old.price });
          }
        });
        tx();
        const total = db.prepare('SELECT COUNT(*) c FROM listings').get().c;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, processed: n, fresh: fresh.length, drops: drops.length, total }));
        console.log(`+${n} (${meta.district}/${meta.categoryTxn}) yeni:${fresh.length} düşüş:${drops.length} -> DB ${total}`);
        if (fresh.length) notifier.notifyNew(fresh).catch(() => {});
        if (drops.length) notifier.notifyPriceDrops(drops).catch(() => {});
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/index'))) {
    try { const html = fs.readFileSync(path.join(cfg.ROOT, 'dashboard.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
    catch (e) { res.writeHead(500); return res.end('dashboard.html okunamadi'); }
  }

  if (req.method === 'GET' && req.url.startsWith('/api/listings')) {
    const u = new URL(req.url, 'http://x');
    const seller = u.searchParams.get('seller');
    let rows;
    if (seller === 'emlakci') {
      rows = db.prepare(`SELECT * FROM listings WHERE seller_type='emlakci' AND is_active=1
        AND days_on_site BETWEEN ? AND ? ORDER BY days_on_site DESC`).all(W.min, W.max);
    } else if (seller === 'sahibinden') {
      rows = db.prepare(`SELECT * FROM listings WHERE seller_type='sahibinden' AND is_active=1
        ORDER BY days_on_site DESC`).all();
    } else {
      rows = db.prepare('SELECT * FROM listings WHERE is_active=1').all();
    }
    rows.forEach((r) => (r.days_left = daysLeft(r.days_on_site)));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(rows));
  }

  if (req.method === 'GET' && req.url === '/api/stats') {
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const one = (q, ...a) => db.prepare(q).get(...a).c;
    const stats = {
      total: one('SELECT COUNT(*) c FROM listings WHERE is_active=1'),
      new24h: one('SELECT COUNT(*) c FROM listings WHERE first_seen>=?', cutoff),
      expiring: one('SELECT COUNT(*) c FROM listings WHERE is_active=1 AND days_on_site BETWEEN ? AND ?', W.min, W.max),
      portfolio: one('SELECT COUNT(*) c FROM listings WHERE shared=1 AND is_active=1'),
      withPhone: one("SELECT COUNT(*) c FROM listings WHERE phone IS NOT NULL AND phone!='' AND is_active=1"),
      inquiries: one('SELECT COUNT(*) c FROM inquiries'),
      arananlar: one("SELECT COUNT(*) c FROM listings WHERE status!='Yeni' AND is_active=1"),
      districts: one('SELECT COUNT(DISTINCT district) c FROM listings WHERE is_active=1'),
      byDistrict: db.prepare('SELECT district, COUNT(*) c FROM listings WHERE is_active=1 GROUP BY district ORDER BY c DESC').all(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(stats));
  }

  if (req.method === 'GET' && req.url.startsWith('/harvester.js')) {
    try {
      const src = fs.readFileSync(path.join(cfg.ROOT, 'harvester.js'));
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end(src);
    } catch (e) { res.writeHead(500); return res.end('// harvester okunamadi'); }
  }

  if (req.method === 'GET' && req.url === '/kur') {
    try {
      // bookmarklet = yukleyici: her tikta en guncel harvester'i localhost'tan ceker (yeniden kurma gerekmez)
      const bm = "javascript:(function(){fetch('http://localhost:7777/harvester.js?'+Date.now()).then(r=>r.text()).then(t=>eval(t)).catch(e=>alert('Yükleme hatası: '+e+'\\ncollector çalışıyor mu?'))})();";
      const escAttr = bm.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const escTa = bm.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Kurulum · Bircan Akın</title>
<style>body{font-family:-apple-system,Segoe UI,Arial;background:#0b1020;color:#e7ecf6;max-width:780px;margin:40px auto;padding:0 20px;line-height:1.7}
.btn{display:inline-block;background:#4f8cff;color:#fff;padding:16px 26px;border-radius:12px;text-decoration:none;font-weight:800;font-size:17px;cursor:grab}
.step{background:#151b30;border:1px solid #26304d;border-radius:12px;padding:16px 20px;margin:14px 0}
code{background:#0b1020;padding:2px 7px;border-radius:6px;color:#9cc0ff}
textarea{width:100%;height:80px;background:#0b1020;color:#9cc0ff;border:1px solid #26304d;border-radius:8px;padding:10px;font:12px monospace;margin-top:8px}
h2{color:#4f8cff}.big{font-size:15px}</style></head><body>
<h2>🏠 Bircan Akın · İlan Tarama — Kurulum (tek sefer)</h2>
<div class="step big"><b>1.</b> Yer imleri çubuğunu aç: <code>Cmd+Shift+B</code></div>
<div class="step big"><b>2.</b> Aşağıdaki mavi butonu <b>yer imleri çubuğuna SÜRÜKLE</b> (tıklama — basılı tutup sürükle-bırak):<br><br>
  <a class="btn" href="${escAttr}">🏠 İlanları Tara</a></div>
<div class="step big"><b>3.</b> Bir <b>sahibinden ilan listesi sayfasındayken</b> çubuktaki <b>"🏠 İlanları Tara"</b> yer imine <b>tıkla</b>. Sağ altta yeşil kutu çıkar, 5 ilçe taranır, panel <a style="color:#4f8cff" href="/">localhost:7777</a> canlı dolar.</div>
<div class="step">Sürükleme olmadıysa: tarayıcıda <b>yeni yer imi</b> ekle → <b>Ad:</b> İlanları Tara → <b>URL:</b> alanına şunu yapıştır:
  <textarea readonly onclick="this.select()">${escTa}</textarea></div>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) { res.writeHead(500); return res.end('kur hata: ' + e.message); }
  }

  // --- CRM: ilan alani guncelle (durum/not/atanan/portfoy) ---
  if (req.method === 'POST' && req.url === '/api/update') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { id, fields } = JSON.parse(body);
        const allow = ['status', 'notes', 'assignee', 'shared'];
        const sets = [], vals = [];
        for (const k of allow) if (k in fields) { sets.push(`${k}=?`); vals.push(fields[k]); }
        if ('shared' in fields && fields.shared) { sets.push('consent_date=?'); vals.push(new Date().toISOString()); }
        if (sets.length) { vals.push(String(id)); db.prepare(`UPDATE listings SET ${sets.join(',')} WHERE id=?`).run(...vals); }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // --- telefonu eksik ilanlar (detay-zenginlestirme icin) ---
  if (req.method === 'GET' && req.url === '/api/need-phone') {
    const rows = db.prepare("SELECT id,url FROM listings WHERE (phone IS NULL OR phone='') AND is_active=1 ORDER BY days_on_site DESC").all();
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(rows));
  }

  // --- detaydan gelen zenginlestirme (telefon/satici/tapu) ---
  if (req.method === 'POST' && req.url === '/api/enrich') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const e = JSON.parse(body);
        db.prepare('UPDATE listings SET phone=COALESCE(?,phone), seller_name=COALESCE(?,seller_name), ownership_type=COALESCE(?,ownership_type), verified_owner=COALESCE(?,verified_owner) WHERE id=?')
          .run(e.phone || null, e.seller_name || null, e.ownership_type || null, (e.verified_owner == null ? null : (e.verified_owner ? 1 : 0)), String(e.id));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
    });
    return;
  }

  // --- Musteri portfoyu: sadece izinli (shared=1) ilanlar ---
  if (req.method === 'GET' && req.url.startsWith('/api/portfolio')) {
    const rows = db.prepare("SELECT id,url,title,price,district,neighborhood,category,property_type,rooms,area_m2,image_url,listing_date FROM listings WHERE shared=1 AND is_active=1 ORDER BY price DESC").all();
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(rows));
  }

  // --- Musteri talebi (sepet/sürec baslat) ---
  if (req.method === 'POST' && req.url === '/api/inquiry') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const q = JSON.parse(body);
        db.prepare('INSERT INTO inquiries (created_at,name,phone,email,message,lang,item_ids) VALUES (?,?,?,?,?,?,?)')
          .run(new Date().toISOString(), q.name || '', q.phone || '', q.email || '', q.message || '', q.lang || 'tr', JSON.stringify(q.item_ids || []));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
        console.log(`📩 Yeni talep: ${q.name} (${q.phone}) — ${(q.item_ids || []).length} ilan`);
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/inquiries') {
    const rows = db.prepare('SELECT * FROM inquiries ORDER BY id DESC').all();
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(rows));
  }

  if (req.method === 'GET' && (req.url === '/portfolio' || req.url === '/musteri')) {
    try { const html = fs.readFileSync(path.join(cfg.ROOT, 'portfolio.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
    catch (e) { res.writeHead(500); return res.end('portfolio.html yok'); }
  }

  if (req.method === 'GET' && req.url === '/status') {
    const byType = db.prepare("SELECT seller_type, COUNT(*) c FROM listings GROUP BY seller_type").all();
    const byDist = db.prepare("SELECT district, COUNT(*) c FROM listings GROUP BY district").all();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ byType, byDist }, null, 2));
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Sahibinden collector calisiyor.\nGET / (panel) | POST /ingest | GET /status');
});

server.listen(PORT, () => console.log(`✅ Collector dinliyor: http://localhost:${PORT}  (GET /status ile sayıları gör)`));
