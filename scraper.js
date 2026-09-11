// scraper.js — Cainiao izləmə scraper-i (bir Google Sheets cədvəli üçün)
//
// Hər cədvəlin öz repo-su olur; fayllar eynidir, yalnız Secrets fərqlidir.
//
// Statuslar Taobao modulu ilə EYNİ lüğətdən yazılır:
//   Delivered | Out for delivery | In transit | Picked up |
//   Awaiting pickup | Problem | Not found
//
// Konfiqurasiya (GitHub → Settings → Secrets and variables → Actions):
//   SHEET_WEBAPP_URL — cədvəlin /exec ünvanı
//   SHEET_SECRET     — Code.gs-dəki SECRET

const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const UA = require('random-useragent');
const fs = require('fs');
const path = require('path');

/* ================== CƏDVƏL ================== */

const WEBAPP_URL = String(process.env.SHEET_WEBAPP_URL || '').trim();
const SECRET     = String(process.env.SHEET_SECRET || '').trim();

/* ================== SAYT VƏ SELEKTORLAR ================== */

const PAGE_URL   = 'https://page.cainiao.com/guoguo/app-myexpress-taobao/search-express.html';
const INPUT_SEL  = 'body > div > div.search > input[type=text]';
const BUTTON_SEL = 'body > div > div.btn';
const STATUS_CANDIDATES = [
  'div.package-status',
  '.package-status',
  '.cp-info_detail .package-status',
  '.cp-info .package-status',
  '.cp-info .status',
  '.result', '.status', '.topStatus', '.title'
];

const WAIT_INPUT_TIMEOUT_MS = 15000;
const WAIT_BTN_TIMEOUT_MS   = 10000;
const PER_TRACKING_MAX_MS   = 60000;
const PAUSE_BETWEEN_MS      = 1500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ================== STATUS LÜĞƏTİ ================== */

/** Çin mətnini Taobao modulu ilə eyni ingilis statusuna çevirir. */
function toStatus(textCN) {
  const t = String(textCN || '').trim();
  if (!t) return 'Not found';

  if (/未查询到|暂无|没有相关|无法查询/.test(t)) return 'Not found';
  if (/签收|妥投|送达/.test(t) || /(delivered|received|signed)/i.test(t)) return 'Delivered';
  if (/派送中|投递|派件/.test(t) || /out\s*for\s*delivery/i.test(t))      return 'Out for delivery';
  if (/待揽收/.test(t))                                                   return 'Awaiting pickup';
  if (/揽收|收寄|已取件/.test(t) || /(picked\s*up|accept)/i.test(t))       return 'Picked up';
  if (/运输中|在途|到达|转运|发出|已发货/.test(t) ||
      /(in\s*transit|arrived|shipped)/i.test(t))                          return 'In transit';
  if (/异常|问题件|退回|失败/.test(t) || /(exception|failed)/i.test(t))    return 'Problem';

  return 'In transit';
}

/* ================== DEBUG ================== */

async function saveDebug(page, name) {
  try {
    const dir = path.join(process.cwd(), 'debug');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    await page.screenshot({ path: path.join(dir, name + '.png'), fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) fs.writeFileSync(path.join(dir, name + '.html'), html, 'utf8');
  } catch {}
}

/* ================== GOOGLE SHEETS ================== */

async function getTrackingList() {
  const url = WEBAPP_URL + '?secret=' + encodeURIComponent(SECRET) + '&op=list';
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let js;
  try { js = JSON.parse(text); }
  catch { throw new Error('Cədvəl JSON qaytarmadı: ' + text.slice(0, 200)); }
  if (!js.ok || !Array.isArray(js.items)) {
    throw new Error('Cədvəl xətası: ' + (js.error || 'naməlum'));
  }
  return js.items.map(x => String(x).trim()).filter(Boolean);
}

async function postResult(tracking, status) {
  try {
    const res = await fetch(WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET, tracking: tracking, status: status })
    });
    const js = await res.json().catch(() => ({}));
    if (!js.ok) console.error('yazılmadı: ' + tracking, js.error || '');
  } catch (e) {
    console.error('POST xətası: ' + tracking, e.message);
  }
}

/* ================== SƏHİFƏ ================== */

async function hardClick(page, selector) {
  try {
    await page.$eval(selector, el => { el.scrollIntoView({ block: 'center' }); el.click(); });
  } catch (_) {}
  try {
    const el = await page.$(selector);
    if (el) {
      const box = await el.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down(); await page.mouse.up();
      }
    }
  } catch (_) {}
}

