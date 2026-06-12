// scrape.js — login olmus profille 5 ilcenin EV SAHIBI (sahibinden) emlak ilanlarini kazir.
// Tum kategoriler, liste seviyesi, 403-dayanikli, SQLite'a dedup'li yazar.
const { chromium } = require('playwright');
const cfg = require('./config');
const { parseTrDate, parsePrice, detectType, bestImage, splitLocation } = require('./lib');
const { upsertListing, markAllInactive, startRun, finishRun } = require('./db');

const BASE = 'https://www.sahibinden.com';
const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CLI: --district=nilufer  --seller=sahibinden|emlak-ofisinden  --sort=date_desc
const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const SELLER = argv.seller || 'sahibinden';
const SORT = argv.sort || 'date_desc';
const ONLY_DISTRICT = argv.district || null;
const ONLY_CATEGORY = argv.category || null;

function isBlocked(status, html, title) {
  const l = (html || '').toLowerCase();
  return status === 403 || /olağan dışı|datadome|px-captcha|giriş yapman/.test(l) ||
    /olağan dışı/i.test(title || '');
}

// sayfa, DataDome "Basılı Tut" dogrulamasi gosteriyor mu + ilan var mi?
async function pageState(page) {
  const title = await page.title().catch(() => '');
  const html = await page.content().catch(() => '');
  const rows = await page.locator('tr[data-id]').count().catch(() => 0);
  const challenge = isBlocked(0, html, title) || /basılı tut|bağlantınız kontrol|press.*hold/i.test(html.toLowerCase());
  return { challenge, rows, title };
}

// otomatik press-and-hold denemesi (iframe icindeki butonu ~9 sn basili tut)
async function autoHold(page) {
  try {
    let handle = null;
    for (const f of page.frames()) {
      handle = await f.$('button:has-text("Basılı")').catch(() => null)
        || await f.$('button:has-text("Hold")').catch(() => null)
        || await f.$('#ddv1-captcha-container button, .captcha__human__button, button').catch(() => null);
      if (handle) break;
    }
    if (!handle) return false;
    const box = await handle.boundingBox(); if (!box) return false;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.down();
    await sleep(9000 + Math.floor(Math.random() * 2500));
    await page.mouse.up();
    await sleep(4000);
    return true;
  } catch { return false; }
}

// dogrulama cikarsa: once oto, sonra MANUEL (kullanici pencerede basili tutar) bekle.
async function clearChallenge(page, label) {
  console.log(`\n  🟡 [${label}] DataDome doğrulaması çıktı. Otomatik deneniyor...`);
  await autoHold(page);
  let st = await pageState(page);
  if (!st.challenge && st.rows > 0) { console.log(`  ✅ [${label}] otomatik geçildi.`); return true; }

  console.log(`  👉 [${label}] LÜTFEN açık Chrome penceresinde "Basılı Tut" butonuna ~8 sn BASILI TUT. (6 dk bekliyorum)`);
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(4000);
    st = await pageState(page);
    if (!st.challenge && st.rows > 0) { console.log(`  ✅ [${label}] doğrulama geçildi, devam.`); return true; }
  }
  console.log(`  ❌ [${label}] doğrulama süresi doldu.`);
  return false;
}

// bir sayfayi guvenli ac; dogrulama cikarsa coz, sonra ayni URL'i tekrar dene.
async function gotoSafe(page, url, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let status = 0;
    try { const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); status = r ? r.status() : 0; }
    catch (e) { console.log(`  [${label}] goto hata: ${e.message}`); }
    await sleep(rnd(2500, 4500));
    const st = await pageState(page);
    if (!st.challenge) return { ok: true };
    const solved = await clearChallenge(page, label);
    if (solved) return { ok: true };
  }
  return { ok: false };
}

