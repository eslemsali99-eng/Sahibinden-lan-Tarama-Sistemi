// Bircan Akın — arka plan service worker
// 1) chrome.alarms ile 7/24 zamanlayıcı: günde ~8 tur (sekme arkada/kapalı olsa da)
// 2) Telefon için GERÇEK arka-plan sekmesi açma: gerçek gezinme DataDome'u tetiklemez -> telefon gelir
const CYCLE_MIN = 180; // 3 saatte bir = günde ~8 tur

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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'enrichViaTabs') { enrichViaTabs(msg.items || []).then((n) => sendResponse({ ok: true, done: n })); return true; }
});

async function enrichViaTabs(items) {
  let done = 0;
  for (const it of items.slice(0, 15)) {
    if (!it || !it.url) continue;
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: it.url, active: false }); // arka planda gerçek gezinme (blok yok)
      await new Promise((r) => setTimeout(r, 15000)); // detay yüklensin + o sayfanın content script'i telefonu okuyup POST etsin
      done++;
    } catch (e) {}
    if (tab && tab.id != null) await chrome.tabs.remove(tab.id).catch(() => {});
    await new Promise((r) => setTimeout(r, 4000)); // sekmeler arası nazik bekleme
  }
  return done;
}
