// push-sheets.js — SQLite -> canli Google Sheet. ILAN NO'ya gore UPSERT.
// Bot sadece kendi sutunlarini (A..O) gunceller; kullanicinin ekledigi sutunlara (P+) DOKUNMAZ.
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const cfg = require('./config');

const KEY_FILE = path.join(cfg.OUTPUT_DIR, 'gcp-service-account.json');
const SHEET_CFG = path.join(cfg.OUTPUT_DIR, 'sheet-config.json');

// bot sutunlari (A..O). Kullanici P sutunundan itibaren kendi alanlarini ekleyebilir.
const HEADERS = ['İlan No', 'İlan Linki (kalıcı)', 'Görsel', 'Tür', 'Başlık', 'Fiyat (TL)',
  'İlçe', 'Mahalle', 'Kategori', 'm²', 'Oda', 'İlan Tarihi', 'Yaş (gün)', 'Kalan ~gün',
  'Sahiplik', 'Telefon', 'Tapu/Sahiplik Türü'];
const LAST_COL = 'Q'; // 17 sutun

function rowFor(r) {
  const img = r.image_url ? `=IMAGE("${r.image_url}")` : '';
  return [
    r.id,
    r.url || '',
    img,
    r.property_type || '',
    r.title || '',
    r.price || '',
    r.district || '',
    r.neighborhood || '',
    r.category || '',
    r.area_m2 || '',
    r.rooms || '',
    r.listing_date || '',
    r.days_on_site ?? '',
    (r.days_on_site == null) ? '' : Math.max(0, cfg.EXPIRY_ESTIMATE_DAYS - r.days_on_site),
    r.seller_type === 'sahibinden' ? 'Ev Sahibi' : 'Emlakçı',
    r.phone || '',
    r.ownership_type || '',
  ];
}

async function getClient() {
  if (!fs.existsSync(KEY_FILE)) throw new Error(`Service account JSON yok: ${KEY_FILE}`);
  const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function ensureTab(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  let sheet = meta.data.sheets.find((s) => s.properties.title === title);
  if (!sheet) {
    const res = await sheets.spreadsheets.batchUpdate({ spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] } });
    sheet = { properties: res.data.replies[0].addSheet.properties };
  }
  // baslik satiri var mi?
  const hdr = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${title}!A1:${LAST_COL}1` });
  if (!hdr.data.values || hdr.data.values.length === 0) {
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${title}!A1`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [HEADERS] } });
    // baslik bicimi + satir yuksekligi (gorsel icin)
    const sid = sheet.properties.sheetId;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [
      { repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { backgroundColor: { red: 0.18, green: 0.49, blue: 0.2 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat)' } },
      { updateSheetProperties: { properties: { sheetId: sid, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      // gorsel sutunu (C) genis + default satir yuksekligi
      { updateDimensionProperties: { range: { sheetId: sid, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 },
        properties: { pixelSize: 120 }, fields: 'pixelSize' } },
    ] } });
  }
  return sheet.properties.sheetId;
}

async function upsertTab(sheets, spreadsheetId, title, rows) {
  const sid = await ensureTab(sheets, spreadsheetId, title);
  // mevcut ID->satir haritasi (A sutunu)
  const idCol = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${title}!A2:A` });
  const existing = new Map();
  (idCol.data.values || []).forEach((v, i) => { if (v[0]) existing.set(String(v[0]), i + 2); });

  const updates = [];   // mevcut satirlar -> sadece A..O guncelle
  const appends = [];    // yeni satirlar
  const rowHeights = []; // yeni eklenen satirlarin yuksekligi

  for (const r of rows) {
    const data = rowFor(r);
    const ex = existing.get(String(r.id));
    if (ex) updates.push({ range: `${title}!A${ex}:${LAST_COL}${ex}`, values: [data] });
    else appends.push(data);
  }

  // mevcutlari batch guncelle (parça parça)
  for (let i = 0; i < updates.length; i += 400) {
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates.slice(i, i + 400) } });
  }
  // yenileri ekle
  if (appends.length) {
    await sheets.spreadsheets.values.append({ spreadsheetId, range: `${title}!A1`,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: appends } });
  }
  // tum veri satirlarina gorsel icin yukseklik ver
  const total = existing.size + appends.length;
  if (total > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [
      { updateDimensionProperties: { range: { sheetId: sid, dimension: 'ROWS', startIndex: 1, endIndex: total + 1 },
        properties: { pixelSize: 90 }, fields: 'pixelSize' } },
    ] } }).catch(() => {});
  }
  return { updated: updates.length, added: appends.length };
}

(async () => {
  if (!fs.existsSync(SHEET_CFG)) { console.log(`❌ ${SHEET_CFG} yok. Once spreadsheetId'yi buraya yaz.`); process.exit(1); }
  const { spreadsheetId } = JSON.parse(fs.readFileSync(SHEET_CFG, 'utf8'));
  const sheets = await getClient();

  const owner = db.prepare(`SELECT * FROM listings WHERE seller_type='sahibinden' AND is_active=1
    ORDER BY district, property_type, days_on_site`).all();
  const agent = db.prepare(`SELECT * FROM listings WHERE seller_type='emlakci' AND is_active=1
    AND days_on_site BETWEEN ? AND ? ORDER BY days_on_site DESC`).all(cfg.EXPIRY_WINDOW.min, cfg.EXPIRY_WINDOW.max);

  console.log(`Sheet'e yaziliyor... ev sahibi=${owner.length}, dolmaya yakin emlakci=${agent.length}`);
  const r1 = await upsertTab(sheets, spreadsheetId, 'Ev Sahibi', owner);
  const r2 = await upsertTab(sheets, spreadsheetId, 'Dolmaya Yakın Emlakçı', agent);
  console.log(`✅ Ev Sahibi: +${r1.added} yeni / ${r1.updated} guncellendi`);
  console.log(`✅ Dolmaya Yakın Emlakçı: +${r2.added} yeni / ${r2.updated} guncellendi`);
  console.log(`Sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
})();
