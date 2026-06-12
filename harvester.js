/* ============================================================================
   SAHİBİNDEN HARVESTER — GERÇEK Chrome'da bir sahibinden sekmesinde Console'a yapıştır.
   Aynı-origin fetch ile tüm sayfaları çeker, localhost:7777 toplayıcıya gönderir.
   Önce: terminalde `node collector.js` çalışıyor olmalı.
   ============================================================================ */
(async () => {
  if (!location.hostname.includes('sahibinden.com')) {
    alert('⚠️ Bu butonu SAHİBİNDEN.COM ilan listesi sayfasındayken tıkla.\nŞu anki sayfa: ' + location.hostname);
    return;
  }
  const COLLECTOR = 'http://localhost:7777/ingest';
  const SELLER = 'sahibinden';            // ev sahibi. (emlakçı için: 'emlak-ofisinden')
  const BASE = 'https://www.sahibinden.com';
  const MAX_PAGES = 50;                    // kategori başına tavan (sahibinden ~1000 ilan sınırı)
  const PAGE_MIN = 1800, PAGE_MAX = 4000;  // sayfa arası bekleme (ms)
  const CAT_MIN = 5000, CAT_MAX = 9000;    // kategori arası bekleme

  const DISTRICTS = [
    { name: 'Yıldırım', slug: 'bursa-yildirim' },
    { name: 'Osmangazi', slug: 'bursa-osmangazi' },
    { name: 'Nilüfer', slug: 'bursa-nilufer' },
    { name: 'Karacabey', slug: 'bursa-karacabey' },
    { name: 'Mudanya', slug: 'bursa-mudanya' },
  ];
  const CATS = [
    { slug: 'satilik', baseType: 'Konut', label: 'Satılık' },
    { slug: 'kiralik', baseType: 'Konut', label: 'Kiralık' },
    { slug: 'arsa', baseType: 'Arsa', label: 'Arsa' },
    { slug: 'isyeri', baseType: 'İşyeri', label: 'İşyeri' },
    { slug: 'gunluk-kiralik', baseType: 'Konut', label: 'Günlük Kiralık' },
    { slug: 'devremulk', baseType: 'Devremülk', label: 'Devremülk' },
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));

  // ekranda ilerleme kutusu
  let box = document.getElementById('shb-harv');
  if (!box) {
    box = document.createElement('div'); box.id = 'shb-harv';
    box.style.cssText = 'position:fixed;z-index:999999;right:14px;bottom:14px;width:330px;max-height:50vh;overflow:auto;background:#111;color:#0f0;font:12px/1.4 monospace;padding:10px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.4)';
    document.body.appendChild(box);
  }
  const log = (m, c) => { const d = document.createElement('div'); if (c) d.style.color = c; d.textContent = m; box.appendChild(d); box.scrollTop = box.scrollHeight; console.log('[harvest]', m); };

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

  async function post(meta, rows) {
    try {
      const r = await fetch(COLLECTOR, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meta, rows }) });
      const j = await r.json(); return j.total;
    } catch (e) {
      log('⚠️ collector erişilemedi: ' + e.message, '#f55');
      if (!window.__shbAlerted) { window.__shbAlerted = 1; alert('⚠️ localhost toplayıcıya ulaşılamadı.\nTerminalde collector çalışıyor mu? Hata: ' + e.message); }
      throw e;
    }
  }

  let grandTotal = 0, challenged = false;
  for (const d of DISTRICTS) {
    for (const c of CATS) {
      const meta = { district: d.name, categoryTxn: c.label, baseType: c.baseType, sellerType: SELLER };
      log(`▶ ${d.name} / ${c.label} ...`, '#ff0');
      let got = 0;
      for (let p = 0; p < MAX_PAGES; p++) {
        const url = `${BASE}/${c.slug}/${d.slug}/${SELLER}?sorting=date_desc&pagingOffset=${p * 20}`;
        let html;
        try { const resp = await fetch(url, { credentials: 'include' }); html = await resp.text(); }
        catch (e) { log('fetch hata: ' + e.message, '#f55'); break; }
        if (/Basılı Tut|Olağan dışı|Bağlantınız kontrol/i.test(html)) {
          log('🛑 DOĞRULAMA ÇIKTI. Bu sekmede sayfayı yenileyip "Basılı Tut"u geç, sonra script\'i TEKRAR çalıştır.', '#f55');
          challenged = true; break;
        }
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rows = parsePage(doc);
        if (rows.length === 0) break;
        grandTotal = await post(meta, rows);
        got += rows.length;
        await sleep(rnd(PAGE_MIN, PAGE_MAX));
        if (rows.length < 20) break; // son sayfa
      }
      log(`   ${d.name}/${c.label}: ${got} ilan  | DB toplam: ${grandTotal}`, '#0f0');
      if (challenged) break;
      await sleep(rnd(CAT_MIN, CAT_MAX));
    }
    if (challenged) break;
  }
  log(challenged ? '⏸️ Doğrulama nedeniyle durdu — geç ve tekrar çalıştır.' : `✅ BİTTİ. Toplam DB: ${grandTotal}`, challenged ? '#fa0' : '#0f0');
})();
