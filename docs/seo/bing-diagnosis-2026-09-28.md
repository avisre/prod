# Bing diagnosis — stockportfolio.pro, 2026-09-28

Generated: **2026-09-28**
Site: `https://www.stockportfolio.pro/`

> Scope: `https://www.stockportfolio.pro/` only. The API key's account also holds
> `localyze.pro` and `playship.pro`; both are excluded by instruction and neither is
> referenced below.
>
> Every figure is labelled with the call it came from. Nothing here is inferred or
> back-filled; where a number was previously thought to be something else, the
> correction is recorded rather than the original claim.

## Summary

The site's indexing and crawl health are genuinely good. It has three real defects,
and the most damaging one is not visible in the Bing dashboard at all: **the site tells
Bing that 97.7% of its pages were last modified on 2026-07-19**, and Bing schedules
recrawls from that signal.

| | Finding | Severity |
|---|---|---|
| 1 | `<lastmod>` frozen at `2026-07-19` for 21,272 of 21,780 URLs | **High** |
| 2 | Weekly report headline computed from a top-N source | **High** (reporting) |
| 3 | One synthetic query is 42.8% of attributed impressions | Medium (reporting) |
| 4 | IndexNow key file refused by the site's own bot blocker | Medium |
| 5 | Description boilerplate exceeds SERP length on 88% of pages | Low |
| — | Crawl health, index growth, robots.txt, canonicalisation | **Healthy** |

## 1. Indexing and crawl health are not the problem

Source: `GetCrawlStats` (latest row).

| | |
|---|---|
| Pages in index | **43,552** |
| Crawled per day | 2,199 |
| Crawl errors | 8 |
| 4xx / 5xx | 4 / 4 |

Source: `GetUserSites` / earlier `GetCrawlStats`. The index has grown from **38 pages on
2026-06-15** to 43,552 today. `GetCrawlIssues` returned empty. Sitemap feeds report OK.
4xx and 5xx are in the low single digits per day.

The ~1,000/day `AllOtherCodes` entries in crawl stats are **not** the bot blocker:
`sendBlocked()` returns 403 and 4xx totals 4/day, so those are 304s. Benign.

Two things deliberately **not** done, with reasons:

- The ~14K templated metric pages are **not** re-excluded from the sitemap. Bing data
  shows they earn the traffic, and the repo already reversed that decision once.
- No link-building or content-authority work. It is the real long-term lever for the
  position bands in §4, but it is not a code change.

## 2. `<lastmod>` is frozen — HIGH

**Measured on live production**, 2026-09-28:

| Shard | URLs | Frozen at `2026-07-19` |
|---|---:|---:|
| `core.xml` | 114 | 0 |
| `stocks-1.xml` | 1,506 | 1,506 |
| `comparisons-1.xml` | 5,000 | 5,000 |
| `comparisons-2.xml` | 887 | 887 |
| `metrics-1.xml` | 5,000 | 5,000 |
| `metrics-2.xml` | 5,000 | 5,000 |
| `metrics-3.xml` | 3,879 | 3,879 |
| `diffs-1.xml` | 394 | 0 |
| **Total** | **21,780** | **21,272 (97.7%)** |

Root cause (`backend/seo-pages.js`): `isoDataMtime()` clamped any data file whose mtime
was within one hour of `SITEMAP_DEPLOY_MS` — the mtime of `seo-pages.js` itself — to a
hard-coded `SITEMAP_DATA_SNAPSHOT = '2026-07-19'`. On a git-checkout deploy **every**
file receives the checkout timestamp, so the clamp fired unconditionally and `lastmod`
could never advance. Its intent was to stop deploys faking freshness; it guaranteed
permanent staleness instead.

**The site contradicted itself.** `/stocks/AAPL/shares-outstanding` rendered
*"refreshed nightly (last updated September 28, 2026)"* — from the unclamped
`fundamentalsMtime()` — while its own sitemap entry said `2026-07-19`.

**Fix applied.** `scripts/refresh-fundamentals.js` now writes a committed manifest,
`frontend/data/fundamentals-changed.json`, recording the date each symbol's filed data
last changed; `backend/seo-pages.js` reads it and the clamp is deleted. A plain code
deploy no longer moves or freezes the date; a real data refresh does. The page body, the
JSON-LD `dateModified`, and the sitemap now derive from that one source.

