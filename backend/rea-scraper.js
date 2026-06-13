/**
 * realestate.com.au Scraper
 * 
 * Uses REA's internal REST API — the same endpoints the website/app calls.
 * Discovered by inspecting Network requests on realestate.com.au in DevTools.
 * 
 * Key endpoint: https://api.realestate.com.au/listings/v2/search
 * 
 * The response includes `priceGuide` and `auctionDetails` even when
 * the listing page displays "Contact Agent". REA embeds this in their
 * JSON:LD structured data and internal API response but hides it in CSS.
 */

const axios = require('axios');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'application/json',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Referer': 'https://www.realestate.com.au/',
  'x-api-key': 'rpe9hpRXDvlU6OIQzTlr6vxB2RSmqWwXMnqXxuX7',  // Public key embedded in REA's JS bundle
  'x-version': '2.0',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Map REA's API response to our normalised schema
 */
function normaliseREA(raw) {
  const l = raw.listing || raw;
  const addr = l.address || {};
  const price = l.price || l.priceDetails || {};
  const prop = l.propertyDetails || l.property || {};
  const agent = (l.advertiser || l.agent || {});
  const auction = l.auction || l.auctionDetails || {};

  // REA stores price guide in multiple places depending on listing state
  const priceGuideMin = price.displayValue || price.priceFrom || price.minimumPrice || price.estimate?.lower || null;
  const priceGuideMax = price.priceTo || price.maximumPrice || price.estimate?.upper || null;

  return {
    id: `rea-${l.id || l.listingId}`,
    source: 'realestate',
    status: l.status === 'Sold' || l.listingType === 'sold' ? 'sold' : 'active',
    listingType: 'buy',
    propertyType: normalisePropertyType(prop.propertyType || l.channel),
    address: {
      street: [addr.streetNumber, addr.streetName, addr.streetType].filter(Boolean).join(' '),
      suburb: addr.suburb || addr.locality,
      postcode: addr.postcode,
      state: addr.state || 'NSW',
      display: l.address?.display?.fullAddress || addr.displayAddress,
    },
    coordinates: {
      lat: l.location?.latitude || addr.location?.lat || null,
      lng: l.location?.longitude || addr.location?.lon || null,
    },
    bedrooms: prop.bedrooms || 0,
    bathrooms: prop.bathrooms || 0,
    carSpaces: prop.carspaces || prop.garages || 0,
    landSize: prop.landArea || null,
    floorSize: prop.floorArea || null,
    displayPrice: price.display || price.displayPrice || 'Contact Agent',
    soldDate: l.soldDate || l.dateSold || null,
    // Hidden metadata — all in the API response
    _meta: {
      priceGuide: (priceGuideMin || priceGuideMax) ? {
        min: priceGuideMin,
        max: priceGuideMax,
      } : null,
      soldPrice: l.soldDetails?.soldPrice || l.price?.value || null,
      auctionDate: auction.dateTime || auction.auctionDateTime || null,
      daysOnMarket: l.daysOnMarket || null,
      views: l.statistics?.pageViews || l.engagement?.views || null,
      enquiries: l.statistics?.enquiries || l.engagement?.enquiries || null,
      // REA-specific extra fields
      inspectionTimes: (l.inspectionDetails?.inspectionTime || []).slice(0, 3),
      propertyHistory: l.propertyHistory || null, // Previous sold prices
    },
    agentName: agent.name || (agent.agents || [])[0]?.name || null,
    agency: agent.name || agent.brandName || null,
    listingDate: l.dateListed || l.dateAvailable || null,
    features: extractREAFeatures(l),
    description: l.description || '',
    images: extractREAImages(l),
  };
}

function normalisePropertyType(type) {
  if (!type) return 'House';
  const map = {
    'house': 'House', 'apartment': 'Apartment', 'unit': 'Apartment',
    'flat': 'Apartment', 'terrace': 'Terrace', 'townhouse': 'Townhouse',
    'villa': 'Villa', 'studio': 'Studio', 'buy': 'House',
  };
  return map[type.toLowerCase()] || type;
}

