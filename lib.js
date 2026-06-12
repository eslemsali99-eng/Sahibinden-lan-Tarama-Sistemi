// lib.js — ayrıştırma yardımcıları.
const TR_MONTHS = { ocak:1, 'şubat':2, subat:2, mart:3, nisan:4, 'mayıs':5, mayis:5, haziran:6,
  temmuz:7, 'ağustos':8, agustos:8, 'eylül':9, eylul:9, 'ekim':10, 'kasım':11, kasim:11, 'aralık':12, aralik:12 };

// "08 Haziran 2026" -> {iso:'2026-06-08', days: yas}
function parseTrDate(str, now = new Date()) {
  if (!str) return { iso: null, days: null };
  const s = str.toLowerCase().trim();
  if (s.includes('bugün')) return { iso: toISO(now), days: 0 };
  if (s.includes('dün')) { const d = new Date(now); d.setDate(d.getDate() - 1); return { iso: toISO(d), days: 1 }; }
  const m = s.match(/(\d{1,2})\s+([a-zçğıöşü]+)\s+(\d{4})/);
  if (!m) return { iso: null, days: null };
  const day = parseInt(m[1], 10);
  const mon = TR_MONTHS[m[2]];
  const year = parseInt(m[3], 10);
  if (!mon) return { iso: null, days: null };
  const d = new Date(year, mon - 1, day, 12, 0, 0);
  const days = Math.floor((stripTime(now) - stripTime(d)) / 86400000);
  return { iso: toISO(d), days };
}
function stripTime(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function toISO(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// fiyat: "2.400.000 TL" -> 2400000
function parsePrice(str) {
  if (!str) return null;
  const m = str.replace(/[^\d]/g, '');
  return m ? parseInt(m, 10) : null;
}

// href slug + baslik'tan tur cikar. baseType: kategori (Konut/Arsa/İşyeri/Devremülk)
function detectType(href, title, baseType) {
  const h = (href || '').toLowerCase();
  const t = (title || '').toLowerCase();
  const has = (kw) => h.includes(kw) || t.includes(kw);
  // ince alt tipler (oncelik sirasi)
  if (has('fabrika')) return 'Fabrika';
  if (has('depo')) return 'Depo';
  if (has('tarla')) return 'Tarla';
  if (has('bağ') || has('bag-') || has('bahçe') || has('bahce')) return 'Bağ/Bahçe';
  if (has('villa')) return 'Villa';
  if (has('müstakil') || has('mustakil')) return 'Müstakil Ev';
  if (has('yazlık') || has('yazlik')) return 'Yazlık';
  if (has('dükkan') || has('dukkan') || has('mağaza') || has('magaza')) return 'Dükkan/Mağaza';
  if (has('ofis') || has('büro') || has('buro')) return 'Ofis';
  if (has('residence') || has('rezidans')) return 'Rezidans';
  if (has('daire')) return 'Daire';
  if (has('arsa')) return 'Arsa';
  // taban kategori
  if (baseType === 'Konut') return 'Konut';
  return baseType || 'Diğer';
}

// liste satiri img src'sinden en anlamli gorsel. lthmb -> daha buyuk dene, degilse oldugu gibi.
function bestImage(src) {
  if (!src) return null;
  // sahibinden kucuk thumbnail (lthmb) -> orta boy (x5) dene; basarisiz olursa zaten lthmb gecerli.
  return src; // guvenli: liste thumbnail (kapak foto). Buyutme riskli, sonra denenebilir.
}

// "GörükleGörükle Mh." gibi birlesik lokasyondan mahalle ayikla
function splitLocation(loc) {
  if (!loc) return { semt: null, mahalle: null };
  // "...Mh." ile biten mahalleyi yakala
  const m = loc.match(/([A-Za-zÇĞİÖŞÜçğıöşü0-9.\s]+?Mh\.?)$/);
  if (m) {
    const mahalle = m[1].trim();
    const semt = loc.slice(0, loc.length - mahalle.length).trim();
    return { semt: semt || null, mahalle };
  }
  return { semt: loc.trim() || null, mahalle: null };
}

module.exports = { parseTrDate, parsePrice, detectType, bestImage, splitLocation, toISO };