Verified after the fix: all 7 local shards date from the manifest (`2026-09-28`, the day a
full backfill rewrote every symbol's data), and **0 URLs** remain on the frozen date.
`backend/test/sitemap-lastmod.test.js` guards this per shard, including a source-text
assertion that the clamp cannot return.

**Honest limitation.** The manifest now carries a date for each of 1,003 symbols, but on
2026-09-28 **all of them share one day** — that day's backfill rewrote every symbol's data,
so one date is the truthful answer, not a collapse. Per-symbol variation begins with the
first *partial* weekly refresh, when only some companies' filings change. A git-history
backfill of exact per-symbol dates was evaluated and rejected as disproportionate — the
data directory is 965 MB and a full blob walk would mean reading several GB to refine a
recrawl hint. The tradeoff is recorded here rather than hidden.

## 3. The weekly report's headline was computed from a top-N source — HIGH (reporting)

`GetPageStats` and `GetQueryStats` return a **capped** list: measured, exactly **100 rows
per weekly bucket** (1,004 rows across 15 buckets for queries). Summing that as if it were
the site total is the bug.

`GetRankAndTrafficStats` is the only daily-grained, exhaustive source.

Week ending 2026-09-04, from `docs/seo/bing-weekly-2026-09-04.md`:

| Source | Clicks | Impressions | CTR |
|---|---:|---:|---:|
| "Week totals" table (top-N page list) | 15 | 329 | 4.56% |
| The same document's Daily table (site-level) | 19 | 1,502 | 1.27% |

Impressions under-reported **4.6x**, CTR over-reported **3.6x**. The two tables sit in one
document and disagree.

**Fix applied.** "Week totals" now comes from a `window_totals()` helper over
`GetRankAndTrafficStats`. Re-run for the week ending 2026-09-18:

| Source | Clicks | Impressions | CTR |
|---|---:|---:|---:|
| Site totals (new headline) | 21 | 2,070 | 1.01% |
| Top-N page list (what it used to print) | 23 | 539 | 4.27% |

The report's Week totals now equal the sum of its own Daily table — verified, 2,070 and
21 on both.

## 4. One synthetic query dominates the impression denominator — Medium (reporting)

Source: `GetQueryStats`, 105 days. The query `aap 2024 free cash flow guided flat
strategic costs` returns **1,181 impressions and 0 clicks**, at positions ~6, landing on
`/stocks/AAP/free-cash-flow` (attributed via `GetQueryPageStats`). That is **42.8% of all
attributed query impressions**.

| Basis | Impressions | Clicks | CTR |
|---|---:|---:|---:|
| All attributed queries | 2,757 | 119 | 4.32% |
| Excluding the synthetic query | 1,576 | 119 | **7.55%** |

**Correction to an earlier figure.** The position-band table previously recorded 2.46% CTR
at positions 4-10 and described it as "close to normal organic benchmarks". That band was
**contaminated by this same query** — 1,181 zero-click impressions sitting at position ~6.
Re-derived with the synthetic query excluded:

| Position band | Impressions | Clicks | CTR |
|---|---:|---:|---:|
| 1-3 | 265 | 57 | **21.51%** |
| 4-10 | 1,307 | 61 | **4.67%** |
| 11-20 | 1 | 0 | — |
| 21+ | 3 | 1 | — |

So positions 4-10 convert at 4.67%, not 2.46%. The conclusion changes: **ranking depth is
still the binding constraint** — 57 of 119 clicks (48%) come from positions 1-3 on only
265 impressions — but the "titles are failing at 2.46%" premise was an artifact of the
same phantom query. Only **963 distinct queries** produced any impression in 105 days.

**Fix applied.** The report now separates zero-click queries holding ≥5% of query
impressions into their own printed section, and shows CTR both including and excluding
them. Verified against real snapshots: it flags the synthetic query in the 2026-08-21 and
2026-09-04 weeks, and `energy stocks ranked by dividend` in 2026-08-28.

## 5. IndexNow's key file is refused by the site's own bot blocker — Medium

**Measured on live production**, 2026-09-28, for `/<key>.txt`:

| Request | Status |
|---|---|
| Plain curl UA | **403** |
| `IndexNow/1.0` UA | **403** |
| `python-requests/2.34.2` UA | **403** |
| Full browser header set | 200 |
| `robots.txt` (control — already exempt) | 200 |

The key path was absent from `EXEMPT_PATH_PATTERNS` in `backend/bot-blocker.js`.
IndexNow's spec requires the key file be publicly fetchable, and participants fetch it
**asynchronously, after accepting the POST**.

The failure was silent by construction: `indexnow-ping.js` treats HTTP 200/202 on the POST
as success, and the workflow runs the step with `continue-on-error: true` plus `|| true`.

Two corrections to record, because the opposite was assumed earlier:

- **IndexNow is already wired up** and runs weekly in `refresh-fundamentals.yml`. It is
  not unused.
- The committed `seo-data/indexnow-queue.json`, frozen at 9 URLs since 2026-09-11, was a
  **stale tracked artifact**. The workflow comment claimed the file "is never committed"
  while git tracked it. That disagreement is what made the pipeline look dead.

**Fixes applied.** The key path is now exempt (anchored to a root-level 32-hex `.txt`, with
a test asserting it does not open arbitrary `.txt` paths); the authoritative key file's
stray trailing newline is removed so its body is exactly the 32-character key; the queue
is untracked and gitignored so the file matches the comment; and
`backend/test/indexnow-key.test.js` asserts the key `indexnow-ping.js` submits with is
actually hosted and fetchable.

**Still open for the owner:** a second, unused key file
(`1668f45a03ea53cf94c51b61c43163d4.txt`) is hosted and referenced nowhere. It has not been
deleted — only the owner can confirm whether it is registered with a search engine.

## 6. Titles and descriptions — Low

Measured across 50 symbol/metric pairs by rendering `renderMetricPage`.

**Titles are not too long**, contrary to the assumption that drove the P0 worklist:

| | Before | After |
|---|---:|---:|
| Length min / median / max | 24 / 39 / 56 | 24 / 39 / 55 |
| Over 60 characters | 0 of 50 | 0 of 50 |
| Containing a `…` | 3 of 50 | **0** |

The real title defect was a `…`, not length: `titleNameShort` truncated any company name
over 28 characters mid-word, producing `IBM Revenue History | International Business…`.
It affected ~6% of samples (long legal names). It is now clipped on whole-word boundaries
with no ellipsis.

**Descriptions were the measurable defect** — they exceeded the ~160 characters a SERP
renders, and the part being cut was the identical sitewide boilerplate tail:

| | Before | After |
|---|---:|---:|
| Length min / median / max | 150 / 171 / 200 | 116 / 137 / 166 |
| Over 160 characters | 44 of 50 | **2 of 50** |

The differentiating content — which already leads with the exact query terms, the ticker,
and the latest filed value — now survives instead of being truncated away. The two
remaining over-length cases are IBM-class long legal names.

This is a **bounded test, not a promised gain**. The `?v=` cache stamp does not apply:
these pages are server-rendered.

## 7. Verified healthy — do not spend effort here

- Index growth 38 → 43,552 pages since 2026-06-15; ~2,199 crawled/day; no crawl issues.
- `robots.txt` correctly allows Bing and Google and names the sitemap index; child
  sitemaps return 200.
- `www` canonicalisation is a clean 301 from the apex; `/sitemap.xml` is a valid index.
- 4xx/5xx negligible.

## 8. The `.html` URL twins, and the pages missing from the sitemap — HIGH (shipped `0a570df9`)

Site Scan's panel is a third dataset from the API surfaces in §1–§7: it audits the site's own
**internal link graph against the sitemap**, which the API-side analysis never looked at.

`express.static(..., { extensions: ['html'] })` resolves `/<name>` to `/<name>.html` — the
extension fallback *serves* the file, it does not redirect (`node_modules/send/index.js`). So every
public page answered **200 at two URLs**; all 22 twins were measured live on 2026-09-28. The
`.html` spelling is in no sitemap, duplicates its clean route's `<title>` and description verbatim
(Site Scan cards 2 and 3), three carried no canonical at all, and 72 internal `href`s pointed at
them — the site was feeding Bing its own duplicates.

Fix: an exact 301 table in `app.js`, registered ahead of the wall and of `express.static`, GET-only,
query preserved. Exact entries rather than `/(.+)\.html$/`, because the 17 noindex private pages
must keep both spellings — `/upgrade` and `/recharge` deep-link `?next=%2Fupgrade.html`, and
`/profile.html` is the *target* of the `/inbox` 301.

Four things an anchor-only sweep misses — all four were still live after the hrefs were "done":

- the homepage JSON-LD `SearchAction.target` (`/company.html?symbol={search_term_string}`);
- a client-side navigation string in `gurus.html`;
- four alert-email URLs (`smart-alerts.js` ×3, `watchdog.js` ×1);
- **the paywall's own redirect target** — `wallRedirect(res, '/register.html')` sent every
  anonymous wall hit through a second hop.

`test/legacy-html-redirects.test.js` derives its expected key set from the files themselves (plus
the two route-only twins `/verify-ledger.html` and `/filing-changes.html`, whose pages are
dual-path route arrays with no file on disk, so a file-derived list can never see them) and guards
all four classes above.

Sitemap: `core.xml` **114 → 119**. `/verify`, `/compare-dossiers`, `/partners`, `/partners-apply`
and `/lifetime` were indexable and internally linked but in no shard. `/company` is **deliberately
excluded**: bare `/company` is a JS-only skeleton that nothing links, and `/stocks/:symbol` already
covers per-symbol pages. Card 5 (inbound links) is untouched — a sitemap row is not an inbound
link, so `/lifetime` still needs one.

Two live 404s in shipped documentation prose (`/markets.html`, `/portfolio.html`) now point at
`/news` and `/dashboard`, the pages the shared nav calls Markets and Portfolio.

Deliberately not done: `/demo` stays a 302 (its target is noindex by design, so "permanent" would
be wrong); `frontend-v2/assets/app.js` keeps 34 twin references in the sitewide nav and footer —
the 301 makes those clicks work, so it is cosmetic, and the edit costs the shared `?v=` stamp bump
across ~40 pages plus 11 pinned test literals.

## Verification performed

- `cd backend && node --test test/` — **968 passing, 0 failing** (exit 0).
- Sitemap: all 7 local shards date from the data manifest; 0 URLs on the frozen date; the
  sitemap date equals the page-body date for the same ticker.
- `test/sitemap-index.test.js` no longer asserts that lastmod *varies* across the
  inventory. That assertion was a coincidence detector rather than an invariant: `core.xml`
  carries real file mtimes while the data shards carry the manifest date, so the distinct
  count was 2 only on days those disagree — and on the day the refresh runs (what the
  weekly pipeline does, and what the 2026-09-28 backfill did) they agree by design. It is
  replaced by a per-shard frozen-date check plus an assertion that the inventory carries the
  manifest's date, and `sitemap-lastmod.test.js` now derives its shard list instead of
  hardcoding it, so `comparisons-2` and any future shard are covered.
- Weekly report: Week totals equal the sum of the Daily table (2,070 impressions, 21
  clicks), where the two previously disagreed by 4.6x.
- IndexNow: key path exempt, orphan key reported, queue untracked; regression tests added.
- Tests repaired on the way: `ga4-consent-resolution` was failing at HEAD because its
  2000-character slice had been outgrown by the route (the assertion, not the code, was
  wrong); `social-compose` could not load at all because a top-level
  `require('selenium-webdriver')` took the whole file down when the optional package is
  absent. Both fixed.

## Environment notes discovered

- `requests` was not installed for any `python3` on this machine, and Homebrew's Python is
  externally managed (PEP 668), so `pip install --user` is refused — none of the four
  `scripts/*.py` operator scripts could run. A repo-local `.venv` (gitignored) plus
  `scripts/requirements.txt` now document and satisfy this.
- These Python scripts are operator-run; no workflow invokes them.
