# Backend Notes – stockportfolio.pro

This note assumes a typical Express/Node backend located in `backend/`.

## Likely structure

Although exact filenames may vary, the design is:

- `backend/server.js` – creates Express app and mounts routers.
- `backend/routes/auth.js` – login, register, token refresh.
- `backend/routes/portfolio.js` – portfolio CRUD and analytics.
- `backend/routes/stripe.js` – billing checkout and webhooks.
- `backend/middleware/auth.js` – verifies JWT/opaque tokens.

## Auth pattern

1. Client submits credentials to `/api/auth/login`.
2. Server returns a signed token.
3. Client stores token in `localStorage` under `token`.
4. All subsequent `/api/*` requests include `Authorization: Bearer <token>`.
5. Middleware checks token and sets `req.user`.

Client‑side defence in depth:

- `script.js` prevents unauthenticated access to `dashboard.html`, `fundamentals.html` and `news.html` by:
  - Redirecting on direct URL loads when no token is present.
  - Rewriting guarded nav links to `login.html?next=...` for guests.

Server‑side defence:

- All `/api` endpoints that read or mutate portfolio data must require a valid token.

## Stripe integration

- `initiateStripeCheckout` in `script.js` calls `/api/stripe/create-checkout-session` with `{ email }`.
- Backend:
  - Creates a Stripe Checkout session using the publishable key referenced by the frontend.
  - Returns `sessionId`.
  - Handles webhook events for successful payment and updates user entitlement.

## Data modelling (conceptual)

- `users` – id, email, password hash, stripeCustomerId, plan, createdAt.
- `positions` – id, userId, symbol, name, quantity, purchasePrice, createdAt.
- Optional tables for:
  - `watchlists`
  - API key preferences, saved units/basis, and display options.

