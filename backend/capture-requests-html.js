/**
 * PropFind — Data Capture Script v2
 *
 * Both Domain and REA are Next.js apps that embed ALL listing data
 * directly in the page HTML inside a __NEXT_DATA__ script tag.
 * This script extracts that data without needing to intercept API calls.
 *
 * Run in Railway console:
 *   node capture-requests.js
 */

const { chromium } = require('playwright');
const fs = require('fs');

const SUBURBS = [
  { name: 'Balmain',      postcode: '2041', state: 'nsw' },
  { name: 'Newtown',      postcode: '2042', state: 'nsw' },
  { name: 'Glebe',        postcode: '2037', state: 'nsw' },
];

const results = { domain: [], realestate: [], raw: {} };

// ─── STEALTH HEADERS ─────────────────────────────────────────
const HEADERS = {
  'Accept-Language': 'en-AU,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
};

async function extractNextData(page, label) {
  try {
    const data = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (el) return JSON.parse(el.textContent);
      // Fallback: look for window.__data__ or similar
      return window.__NEXT_DATA__ || window.__data__ || null;
    });
    if (data) {
      console.log(`  ✓ [${label}] Found __NEXT_DATA__ (${JSON.stringify(data).length} chars)`);
      return data;
    }
    console.log(`  ✗ [${label}] No __NEXT_DATA__ found`);
    return null;
  } catch (e) {
    console.log(`  ✗ [${label}] Error extracting data: ${e.message}`);
    return null;
  }
}

async function extractAllScriptData(page, label) {
  // Grab everything in script tags in case data isn't in __NEXT_DATA__
  try {
    const scripts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('script:not([src])'))
        .map(s => s.textContent)
        .filter(t => t.length > 200 && (t.includes('"listings"') || t.includes('"price"') || t.includes('"address"') || t.includes('"suburb"')))
        .slice(0, 5);
    });
    return scripts;
  } catch (e) {
    return [];
  }
}

(async () => {
  console.log('='.repeat(60));
  console.log('PropFind Data Capture Script v2 — __NEXT_DATA__ extractor');
  console.log('='.repeat(60));

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-AU',
    extraHTTPHeaders: HEADERS,
  });

  // Remove automation detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // ─── DOMAIN ────────────────────────────────────────────────
  console.log('\n── DOMAIN.COM.AU ──────────────────────────────────────');
  for (const suburb of SUBURBS) {
    try {
      const page = await context.newPage();
      const url = `https://www.domain.com.au/sale/${suburb.name.toLowerCase()}-${suburb.state}-${suburb.postcode}/`;
      console.log(`\n→ ${url}`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const nextData = await extractNextData(page, `Domain/${suburb.name}`);
      const scriptData = await extractAllScriptData(page, `Domain/${suburb.name}`);
      const pageTitle = await page.title();
      const pageUrl = page.url();

      results.raw[`domain_${suburb.name}`] = {
        url, finalUrl: pageUrl, title: pageTitle, nextData, scriptData
      };

      if (nextData) results.domain.push({ suburb: suburb.name, data: nextData });

      await page.close();
      await new Promise(r => setTimeout(r, 1500)); // polite delay
    } catch (e) {
      console.error(`  Error on Domain/${suburb.name}:`, e.message);
    }
  }

  // Also try Domain's search API endpoint directly
  console.log('\n→ Trying Domain search API directly...');
  try {
    const page = await context.newPage();
    const apiUrl = 'https://www.domain.com.au/api/2.0/search/listings?suburb=Balmain&state=nsw&listing_type=sale&page_size=20';
    await page.goto(apiUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const content = await page.content();
    const bodyText = await page.evaluate(() => document.body.innerText);
    try {
      const json = JSON.parse(bodyText);
      console.log('  ✓ Domain API responded with JSON!');
      results.raw['domain_direct_api'] = json;
    } catch (e) {
      console.log('  ✗ Domain API did not return JSON');
      results.raw['domain_direct_api_html'] = bodyText.slice(0, 500);
    }
    await page.close();
  } catch (e) {
    console.log('  ✗ Domain direct API error:', e.message);
  }

  // ─── REALESTATE.COM.AU ─────────────────────────────────────
  console.log('\n── REALESTATE.COM.AU ──────────────────────────────────');
  for (const suburb of SUBURBS) {
    try {
      const page = await context.newPage();
      const url = `https://www.realestate.com.au/buy/in-${suburb.name.toLowerCase()},+${suburb.state.toUpperCase()}/list-1`;
      console.log(`\n→ ${url}`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const nextData = await extractNextData(page, `REA/${suburb.name}`);
      const scriptData = await extractAllScriptData(page, `REA/${suburb.name}`);
      const pageTitle = await page.title();
      const pageUrl = page.url();

      results.raw[`rea_${suburb.name}`] = {
        url, finalUrl: pageUrl, title: pageTitle, nextData, scriptData
      };

      if (nextData) results.realestate.push({ suburb: suburb.name, data: nextData });

      await page.close();
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.error(`  Error on REA/${suburb.name}:`, e.message);
    }
  }

  await browser.close();

  // ─── SAVE ──────────────────────────────────────────────────
  fs.writeFileSync('captured-endpoints.json', JSON.stringify(results, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('CAPTURE COMPLETE');
  console.log('='.repeat(60));
  console.log(`Domain pages with data:   ${results.domain.length}`);
  console.log(`REA pages with data:      ${results.realestate.length}`);
  console.log(`\nFile saved: captured-endpoints.json`);
  console.log(`File size:  ${(fs.statSync('captured-endpoints.json').size / 1024).toFixed(1)} KB`);

  // Print page titles so we can see if we got the right pages or redirected to login/captcha
  console.log('\n── Page titles (tells us if we were blocked) ──');
  Object.entries(results.raw).forEach(([key, val]) => {
    if (val.title) console.log(`  ${key}: "${val.title}"`);
  });

  console.log('\n── What to do next ──');
  console.log('If domain/REA pages are 0, paste the page titles above back to Claude.');
  console.log('If data was found, run:');
  console.log('  cat captured-endpoints.json | head -200');
})();