async function parseRows(page, ctx) {
  const raw = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr.searchResultsItem[data-id]'));
    return rows.map((r) => {
      if (/nativeAd/i.test(r.className)) return null;
      const q = (sel) => { const e = r.querySelector(sel); return e ? e.textContent.trim().replace(/\s+/g, ' ') : null; };
      const a = r.querySelector('a.classifiedTitle');
      const img = r.querySelector('img');
      const attrs = Array.from(r.querySelectorAll('.searchResultsAttributeValue')).map((e) => e.textContent.trim());
      return {
        id: r.getAttribute('data-id'),
        title: q('a.classifiedTitle'),
        href: a ? a.getAttribute('href') : null,
        priceTxt: q('.searchResultsPriceValue'),
        dateTxt: q('.searchResultsDateValue'),
        locTxt: q('.searchResultsLocationValue'),
        attrs,
        imgSrc: img ? (img.getAttribute('src') || img.getAttribute('data-src')) : null,
      };
    }).filter(Boolean);
  }).catch(() => []);

  return raw.map((x) => {
    const { iso, days } = parseTrDate(x.dateTxt);
    const { semt, mahalle } = splitLocation(x.locTxt);
    // attrs: konutta [m2, oda] gibi; m2 = sadece rakam, oda = '+' iceren
    let area = null, rooms = null;
    for (const v of x.attrs) {
      if (/\+/.test(v) && !rooms) rooms = v;
      else if (/^\d[\d.]*$/.test(v) && !area) area = parseInt(v.replace(/\./g, ''), 10);
    }
    return {
      id: x.id,
      url: x.href ? (x.href.startsWith('http') ? x.href : BASE + x.href) : null,
      title: x.title,
      price: parsePrice(x.priceTxt),
      district: ctx.districtName,
      neighborhood: mahalle || semt,
      category: ctx.txn,
      property_type: detectType(x.href, x.title, ctx.baseType),
      seller_type: SELLER === 'sahibinden' ? 'sahibinden' : 'emlakci',
      listing_date: iso,
      days_on_site: days,
      rooms,
      area_m2: area,
      image_url: bestImage(x.imgSrc),
      raw_json: JSON.stringify(x),
    };
  });
}

async function scrapeCategory(page, district, cat, stats) {
  const label = `${district.name}/${cat.name}`;
  console.log(`\n▶ ${label} (${SELLER})`);
  let seenThisCat = new Set();
  for (let pageNo = 0; pageNo < cfg.PACING.maxPagesPerCategory; pageNo++) {
    const offset = pageNo * cfg.PACING.pageSize;
    const url = `${BASE}/${cat.slug}/${district.slug}/${SELLER}?sorting=${SORT}&pagingOffset=${offset}`;
    const res = await gotoSafe(page, url, label);
    if (!res.ok) { stats.blocked = true; console.log(`  [${label}] kalici blok, kategori atlandi.`); return; }

    const recs = await parseRows(page, { districtName: district.name, txn: cat.txn, baseType: cat.baseType });
    if (recs.length === 0) { console.log(`  [${label}] sayfa ${pageNo+1}: ilan yok, kategori bitti.`); break; }

    let newOnPage = 0;
    for (const rec of recs) {
      if (!rec.id || seenThisCat.has(rec.id)) continue;
      seenThisCat.add(rec.id);
      upsertListing(rec);
      stats.found++; newOnPage++;
    }
    console.log(`  [${label}] sayfa ${pageNo+1}: ${recs.length} ilan (+${newOnPage} islendi) | toplam ${seenThisCat.size}`);

    // tum sayfa tekrar/eskiyse dur
    if (newOnPage === 0) { console.log(`  [${label}] yeni ilan yok, dur.`); break; }
    if (recs.length < cfg.PACING.pageSize) { console.log(`  [${label}] son sayfa.`); break; }

    await sleep(rnd(cfg.PACING.betweenPagesMin, cfg.PACING.betweenPagesMax));
  }
}

(async () => {
  const runId = startRun();
  const stats = { found: 0, blocked: false };
  console.log(`=== SAHIBINDEN KAZIMA BASLADI (seller=${SELLER}, sort=${SORT}) ===`);

  const context = await chromium.launchPersistentContext(cfg.PROFILE_DIR, {
    headless: process.env.HEADLESS === '1', channel: 'chrome', userAgent: cfg.UA, // DataDome headless'i blokluyor -> headed sart
    locale: 'tr-TR', timezoneId: 'Europe/Istanbul', viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = context.pages()[0] || (await context.newPage());

  // isinma
  await gotoSafe(page, BASE + '/', 'anasayfa');
  await sleep(rnd(3000, 6000));

  const districts = cfg.DISTRICTS.filter((d) => !ONLY_DISTRICT || d.slug.includes(ONLY_DISTRICT));
  const cats = cfg.CATEGORIES.filter((c) => !ONLY_CATEGORY || c.slug === ONLY_CATEGORY);

  for (const district of districts) {
    for (const cat of cats) {
      await scrapeCategory(page, district, cat, stats);
      if (stats.blocked) break;
      await sleep(rnd(cfg.PACING.betweenPagesMin, cfg.PACING.betweenPagesMax));
    }
    if (stats.blocked) break;
    await sleep(rnd(cfg.PACING.betweenDistrictsMin, cfg.PACING.betweenDistrictsMax));
  }

  finishRun(runId, { found: stats.found, status: stats.blocked ? 'blocked' : 'ok',
    note: `seller=${SELLER}` });
  console.log(`\n=== BITTI: ${stats.found} ilan islendi. durum=${stats.blocked ? 'BLOK' : 'OK'} ===`);
  await context.close();
  process.exit(0);
})();
