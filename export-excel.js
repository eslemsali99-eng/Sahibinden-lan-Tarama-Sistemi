// export-excel.js — SQLite -> Excel (.xlsx). Gomulu kapak gorseli + tur + KALICI ilan linki.
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const cfg = require('./config');

const IMG_CACHE = path.join(cfg.OUTPUT_DIR, 'img');
if (!fs.existsSync(IMG_CACHE)) fs.mkdirSync(IMG_CACHE, { recursive: true });

async function getImageBuffer(id, url) {
  if (!url) return null;
  const ext = (url.match(/\.(jpe?g|png|webp)/i) || [, 'jpg'])[1].toLowerCase().replace('jpeg', 'jpg');
  const file = path.join(IMG_CACHE, `${id}.${ext}`);
  if (fs.existsSync(file)) return { buffer: fs.readFileSync(file), extension: ext === 'webp' ? 'png' : ext };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': cfg.UA, 'Referer': 'https://www.sahibinden.com/' } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(file, buf);
    return { buffer: buf, extension: ext === 'webp' ? 'png' : ext };
  } catch { return null; }
}

const COLUMNS = [
  { header: 'Görsel', key: 'image', width: 16 },
  { header: 'Tür', key: 'property_type', width: 14 },
  { header: 'Başlık', key: 'title', width: 42 },
  { header: 'Fiyat (TL)', key: 'price', width: 15 },
  { header: 'İlçe', key: 'district', width: 12 },
  { header: 'Mahalle', key: 'neighborhood', width: 18 },
  { header: 'Kategori', key: 'category', width: 12 },
  { header: 'm²', key: 'area_m2', width: 8 },
  { header: 'Oda', key: 'rooms', width: 8 },
  { header: 'İlan Tarihi', key: 'listing_date', width: 13 },
  { header: 'Yaş (gün)', key: 'days_on_site', width: 10 },
  { header: 'Kalan ~gün', key: 'days_left', width: 11 },
  { header: 'Sahiplik', key: 'seller_label', width: 12 },
  { header: 'Telefon', key: 'phone', width: 15 },
  { header: 'Tapu/Sahiplik Türü', key: 'ownership_type', width: 18 },
  { header: 'İLAN LİNKİ (kalıcı)', key: 'url', width: 50 },
];

async function buildSheet(wb, title, rows, headerColor) {
  const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS;
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerColor } };
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  let r = 2;
  for (const row of rows) {
    const excelRow = ws.addRow({
      property_type: row.property_type,
      title: row.title,
      price: row.price,
      district: row.district,
      neighborhood: row.neighborhood,
      category: row.category,
      area_m2: row.area_m2,
      rooms: row.rooms,
      listing_date: row.listing_date,
      days_on_site: row.days_on_site,
      days_left: (row.days_on_site == null) ? '' : Math.max(0, cfg.EXPIRY_ESTIMATE_DAYS - row.days_on_site),
      seller_label: row.seller_type === 'sahibinden' ? 'Ev Sahibi' : 'Emlakçı',
      phone: row.phone || '',
      ownership_type: row.ownership_type || '',
      url: row.url,
    });
    excelRow.height = 60;
    excelRow.alignment = { vertical: 'middle', wrapText: true };
    // kalici link -> tiklanabilir hyperlink
    if (row.url) {
      const c = excelRow.getCell('url');
      c.value = { text: row.url, hyperlink: row.url };
      c.font = { color: { argb: 'FF1155CC' }, underline: true };
    }
    excelRow.getCell('price').numFmt = '#,##0';
    // gomulu gorsel
    const img = await getImageBuffer(row.id, row.image_url);
    if (img) {
      const imageId = wb.addImage({ buffer: img.buffer, extension: img.extension });
      ws.addImage(imageId, { tl: { col: 0.1, row: r - 1 + 0.05 }, ext: { width: 100, height: 72 } });
    }
    r++;
  }
  return ws;
}

(async () => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sahibinden Bursa Emlak Bot';

  const owner = db.prepare(`SELECT * FROM listings WHERE seller_type='sahibinden' AND is_active=1
    ORDER BY district, property_type, days_on_site`).all();
  const agentExpiring = db.prepare(`SELECT * FROM listings WHERE seller_type='emlakci' AND is_active=1
    AND days_on_site BETWEEN ? AND ? ORDER BY days_on_site DESC`).all(cfg.EXPIRY_WINDOW.min, cfg.EXPIRY_WINDOW.max);

  console.log(`Ev sahibi ilanlari: ${owner.length} | Dolmaya yakin emlakci: ${agentExpiring.length}`);
  console.log('Gorseller indiriliyor + gomuluyor (ilk seferde yavas, sonra cache)...');

  await buildSheet(wb, 'Ev Sahibi İlanları', owner, 'FF2E7D32');
  await buildSheet(wb, 'Dolmaya Yakın Emlakçı', agentExpiring, 'FFC62828');

  const out = path.join(cfg.OUTPUT_DIR, 'sahibinden-bursa-emlak.xlsx');
  await wb.xlsx.writeFile(out);
  console.log(`\n✅ Excel yazildi: ${out}`);
})();
