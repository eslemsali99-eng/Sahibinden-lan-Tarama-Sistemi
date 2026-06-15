/* Bircan Akın · İlan Tarama — content script  [v4 · KONUT SATILIK · EV SAHİBİ · resume + telefon] */
(function () {
  if (window.__bircanV4) return; window.__bircanV4 = true;
  const VER = 'v4';
  const CFG = window.BIRCAN_CFG || { collector: 'https://bircan-emlak-crm.onrender.com', token: '' };
  const ING = CFG.collector + '/ingest', ENR = CFG.collector + '/api/enrich', NEED = CFG.collector + '/api/need-phone';
  const TOK = CFG.token; // config.js'ten (gitignore'lu)
  const BASE = 'https://www.sahibinden.com';
  const MAX_PAGES = 60, PAGE_MIN = 3500, PAGE_MAX = 7000, DIST_MIN = 7000, DIST_MAX = 12000;
  const DISTRICTS = [
    { name: 'Osmangazi', slug: 'bursa-osmangazi' },
    { name: 'Nilüfer', slug: 'bursa-nilufer' }, { name: 'Karacabey', slug: 'bursa-karacabey' },
    { name: 'Mudanya', slug: 'bursa-mudanya' },
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));
  const DONE = () => JSON.parse(localStorage.getItem('bircan_done') || '[]');
  const setDone = (a) => localStorage.setItem('bircan_done', JSON.stringify(a));

  function mkBtn(txt, bottom, color) {
    const b = document.createElement('button');
    b.textContent = txt;
    b.style.cssText = `position:fixed;z-index:2147483647;right:16px;bottom:${bottom}px;background:${color};color:#fff;border:none;border-radius:12px;padding:13px 18px;font:700 14px/1 -apple-system,Arial;box-shadow:0 6px 24px rgba(0,0,0,.35);cursor:pointer`;
    document.body.appendChild(b); return b;
  }
  // Telefon çekme butonu IP yorduğu için kaldırıldı. Sadece hafif tarama + 7/24 + aktiflik kontrol.
  const btn = mkBtn('🏠 İlanları Tara', 116, '#4f8cff');
  const btn4 = mkBtn('📋 Aktiflik Kontrol', 24, '#c0392b');
  const btn3 = mkBtn('🔄 7/24 Oto', 70, '#555');
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

  async function harvest() {
    btn.disabled = true; btn.textContent = '⏳...'; box.innerHTML = '';
    let done = DONE(); if (done.length >= DISTRICTS.length) { done = []; setDone(done); }
    log(`Bircan Akın ${VER} · konut satılık · ev sahibi  (tamamlanan: ${done.join(',') || '-'})`, '#9cf');
    let grand = 0;
    for (const d of DISTRICTS) {
      if (done.includes(d.name)) { log(`↷ ${d.name} zaten tamam, atlandı`, '#888'); continue; }
      // bulk:true -> toplu tarama; sunucu bildirim ATMAZ (WhatsApp/Telegram seli olmasın)
      const meta = { district: d.name, categoryTxn: 'Satılık', baseType: 'Konut', sellerType: 'sahibinden', bulk: true };
      log(`▶ ${d.name} ...`, '#ff0');
      let got = 0, blocked = false;
      for (let p = 0; p < MAX_PAGES; p++) {
        const res = await getPage(`${BASE}/satilik/${d.slug}/sahibinden?sorting=date_desc&pagingOffset=${p * 20}`);
        if (!res.ok) { blocked = true; break; }
        const rows = parsePage(res.doc); if (rows.length === 0) break;
        try { grand = (await jpost(ING, { meta, rows })).total; } catch (e) { log('⚠️ collector yok: ' + e.message, '#f55'); btn.disabled = false; btn.textContent = '🏠 İlanları Tara'; return; }
        got += rows.length; await sleep(rnd(PAGE_MIN, PAGE_MAX)); if (rows.length < 20) break;
      }
      if (blocked) {
        log(`⏸️ ${d.name} doğrulamaya takıldı. Bu sekmeyi YENİLE, "Basılı Tut" çıkarsa geç, sonra tekrar "İlanları Tara"ya bas — kaldığı yerden devam eder.`, '#fa0');
        alert(`${d.name} doğrulamaya takıldı.\n1) Bu sekmeyi yenile (Cmd+R)\n2) "Basılı Tut" çıkarsa geç\n3) Tekrar "İlanları Tara"ya bas\nTamamlanan ilçeler korunur, kaldığı yerden devam eder.`);
        btn.disabled = false; btn.textContent = '🏠 İlanları Tara'; return;
      }
      done.push(d.name); setDone(done);
      log(`   ✓ ${d.name}: ${got} | DB: ${grand}`, '#0f0');
      await sleep(rnd(DIST_MIN, DIST_MAX));
    }
    log(`✅ TÜM İLÇELER TAMAM. DB toplam: ${grand}. Artık "🔄 7/24 Oto"ya basıp bırakabilirsin.`, '#0f0');
    setDone([]); // sonraki tam tarama icin sifirla
    btn.disabled = false; btn.textContent = '🏠 İlanları Tara';
  }

  // --- AKTİFLİK KONTROL: sahibinden'de hâlâ var mı? yoksa 'yayından kalktı' işaretle ---
  async function checkOne(url) {
    let html = '', status = 0;
    try { const r = await fetch(url, { credentials: 'include' }); status = r.status; html = await r.text(); } catch (e) { return { err: true }; }
    if (/Basılı Tut|Olağan dışı|Bağlantınız kontrol/i.test(html)) return { challenge: true };
    if (status === 404 || /yayından kaldır|yayında olmayan|yayında değil|ilana ulaşılam|ilan bulunamad|kaldırılmış|sona ermiş|yayında bulun/i.test(html)) return { removed: true };
    // AKTİF: aynı sayfadan telefon + tapu + açıklama + görseller (ekstra istek yok, IP yormaz)
    let phone = null, tapu = null, description = null, images = [];
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const txt = doc.body ? doc.body.innerText : '';
      phone = (txt.match(/0?\s?5\d{2}[\s)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/) || [])[0]
        || (txt.match(/0?\s?2\d{2}[\s)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/) || [])[0] || null;
      if (phone) phone = phone.replace(/\s+/g, ' ').trim();
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
  async function checkActive() {
    btn4.disabled = true; btn4.textContent = '⏳...'; box.innerHTML = '';
    const U = (p) => NEED.replace('/api/need-phone', p);
    let list; try { list = await fetch(U('/api/need-check'), { headers: { 'x-token': TOK } }).then(r => r.json()); } catch (e) { alert('collector yok'); btn4.disabled = false; btn4.textContent = '📋 Aktiflik Kontrol'; return; }
    log(`📋 ${list.length} ilan aktiflik kontrolü başladı...`, '#fa0');
    let removed = [], active = [], i = 0, totalRemoved = 0, totalPhone = 0;
    for (const it of list) {
      const url = it.url.startsWith('http') ? it.url : BASE + it.url;
      const r = await checkOne(url);
      if (r.challenge) { log('⏸️ doğrulama — sekmeyi yenile/geç, tekrar bas', '#f55'); alert('Doğrulama çıktı. Sekmeyi yenile, geç, tekrar "Aktiflik Kontrol"e bas.'); break; }
      if (r.removed) { removed.push(it.id); totalRemoved++; }
      else if (r.active) { active.push(it.id); try { await jpost(U('/api/enrich'), { id: it.id, phone: r.phone, ownership_type: r.tapu, description: r.description, images: r.images, contact_type: r.contact_type, verified_owner: 1 }); if (r.phone) totalPhone++; } catch (e) {} }
      i++;
      if (removed.length >= 15) { try { await jpost(U('/api/mark-removed'), { ids: removed }); } catch (e) {} removed = []; }
      if (active.length >= 50) { try { await jpost(U('/api/mark-checked'), { ids: active }); } catch (e) {} active = []; }
      if (i % 25 === 0) log(`   ${i}/${list.length} · kalkan: ${totalRemoved} · tel: ${totalPhone}`, '#0f0');
      await sleep(rnd(PAGE_MIN, PAGE_MAX));
    }
    if (removed.length) try { await jpost(U('/api/mark-removed'), { ids: removed }); } catch (e) {}
    if (active.length) try { await jpost(U('/api/mark-checked'), { ids: active }); } catch (e) {}
    log(`✅ Kontrol bitti: ${i} ilan · ${totalRemoved} kalkmış · ${totalPhone} telefon çekildi`, '#0f0');
    btn4.disabled = false; btn4.textContent = '📋 Aktiflik Kontrol';
  }
  btn4.onclick = checkActive;

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
    // 2) YENİ ilanları detaydan zenginleştir + TELEFONLA bildir (notify:true)
    for (let k = 0; k < fresh.length; k++) {
      const f = fresh[k];
      const r = await checkOne(f.url.startsWith('http') ? f.url : BASE + f.url);
      if (r.challenge) { // blok: kalan yenileri telefonsuz da olsa bildir (alarm kaçmasın), sonra dur
        for (let j = k; j < fresh.length; j++) { try { await jpost(ENR, { id: fresh[j].id, notify: true }); } catch (e) {} }
        setBlock(); break;
      }
      if (r.removed) { try { await jpost(U('/api/mark-removed'), { ids: [f.id] }); } catch (e) {} continue; }
      try { await jpost(ENR, { id: f.id, notify: true, verified_owner: 1, phone: r.phone, ownership_type: r.tapu, description: r.description, images: r.images, contact_type: r.contact_type }); } catch (e) {}
      await sleep(rnd(PAGE_MIN, PAGE_MAX));
    }
    // 3) AKTİFLİK + TELEFON: her tur ~25 eski/telefonsuz ilan
    if (Date.now() >= +(localStorage.getItem('bircan_blocked_until') || 0)) await checkBatch(25);
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

  btn.onclick = harvest;
})();
