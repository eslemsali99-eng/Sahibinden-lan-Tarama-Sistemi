/* Bircan Akın · İlan Tarama — content script  [v4 · KONUT SATILIK · EV SAHİBİ · resume + telefon] */
(function () {
  if (window.__bircanV4) return; window.__bircanV4 = true;
  const VER = 'v4';
  const CFG = window.BIRCAN_CFG || { collector: 'https://bircan-emlak-crm.onrender.com', token: '' };
  const ING = CFG.collector + '/ingest', ENR = CFG.collector + '/api/enrich', NEED = CFG.collector + '/api/need-phone';
  const TOK = CFG.token; // config.js'ten (gitignore'lu)
  const OCR_KEY = CFG.ocrKey || 'helloworld'; // ocr.space ücretsiz key (config.js'e ocrKey ekle, daha yüksek limit)
  const BASE = 'https://www.sahibinden.com';
  const MAX_PAGES = 60, PAGE_MIN = 3500, PAGE_MAX = 7000, DIST_MIN = 7000, DIST_MAX = 12000;
  const DISTRICTS = [
    { name: 'Osmangazi', slug: 'bursa-osmangazi' },
    { name: 'Nilüfer', slug: 'bursa-nilufer' }, { name: 'Karacabey', slug: 'bursa-karacabey' },
    { name: 'Mudanya', slug: 'bursa-mudanya' },
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));
  // telefonu TR formatına normalize et; geçersizse null (çöp telefon kaydetme)
  function normPhone(raw) {
    if (!raw) return null;
    let d = String(raw).replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('90')) d = d.slice(2);
    if (d.length === 10) d = '0' + d;
    if (d.length === 11 && d[0] === '0' && '2345'.includes(d[1])) return d.slice(0, 4) + ' ' + d.slice(4, 7) + ' ' + d.slice(7, 9) + ' ' + d.slice(9);
    return null;
  }
  const DONE = () => JSON.parse(localStorage.getItem('bircan_done') || '[]');
  const setDone = (a) => localStorage.setItem('bircan_done', JSON.stringify(a));

  function mkBtn(txt, bottom, color) {
    const b = document.createElement('button');
    b.textContent = txt;
    b.style.cssText = `position:fixed;z-index:2147483647;right:16px;bottom:${bottom}px;background:${color};color:#fff;border:none;border-radius:12px;padding:13px 18px;font:700 14px/1 -apple-system,Arial;box-shadow:0 6px 24px rgba(0,0,0,.35);cursor:pointer`;
    document.body.appendChild(b); return b;
  }
  // TEK buton tek algoritma: 7/24 Oto = tarama + telefon/detay + aktiflik + toplu bildirim
  const btn3 = mkBtn('🔄 7/24 Oto', 24, '#555');
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:210px;width:340px;max-height:48vh;overflow:auto;background:#111;color:#0f0;font:12px/1.4 monospace;padding:10px;border-radius:10px;display:none;box-shadow:0 6px 24px rgba(0,0,0,.4)';
  document.body.appendChild(box);
  const log = (m, c) => { box.style.display = 'block'; const d = document.createElement('div'); if (c) d.style.color = c; d.textContent = m; box.appendChild(d); box.scrollTop = box.scrollHeight; };

  function parsePage(doc) {
    return [...doc.querySelectorAll('tr.searchResultsItem[data-id]')].map((r) => {
      if (/nativeAd/i.test(r.className)) return null;
      const q = (s) => { const e = r.querySelector(s); return e ? e.textContent.trim().replace(/\s+/g, ' ') : null; };
      const a = r.querySelector('a.classifiedTitle'); const img = r.querySelector('img');
      return { id: r.getAttribute('data-id'), title: q('a.classifiedTitle'), href: a && a.getAttribute('href'),
        priceTxt: q('.searchResultsPriceValue'), dateTxt: q('.searchResultsDateValue'), locTxt: q('.searchResultsLocationValue'),
        attrs: [...r.querySelectorAll('.searchResultsAttributeValue')].map((e) => e.textContent.trim()),
        imgSrc: img && (img.getAttribute('src') || img.getAttribute('data-src')) };
    }).filter(Boolean);
  }
  async function jpost(url, obj) {
    for (let t = 0; t < 3; t++) { try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-token': TOK }, body: JSON.stringify(obj) }); return await r.json(); } catch (e) { if (t === 2) throw e; await sleep(2500); } }
  }
  async function getPage(url) {
    for (let t = 0; t < 4; t++) {
      let html = ''; try { html = await (await fetch(url, { credentials: 'include' })).text(); } catch (e) { html = ''; }
      if (html && !/Basılı Tut|Olağan dışı|Bağlantınız kontrol/i.test(html)) return { ok: true, doc: new DOMParser().parseFromString(html, 'text/html') };
      log(`   ⏳ doğrulama — 15sn bekle-tekrar (${t + 1}/4)`, '#fa0'); await sleep(15000);
    }
    return { ok: false };
  }

  // Foto-OCR (BLOKSUZ): ev sahipleri telefonu sık sık fotoğrafa yazıyor. Fotoğraf CDN'de (i0.shbdn.com),
  // DataDome korumasız -> ocr.space ile okuyup telefonu çıkar. Hiç detay sayfası açmadan = sıfır blok.
  async function ocrPhone(imgUrl) {
    if (!imgUrl) return null;
    const cands = [...new Set([imgUrl.replace(/\/(x5|x2|thmb|small|org)_/i, '/x10_'), imgUrl])];
    for (const u of cands) {
      try {
        const r = await fetch(`https://api.ocr.space/parse/imageurl?apikey=${OCR_KEY}&OCREngine=2&url=${encodeURIComponent(u)}`);
        const j = await r.json();
        const txt = (j && j.ParsedResults && j.ParsedResults[0] && j.ParsedResults[0].ParsedText) || '';
        const p = normPhone((txt.match(/0?\s?5\d{2}[\s)\-.]*\d{3}[\s\-.]*\d{2}[\s\-.]*\d{2}/) || [])[0]);
        if (p) return p;
      } catch (e) {}
      await sleep(1200);
    }
    return null;
  }

  // --- detaydan çıkarım: aktif mi? + telefon/tapu/açıklama/görseller ---
  async function checkOne(url) {
    let html = '', status = 0;
    try { const r = await fetch(url, { credentials: 'include' }); status = r.status; html = await r.text(); } catch (e) { return { err: true }; }
    if (/Basılı Tut|Olağan dışı|Bağlantınız kontrol/i.test(html)) return { challenge: true };
    if (status === 404 || /yayından kaldır|yayında olmayan|yayında değil|ilana ulaşılam|ilan bulunamad|kaldırılmış|sona ermiş|yayında bulun/i.test(html)) return { removed: true };
    // AKTİF: aynı sayfadan telefon + tapu + açıklama + görseller (ekstra istek yok, IP yormaz)
    let phone = null, tapu = null, description = null, images = [];
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // 1) en güvenilir: tel: linki   2) sahibinden telefon kutusu   3) JSON/meta   4) regex fallback
      const telA = doc.querySelector('a[href^="tel:"]');
      if (telA) phone = normPhone(telA.getAttribute('href'));
      if (!phone) { const pe = doc.querySelector('.pretty-phone-part, #phoneList, .phone-line, .megaPhoneBox, .classifiedUserPhone, [class*="hone"]'); if (pe) phone = normPhone((pe.textContent.match(/0?\s?5\d{2}[\s)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/) || [])[0]); }
      if (!phone) { const m = html.match(/"phone\w*"\s*:\s*"?(\+?90?5\d{9})/i); if (m) phone = normPhone(m[1]); }
      const txt = doc.body ? doc.body.innerText : '';
      if (!phone) phone = normPhone((txt.match(/0?\s?5\d{2}[\s)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/) || [])[0]
        || (txt.match(/0?\s?2\d{2}[\s)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/) || [])[0]);
      tapu = (txt.match(/Tapu Durumu\s*:?\s*([A-Za-zÇĞİÖŞÜçğıöşü\/ ]{3,30})/) || [])[1] || null;
      if (tapu) tapu = tapu.trim();
      const dEl = doc.querySelector('#classifiedDescription, .classifiedDescription, .classified-detail-desc');
      description = dEl ? dEl.innerText.trim().replace(/\n{3,}/g, '\n\n').slice(0, 4000) : null;
      const seen = new Set();
      doc.querySelectorAll('img').forEach((im) => {
        const s = im.getAttribute('src') || im.getAttribute('data-src') || '';
        if (/shbdn\.com|\/photos\//i.test(s) && !seen.has(s)) { seen.add(s); images.push(s); }
      });
      images = images.slice(0, 12);
    } catch (e) {}
    const contact_type = phone ? 'phone' : 'message';
    return { active: true, phone, tapu, description, images, contact_type };
  }
  // --- 7/24 OTO: TEK döngüde tarama + yeni-ilan telefon/detay/bildirim + aktiflik kontrol ---
  const AUTO_MS = 60 * 60 * 1000;
  let autoTimer = null;
  const U = (p) => ING.replace('/ingest', p);
  function setBlock() { localStorage.setItem('bircan_blocked_until', String(Date.now() + 3 * 3.6e6)); log('🚫 doğrulama/blok — IP dinlensin diye 3 saat beklenecek', '#f55'); }

  // eski/telefonsuz ilanları kontrol et: kalkanları işaretle + telefon/açıklama/görsel çek
  async function checkBatch(limit) {
    let list; try { list = await fetch(U('/api/need-check'), { headers: { 'x-token': TOK } }).then((r) => r.json()); } catch (e) { return; }
    list = (list || []).slice(0, limit);
    if (!list.length) return;
    log(`📋 aktiflik+telefon: ${list.length} ilan`, '#fa0');
    let removed = [], active = [], gone = 0, phones = 0;
    for (const it of list) {
      // 1) BLOKSUZ önce: fotoğraftan OCR ile telefon dene (detay açmadan)
      const op = await ocrPhone(it.image_url);
      if (op) {
        try { await jpost(U('/api/enrich'), { id: it.id, phone: op, contact_type: 'phone', verified_owner: 1 }); } catch (e) {}
        phones++; active.push(it.id);
        if (active.length >= 40) { try { await jpost(U('/api/mark-checked'), { ids: active }); } catch (e) {} active = []; }
        await sleep(rnd(2000, 4000)); continue;
      }
      // 2) detay fetch (telefon + açıklama + görsel + aktiflik)
      const r = await checkOne(it.url.startsWith('http') ? it.url : BASE + it.url);
      if (r.challenge) { setBlock(); break; }
      if (r.removed) { removed.push(it.id); gone++; }
      else if (r.active) { active.push(it.id); try { await jpost(U('/api/enrich'), { id: it.id, phone: r.phone, ownership_type: r.tapu, description: r.description, images: r.images, contact_type: r.contact_type, verified_owner: 1 }); if (r.phone) phones++; } catch (e) {} }
      if (removed.length >= 10) { try { await jpost(U('/api/mark-removed'), { ids: removed }); } catch (e) {} removed = []; }
      if (active.length >= 40) { try { await jpost(U('/api/mark-checked'), { ids: active }); } catch (e) {} active = []; }
      await sleep(rnd(8000, 16000));
    }
    if (removed.length) try { await jpost(U('/api/mark-removed'), { ids: removed }); } catch (e) {}
    if (active.length) try { await jpost(U('/api/mark-checked'), { ids: active }); } catch (e) {}
    log(`   kontrol: ${gone} kalkmış · ${phones} telefon`, '#0f0');
  }

  // KALKAN TESPİTİ (Fikir 2): tam liste sayfalarındaki ID'leri topla -> sunucuda DB ile eşle.
  // Bizde olup sahibinden listesinde OLMAYAN = yayından kalktı. DETAY FETCH YOK -> blok yok. Günde ~1.
  const SWEEP_MS = 20 * 60 * 60 * 1000;
  async function removalSweep() {
    const last = +(localStorage.getItem('bircan_lastsweep') || 0);
    if (Date.now() - last < SWEEP_MS) return;
    localStorage.setItem('bircan_lastsweep', String(Date.now())); // slotu hemen al
    log('🔎 yayından kalkan taraması (tam liste, detaysız)...', '#9cf');
    for (const d of DISTRICTS) {
      const ids = []; let complete = true;
      for (let p = 0; p < MAX_PAGES; p++) {
        const res = await getPage(`${BASE}/satilik/${d.slug}/sahibinden?sorting=date_desc&pagingOffset=${p * 20}`);
        if (!res.ok) { complete = false; setBlock(); break; }
        const rows = parsePage(res.doc); if (!rows.length) break;
        rows.forEach((r) => ids.push(r.id));
        try { await jpost(ING, { meta: { district: d.name, baseType: 'Konut', sellerType: 'sahibinden', bulk: true }, rows }); } catch (e) {}
        await sleep(rnd(PAGE_MIN, PAGE_MAX));
        if (rows.length < 20) break;
      }
      // SADECE tam tamamlanan ilçede diff yap (yarım kalırsa yanlış 'kalktı' demesin)
      if (complete && ids.length) {
        try { const r = await jpost(U('/api/reconcile'), { district: d.name, ids }); if (r && r.removed) log(`   📭 ${d.name}: ${r.removed} yayından kalktı (teyit bekliyor)`, '#fa0'); } catch (e) {}
      } else { log(`   ⏸️ ${d.name} yarım kaldı — diff atlandı`, '#888'); if (!complete) break; }
      await sleep(rnd(DIST_MIN, DIST_MAX));
    }
    log('   ✅ kalkan taraması bitti', '#0f0');
  }

  async function autoCycle() {
    const bu = +(localStorage.getItem('bircan_blocked_until') || 0);
    if (Date.now() < bu) { log(`⏸️ blok bekleme — ~${Math.ceil((bu - Date.now()) / 3.6e6)} saat sonra`, '#fa0'); return; }
    log(`🔄 oto tur ${new Date().toLocaleTimeString('tr-TR')}`, '#9cf');
    // 1) TARAMA: her ilçe ilk 2 sayfa -> yeni ilan url'leri
    const fresh = [];
    for (const d of DISTRICTS) {
      const meta = { district: d.name, categoryTxn: 'Satılık', baseType: 'Konut', sellerType: 'sahibinden' };
      for (let p = 0; p < 2; p++) {
        const res = await getPage(`${BASE}/satilik/${d.slug}/sahibinden?sorting=date_desc&pagingOffset=${p * 20}`);
        if (!res.ok) { setBlock(); return; }
        const rows = parsePage(res.doc); if (!rows.length) break;
        try { const r = await jpost(ING, { meta, rows }); if (r && r.freshUrls && r.freshUrls.length) { fresh.push(...r.freshUrls); log(`   +${r.freshUrls.length} yeni (${d.name})`, '#0f0'); } } catch (e) { return; }
        await sleep(rnd(PAGE_MIN, PAGE_MAX));
      }
      await sleep(rnd(DIST_MIN, DIST_MAX));
    }
    // 2) YENİ ilanları detaydan zenginleştir (telefon/açıklama/görsel) — burada NOTIFY YOK
    const freshIds = fresh.map((f) => String(f.id));
    const CAP = 12; // bir turda en fazla 12 yeni detay (burst -> blok riskini sınırla)
    for (let k = 0; k < fresh.length && k < CAP; k++) {
      const f = fresh[k];
      const r = await checkOne(f.url.startsWith('http') ? f.url : BASE + f.url);
      if (r.challenge) { // detay bloklandı -> kalan yenilerde BLOKSUZ Foto-OCR dene, sonra dur
        for (let j = k; j < fresh.length && j < CAP; j++) { const op = await ocrPhone(fresh[j].img); if (op) { try { await jpost(ENR, { id: fresh[j].id, phone: op, contact_type: 'phone', verified_owner: 1 }); } catch (e) {} } }
        setBlock(); break;
      }
      if (r.removed) { try { await jpost(U('/api/mark-removed'), { ids: [f.id] }); } catch (e) {} continue; }
      let phone = r.phone, ctype = r.contact_type;
      if (!phone) { const op = await ocrPhone(f.img); if (op) { phone = op; ctype = 'phone'; } } // detayda telefon yoksa fotodan dene
      try { await jpost(ENR, { id: f.id, verified_owner: 1, phone, ownership_type: r.tapu, description: r.description, images: r.images, contact_type: ctype }); } catch (e) {}
      await sleep(rnd(PAGE_MIN, PAGE_MAX));
    }
    // TEK TOPLU bildirim (telefonlar çekilmiş halde) — sel yok, tek mesajda hepsi telefonuyla
    if (freshIds.length) { try { await jpost(U('/api/notify-fresh'), { ids: freshIds }); } catch (e) {} log(`   🔔 ${freshIds.length} yeni ilan → tek toplu bildirim`, '#0f0'); }
    // 3) KALKAN TESPİTİ: günde 1 kez tam liste ID-diff (detaysız, robust) — en önemli kısım
    if (Date.now() >= +(localStorage.getItem('bircan_blocked_until') || 0)) await removalSweep();
    // 4) TELEFON: telefonsuz birkaç ilanı detaydan doldur (hafif, blok riski sınırlı)
    if (Date.now() >= +(localStorage.getItem('bircan_blocked_until') || 0)) await checkBatch(10);
    log(`✅ tur bitti`, '#0f0');
  }
  function setAuto(on) {
    localStorage.setItem('bircan_auto', on ? '1' : '');
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (on) { btn3.textContent = '🔄 7/24 AÇIK'; btn3.style.background = '#2e7d32'; autoCycle(); autoTimer = setInterval(autoCycle, AUTO_MS); }
    else { btn3.textContent = '🔄 7/24 Oto'; btn3.style.background = '#555'; }
  }
  btn3.onclick = () => setAuto(localStorage.getItem('bircan_auto') !== '1');
  if (localStorage.getItem('bircan_auto') === '1') setTimeout(() => setAuto(true), 4000);
})();
