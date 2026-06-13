/**
 * PropFind Backend Server
 * 
 * Fetches listings from Domain.com.au and realestate.com.au internal APIs,
 * normalises them into a shared schema, and serves to the frontend.
 * 
 * Run: npm install && npm start
 * Then point the frontend at http://localhost:3001/api/listings
 */

const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const { fetchDomainListings } = require('./domain-scraper');
const { fetchREAListings } = require('./rea-scraper');

const app = express();
const cache = new NodeCache({ stdTTL: 300 }); // 5-minute cache

app.use(cors());
app.use(express.json());

/**
 * GET /api/listings
 * Query params:
 *   listingType: 'buy' | 'sold'         (default: buy)
 *   suburb: comma-separated             (e.g. Balmain,Glebe)
 *   postcode: comma-separated           (e.g. 2041,2037)
 *   priceMin: number
 *   priceMax: number
 *   bedrooms: min bedrooms
 *   bathrooms: min bathrooms
 *   propertyType: House|Apartment|Terrace etc.
 *   page: page number                   (default: 1)
 * 
 * Returns: { listings: [...], total: number, page: number }
 */
app.get('/api/listings', async (req, res) => {
  try {
    const params = {
      listingType: req.query.listingType || 'buy',
      suburbs: req.query.suburb ? req.query.suburb.split(',') : [],
      postcodes: req.query.postcode ? req.query.postcode.split(',') : [],
      priceMin: req.query.priceMin ? +req.query.priceMin : null,
      priceMax: req.query.priceMax ? +req.query.priceMax : null,
      bedrooms: req.query.bedrooms ? +req.query.bedrooms : 0,
      bathrooms: req.query.bathrooms ? +req.query.bathrooms : 0,
      propertyType: req.query.propertyType || null,
      page: req.query.page ? +req.query.page : 1,
    };

    const cacheKey = JSON.stringify(params);
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('Cache hit:', cacheKey);
      return res.json(cached);
    }

    // Fetch from both sources in parallel
    const [domainListings, reaListings] = await Promise.allSettled([
      fetchDomainListings(params),
      fetchREAListings(params),
    ]);

    const listings = [
      ...(domainListings.status === 'fulfilled' ? domainListings.value : []),
      ...(reaListings.status === 'fulfilled' ? reaListings.value : []),
    ];

    // Filter sold to 12 months
    const twelveMonthsAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const filtered = listings.filter(l => {
      if (l.status === 'sold' && new Date(l.soldDate) < twelveMonthsAgo) return false;
      return true;
    });

    // Sort: active first, then by days on market ascending
    filtered.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return (a._meta.daysOnMarket || 999) - (b._meta.daysOnMarket || 999);
    });

    const result = { listings: filtered, total: filtered.length, page: params.page, source: { domain: domainListings.status, rea: reaListings.status } };
    cache.set(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error('Error fetching listings:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`PropFind backend running on http://localhost:${PORT}`));
