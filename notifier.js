// notifier.js — yeni ilan / fiyat düşüşü bildirimleri. Telegram + ücretsiz WhatsApp (CallMeBot).
// Ayar: output/notify.json -> { enabled, telegram:{token,chatIds[]}, whatsapp:[{phone,apikey}] }
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const NOTIFY_FILE = path.join(cfg.OUTPUT_DIR, 'notify.json');
// Panelin herkese açık adresi (Render RENDER_EXTERNAL_URL'i otomatik verir) — kalkan ilan linkinde kullanılır
const PANEL = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || 'http://localhost:7777').replace(/\/$/, '');
function load() {
  // Render/bulut: tüm config NOTIFY_JSON env değişkeninden; yerel: output/notify.json
  if (process.env.NOTIFY_JSON) {
    try { return JSON.parse(process.env.NOTIFY_JSON); } catch {}
  }
  try { return JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf8')); }
  catch { return { enabled: false, telegram: { token: '', chatIds: [] }, whatsapp: [] }; }
}

async function sendTelegram(token, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false }),
    });
  } catch (e) { console.log('[notify] telegram hata:', e.message); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// CallMeBot HTML desteklemez -> Telegram etiketlerini temizle, düz metne çevir
function htmlToPlain(t) {
  return String(t).replace(/<\/?[a-z][^>]*>/gi, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
async function sendWhatsApp(phone, apikey, text) {
  try {
    const u = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${apikey}`;
    const r = await fetch(u);
    const body = await r.text().catch(() => '');
    if (!/queued|success|will receive/i.test(body)) console.log(`[notify] whatsapp ${phone} başarısız:`, body.slice(0, 140));
  } catch (e) { console.log('[notify] whatsapp hata:', e.message); }
}
// CallMeBot rate-limit: TÜM WhatsApp gönderimleri tek kuyrukta, SIRAYLA + 2sn aralıkla
let waChain = Promise.resolve();
function queueWhatsApp(phone, apikey, text) {
  waChain = waChain.then(() => sendWhatsApp(phone, apikey, text)).then(() => sleep(2200));
  return waChain;
}

// genel mesaj
async function send(text) {
  const c = load();
  if (!c.enabled) return;
  const jobs = [];
  if (c.telegram && c.telegram.token) for (const id of (c.telegram.chatIds || [])) jobs.push(sendTelegram(c.telegram.token, id, text));
  // WhatsApp: düz metin + kuyrukta sırayla (Telegram'a giden her şey WP'a da gider)
  const plain = htmlToPlain(text);
  for (const w of (c.whatsapp || [])) if (w.phone && w.apikey) queueWhatsApp(w.phone, w.apikey, plain);
  await Promise.allSettled(jobs);
}

// iletişim satırı: telefon varsa numara, yoksa "mesajla", henüz çekilmediyse "panelde"
function contactLine(x) {
  if (x.phone) return `📞 ${x.phone}`;
  if (x.contact_type === 'message') return `✉️ Telefon yok — sahibinden'de mesajla iletişim kabul ediyor`;
  return `📞 Telefon panelde görünecek`;
}
// link: HER ZAMAN kendi panelimizdeki ilana (sahibinden kalkınca genel sayfaya atıyor)
const panelLink = (x) => `${PANEL}/?id=${encodeURIComponent(x.id)}`;

// yeni ilanlar icin mesaj (telefon + panel linki ile)
async function notifyNew(listings) {
  if (!listings.length) return;
  const c = load(); if (!c.enabled) return;
  const top = listings.slice(0, 8);
  const lines = top.map((x) => {
    const price = x.price ? Number(x.price).toLocaleString('tr-TR') + ' ₺' : '';
    const tip = x.property_type || '';
    const yer = [x.district, x.neighborhood].filter(Boolean).join(' · ');
    return `🏠 <b>${price}</b> ${tip} — ${yer}\n${contactLine(x)}\n👉 ${panelLink(x)}`;
  });
  const more = listings.length > top.length ? `\n…ve ${listings.length - top.length} ilan daha` : '';
  const header = `🚨 <b>${listings.length} YENİ EV SAHİBİ İLANI</b>\nİlk arayan ol! 📞\n\n`;
  await send(header + lines.join('\n\n') + more);
}

// fiyat düşüşü bildirimi
async function notifyPriceDrops(drops) {
  if (!drops.length) return;
  const c = load(); if (!c.enabled) return;
  const lines = drops.slice(0, 8).map((x) => {
    const yeni = Number(x.price).toLocaleString('tr-TR');
    const eski = Number(x.oldPrice).toLocaleString('tr-TR');
    const fark = Math.round((1 - x.price / x.oldPrice) * 100);
    const yer = [x.district, x.neighborhood].filter(Boolean).join(' · ');
    return `📉 <b>%${fark} indirim</b>\n<s>${eski} ₺</s> → <b>${yeni} ₺</b>\n${x.property_type || ''} — ${yer}\n${contactLine(x)}\n👉 ${panelLink(x)}`;
  });
  await send(`💰 <b>${drops.length} İLANDA FİYAT DÜŞTÜ</b> — pazarlığa açık olabilir! 📞\n\n` + lines.join('\n\n'));
}

// yayından kalkan ilan bildirimi (teyit gerekiyor)
async function notifyRemoved(listings) {
  if (!listings.length) return;
  const c = load(); if (!c.enabled) return;
  const lines = listings.slice(0, 8).map((x) => {
    const price = x.price ? Number(x.price).toLocaleString('tr-TR') + ' ₺' : '';
    const yer = [x.district, x.neighborhood].filter(Boolean).join(' · ');
    // sahibinden linki ölü -> kendi panelimizdeki o spesifik ilana yönlendir (Yayından Kalkanlar)
    const link = `${PANEL}/?tab=removed&id=${encodeURIComponent(x.id)}`;
    return `📭 <b>${price}</b> ${x.property_type || ''} — ${yer}\n${contactLine(x)}\n👉 Panelde aç: ${link}`;
  });
  await send(`🔎 <b>${listings.length} İLAN YAYINDAN KALKTI</b> — Teyit gerekiyor!\nEv sahibini ara: sattı mı, vazgeçti mi? 📞\n\n` + lines.join('\n\n'));
}

// SON ŞANS günlük özet: dolmaya çok az kalan ilanlar (yarın kalkabilir) — bugün ara!
async function notifyDigest(listings) {
  if (!listings.length) return;
  const c = load(); if (!c.enabled) return;
  const lines = listings.slice(0, 12).map((x) => {
    const price = x.price ? Number(x.price).toLocaleString('tr-TR') + ' ₺' : '';
    const yer = [x.district, x.neighborhood].filter(Boolean).join(' · ');
    const left = x.days_on_site != null ? Math.max(0, 30 - x.days_on_site) : '?';
    return `⏳ <b>${left} gün kaldı</b> · ${price} ${x.property_type || ''} — ${yer}\n${contactLine(x)}\n👉 ${panelLink(x)}`;
  });
  const more = listings.length > 12 ? `\n…ve ${listings.length - 12} ilan daha` : '';
  await send(`🔔 <b>SON ŞANS — bugün ara!</b>\nDolmaya çok az kaldı, yarın yayından kalkabilir 📞\n\n` + lines.join('\n\n') + more);
}

module.exports = { send, notifyNew, notifyPriceDrops, notifyRemoved, notifyDigest, load };
