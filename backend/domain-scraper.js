/**
 * Domain.com.au Scraper
 * 
 * Uses Domain's internal GraphQL API — the same endpoint the website uses.
 * Found by inspecting Network tab on domain.com.au → XHR → search requests.
 * 
 * The key insight: Domain's GraphQL response includes priceDetails.priceGuide
 * even when the UI shows "Contact Agent". This field is just not rendered.
 */

const axios = require('axios');

// Shared headers that mimic a real browser request
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'application/json, */*',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://www.domain.com.au',
  'Referer': 'https://www.domain.com.au/',
  'x-domain-client': 'web-consumer',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Map Domain's API response into our normalised schema
 */
function normaliseDomain(raw) {
  const l = raw.listingInfo || raw;
  const addr = l.addressParts || {};
  const price = l.priceDetails || {};
  const features = l.features || {};
  const inspection = l.inspectionDetails || {};
  const agent = (l.advertiserIdentifiers || {});

  return {
    id: `dom-${l.id}`,
    source: 'domain',
    status: l.status === 'Sale' ? 'active' : l.status === 'Sold' ? 'sold' : 'active',
    listingType: 'buy',
    propertyType: l.propertyType || 'House',
    address: {
      street: [addr.streetNumber, addr.street].filter(Boolean).join(' '),
      suburb: addr.suburb,
      postcode: addr.postcode,
      state: addr.state || 'NSW',
      display: l.address || addr.displayAddress,
    },
    coordinates: {
      lat: l.geoLocation?.latitude,
      lng: l.geoLocation?.longitude,
    },
    bedrooms: features.bedrooms || 0,
    bathrooms: features.bathrooms || 0,
    carSpaces: features.carSpaces || features.garages || 0,
    landSize: features.landSize || null,
    floorSize: features.floorSize || null,
    displayPrice: price.displayPrice || 'Contact Agent',
    soldDate: l.soldDetails?.soldDate || null,
    // Hidden metadata — present in JSON but not rendered on page
    _meta: {
      // priceGuide is the gold: often populated even when displayPrice = "Contact Agent"
      priceGuide: price.priceFrom || price.priceTo ? {
        min: price.priceFrom || null,
        max: price.priceTo || null,
      } : null,
      soldPrice: l.soldDetails?.soldPrice || null,
      auctionDate: inspection.auctionDate || null,
      daysOnMarket: l.daysOnMarket || null,
      views: l.statistics?.views || null,
      enquiries: l.statistics?.enquiries || null,
      // Additional hidden fields
      councilRates: l.propertySummary?.councilRates || null,
      waterRates: l.propertySummary?.waterRates || null,
      strataLevy: l.propertySummary?.strataLevy || null,
    },
    agentName: agent.agentName || null,
    agency: agent.advertiserName || null,
    listingDate: l.dateListed || null,
    features: features.generalFeatures || [],
    description: l.description || '',
    images: (l.images || []).map(i => i.url).filter(Boolean),
  };
}

/**
 * Fetch listings from Domain's internal search API
 * Endpoint discovered via DevTools Network inspection
 */
async function fetchDomainListings(params) {
  const { listingType, suburbs, postcodes, priceMin, priceMax, bedrooms, bathrooms, propertyType, page } = params;

  // Build search areas from suburbs or postcodes
  const locations = postcodes.length > 0
    ? postcodes.map(pc => ({ suburb: '', postcode: pc, state: 'NSW', includeSurroundingSuburbs: false }))
    : suburbs.length > 0
      ? suburbs.map(s => ({ suburb: s, postcode: '', state: 'NSW', includeSurroundingSuburbs: false }))
      : [{ suburb: '', postcode: '', state: 'NSW', area: 'Inner Sydney - Inner West', includeSurroundingSuburbs: true }];

  const searchMode = listingType === 'sold' ? 'sold' : 'buy';

  try {
    // Domain's internal search API (REST endpoint, discovered via Network tab)
    const response = await axios.get(`https://www.domain.com.au/api/search/v1/${searchMode}`, {
      headers: HEADERS,
      params: {
        'locations[]': locations.map(l => l.suburb || l.postcode),
        'state': 'nsw',
        'property-types[]': propertyType ? [propertyType.toLowerCase()] : ['house', 'apartment-unit-flat', 'terrace', 'townhouse'],
        'bedrooms': bedrooms > 0 ? bedrooms : undefined,
        'bathrooms': bathrooms > 0 ? bathrooms : undefined,
        'price': priceMin || priceMax ? `${priceMin || 0}-${priceMax || 99000000}` : undefined,
        'page': page,
        'per-page': 25,
        'sort': listingType === 'sold' ? 'solddate-desc' : 'list-date',
      },
      timeout: 10000,
    });

    await sleep(500 + Math.random() * 500); // polite rate limiting

    const items = response.data?.items || response.data?.listings || [];
    return items.map(normaliseDomain).filter(l => l.coordinates.lat);

  } catch (err) {
    console.error('Domain fetch error:', err.message);

    // Fallback: try Domain's GraphQL endpoint
    try {
      return await fetchDomainGraphQL(params);
    } catch (gqlErr) {
      console.error('Domain GraphQL fallback error:', gqlErr.message);
      return [];
    }
  }
}

/**
 * Domain GraphQL fallback
 * This is the primary API the Domain website uses for listing search pages
 */
async function fetchDomainGraphQL(params) {
  const { listingType, postcodes, suburbs, priceMin, priceMax, bedrooms, bathrooms, propertyType, page } = params;

  const query = `
    query searchResultsPageQuery($criteria: SearchCriteria!, $pagination: Pagination) {
      searchResults(criteria: $criteria, pagination: $pagination) {
        totalResultsCount
        results {
          ... on ListingSearchResult {
            listing {
              id
              status
              propertyType
              address
              addressParts { streetNumber street suburb postcode state }
              geoLocation { latitude longitude }
              priceDetails {
                displayPrice
                priceFrom
                priceTo
                priceLabel
              }
              soldDetails { soldDate soldPrice }
              features { bedrooms bathrooms carSpaces garages landSize floorSize generalFeatures }
              advertiserIdentifiers { agentName advertiserName }
              inspectionDetails { auctionDate }
              dateListed
              daysOnMarket
              statistics { views enquiries }
              description
              images { url }
            }
          }
        }
      }
    }
  `;

  const variables = {
    criteria: {
      listingType: listingType === 'sold' ? 'SOLD' : 'SALE',
      propertyTypes: propertyType ? [propertyType.toUpperCase().replace(' ', '_')] : ['HOUSE', 'APARTMENT_UNIT_FLAT', 'TERRACE', 'TOWNHOUSE'],
      locations: postcodes.length > 0
        ? postcodes.map(pc => ({ postcode: pc, state: 'NSW' }))
        : suburbs.length > 0
          ? suburbs.map(s => ({ suburb: s, state: 'NSW' }))
          : [{ region: 'Sydney Region', state: 'NSW' }],
      price: { minimum: priceMin || 0, maximum: priceMax || 50000000 },
      bedroomsCount: { minimum: bedrooms },
      bathroomsCount: { minimum: bathrooms },
    },
    pagination: { pageNumber: page, pageSize: 25 },
  };

  const response = await axios.post('https://www.domain.com.au/graphql', { query, variables }, {
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  await sleep(500 + Math.random() * 500);

  const results = response.data?.data?.searchResults?.results || [];
  return results
    .map(r => r.listing)
    .filter(Boolean)
    .map(normaliseDomain)
    .filter(l => l.coordinates.lat);
}

module.exports = { fetchDomainListings };
