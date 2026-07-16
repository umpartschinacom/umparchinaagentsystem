// scraper.js — Final stabilized version (Cainiao + Google Sheets)
const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const UA = require('random-useragent');
const fs = require('fs');
const path = require('path');

// Google Apps Script bağlantısı (Secrets → env). Lokal test üçün fallback var.
const WEBAPP_URL = process.env.SHEET_WEBAPP_URL
  || 'https://script.google.com/macros/s/AKfycbxxL1BUluNan_gXD-UFW0S6l9UxaQsQYsipBJjcQOGFpi0236sUX01w-R2egwDXkDKvcQ/exec';
const SECRET = process.env.SHEET_SECRET
  || 'bmwmpart_2AGENT_SYS_2025_secret_9bX4h2Qz';

// Cainiao səhifəsi və selektorlar
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

// Taymaut parametrləri
const NAV_TIMEOUT_MS        = 20000;
const WAIT_INPUT_TIMEOUT_MS = 15000;
const WAIT_BTN_TIMEOUT_MS   = 10000;
const PER_TRACKING_MAX_MS   = 60000;  // 60 saniyə
const STATUS_POLL_INTERVAL  = 1000;   // 1 saniyə

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/** Çin dilindən Azərbaycan statusuna çevirici */
function cnToAzStatus(textCN) {
  const t = (textCN || '').toString().trim();
  if (!t) return 'hazırlanır';
  if (/未查询到|暂无|没有相关|无法查询/.test(t)) return 'problem';
  if (/签收|妥投|送达/.test(t) || /(delivered|received|signed)/i.test(t)) return 'çatdı (received)';
  if (/派送中|投递|派件/.test(t) || /out\s*for\s*delivery/i.test(t)) return 'çatdırılmada';
  if (/运输中|在途|到达|转运|发出/.test(t) || /(in\s*transit|arrived)/i.test(t)) return 'yoldadır (in transit)';
  if (/揽收|收寄|待揽收/.test(t) || /(pickup|accept|preparing)/i.test(t)) return 'hazırlanır';
  if (/异常|问题件|退回|失败/.test(t) || /(exception|failed)/i.test(t)) return 'problem';
  return 'yoldadır (in transit)';
}

/** Debug (problem/nostatus üçün screenshot və HTML) */
async function saveDebug(page, name) {
  try {
    const dir = path.join(process.cwd(), 'debug');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(()=>{});
    const html = await page.content().catch(()=> '');
    if (html) fs.writeFileSync(path.join(dir, `${name}.html`), html, 'utf8');
  } catch {}
}

/** Google Sheets-dən siyahını alır (yalnız aktiv izləmə kodları) */
async function getTrackingList() {
  const base = `${WEBAPP_URL}?secret=${encodeURIComponent(SECRET)}`;

  // 1) op=list ilə cəhd
  let url = `${base}&op=list`;
  let res = await fetch(url, { method: 'GET' });
  let text = await res.text();
  try {
    const js = JSON.parse(text);
    if (js.ok && Array.isArray(js.items)) {
      return js.items.map(x => String(x).trim()).filter(Boolean);
    }
    console.error('GET list not ok:', js.error || js);
  } catch {
    console.error('GET list JSON parse fail:', text.slice(0,200));
  }

  // 2) Fallback: op olmadan köhnə endpoint
  url = base;
  res = await fetch(url, { method: 'GET' });
  text = await res.text();
  try {
    const js = JSON.parse(text);
    if (js.ok && Array.isArray(js.items)) {
      return js.items.map(x => String(x).trim()).filter(Boolean);
    }
    throw new Error('WebApp doGet error: ' + (js.error || 'unknown'));
  } catch (e) {
    throw new Error('WebApp doGet error: ' + (e.message || text.slice(0,200)));
  }
}

/** Cavabı geri göndər */
async function postResult(tracking, status) {
  await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, tracking, status })
  }).catch(()=>{});
}