async function findStatusInPageAndFrames(page) {
  const evalFn = (cands) => {
    const hasStatus = (s) => !!(s && /签收|派送中|运输中|揽收|问题件|在途|投递|未查询|暂无|无法查询/i.test(String(s)));
    const probe = (root, sels) => {
      for (const sel of sels) {
        const el = root.querySelector && root.querySelector(sel);
        if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
      }
      const txt0 = root.innerText || '';
      if (hasStatus(txt0)) {
        const hit = txt0.split(/\n+/).map(s => s.trim()).find(hasStatus);
        if (hit) return hit;
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
      let node;
      while ((node = walker.nextNode())) {
        const txt = node.innerText;
        if (txt && hasStatus(txt)) {
          const hit = txt.split(/\n+/).map(s => s.trim()).find(hasStatus);
          if (hit) return hit;
        }
        if (node.shadowRoot) {
          const sub = probe(node.shadowRoot, sels);
          if (sub) return sub;
        }
      }
      return '';
    };
    let val = probe(document, cands);
    if (val) return val;
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const doc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
        if (doc) {
          val = probe(doc, cands);
          if (val) return val;
        }
      } catch (_) {}
    }
    return '';
  };

  try { const v = await page.evaluate(evalFn, STATUS_CANDIDATES); if (v) return v; } catch {}
  for (const fr of page.frames()) {
    try { const v = await fr.evaluate(evalFn, STATUS_CANDIDATES); if (v) return v; } catch {}
  }
  return '';
}

async function scrapeOnce(browser, tracking) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA.getRandom() || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(PAGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    try {
      await page.evaluate(() => {
        const ok = [].slice.call(document.querySelectorAll('button,.btn,[role="button"]'))
          .find(b => /同意|接受|继续|确定|知道了|OK|Accept|Agree/.test((b.textContent || '').trim()));
        if (ok) ok.click();
      });
    } catch {}

    await page.waitForSelector(INPUT_SEL, { visible: true, timeout: WAIT_INPUT_TIMEOUT_MS });
    await page.click(INPUT_SEL);
    await page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, INPUT_SEL);
    await page.type(INPUT_SEL, tracking, { delay: 25 });

    await page.waitForSelector(BUTTON_SEL, { visible: true, timeout: WAIT_BTN_TIMEOUT_MS });
    await hardClick(page, BUTTON_SEL);
    try { await page.keyboard.press('Enter'); } catch {}

    let statusCN = '';
    const start = Date.now();
    while (!statusCN && Date.now() - start < PER_TRACKING_MAX_MS) {
      await sleep(1200);
      statusCN = await findStatusInPageAndFrames(page);
      if (!statusCN) {
        try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 2500 }); } catch {}
      }
    }

    if (!statusCN) {
      await saveDebug(page, tracking + '_nostatus');
      await page.close();
      return 'Not found';
    }

    const status = toStatus(statusCN);
    await page.close();
    return status;
  } catch (e) {
    console.error(tracking + ' — səhv: ' + e.message);
    try { await saveDebug(page, tracking + '_error'); } catch {}
    try { await page.close(); } catch {}
    return 'Problem';
  }
}

async function scrapeWithRetry(browser, tracking) {
  const first = await scrapeOnce(browser, tracking);
  if (first !== 'Problem') return first;
  await sleep(1500);
  return await scrapeOnce(browser, tracking);
}

/* ================== MAIN ================== */

async function main() {
  if (!WEBAPP_URL || !SECRET) {
    throw new Error('SHEET_WEBAPP_URL və SHEET_SECRET təyin edilməyib.');
  }

  const all = await getTrackingList();
  if (!all.length) { console.log('Yoxlanacaq kod yoxdur.'); return; }
  console.log('Yoxlanacaq kod:', all.length);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=1280,900'
    ]
  });

  let done = 0;
  try {
    for (const tr of all) {
      done++;
      const status = await scrapeWithRetry(browser, tr);
      console.log(done + '/' + all.length + '  ' + tr + ' → ' + status);
      await postResult(tr, status);
      await sleep(PAUSE_BETWEEN_MS);
    }
  } finally {
    await browser.close();
  }

  console.log('Bitdi.');
}

if (require.main === module) {
  main().catch(err => { console.error('FATAL:', err); process.exit(1); });
}
