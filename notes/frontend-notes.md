# Frontend Notes – stockportfolio.pro

This file gives more detailed notes for day‑to‑day frontend work on stockportfolio.pro.

## Page inventory

| Page              | File                        | Purpose                                            |
|-------------------|-----------------------------|----------------------------------------------------|
| Landing           | `frontend/index.html`       | Marketing, pricing, overview of the product       |
| Dashboard         | `frontend/dashboard.html`   | Portfolio holdings, charts, allocation             |
| Fundamentals      | `frontend/fundamentals.html`| Fundamentals search and financial visualisations   |
| News              | `frontend/news.html`        | Filterable news feed                               |
| Support           | `frontend/support.html`     | Contact and support form                           |
| Login             | `frontend/login.html`       | Sign‑in form                                       |
| Register          | `frontend/register.html`    | Account creation                                   |
| Privacy/Terms     | `frontend/privacy.html` / `frontend/terms.html` | Legal copy and illustrations         |

## Key JS entry points

- `script.js` – shared logic:
  - Defines `API_URL = '/api'`.
  - Implements `RESTRICTED_PAGES` auth gating and `configureNavAuthState`.
  - Handles navigation menu toggling (`#toggle-headings`).
  - Adds “blink” animation to `.sticker.face` icons.
  - Normalises sticker icons based on button label (`Dashboard`, `Fundamentals`, etc.).

- `fundamentals.js` – fundamentals page:
  - Reads `symbol` from query string or search input.
  - Uses Alpha Vantage endpoints as described in `architecture.md`.
  - Renders charts and tables into:
    - `#price-chart`
    - `#rev-chart`, `#ni-chart`, `#ocf-chart`, `#balance-chart`, `#cashnet-chart`, `#shares-chart`.
    - `#ratios`, `#tbl-head`, `#tbl-body`.

- `js/login.js` – login page:
  - Submits credentials to `/api/auth/login`.
  - Stores returned token in `localStorage` and redirects to `next` parameter or `dashboard.html`.

- `symbol-lookup.js` – shared stock symbol autocomplete:
  - Provides suggestions for both dashboard and fundamentals symbol search.

## Styling conventions

- Use the tokens defined in `styles.css`:
  - Colours: `--bg`, `--panel`, `--primary`, `--accent`, `--success`, `--danger`, `--muted`.
  - Radius: `--radius` for cards, `border-radius:999px` for pills.
  - Shadow: `--shadow` for main cards.
- Layout:
  - `.container` wraps content at max‑width `1200px`.
  - `.grid` is a two‑column responsive grid for cards.
  - `.cartoon-grid` uses auto‑fit columns for “story” blocks.
- Cartoons:
  - Always place `<div class="cartoon-figure">` before `<div class="cartoon-caption">` and avoid using `.cartoon-panel.reverse` to keep imagery visually consistent.

## Visual cues & accessibility

- Use `aria-label` and `aria-live` on charts and tables where feedback is dynamic (see `loading-overlay`, `news-grid`, and D3 tooltip container).
- For copy that includes visual separators, prefer hidden text (`.sr-only`) for screen readers and `.cartoon-divider` for the visual gradient.

