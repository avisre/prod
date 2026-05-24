# Stock Portfolio Pro

**Live:** https://stockportfolio.pro · **No-signup demo:** https://stockportfolio.pro/demo
**Built by:** [Avinash Sreekumar](https://avisre.github.io) — cross-platform full-stack developer (Trivandrum, India)

A production-grade portfolio tracker and analytics dashboard with hand-rolled D3 charts, drill-down fundamentals, and real-time market data. Read-only demo seeded with AAPL / MSFT / TSLA / NVDA / JPM lives at `/demo`.

## Stack
- **Backend:** Node.js + Express, MongoDB Atlas (Mongoose)
- **Frontend:** Vanilla HTML/CSS/JS + D3.js v7 (custom SVG charts — no Recharts, no Chart.js)
- **Market data:** `yahoo-finance2` wrapped to mimic Alpha Vantage response shape (provider-swappable), plus Alpha Vantage fallback for fundamentals
- **Auth:** JWT + Google OAuth (`google-auth-library`) + Facebook OAuth + bcrypt/argon2
- **Payments:** Stripe subscription gating for paid features
- **Performance:** in-memory tiered TTL cache (60 s quotes → 12 h fundamentals), ~2.5 req/s outbound throttle to stay inside upstream limits
- **Deploy:** Render with custom domain, HTTPS/SSL

## Snapshot notes

This folder contains the production snapshot — Fundamentals + Dashboard improvements (adaptive axes, cleaned layout, new charts, tooltips, USD unit labels, per-user portfolio, plus the `/demo` read-only route).

## Structure

- frontend/ — all static assets (HTML/CSS/JS, Media)
- backend/
  - app.js — Express API + static server
  - package.json, package-lock.json — backend dependencies
  - .env (optional) — secrets and config

## Prerequisites

- Node.js 18+
- MongoDB Atlas connection (the connection string is currently set in `backend/app.js`)
- An Alpha Vantage API key (free) for Fundamentals & News

## Configure

1) In `backend/.env` (optional but recommended), set:

```
ALPHA_VANTAGE_API_KEY=YOUR_ALPHA_KEY
JWT_SECRET=change_this_secret
PORT=5000
```

Note: The MongoDB connection string is configured in `backend/app.js`. If you need to change it, update that file.

## Install & Run

From the `v2/backend` folder:

```
npm install
node app.js
```

The server starts on `http://localhost:5000` and serves the frontend from `v2/frontend` automatically.

Open:
- Dashboard: `http://localhost:5000/index.html` → “Dashboard” button
- Fundamentals: `http://localhost:5000/fundamentals.html`

## Tips

- Demo mode (Dashboard only): append `?demo=1` to seed two holdings if your portfolio is empty.
- Typeahead search: both Dashboard and Fundamentals support company symbol lookup via the backend (`/api/search/:query`).
- Fundamentals charts:
  - Price defaults to 1Yr on first load.
  - Hover tooltips on charts show the date/value (and segment for stacked bars).
  - USD units appear on the Y-axis (Billions/Millions) for financial bars.
  - Tabs: Income, Balance (Assets/Liabilities), Cash on Hand/Net Debt, Shares Outstanding, Ratios.

## Notes

- For local file testing (file://), the frontend falls back to `http://localhost:5000/api` for API calls.
- Alpha Vantage rate limits apply; temporary gaps are handled gracefully.

## License

Private snapshot for internal use.
