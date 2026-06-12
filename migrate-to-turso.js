// migrate-to-turso.js — yerel emlak.db verisini Turso buluta taşır (tek sefer).
// Çalıştır: TURSO_URL=... TURSO_TOKEN=... node migrate-to-turso.js
const { createClient } = require('@libsql/client');
const cfg = require('./config');

(async () => {
  if (!process.env.TURSO_URL) { console.error('TURSO_URL gerekli'); process.exit(1); }
  // 1) Uzak şemayı kur (db.js env'i görüp Turso'ya bağlanır)
  const db = require('./db');
  await db.init();
  console.log('✓ Turso şeması hazır');

  const local = createClient({ url: 'file:' + cfg.DB_PATH });
  const remoteCols = (await db.client.execute('PRAGMA table_info(listings)')).rows.map((c) => c.name);

  // 2) listings kopyala (ortak kolonlar, INSERT OR REPLACE)
  const lrows = (await local.execute('SELECT * FROM listings')).rows;
  const cols = remoteCols.filter((c) => lrows.length && c in lrows[0]);
  let n = 0;
  for (let i = 0; i < lrows.length; i += 50) {
    const chunk = lrows.slice(i, i + 50).map((r) => ({
      sql: `INSERT OR REPLACE INTO listings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      args: cols.map((c) => r[c]),
    }));
    await db.batchWrite(chunk); n += chunk.length;
    process.stdout.write(`\r  listings: ${n}/${lrows.length}`);
  }
  console.log(`\n✓ ${n} ilan taşındı`);

  // 3) inquiries (varsa)
  try {
    const irows = (await local.execute('SELECT * FROM inquiries')).rows;
    if (irows.length) {
      const ic = ['created_at', 'name', 'phone', 'email', 'message', 'lang', 'item_ids', 'handled'];
      await db.batchWrite(irows.map((r) => ({ sql: `INSERT INTO inquiries (${ic.join(',')}) VALUES (${ic.map(() => '?').join(',')})`, args: ic.map((c) => r[c]) })));
      console.log(`✓ ${irows.length} talep taşındı`);
    }
  } catch {}

  const tot = (await db.get('SELECT COUNT(*) c FROM listings')).c;
  const shared = (await db.get('SELECT COUNT(*) c FROM listings WHERE shared=1')).c;
  console.log(`\n🎉 Turso toplam: ${tot} ilan (${shared} portföyde). Bağlantı çalışıyor.`);
  process.exit(0);
})().catch((e) => { console.error('migrasyon hata:', e); process.exit(1); });