/** Klik yardımçısı */
async function hardClick(page, selector) {
  try {
    await page.$eval(selector, el => { el.scrollIntoView({block:'center'}); el.click(); });
  } catch(_) {}
  try {
    const el = await page.$(selector);
    if (el) {
      const box = await el.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down(); await page.mouse.up();
      }
    }
  } catch(_) {}
}

/** Shadow DOM və iframeləri də nəzərə alır */
async function findStatusInPageAndFrames(page) {
  const evalFn = (cands) => {
    const hasStatus = (s) => !!(s && /签收|派送中|运输中|揽收|问题件|在途|投递|未查询|暂无|无法查询/i.test(String(s)));
    const probe = (root, sels) => {
      for (const sel of sels) {
        const el = root.querySelector?.(sel);
        if (el && el.innerText?.trim()) return el.innerText.trim();
      }
      const txt = root.innerText || '';
      if (hasStatus(txt)) {
        const hit = txt.split(/\n+/).map(s => s.trim()).find(hasStatus);
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
        const doc = f.contentDocument || f.contentWindow?.document;
        if (doc) {
          val = probe(doc, sels);
          if (val) return val;
        }
      } catch(_) {}
    }
    return '';
  };

  try { const v = await page.evaluate(evalFn, STATUS_CANDIDATES); if (v) return v; } catch {}
  for (const fr of page.frames()) {
    try { const v = await fr.evaluate(evalFn, STATUS_CANDIDATES); if (v) return v; } catch {}
  }
  return '';
}

/** Bir izləmə kodunu yoxlayır */
async function scrapeOnce(browser, tracking) {
  const page = await browser.newPage();
  try {
    const ua = UA.getRandom() || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(PAGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Cookie razılığı varsa, bas
    try {
      await page.evaluate(() => {
        const ok = [...document.querySelectorAll('button,.btn,[role="button"]')]
          .find(b => /同意|接受|继续|确定|知道了|OK|Accept|Agree/.test((b.textContent||'').trim()));
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
    console.log(`➡️  ${tracking} üçün düyməyə basıldı`);

    let statusCN = '';
    const start = Date.now();
    while (!statusCN && Date.now() - start < PER_TRACKING_MAX_MS) {
      await sleep(1200);
      statusCN = await findStatusInPageAndFrames(page);
      if (!statusCN) { try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 2500 }); } catch {} }
    }

    if (!statusCN) {
      await saveDebug(page, `${tracking}_nostatus`);
      await page.close();
      return { statusAZ: 'problem' };
    }

    const statusAZ = cnToAzStatus(statusCN);
    await page.close();
    return { statusAZ };
  } catch (e) {
    console.error(`❌ ${tracking} üçün səhv: ${e.message}`);
    try { await saveDebug(page, `${tracking}_error`); } catch {}
    try { await page.close(); } catch {}
    return { statusAZ: 'problem' };
  }
}

/** Retry mexanizmi */
async function scrapeWithRetry(browser, tracking) {
  try { return await scrapeOnce(browser, tracking); }
  catch { await sleep(1000); try { return await scrapeOnce(browser, tracking); } catch { return { statusAZ:'problem' }; } }
}

/** Main */
async function main() {
  const list = await getTrackingList();
  if (!list.length) { console.log('Yoxlanacaq kod yoxdur.'); return; }

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

  for (const tr of list) {
    console.log('Yoxlanır:', tr);

    // Hər izləmə kodu üçün yoxlama başlasın və paralel status yaza bilsin
    const checkPromise = scrapeWithRetry(browser, tr)
      .then(async (res) => {
        console.log(' →', tr, '⇒', res.statusAZ);
        await postResult(tr, res.statusAZ);   // DƏRHAL YAZ
        return res;
      })
      .catch(async (err) => {
        console.error(`❌ ${tr} üçün səhv: ${err.message}`);
        await postResult(tr, 'problem');
        return { statusAZ: 'problem' };
      });

    // Növbəvi icra (paralel açmayaraq sistemə yüngül yanaşırıq)
    await checkPromise;
  }

  await browser.close();
}

if (require.main === module) {
  main().catch(err => { console.error('FATAL:', err); process.exit(1); });
}
