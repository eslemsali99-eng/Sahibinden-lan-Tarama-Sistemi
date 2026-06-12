// db.js — SQLite (better-sqlite3) sema + yardimcilar. CRM'in kalbi.
const Database = require('better-sqlite3');
const { DB_PATH } = require('./config');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS listings (
  id              TEXT PRIMARY KEY,         -- sahibinden ilan no
  url             TEXT,                     -- direkt ilan linki
  title           TEXT,
  price           INTEGER,                  -- TL
  currency        TEXT DEFAULT 'TL',
  district        TEXT,                     -- ilce (Nilüfer vb.)
  neighborhood    TEXT,                     -- mahalle
  category        TEXT,                     -- Satılık / Kiralık
  property_type   TEXT,                     -- Daire / Arsa / Işyeri vb.
  seller_type     TEXT,                     -- 'sahibinden' | 'emlakci' (kimden)
  seller_name     TEXT,                     -- ev sahibi adi veya ofis adi
  ownership_type  TEXT,                     -- sahiplik/tapu turu (Kat Mülkiyetli vb.)
  phone           TEXT,                     -- iletisim
  listing_date    TEXT,                     -- ilan tarihi (YYYY-MM-DD)
  days_on_site    INTEGER,                  -- yas (gun)
  rooms           TEXT,                     -- oda sayisi (3+1 vb.)
  area_m2         INTEGER,                  -- m2 (brüt/net)
  image_url       TEXT,                     -- en anlamli kapak gorseli (CDN URL)
  first_seen      TEXT,                     -- bizim ilk gordugumuz an (ISO)
  last_seen       TEXT,                     -- son gordugumuz an (ISO)
  is_active       INTEGER DEFAULT 1,        -- son turda hala yayinda mi
  raw_json        TEXT                      -- ham veri yedegi
);
CREATE INDEX IF NOT EXISTS idx_seller   ON listings(seller_type);
CREATE INDEX IF NOT EXISTS idx_district ON listings(district);
CREATE INDEX IF NOT EXISTS idx_days     ON listings(days_on_site);
CREATE INDEX IF NOT EXISTS idx_active   ON listings(is_active);

-- her tur kaydi (audit / saglik takibi)
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT,
  finished_at   TEXT,
  found         INTEGER DEFAULT 0,
  new_count     INTEGER DEFAULT 0,
  updated_count INTEGER DEFAULT 0,
  status        TEXT,                       -- ok | blocked | error
  note          TEXT
);
`);

// --- migrasyon: CRM + portfoy alanlari (mevcut tabloya ekle) ---
const cols = db.prepare('PRAGMA table_info(listings)').all().map((c) => c.name);
const addCol = (name, def) => { if (!cols.includes(name)) db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${def}`); };
addCol('status', "TEXT DEFAULT 'Yeni'");      // Yeni | Arandı | İzin Verdi | Reddetti | Ulaşılamadı
addCol('notes', 'TEXT');
addCol('assignee', 'TEXT');                    // arayan ekip uyesi
addCol('shared', 'INTEGER DEFAULT 0');         // 1 = musteri portfoyune dustu (izinli)
addCol('consent_date', 'TEXT');
addCol('verified_owner', 'INTEGER');           // detay-dogrulama: 1 ev sahibi, 0 emlakci, null bilinmiyor
addCol('removed', 'INTEGER DEFAULT 0');        // 1 = sahibinden'den kaldirildi (yayindan kalkti)
addCol('removed_date', 'TEXT');                // kaldirildigi tespit tarihi
addCol('verify_status', 'TEXT');               // Teyit Bekliyor | Satıldı | Vazgeçti | Hâlâ Satıyor | Ulaşılamadı
addCol('last_check', 'TEXT');                  // son aktiflik kontrol tarihi

// musteri talepleri (sepet/sürec baslat)
db.exec(`CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT, name TEXT, phone TEXT, email TEXT, message TEXT,
  lang TEXT, item_ids TEXT, handled INTEGER DEFAULT 0
);`);

const upsertStmt = db.prepare(`
INSERT INTO listings (id, url, title, price, currency, district, neighborhood, category,
  property_type, seller_type, seller_name, ownership_type, phone, listing_date, days_on_site,
  rooms, area_m2, image_url, first_seen, last_seen, is_active, raw_json)
VALUES (@id, @url, @title, @price, @currency, @district, @neighborhood, @category,
  @property_type, @seller_type, @seller_name, @ownership_type, @phone, @listing_date, @days_on_site,
  @rooms, @area_m2, @image_url, @now, @now, 1, @raw_json)
ON CONFLICT(id) DO UPDATE SET
  url=excluded.url, title=excluded.title, price=excluded.price, district=excluded.district,
  neighborhood=excluded.neighborhood, category=excluded.category, property_type=excluded.property_type,
  seller_type=excluded.seller_type, seller_name=excluded.seller_name,
  ownership_type=COALESCE(excluded.ownership_type, listings.ownership_type),
  phone=COALESCE(excluded.phone, listings.phone),
  listing_date=excluded.listing_date, days_on_site=excluded.days_on_site,
  rooms=excluded.rooms, area_m2=excluded.area_m2,
  image_url=COALESCE(excluded.image_url, listings.image_url),
  last_seen=excluded.last_seen, is_active=1, raw_json=excluded.raw_json
`);

function upsertListing(rec) {
  const now = new Date().toISOString();
  upsertStmt.run({
    currency: 'TL', neighborhood: null, property_type: null, seller_name: null,
    ownership_type: null, phone: null, rooms: null, area_m2: null, image_url: null, raw_json: null,
    ...rec, now,
  });
}

// bir turun basinda tum kayitlari pasif isaretle; gorduklerimizi upsert tekrar aktif yapar.
function markAllInactive() { db.prepare('UPDATE listings SET is_active = 0').run(); }

function startRun() {
  return db.prepare('INSERT INTO runs (started_at, status) VALUES (?, ?)')
    .run(new Date().toISOString(), 'running').lastInsertRowid;
}
function finishRun(id, fields) {
  db.prepare(`UPDATE runs SET finished_at=@finished_at, found=@found, new_count=@new_count,
    updated_count=@updated_count, status=@status, note=@note WHERE id=@id`)
    .run({ id, finished_at: new Date().toISOString(), found: 0, new_count: 0, updated_count: 0,
      status: 'ok', note: '', ...fields });
}

module.exports = { db, upsertListing, markAllInactive, startRun, finishRun };
