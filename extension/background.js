// Bircan Akın — arka plan service worker
// 1) chrome.alarms ile 7/24 zamanlayıcı: günde ~8 tur (sekme arkada/kapalı olsa da)
// 2) Telefon için GERÇEK arka-plan sekmesi açma: gerçek gezinme DataDome'u tetiklemez -> telefon gelir
const CYCLE_MIN = 120; // 2 saatte bir = günde ~12 tur (sürekli aktiflik)

function ensureAlarm() { chrome.alarms.create('cycle', { periodInMinutes: CYCLE_MIN, delayInMinutes: 2 }); }
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'cycle') return;
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.sahibinden.com/*' });
    // tercihen liste sayfası olan bir sekme (ilan detayı değil)
    let tab = tabs.find((t) => t.url && !/\/ilan\//.test(t.url)) || tabs[0];
    if (!tab) tab = await chrome.tabs.create({ url: 'https://www.sahibinden.com/satilik/bursa-nilufer/sahibinden?sorting=date_desc', active: false });
    setTimeout(() => { chrome.tabs.sendMessage(tab.id, { type: 'runCycle' }).catch(() => {}); }, 9000);
  } catch (e) {}
});

// liste-sayfası content script'ten: "şu ilanları gerçek arka-plan sekmesinde aç, telefon çekilsin"
// detay sekmesinden: "bu ilanı işledim (telefon/mesaj/blok), sekmeyi kapatabilirsin" — sabit 15sn beklemek yerine
// gerçek bitişi bekliyoruz; arka plan (active:false) sekmeler Chrome tarafından throttle edilip içerideki
// setTimeout'lar 15sn'den uzun sürebiliyor, sabit süre dolup sekme erken kapanınca telefon hiç POST edilmiyordu.
const pendingDetail = new Map(); // id -> resolve
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'enrichViaTabs') { enrichViaTabs(msg.items || []).then((n) => sendResponse({ ok: true, done: n })); return true; }
  if (msg && msg.type === 'detailDone' && msg.id != null) { const r = pendingDetail.get(String(msg.id)); if (r) { r(); pendingDetail.delete(String(msg.id)); } }
});

async function enrichViaTabs(items) {
  let done = 0;
  for (const it of items.slice(0, 15)) {
    if (!it || !it.url) continue;
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: it.url, active: false }); // arka planda gerçek gezinme (blok yok)
      await new Promise((resolve) => {
        pendingDetail.set(String(it.id), resolve);
        setTimeout(resolve, 28000); // throttle edilmiş sekme için güvenlik üst sınırı (normalde 'detailDone' ile çok daha erken biter)
      });
      pendingDetail.delete(String(it.id));
      done++;
    } catch (e) {}
    if (tab && tab.id != null) await chrome.tabs.remove(tab.id).catch(() => {});
    await new Promise((r) => setTimeout(r, 4000)); // sekmeler arası nazik bekleme
  }
  return done;
}
