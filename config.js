// config.js — projenin tek merkezi ayar dosyasi.
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), 'sahibinden-bursa-emlak');

module.exports = {
  ROOT,
  PROFILE_DIR: path.join(ROOT, '.chrome-profile'), // login olmus kalici Chrome profili
  DB_PATH: path.join(ROOT, 'output', 'emlak.db'),
  OUTPUT_DIR: path.join(ROOT, 'output'),

  // Hedef ilceler (sahibinden URL slug'lari). Sadece Bursa.
  DISTRICTS: [
    { name: 'Yıldırım', slug: 'bursa-yildirim' },
    { name: 'Osmangazi', slug: 'bursa-osmangazi' },
    { name: 'Nilüfer', slug: 'bursa-nilufer' },
    { name: 'Karacabey', slug: 'bursa-karacabey' },
    { name: 'Mudanya', slug: 'bursa-mudanya' },
  ],

  // Emlak kategorileri (login sonrasi DOGRULANDI). Her biri /{slug}/bursa-{ilce}/sahibinden calisir.
  CATEGORIES: [
    { name: 'Konut Satılık', slug: 'satilik', txn: 'Satılık', baseType: 'Konut' },
    { name: 'Konut Kiralık', slug: 'kiralik', txn: 'Kiralık', baseType: 'Konut' },
    { name: 'Arsa',          slug: 'arsa', txn: '-', baseType: 'Arsa' },
    { name: 'İşyeri',        slug: 'isyeri', txn: '-', baseType: 'İşyeri' },
    { name: 'Günlük Kiralık', slug: 'gunluk-kiralik', txn: 'Günlük Kiralık', baseType: 'Konut' },
    { name: 'Devremülk',     slug: 'devremulk', txn: '-', baseType: 'Devremülk' },
  ],

  // "Dolmaya yakin" emlakci ilani esigi (gun). 25-27+ gun = ~30 gunde dolmaya yakin.
  EXPIRY_WINDOW: { min: 25, max: 31 },
  // Tahmini yayin omru (gun). "Kalan ~gun" = EXPIRY_ESTIMATE_DAYS - yas.
  EXPIRY_ESTIMATE_DAYS: 30,

  // TEMKINLI tempo (ban riskini dusurmek icin). ms cinsinden.
  PACING: {
    betweenPagesMin: 9000,   // sayfa->sayfa arasi min bekleme
    betweenPagesMax: 20000,  // max bekleme
    betweenDetailsMin: 6000, // detay->detay arasi
    betweenDetailsMax: 14000,
    betweenDistrictsMin: 25000, // ilce->ilce arasi
    betweenDistrictsMax: 55000,
    pageSize: 20,            // sahibinden varsayilani (probe2 boyle gecti; ekstra param suphe cekiyor)
    maxPagesPerCategory: 50, // guvenlik tavani
  },

  UA: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
