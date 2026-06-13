# PropFind

Sydney property search app — pulls listings from Domain.com.au and realestate.com.au,
including hidden price guides and metadata not shown on their websites.

## Structure

```
propfind/
├── index.html          ← Frontend (open directly in browser, self-contained with mock data)
└── backend/
    ├── server.js        ← Express API server
    ├── domain-scraper.js ← Domain.com.au internal API calls
    ├── rea-scraper.js   ← realestate.com.au internal API calls
    └── package.json
```

## Quick Start (frontend only)

Just open `index.html` in a browser. It runs entirely with mock data
structured identically to what the real APIs return. Great for testing
the UI and filters.

## Wiring in Live Data

1. **Start the backend:**
   ```bash
   cd backend
   npm install
   npm start
   # Running on http://localhost:3001
   ```

2. **Update the frontend** — replace the mock `ALL_LISTINGS` constant in
   `index.html` with a fetch call:

   ```javascript
   // In the App component, replace ALL_LISTINGS with:
   const [allListings, setAllListings] = useState([]);
   
   useEffect(() => {
     fetch('http://localhost:3001/api/listings?listingType=buy')
       .then(r => r.json())
       .then(data => setAllListings(data.listings));
   }, []);
   ```

## How the Hidden Price Guides Work

Both sites embed more data in their API JSON than they display in the UI.

**Domain:** The `priceDetails.priceFrom` and `priceDetails.priceTo` fields
are populated even when `displayPrice` is "Contact Agent". The website's
React components simply don't render them — but they're in the response.

**REA:** The `price.displayValue`, `price.estimate.lower/.upper`, and 
`auction.dateTime` fields are present in the API response. REA suppresses
them from display when the agent has chosen "Contact Agent" as the listing
type, but the underlying data is often still there.

## Rate Limiting

The scrapers include 500–1000ms delays between requests. Don't remove these —
both sites will temporarily block your IP if you hammer them. For personal
use at low volume this is completely fine.

## If Requests Get Blocked

Both sites use Cloudflare. If you start getting 403s:
- Add a rotating residential proxy (Bright Data, Oxylabs have free tiers)
- Or use the Apify actors mentioned in the exploration phase, which handle
  proxy rotation for you and expose a simple API
- The Apify `one-api/realestate-com-au-scraper` and 
  `parseforge/domain-com-au-scraper` actors return data in a very similar
  schema to what these scrapers produce

## API Endpoint Reference

The backend serves:

`GET /api/listings` — All listings matching query params
- `listingType`: buy | sold (default: buy)
- `postcode`: comma-separated (e.g. 2041,2037,2040)
- `suburb`: comma-separated (e.g. Balmain,Glebe)  
- `priceMin`, `priceMax`: numbers
- `bedrooms`, `bathrooms`: minimum counts
- `propertyType`: House|Apartment|Terrace|Townhouse

`GET /api/health` — Health check