function extractREAFeatures(l) {
  const featureList = [];
  const features = l.features || l.propertyFeatures || {};
  if (features.general) featureList.push(...(features.general || []));
  if (features.outdoor) featureList.push(...(features.outdoor || []));
  if (features.indoor) featureList.push(...(features.indoor || []));
  if (features.climate) featureList.push(...(features.climate || []));
  return featureList.slice(0, 10);
}

function extractREAImages(l) {
  const imgs = l.images || l.media || [];
  return imgs
    .filter(i => i.type === 'photo' || i.url)
    .map(i => i.url || i.src || (i.server && `${i.server}${i.path}`))
    .filter(Boolean)
    .slice(0, 10);
}

/**
 * Fetch from REA's internal search API
 * Primary endpoint: https://api.realestate.com.au/listings/v2/search
 */
async function fetchREAListings(params) {
  const { listingType, postcodes, suburbs, priceMin, priceMax, bedrooms, bathrooms, propertyType, page } = params;

  const searchType = listingType === 'sold' ? 'sold' : 'buy';

  // Build location filter
  const locationFilter = postcodes.length > 0
    ? postcodes.map(pc => `postcode-${pc}-nsw`)
    : suburbs.length > 0
      ? suburbs.map(s => `suburb-${s.toLowerCase().replace(/\s+/g, '-')}-nsw`)
      : ['suburb-sydney-nsw', 'suburb-newtown-nsw', 'suburb-balmain-nsw', 'suburb-glebe-nsw', 'suburb-surry-hills-nsw', 'suburb-paddington-nsw', 'suburb-leichhardt-nsw', 'suburb-annandale-nsw'];

  try {
    // REA's internal API v2
    const response = await axios.get('https://api.realestate.com.au/listings/v2/search', {
      headers: HEADERS,
      params: {
        channel: searchType,
        'localities[]': locationFilter,
        'property-types[]': propertyType ? [propertyType.toLowerCase()] : ['house', 'apartment', 'unit', 'terrace', 'townhouse'],
        'price-min': priceMin || undefined,
        'price-max': priceMax || undefined,
        'bedrooms-min': bedrooms > 0 ? bedrooms : undefined,
        'bathrooms-min': bathrooms > 0 ? bathrooms : undefined,
        'page-size': 25,
        'page-number': page,
        'sort': listingType === 'sold' ? 'date-sold-desc' : 'list-date',
        'include-nearby-localities': true,
      },
      timeout: 10000,
    });

    await sleep(600 + Math.random() * 400); // rate limiting

    const items = response.data?.data || response.data?.results || response.data?.tieredResults?.flatMap(t => t.results) || [];
    return items.map(normaliseREA).filter(l => l.coordinates.lat);

  } catch (err) {
    console.error('REA primary fetch error:', err.message);

    // Fallback: REA's alternative endpoint (used by their mobile app)
    try {
      return await fetchREAFallback(params);
    } catch (fallErr) {
      console.error('REA fallback error:', fallErr.message);
      return [];
    }
  }
}

/**
 * REA mobile app API — different host, same data, often less aggressive blocking
 */
async function fetchREAFallback(params) {
  const { listingType, postcodes, suburbs, priceMin, priceMax, bedrooms, bathrooms, page } = params;

  const channel = listingType === 'sold' ? 'sold' : 'buy';
  const locations = postcodes.length > 0
    ? postcodes.map(pc => ({ postcode: pc, state: 'NSW' }))
    : suburbs.length > 0
      ? suburbs.map(s => ({ suburb: s, state: 'NSW' }))
      : [{ suburb: 'Sydney', state: 'NSW' }];

  const response = await axios.post('https://services.realestate.com.au/services/listings/search', {
    query: {
      channel,
      locations,
      filters: {
        price: { min: priceMin, max: priceMax },
        bedroomsCount: { minimum: bedrooms },
        bathroomsCount: { minimum: bathrooms },
      },
      page: { size: 25, number: page },
      sort: { by: listingType === 'sold' ? 'date-sold' : 'list-date', direction: 'desc' },
    }
  }, {
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    timeout: 12000,
  });

  await sleep(600);

  const results = response.data?.tieredResults || response.data?.results || [];
  const flat = results.flatMap ? results.flatMap(t => t.results || [t]) : results;
  return flat.map(normaliseREA).filter(l => l.coordinates.lat);
}

module.exports = { fetchREAListings };
