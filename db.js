// db.js — Turso (libSQL) async şema + yardımcılar. CRM'in kalbi.
// TURSO_URL + TURSO_TOKEN env varsa buluta (kalıcı, ekip senkron) bağlanır;
// yoksa yerel dosyaya (file:output/emlak.db) düşer — geliştirme için.
const { createClient } = require('@libsql/client');
const cfg = require('./config');

const url = process.env.TURSO_URL || ('file:' + cfg.DB_PATH);
const authToken = process.env.TURSO_TOKEN || undefined;
const client = createClient(authToken ? { url, authToken } : { url });
const REMOTE = !!process.env.TURSO_URL;

// --- ince sorgu yardımcıları (better-sqlite3 yerine) ---
async function all(sql, args = []) { return (await client.execute({ sql, args })).rows; }
async function get(sql, args = []) { return (await client.execute({ sql, args })).rows[0] || null; }
async function run(sql, args = []) { return client.execute({ sql, args }); }
async function batchWrite(stmts) { if (stmts.length) await client.batch(stmts, 'write'); }

const DDL = [
  `CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY, url TEXT, title TEXT, price INTEGER, currency TEXT DEFAULT 'TL',
    district TEXT, neighborhood TEXT, category TEXT, property_type TEXT,
    seller_type TEXT, seller_name TEXT, ownership_type TEXT, phone TEXT,
    listing_date TEXT, days_on_site INTEGER, rooms TEXT, area_m2 INTEGER, image_url TEXT,
    first_seen TEXT, last_seen TEXT, is_active INTEGER DEFAULT 1, raw_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_seller   ON listings(seller_type)`,
  `CREATE INDEX IF NOT EXISTS idx_district ON listings(district)`,
  `CREATE INDEX IF NOT EXISTS idx_days     ON listings(days_on_site)`,
  `CREATE INDEX IF NOT EXISTS idx_active   ON listings(is_active)`,
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, finished_at TEXT,
    found INTEGER DEFAULT 0, new_count INTEGER DEFAULT 0, updated_count INTEGER DEFAULT 0,
    status TEXT, note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, name TEXT, phone TEXT, email TEXT,
    message TEXT, lang TEXT, item_ids TEXT, handled INTEGER DEFAULT 0
  )`,
];

// CRM + portföy alanları (mevcut tabloya ekle — migrasyon)
const EXTRA_COLS = [
  ['status', "TEXT DEFAULT 'Yeni'"], ['notes', 'TEXT'], ['assignee', 'TEXT'],
  ['shared', 'INTEGER DEFAULT 0'], ['consent_date', 'TEXT'], ['verified_owner', 'INTEGER'],
  ['removed', 'INTEGER DEFAULT 0'], ['removed_date', 'TEXT'], ['verify_status', 'TEXT'], ['last_check', 'TEXT'],
];

let ready = null;
async function init() {
  if (ready) return ready;
  ready = (async () => {
    for (const sql of DDL) await client.execute(sql);
    const info = await client.execute('PRAGMA table_info(listings)');
    const have = info.rows.map((c) => c.name);
    for (const [name, def] of EXTRA_COLS) {
      if (!have.includes(name)) await client.execute(`ALTER TABLE listings ADD COLUMN ${name} ${def}`);
    }
  })();
  return ready;
}

// upsert ifadesini (sql+args) üretir — collector bunları batch'leyebilir
function upsertStatement(rec) {
  const now = new Date().toISOString();
  const r = {
    currency: 'TL', neighborhood: null, property_type: null, seller_name: null,
    ownership_type: null, phone: null, rooms: null, area_m2: null, image_url: null, raw_json: null,
    ...rec,
  };
  return {
    sql: `INSERT INTO listings (id,url,title,price,currency,district,neighborhood,category,
      property_type,seller_type,seller_name,ownership_type,phone,listing_date,days_on_site,
      rooms,area_m2,image_url,first_seen,last_seen,is_active,raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET
        url=excluded.url, title=excluded.title, price=excluded.price, district=excluded.district,
        neighborhood=excluded.neighborhood, category=excluded.category, property_type=excluded.property_type,
        seller_type=excluded.seller_type, seller_name=excluded.seller_name,
        ownership_type=COALESCE(excluded.ownership_type, listings.ownership_type),
        phone=COALESCE(excluded.phone, listings.phone),
        listing_date=excluded.listing_date, days_on_site=excluded.days_on_site,
        rooms=excluded.rooms, area_m2=excluded.area_m2,
        image_url=COALESCE(excluded.image_url, listings.image_url),
        last_seen=excluded.last_seen, is_active=1, raw_json=excluded.raw_json`,
    args: [String(r.id), r.url, r.title, r.price, r.currency, r.district, r.neighborhood, r.category,
      r.property_type, r.seller_type, r.seller_name, r.ownership_type, r.phone, r.listing_date, r.days_on_site,
      r.rooms, r.area_m2, r.image_url, now, now, r.raw_json],
  };
}

async function upsertListing(rec) { await batchWrite([upsertStatement(rec)]); }

module.exports = { client, init, all, get, run, batchWrite, upsertStatement, REMOTE };
