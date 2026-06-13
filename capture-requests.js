/**
 * PropFind — API Endpoint Capture Script
 *
 * Launches a real browser, performs searches on Domain.com.au and
 * realestate.com.au, and intercepts every API call they make.
 * Saves all results to captured-endpoints.json for analysis.
 *
 * Run from the Railway console:
 *   node capture-requests.js
 */

const { chromium } = require('playwright');
const fs = require('fs');

const SEARCH_SUBURB = 'Balmain';
const SEARCH_STATE  = 'NSW';

// Patterns that identify real API/data calls (not analytics, ads, etc.)
const INTERESTING = [
  /api\./,
  /graphql/,
  /listings/,
  /search/,
  /properties/,
  /results/,
  /\/v[0-9]/,
];

// Noise to ignore
const IGNORE = [
  /google/,
  /analytics/,
  /facebook/,
  /doubleclick/,
  /segment/,
  /sentry/,
  /hotjar/,
  /mixpanel/,
  /newrelic/,
  /optimizely/,
  /cloudfront\.net\/[a-z0-9]{8,}\.(js|css|png|jpg|svg|woff)/,
];

const captured = { domain: [], realestate: [] };

function isInteresting(url) {
  if (IGNORE.some(p => p.test(url))) return false;
  return INTERESTING.some(p => p.test(url));
}

async function captureSite(page, site, url, targetKey) {
  const requests = [];

  page.on('response', async (response) => {
    const reqUrl = response.url();
    const method = response.request().method();
    const status = response.status();
    const contentType = response.headers()['content-type'] || '';

    if (!contentType.includes('json')) return;
    if (!isInteresting(reqUrl)) return;
    if (method === 'OPTIONS') return;

    try {
      const body = await response.json();
      const postBody = response.request().postData();

      requests.push({
        url: reqUrl,
        method,
        status,
        requestHeaders: response.request().headers(),
        postBody: postBody ? (() => { try { return JSON.parse(postBody); } catch { return postBody; } })() : null,
        responsePreview: JSON.stringify(body).slice(0, 2000),
        responseFull: body,
      });

      console.log(`  ✓ [${site}] ${method} ${status} ${reqUrl.slice(0, 100)}`);
    } catch (e) {
      // non-JSON or empty body, skip
    }
  });

  console.log(`\n→ Loading ${site}...`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  captured[targetKey] = requests;
  page.removeAllListeners('response');
}

(async () => {
  console.log('='.repeat(60));
  console.log('PropFind API Capture Script');
  console.log('='.repeat(60));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    locale: 'en-AU',
  });

  // ─── DOMAIN ──────────────────────────────────────────────────
  try {
    const domainPage = await context.newPage();
    const domainUrl = `https://www.domain.com.au/sale/${SEARCH_SUBURB.toLowerCase()}-${SEARCH_STATE.toLowerCase()}-2041/`;
    await captureSite(domainPage, 'Domain', domainUrl, 'domain');

    // Also try a second page load to catch lazy-loaded requests
    console.log('  → Scrolling to trigger more requests...');
    await domainPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await domainPage.waitForTimeout(2000);

    // Try clicking on a listing to capture detail endpoint
    try {
      const firstListing = await domainPage.$('a[href*="/house-"]') ||
                           await domainPage.$('a[href*="/apartment-"]') ||
                           await domainPage.$('a[data-testid*="listing"]');
      if (firstListing) {
        console.log('  → Clicking first listing to capture detail endpoint...');
        await firstListing.click({ timeout: 3000 });
        await domainPage.waitForTimeout(3000);
      }
    } catch (e) {
      console.log('  (could not click listing, continuing)');
    }

    await domainPage.close();
  } catch (e) {
    console.error('Domain capture error:', e.message);
  }

  // ─── REALESTATE.COM.AU ───────────────────────────────────────
  try {
    const reaPage = await context.newPage();
    const reaUrl = `https://www.realestate.com.au/buy/in-${SEARCH_SUBURB.toLowerCase()}%2C+${SEARCH_STATE}/list-1`;
    await captureSite(reaPage, 'REA', reaUrl, 'realestate');

    console.log('  → Scrolling to trigger more requests...');
    await reaPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await reaPage.waitForTimeout(2000);

    // Try clicking a listing
    try {
      const firstListing = await reaPage.$('a[href*="/property-"]') ||
                           await reaPage.$('[data-testid="listing-card"] a');
      if (firstListing) {
        console.log('  → Clicking first listing to capture detail endpoint...');
        await firstListing.click({ timeout: 3000 });
        await reaPage.waitForTimeout(3000);
      }
    } catch (e) {
      console.log('  (could not click listing, continuing)');
    }

    await reaPage.close();
  } catch (e) {
    console.error('REA capture error:', e.message);
  }

  await browser.close();

  // ─── SAVE RESULTS ────────────────────────────────────────────
  const output = {
    capturedAt: new Date().toISOString(),
    summary: {
      domain: captured.domain.length,
      realestate: captured.realestate.length,
    },
    domain: captured.domain,
    realestate: captured.realestate,
  };

  fs.writeFileSync('captured-endpoints.json', JSON.stringify(output, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('CAPTURE COMPLETE');
  console.log('='.repeat(60));
  console.log(`Domain requests captured:      ${captured.domain.length}`);
  console.log(`REA requests captured:         ${captured.realestate.length}`);
  console.log('\nResults saved to: captured-endpoints.json');
  console.log('\nTo view results, run:');
  console.log('  cat captured-endpoints.json');
  console.log('\nOr print just the URLs:');
  console.log('  node -e "const d=require(\'./captured-endpoints.json\');d.domain.forEach(r=>console.log(\'DOM:\',r.method,r.url));d.realestate.forEach(r=>console.log(\'REA:\',r.method,r.url))"');
})();
