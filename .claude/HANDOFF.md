# Handoff

## Google Search Console: no ranking regression, and crawler checks keyed on the proxy hop (2026-09-24)

Owner pointed at the GSC 24-hour view and asked for Google issues to fix. There is
still no GSC service-account key on this machine (`~/.local/share/secrets/` holds
only `appsumo_licensing.txt` and `bing_webmaster.txt`), so the data came from two
UI CSV exports into `~/Downloads/` (24 hours + 28 days), read with a proper
RFC4180 parser — the naive `split(',')` mis-parses these files and silently
returns zero rows.

- **The August baseline was 64% machine traffic.** `seo-data/gsc/queries-3m.csv`
  is dominated by rank-tool operator queries — `"earnings per share - wab"` (845
  imp), `"earnings per share - wab" "shares outstanding - wab"` (892 imp), and
  ~20 more, all at position 1.3–2.6 with **0 clicks**. Position 1.74 with 1,804
  impressions cannot yield zero clicks from humans. These drove
  `seo-data/search-opportunities.md`'s P1_REVIEW rows (WAB dividend-history,
  3,272 imp) — **that report's priorities are phantoms and should not be acted on.**
- **No regression.** Excluding machine rows AND one 979-impression outlier
  ("playtika ltd. yelp"): August human = 1,009 imp @ position **52.31**; current
  28 days = 341 imp @ **54.41**. Volume and position are both flat. An earlier
  read of "31.5 → 54.4" was an artifact of the outlier, not a real drop.
- **What is actually true**: ~340 human impressions/month, ~0 clicks, position
  ~52 (page 6), across ~21,700 sitemap URLs. The pages are not the problem —
  rendered samples (`/stocks/AAPL/price-history`, `/stocks/TSLA`,
  `/stocks/AMZN/pe-ratio`, `/compare/OWL-vs-UNM`, `/stocks/DIS/dividend-history`)
  all return 200 with correct canonicals, `index, follow`, unique titles, one H1,
  658–1,527 words and JSON-LD. This is scale/authority, not a code defect.
- **Real defect found and fixed — `bot-blocker.js` read `req.ip`.** Behind the
  Cloudflare→Render edge `req.ip` is an intermediate proxy hop, not the caller
  (measured 2026-09-23; app.js and marketing-attribution.js both document it).
  Two consequences: Layer 2 reverse-resolved the *edge*, so a real Googlebot's
  claim was verified against a stranger's PTR record and cached `impostor` for six
  hours (a deindexing bug, not a spam block); and Layer 4's 100-navigation budget
  was shared by every reader behind that hop. Now routed through a `clientIp(req)`
  that mirrors `visitorIp()`. `test/visitor-allowances.test.js` only ever scanned
  `app.js`, which is why this slipped through — its guard now covers bot-blocker.js
  too, plus a behavioural test that fails on the old code (asserts `dns.reverse`
  is called with the visitor IP, not the hop).
- **Not reproduced**: 191 rapid navigations with full browser headers returned
  191×200, and 5 Googlebot-UA requests from a residential IP all returned 200.
  So Layer 4 is inert in production and Layer 2 fails open when the hop has no
  PTR. The fix is correctness/hardening, not a demonstrated outage.
- **Behaviour change to expect after deploy**: impostors claiming a Googlebot/
  Bingbot UA are now actually caught (they previously failed open). Real crawlers
  verify *better*, since the true IP is what gets reverse-resolved.
- Full suite 830 tests, 829 pass; the one failure is the pre-existing
  `selenium-webdriver` miss in `test/social-compose.test.js`.

**The `Indexing > Pages` report is now exported and read** (owner downloaded it;
copied to `seo-data/gsc/coverage-2026-09-24/`). It changes the diagnosis, and it
is the answer to "what is the real Google issue":

- **Indexed pages fell 16,574 → 9,940 between 09-04 and 09-21**; not-indexed rose
  13,041 → 19,708. Two step changes, not a drift: **09-05 (+2,026)** and
  **09-15 (+4,574)**, then flat. A cliff with a date on it is a deploy, not a
  quality verdict.
- **09-15 is `f4af1ee5`**, the hard paywall, which answered every page with a 302
  to `/register.html` — its own message says "SEO is dead for the week by
  design". The week ended; the indexed count did not come back, because
  re-indexing waits on a crawl schedule. **This is the real Google issue.**
- The 18,985 not-indexed URLs map onto the sitemap's two templated tiers almost
  exactly: **12,405 "Discovered – currently not indexed"** ≈ the 13,879
  `/stocks/:sym/:metric` pages, **6,580 "Crawled – currently not indexed"** ≈ the
  5,830 `/compare/X-vs-Y` pairs. Together they are 92% of the 21,327-URL sitemap.
- **The sitemap itself is clean**, so it is not the culprit: all 8 shards return
  200, no duplicate `loc`s, no non-canonical symbols, nothing robots-blocked.
  Every URL is 200 and canonical. Do not "fix" the sitemap.
- Deliberate and expected, not defects: `Blocked by robots.txt` 51 (the
  `/api/`, `/fundamentals`, `/dashboard` disallows), `Excluded by noindex` 6
  (`/login`, `/news`). **`Page with redirect` 604** and **`Server error (5xx)` 2**
  are unexplained — the Coverage export is a summary CSV with no URLs, so they
  need the UI's drill-down to identify.

**Layer 2 measurement, 2026-09-24 (corrects the paragraph above):** the reason a
residential probe is never blocked is **`106.222.237.254` has no PTR at all** —
`dns.reverse` throws ENOTFOUND → `resolveCrawlerIp` returns `unknown` → **not
cached** → every request is `unseen` → served. So the probe returned 200 before
and after the fix and proves nothing either way about the old code. What *is*
measured: this site's own addresses have PTRs (`ip-216-24-57-16.ingress.render.com`)
that are not Google's, so where `req.ip` held a real PTR the old code had
something to compare and would cache `impostor`. Which hop origin actually saw
is still unverified — **confirm before claiming the blocker deindexed anything.**
The `clientIp` change stands on its own merits (ask about the caller, not the
hop) and is what makes the new paywall exemption sound.

**Fix shipped (deployed 2026-09-24, `9453e34c`):** the hard paywall now exempts
bot-blocker's crawler claim, before the `WALL_ALL_PAGES` test, so re-arming the
experiment can no longer take the index down with it. **Verified behaviourally
against dev-local, not by source-pinning** — `WALL_ALL_PAGES=true
node scripts/dev-local.js`, then curl on `/`, `/stocks/AAPL/revenue`,
`/compare/AAPL-vs-MSFT`, `/screener`: Googlebot and Bingbot UA → **200**, Chrome
and GPTBot UA → **302 `/register.html`**. GPTBot 302ing is the check that the
exemption is scoped to what bot-blocker admits, not to "looks like a bot". The
same run also disproves the cache-bypass worry: Chrome 302'd on `/stocks/AAPL`
immediately after Googlebot's 200 would have populated the SSR cache, so a
crawler-warmed entry is not reachable by a walled human.

**Search Console is now scripted (2026-09-24).** The owner created the GCP
service account and the key is installed at
`~/.local/share/secrets/gsc_service_account.json` (mode 600) —
`gsc-stockportfolio@praarthana-492014.iam.gserviceaccount.com`. `scripts/gsc-stats.py`
reads performance; **new `scripts/gsc-index-audit.py`** reads the Sitemaps API and
the URL Inspection API (`urlInspection.index:inspect`, 2,000/day). Note
`access_token()` returns a **tuple** `(token, client_email)` — unpacking it as a
string yields a 401, which is how the first run of the new script failed.

What the API adds to the Coverage-CSV reading above:

- **The sitemap is submitted and being read.** Sitemaps API returns exactly one
  entry — `https://www.stockportfolio.pro/sitemap.xml`, `lastDownloaded
  2026-09-22T19:42:12Z`, `errors=0`, `warnings=0`, 21,689 URLs submitted (web) +
  3 (video). So "re-submit the sitemap" is already done and is not the fix; Google
  is fetching it fine and choosing not to index what it finds.
- **Production is not walled, and crawlers are served.** Live 2026-09-24 with a
  Googlebot UA: `/`, `/stocks/AAPL`, `/compare/AAPL-vs-MSFT` → **200**. The same
  URLs with a Chrome UA → **403**, but that is bot-blocker refusing this probe's
  network, **not** the paywall: the wall's signature is a 302 to `/register.html`,
  and a 403 is a refusal. Read the 403 as "the probe is unwelcome", never as "the
  wall is up".
- **All four tiers serve a crawler today** — 12 spot-checked sitemap URLs (core,
  `/stocks/:sym`, `/stocks/:sym/:metric`, `/compare/X-vs-Y`) all 200 to Googlebot.

**Per-tier index status, measured 2026-09-24** (125 sitemap URLs via URL
Inspection, `/tmp/tiers.json` → `scripts/gsc-index-audit.py`; quota 2,000/day):

| tier | inspected | indexed | crawled-not-indexed | unknown to Google | median crawl age |
|---|---|---|---|---|---|
| core | 40 | 9 | — | 17 | 33d |
| /compare | 30 | 12 | 12 | 4 | 63d |
| /stocks/:sym | 25 | 10 | 8 | 7 | 76d |
| /stocks/:sym/:metric | 30 | 4 | 2 | 21 | 58d |

Read this as **crawl coverage, not a defect**: Google has an old, partial index of
a 21,689-URL site that earns ~340 human impressions/month, and it is not spending
crawl budget it sees no demand for. Nothing in the sample returned a FAIL verdict
on indexing, no canonical mismatches, and no fetch errors. `/monitor-demo` is in
the live sitemap but still "unknown to Google" — the core shard's `lastmod` is
2026-09-23 and Google read it 09-22, so the newest entries simply have not been
picked up yet. Ruled out by measurement, so nobody re-checks them: Cloudflare is
not serving stale 302s (`cf-cache-status: DYNAMIC`, no `age`, every sampled tier
200), robots.txt allows Googlebot everything but `/api/`, `/dashboard`,
`/fundamentals`, `/v1/`, `/v2/`, and the video assets themselves serve 200 with
correct `Content-Type` to a Googlebot UA.

**The URL Inspection API reports the LAST CRAWL, not a live fetch.** `/tour`
still returns `richResultsResult.verdict = "FAIL"` after the fix, because
`lastCrawlTime` is `2026-09-11` — pre-fix. Do not read that as "the fix didn't
work", and do not use this API to validate a markup change: only Google
re-crawling the URL, or the UI's own live test, can move the verdict. What *is*
verifiable from here is the served bytes (two `uploadDate` values on the live
page, confirmed against production).

**The one real error Google reports is fixed (2026-09-24).** The URL Inspection
API on `/tour` returns `richResultsResult.verdict = "FAIL"` with
`Videos → "I asked an AI 3 hard finance questions…" → Missing field "uploadDate"
[ERROR]`. Of the page's **two** VideoObject blocks the local-mp4 one was complete
and the YouTube one had no `uploadDate`, which is why nothing looked wrong.
`uploadDate` is required on a VideoObject; the rich result fails without it. Fixed
in `frontend-v2/tour.html` with the date read from YouTube's own page metadata for
`-3V_IaCOQUo` (`2026-06-13T14:31:13-07:00`), not guessed. A 12-page sweep
(`/`, `/tour`, a stock, a metric, a compare, `/screener`, a tool, a screen,
`/vs/koyfin`, a doc, `/methodology`) found **this and no other rich-result or
usability issue**. New `backend/test/video-schema.test.js` pins it: every
VideoObject on every `frontend-v2/*.html` must carry `name`, `thumbnailUrl`,
`uploadDate` and a parseable date, plus `contentUrl`/`embedUrl`; verified
non-vacuous by deleting the field and watching it fail with Google's own wording.
Note the rich result was failing while the *page* was `PASS`/indexed — a page can
be indexed and still be losing its video result, so index status alone is not a
health check.

**Next, and only the owner can do it:** URL Inspection → Request Indexing on the
highest-value pages, and watch `Indexed` in the Coverage chart for recovery.
The `Server error (5xx)` and `Page with redirect` buckets still need the UI
drill-down to name URLs — the API does not expose either bucket.

## Bing "identical titles / identical descriptions": root cause measured, fixed locally (2026-09-24)

The owner pasted the Bing Webmaster Top Recommendations for www.stockportfolio.pro
(five tiles). Measured each one against the API (`/Date(ms)/` dates; there is
**still no API** for the Recommendations/Investigate list — GetCrawlIssues and
GetBlockedUrls both return empty, so tiles 1 and 4 must be read in the UI).

- **API key**: stored OUTSIDE the repo at
  `~/.local/share/secrets/bing_webmaster.txt` (chmod 600) — never inline it
  here or anywhere tracked; this is a public repo. Probed with Node 26
  native `fetch` — `scripts/bing-webmaster-stats.py` still cannot run here
  (needs `requests`; pip is PEP 668-blocked and HANDOFF already records its
  ConnectionReset).
- **Site state**: 0 crawl issues, 0 blocked URLs, sitemap Success (21,307 URLs,
  last crawled 9/22), quota 100/day & 800/month, InIndex 38,586.
- **Root cause of tiles 2 and 3 (amber, identical titles/descriptions)**: the
  crawlable pages link **5,961 distinct in-site URLs carrying a query string** —
  **3,012 `/ask.html?q=<page-specific question>`** and 2,948
  `/company?symbol=<TICKER>` (plus `/register?plan=monthly`). Every `/ask?q=…`
  returned an indexable 200 with the *same* `<title>` and the *same* meta
  description and **no robots meta** — thousands of identical-title pages.
  `/company?symbol=` was already correct (injects the company name, canonicalises
  to `/stocks/SYM`). Exact duplicate titles/descriptions across all 19,707
  renderable sitemap pages: **0** — so the duplicates Bing counted are only the
  parameterised ones.
- **Fix**: new `backend/ask-page.js` + a route in `backend/app.js` registered
  **ahead of `express.static`** that serves `noindex, follow` on any `/ask` with
  a query string, keeping the template's canonical `/ask`. Plain `/ask` is
  untouched. `frontend-v2/register.html` gained the missing
  `<link rel="canonical" href="…/register" />` (it had none, so `/register` and
  `/register.html` were two indexable pages with one title). robots.txt
  deliberately does **not** disallow `/ask?*` — a blocked URL cannot be read, so
  its noindex is never seen (same reasoning the file already records for
  `/login` and `/news`).
- **Tests**: new `backend/test/ask-page.test.js` (7 pass). Full suite 828 tests,
  827 pass — the one failure is the pre-existing `selenium-webdriver` miss in
  `test/social-compose.test.js`. Verified over real HTTP on a local boot.
- **DEPLOYED AND LIVE 2026-09-24** (owner pushed the commit). Verified against
  production with the internal-UA bypass: `/ask?q=…` → `noindex, follow` with
  canonical `/ask`; `/ask` → no robots meta; `/register` and `/register.html` →
  the same single canonical.
- **Bing recrawl requested the same day**: `SubmitFeed` for `/sitemap.xml` (Bing
  re-read it at once — `LastCrawled`/`Submitted` jumped to now) plus
  `SubmitUrlBatch` of 95 URLs — `/ask`, `/register` and 93 `/ask?q=…` variants
  chosen from the URLs `GetPageStats` reports impressions for. There is no
  "most-linked" ranking to use: every variant is linked from exactly ONE page
  (all inbound counts are 1). Quota is **100/day, 800/month**, so ~2,900
  variants must drop by ordinary recrawl.
- **Tile 1 (red) is staleness, measured**: the live sitemap now holds **21,716**
  URLs across its 8 children, but Bing's last-processed reading of the index was
  **21,307** — behind by ~409 pages. The `SubmitFeed` above forces that re-read;
  no code change was needed. (Bing reports `UrlCount` for a *Sitemap Index* as
  the child count, 8, immediately after a re-read — it is not a regression.)
- **`GetUrlInfo` keeps no crawl record for query URLs**: it reports every
  `/ask?q=…` variant as `documentSize=0`, `lastCrawled=DateTime.MinValue`, while
  content pages (`/`, `/stocks/AAPL`, `/register`, `/login`) show real sizes and
  recent dates. Don't read that as "not indexed" — the site's InIndex (38,586)
  far exceeds its sitemap (21,307), consistent with the parameterised URLs being
  indexed by discovery.
- **Not fixed, on purpose**: tile 4 (NOINDEX) is `/login`, `/news`, `/dashboard`
  and the 404s — all intentional. Tile 5 is backlinks, off-page. Bing's tiles
  refresh on its own schedule; nothing more can be forced through the API.

## Send receipts: shipped, verified, re-send done (2026-09-24)

Live in prod on commit `3f815222` (deployed by the owner manually — see the
deploy note below). Answers "why don't I see send receipts": there were none,
for three separate reasons — `mailer.sendMail` threw nodemailer's result away
and returned a bare boolean; app sends are never filed to the mailbox Sent
folder; and the admin UI wrote one `Done:` line that died on reload, with no
GET route to list past sends.

- `backend/mailer.js` now pins the Message-ID itself and returns
  `{ok, messageId, accepted, rejected, response, envelope, at}`; every failure
  path still returns `false` (verified: no call site strict-compares a result).
- `backend/app.js` stores the receipt **beside** `emailStatus` (`messageId`,
  `smtpResponse`, `accepted[]`, `rejected[]`) — the enum is untouched. A send
  that resolves with `rejected[]` non-empty is recorded `failed`, not `sent`.
- New admin routes `GET /api/admin/messages/broadcasts` (+ `/…/:id`), and a
  read-only receipts panel in `admin-messages.html` (lazy-loaded on open,
  styles inline in the HTML so the universal `?v=` stamp and its 8 pinned
  tests stay put). Only `admin-messages.js` moved, to `20260924-receipts1`.
- **Verified, not assumed:** `scripts/verify-send-receipt.js` self-sends
  support@→support@ and reads the delivered `Message-ID` back over IMAP
  (`BODY.PEEK`, nothing marked seen). Recorded id == delivered id. Then
  `scripts/verify-receipts-panel.js` drives headless Chrome with the admin
  cookie and reads the rendered panel: today's row shows "13/13 emailed · 13
  with receipt", and the 9/23 rows show "no receipt (sent before receipts
  existed)".
- Re-sent the 9/23 update to the **13 real customers** (`RESEND 13`), each with
  its own Message-ID and a `250 2.0.0 Ok: queued as …` reply. Receipt file:
  `backend/tmp-resend-receipt-2026-09-23T21-35-49-547Z.txt`.

**The "60" was not 60 customers.** The 9/23 "general" broadcast's 47 recipients
are not accounts at all: 0 of their `userId`s exist, 24 are QA artifacts
(`a@gmail.com`, `qa_test_*@example.com`, `support+qa-*`, three of the owner's
own addresses), the rest look like cold-outreach prospects. Those rows were
written to an address list, not from `users`. Do not mail that list again —
that is why the re-send tool prints and excludes it rather than shrinking
silently.

**AppSumo, reconciled against the live Licensing API (2026-09-24):** 25 keys =
13 active (all with live accounts, all LTD-active) + 6 inactive (code bought,
never redeemed) + 4 genuine customer refunds + 2 tier-upgrade key retirements.
So "20 completed orders" is 13 activated + buyers who never redeemed, not
missing accounts — the only accounts ever deleted are 3 of the refunded ones.
The unredeemed buyers are **unreachable**: the licence payload carries no
buyer email, only AppSumo holds it.

**Deploy is broken for pushes.** `deploy-render.yml` now fails before building:
`deploy trigger returned HTTP 404 {"message":"not found: https://api.github.com/repositories/1105594471"}`.
Render's GitHub app can no longer see that repo, so a push no longer ships.
Reconnect the repo to service `srv-d4kc6schg0os73al6t10` in the Render
dashboard; until then every deploy is a manual trigger.

Open: `scripts/verify-receipts-panel.js` and `scripts/verify-send-receipt.js`
are currently untracked. This file is 2400+ lines against the 160-line cap in
CLAUDE.md — needs a prune, deliberately not done here because the dossier
record below is still in flight.

## Dossier redesign — "The Plain Filing" mockup DONE, awaiting review (2026-09-24)

Plan: `~/.claude/plans/valiant-singing-parnas.md` (approved). Goal: a layman types
a company **NAME**, clicks once, and gets every pertinent fact on **one page**.

**Step 1 (mockup) is complete and NOT yet reviewed. Step 2 (the port into the real
page) has NOT started.** The owner rejected the first mockup ("Company Brief",
`docs/design/dossier-brief.html`, kept on disk as the record) as *highly
derivative*, and chose a **full new identity** + **dropping the sankey**.

- `docs/design/dossier-plain-filing.html` — the current mockup. A **document, not
  a dashboard**: no card grid, no rounded cards, no shadow, no decorative colour.
  One sheet on the ground (`#e9ebee` under `#fbfbfc`), a ruled masthead, a ruled
  figures band, and nine numbered sections with a left rail. Type is Newsreader
  (display + prose) / IBM Plex Mono (figures, meta) / IBM Plex Sans (UI + chart
  labels) — deliberately not Inter or a system-sans stack. Self-contained, opens
  over `file://`. States via hash (`#empty`/`#building`/`#simple`/`#analyst`) or
  the bottom-left bar; `docs/design/pf-*.png` are the captures.
- **Analyst mode is the SAME nine sections with the evidence opened inside them**
  (statement ledger in 02, six-year ledger in 04, health checks in 09, a section
  10 for deep research). It is *not* a second document — the numbering never
  shifts between modes. The first pass got this wrong and analyst came out
  *shorter* than simple; that is the regression to watch.
- `docs/design/dossier-plain-filing.artifact.html` — GENERATED, do not hand-edit.
  `node scripts/build-dossier-mockup-artifact.js`. The builder now hoists the
  `<link>` tags out of `<head>` (the viewer supplies the skeleton, so anything in
  head is dropped otherwise — and the fonts *are* this design).
  **The Artifact publish was REFUSED**: this session authenticates with
  `ANTHROPIC_AUTH_TOKEN`, and artifacts need a claude.ai login. Owner must unset
  it and `/login` if that link is wanted; the file opens directly meanwhile.
- `scripts/screenshot-cdp.js` — headless Chrome over CDP, no selenium.
  `--shot "<url>|<out.png>|<w>|<h>[|full]"` (repeatable, one browser launch),
  plus `--probe` (prints document-vs-viewport overflow + the widest offenders)
  and `--eval <file>` (runs an expression and prints the result).
  **Why it was needed: `chrome --screenshot --window-size=390,...` lays out at
  macOS's ~500px window floor and crops to 390 — silently wrong mobile shots.**
  `Emulation.setDeviceMetricsOverride` is the only way to set a real viewport.

**Measured, not assumed: 0px horizontal overflow at 1440 AND at 390** (probe on
all four states).

Three things in this design cost real work and should survive the port:

- **Chart text cannot live inside a stretched SVG.** The plots use
  `preserveAspectRatio="none"` so the shape fills any width — which also stretched
  the glyphs (a 640-wide viewBox squeezed into 390px made the tick labels visibly
  wrong). The shape is SVG; every label is **HTML positioned over it**.
- **Severity is fill count + the word, never two status colours.** The validator
  FAILs the status warning/serious pair as *adjacent* marks on this surface
  (normal-vision ΔE 13.6, below the 15 floor). So the meter is 3/2/1 discrete
  cells of fixed width (a `flex: 1` meter just reads as a progress bar) plus the
  word, and only the single most-severe row takes the red. The de-emphasis gray
  is `#7d858f` — `#9aa1ab` measured 2.52:1 on the sheet and was rejected.
- The verdict does not flatter the sample data: FY2024 revenue +2.0% / net income
  −3.4%, so the flag reads "Margin slipping".

Step 2's constraints from the plan still bind, but the *visual* half of the plan
is superseded — the CSS/HTML specifics must be re-derived from the new design.
The four easiest to break: the exact
`>Compare ↔ <span class="beta-badge">Beta</span></a>` literal at ≥2 header render
sites; `setBuilding` must keep a `.loading-line` element (the 5-min timeout at
`dossier.js:1162` probes for it); the `partial` branch's 400-char slice in
`dossier-progressive.test.js`; and only `dossier.js?v=` moves, to
`20260923-brief1`, in exactly two places (dossier.html:287 + that test's line 76).

## AppSumo reviews on the landing page (2026-09-23)

The listing has 3 reviews, all 5 tacos, 5.0 (deal id 261597). They now show in
three places, all with **page-scoped CSS and no cache-stamp bump** (page HTML is
served no-cache; `system.css` untouched):

- `frontend-v2/index.html` — `.trust-badge` in the hero, `<section id="reviews">`
  after `#pro-plans`, and a pill under the Featured-on badges (`.as-tile-row`: a
  `flex:1 0 100%` item, so it takes its own centred line at 1440 — the five badge
  images leave only ~110px in that row).
- `frontend-v2/appsumo.html` — the same 3 reviews as `#reviews`.
- **Deleted** the "Browse the research library" section from index.html (owner
  request). Cost: the ten `/stocks/<TICKER>` deep links lost their landing-page
  entry point; `/stocks` is still linked from the footer. One footer line
  restores them if crawl discovery there ever matters.

Review text is NOT in the repo. **A plain fetch works — no browser needed**
(verified 9/23: HTTP 200, 8.1 KB):
`curl -A "<Chrome UA>" "https://appsumo.com/api/v2/deals/261597/reviews/?page=1&sort=relevance&order=desc&from=0&items_per_page=5"`
→ `comments[]` with `user.username`, `title`, `comment`, `rating`, `created`.
A static page fetch gives aggregates only (`"review_count"`, `"..._N_tacos"`).

Verbatim as of 2026-09-23, all 5 tacos:
- `ian.sterk99` — "Passion project" — 2026-09-11 (owner-fixed-my-issues review)
- `113027750603327378239` — "Outstanding Tool for Quarterly Insights and Market
  Screening" — 2026-09-01. No human-readable handle, so the card labels it
  "AppSumo buyer" with a silhouette avatar rather than a 21-digit id.
- `Krisneni` — "Very Efficient" — 2026-08-13. Asks us to cross-verify accuracy;
  kept on purpose — an all-glowing block reads as marketing, this reads as a
  customer.
- The older note calling the Aug-13 review "gattomorto77" was wrong: that handle
  is not on the live listing. Don't resurrect it.
- The API exposes no plan tier → cards show AppSumo's own "Verified purchaser ·
  Member since …", never a claimed tier. Avatars are handle initials (no stock
  portraits: a stranger's face under "verified purchaser" would be a fabricated
  identity).

## Hosting/VPN wall LIVE (2026-09-23) — the geo wall's VPN hole is closed

The geo wall only knows country. A visitor in SG on an Australian VPN reads as
Australian, and that cannot be fixed by any country check, because the
connection genuinely arrives from Australia. What a VPN cannot hide is who OWNS
the address: commercial VPNs and self-hosted Shadowsocks/Outline boxes run on
cloud/hosting networks, not consumer lines. This wall refuses the free surface
to those ranges, from any exit country.

**Data: `backend/data/hosting-ranges.bin` — 30,723 merged ranges, 245,796 bytes
(240 KB), generated 2026-09-23T17:13:09Z.** Binary format `SPHR` + uint32 count
+ uint32 generatedAt + sorted (start,end) uint32 pairs LE. Reader
`backend/hosting-ranges.js` loads it at require time into two `Uint32Array`s,
binary-searches, and **fails open** two ways: IPv6 (not classified) and a
missing/corrupt bundle (`hasData()` false → nobody is walled, so a data problem
cannot take the free tier from everyone at once). Refresh manually ~monthly:
`node scripts/refresh-hosting-ranges.js` — sources are iptoasn `ip2asn-v4.tsv.gz`
(filtered by curated hosting ASNs + ~50 org keywords), X4BNet/lists_vpn
`ipv4.txt` (44,146 CIDRs, MIT), AWS `ip-ranges.json`, GCP `cloud.json`,
Cloudflare `ips-v4`. The script exits 1 if the merged count falls below a floor
(20000), so a silently-broken source fails loudly instead of shipping a thin
table. **AS19527 (Google Fiber) is excluded via `NEVER_HOSTING_ASNS` and the six
transit carriers (Cogent 174, Lumen 3356, NTT 2914, Telia 1299, PCCW 3491, Tata
6453) are deliberately absent** — all seven carry ordinary residential traffic.

**Policy:** `HOSTING_WALL_ENABLED` (default ON — `!== 'false'`), plus
`HOSTING_WALL_DRY_RUN` (count, don't block) and `HOSTING_WALL_BYPASS_TOKEN` +
`X-Hosting-Wall-Bypass` (QA from a data-centre address). One combined check,
`freeTierWallReason(req)` → `'region'` | `'network'` | `null`, region first;
402 bodies carry `REGION_PAID_ONLY` or `NETWORK_PAID_ONLY`. Five call sites:
`wallAllPagesMiddleware`, `/api/free-tools/:tool`, `anonAskHandler`, keyless MCP
in `apiKeyAuthOptional` (a presented key still wins — `offered` is handled
first), and `signupTrialDaysFor` (→ 0 days). Counters + the bundle in use at
`/api/admin/hosting-wall/stats`.

**Two things in here are load-bearing:**
1. **The address comes from `marketingAttribution.requestIp()` (CF-Connecting-IP
   in production), never `req.ip`** — `req.ip` is an intermediate proxy hop in
   prod (measured 9/23: IN request → req.ip DE), so checking it would classify
   the wrong machine. Same reason `requestCountry` was fixed in 8738e542.
2. **The crawler exemption is not optional.** Googlebot and Bingbot crawl from
   Google/Microsoft cloud ranges that are IN this table, so without it the wall
   answers them with a 302 to `/upgrade.html` and deindexes the site. It exempts
   only a positive `bot-blocker.classifyUa` claim of `allowed-claim`/`internal`
   — deliberately NOT `claim !== 'unknown'`, because `/api/*` skips bot-blocker
   and a UA-less request would otherwise walk past both. Forged bot claims are
   refused by bot-blocker's Layer 2 reverse-DNS check, which runs earlier.

**A real defect found by reading the code, and fixed here:** `startSignupTrial`
sets `status: 'trialing'` on a paid `planId`, but `subscriptionIsPaid` accepts
only `active`/`cancel_at_period_end` — so a walled visitor *granted* a trial was
redirected to `/upgrade.html` on first load and the trial was dead on arrival.
Walled visitors now get 0 trial days: paid-only by design, not a broken promise.

**Rollback without a code change:** `gh workflow run set-render-env.yml -f
key=HOSTING_WALL_ENABLED -f value=false` then **always** `gh workflow run
deploy-render.yml` (set-render-env alone never deploys).

**Accepted cost, weighed by the owner:** legitimate corporate and privacy-VPN
users, and anyone whose office egresses through cloud NAT, lose the free tier
(they can still subscribe). Keyless MCP stops working for ChatGPT and claude.ai
connectors worldwide — those call from Azure/AWS.

**NOT closed by this, and the geo wall has the identical hole:** ~25 keyless
`/api/*` data endpoints (`/api/screener`, `/api/company/:symbol/filings`,
`/api/assets/*`, `/api/market/strip`, `/api/filings/:symbol/report`,
`/api/compare/:pair/verdict`, `/api/gurus*`, `/api/portfolio/briefing/sample`,
`/api/demo/*`, `/api/verify`) serve product data with no auth and no country
check, because `/api` is exempt from the page wall.

Tests: `test/hosting-wall.test.js` (new), `test/geo-wall.test.js` (pins moved to
the combined check), `test/hard-paywall.test.js` (the no-UA rule now scopes to
the region half; the hosting half must have exactly one UA branch, the crawler
exemption). Suite **779/780** — the one failure is the pre-existing
`social-compose` selenium `MODULE_NOT_FOUND`. No frontend asset touched ⇒ no
`?v=` cache-stamp bump.

**Deployed and verified in production the same day, commit `96f9f1ef`.** The
probe is `/api/free-tools/earnings-quality?symbol=AAPL`, chosen because `/api`
is exempt from `bot-blocker` — a page URL is useless here, since check-host's
UA is 403'd by the bot blocker *before* the wall runs (all 7 nodes returned 403
on `/`, which proves nothing). Status from 7 check-host nodes, each IP
classified locally first so the expectation is derived, not assumed:

| node | IP / network | table says | prod |
|---|---|---|---|
| us1 | 38.145.202.12 (hosting) | hosting, US | **402** |
| us3 | 147.45.60.14 (not hosting) | clean, US | **200** |
| de1 | 142.132.174.167 Hetzner | hosting, DE | **402** |
| fr2 | 195.154.114.92 Scaleway | hosting, FR | **402** |
| sg1 | 217.15.166.168 (hosting) | hosting, **SG** | **402** |
| hk1 | 141.98.234.68 (not hosting) | clean, **HK** | **402** |
| in1 | 185.2.49.57 (not hosting) | clean, IN | **200** |

7/7 as predicted. **The us1/us3 pair is the decisive control** — two US nodes,
one request, only ownership differs, and only the hosting one is refused. in1
200 and this machine's residential IP (200 on `/`, `/stocks/AAPL`, `/docs`,
`/api/free-tools`) prove the deploy did not wall the world.

**Body read live, not inferred:** fetched through an AWS-hosted reader
(`r.jina.ai`), the 402 carries `"code":"NETWORK_PAID_ONLY"` and the VPN/data-
center message — so the hosting wall fires end to end. The REGION code was NOT
read from a production body (no SG/HK egress available to fetch one); it is
test-pinned, and hk1 is `hosting=false` in the table yet 402s, so for hk1 the
region branch is the only one that could have run.

**The crawler exemption is verified at the contract it depends on, not end to
end:** `classifyUa` → Googlebot/Bingbot `allowed-claim` (exempt), a real Chrome
UA `unknown` (checked normally — no cloaking hole), empty UA `denied` (also
checked, so the `/api` exemption from bot-blocker does not become a bypass).
End-to-end Googlebot cannot be simulated from here — a forged claim is refused
by bot-blocker's reverse-DNS check, which is the point.

**The page surface is walled too, not just the API:** `/stocks/AAPL` fetched
from the same AWS reader returned `register.html` (the anonymous branch of the
page wall) — with `WALL_ALL_PAGES=false`, so that redirect is the hosting wall
alone. The API probe is what proves the classification; this proves the page
middleware reads the same decision.

Also confirmed: the push itself triggers a Render deploy and it succeeded in
1m50s, so Render's GitHub connection is working again for on-push deploys.

## Geo wall LIVE + hard paywall OFF (2026-09-23, commit 2a75ad19)

`GEO_WALL_COUNTRIES` (default `SG,CN`): SG/CN IPs get no free surface. Pages →
/upgrade.html unless paid (trial/comp/free plan ≠ paid), free-tools API/anon
Ask/keyless MCP → 402 REGION_PAID_ONLY, no signup trial (402 PAID_PLAN_REQUIRED).
HK added (c31edf66). **req.ip is a proxy hop in prod** (measured: IN request →
req.ip DE; XFF = [client, proxy]; CF-IPCountry correct). Fixed 8738e542:
`marketingAttribution.requestCountry()` uses CF-IPCountry in production (also
feeds dashboard country, so pre-9/23 country data = proxy locations, junk).
Verified 2x from check-host hk1/sg1 → 402, us1/us2/India → 200.
FIXED 5f37d270: per-IP limits (anon Ask, keyless MCP, the free-surface rate
limiters, free-stock + compare-verdict allowances) now resolve the visitor via
`visitorIp()` — the same CF-Connecting-IP resolution the walls use — never
req.ip. NOT via `TRUST_PROXY_HOPS=2`: a fixed hop count breaks silently if the
chain changes length, and past that point reads a value the caller controls.
CF-Connecting-IP cannot be forged (verified 9/23: any client-supplied value →
403 "error code: 1000" before reaching the app, and `CF-IPCountry: CN` was
overwritten with the real country). Auth/abuse limiters (login, password reset,
support, subscribe, checkout claim) deliberately left on the shared key.
Test: `test/visitor-allowances.test.js`.
FIXED 2d712451 (anonymous company allowance): a signed-out visitor gets 25
DISTINCT companies/day (`ANON_COMPANY_DAY`, `0` = off, no redeploy) on the six
symbol-scoped keyless data routes — company filings/insider-history/ownership
and asset profile/holdings/fees. Distinct symbols, not calls, so a page fanning
out for one stock costs one; re-reading a company is free; signed-in and keyed
callers are never counted. Over it: 429 `ANON_COMPANY_LIMIT`, no-store, and no
live SEC work happens. Verified in prod from one residential line: 25×200 then
429 on the 26th, repeat view 200, AAPL filings 200 (8,892 bytes), /stocks/AAPL
still renders. `/api/admin/anon-company/stats` reports the limit and how often
it bites — the number that says whether machines are walking the free surface.
Still open: Keypoints (5/month) and the filing monitor report keep their own.

FIXED the bulk-endpoint gap in two of three, and MEASURED the third before
touching it (2026-09-24):
- **`/api/market/strip` (the tape)** — 12 symbols per response, a live Yahoo
  daily series per cold symbol, and *no auth at all*, while every outbound call
  queues on one process-wide 400ms gate: a caller varying symbols held that queue
  ahead of paying customers' price data, and the whole 3,840-company universe was
  ~320 requests. Now `optionalAuth` + a per-visitor DAILY SYMBOL BUDGET
  (`ANON_STRIP_SYMBOL_DAY`, default 40, `0` = off, no redeploy) that **CLIPS**
  rather than refuses — a 429 on the chrome of a page the visitor is already
  reading says nothing they can act on. Clipping is per request and never writes
  into the shared cache. **Its own budget, deliberately not the 25-company
  allowance:** the tape is ETFs and indices, and drawing on the research
  allowance would spend four of a reader's 25 companies on SPY,QQQ,DIA,IWM before
  they read anything. Reported under `strip` at `/api/admin/anon-company/stats`.
- **`/api/assets/search`** — one *uncached* live Yahoo call per keystroke (the
  client has no debounce). Now cached 5 min (`ALPHA_CACHE_TTL_MS.search`) and
  behind its own per-visitor limiter (`assetSearchLimiter`, 150/15min — the 6th
  limiter keyed per visitor). The client falls back to its bundled company list
  when refused, so a refusal degrades autocomplete instead of breaking it.
- **`/api/screener` — NOT changed, on evidence.** Measured: `screenRows` reads a
  local persisted index (no provider call, ~ms), the universe is **3,840
  companies x 26 filed metrics**, and a full dump is **~39 requests**. But it is
  advertised as **free and unmetered** in `docs-pages.js:60` ("Company pages, the
  screener ... are free and unmetered"), in index.html's JSON-LD ("free for
  everyone", "no account needed"), on features.html, and in the AppSumo listing
  ("without an account"). Clipping it would contradict indexed copy in five
  places to protect filed fundamentals the SEC publishes and we already give
  away. **Owner's call with the numbers attached** — a knob of exactly the
  strip's shape (`ANON_SCREENER_ROW_DAY`) is one edit if it is wanted.

Verified: boots clean on local mongo (`BOOT OK`, no TDZ) and a real HTTP request
through the live handler with `ANON_STRIP_SYMBOL_DAY=2` and 3 symbols returns
`{"quotes":{…},"limited":true,"limit":2}` + `Cache-Control: no-store`, repeat
requests free. The positive case could NOT be shown locally — Yahoo 429s this
machine, so the shared payload was empty. Tests: `test/anon-bulk-allowance.test.js`
(new, 6); `anon-company-limit` + `visitor-allowances` pins moved (the key derivation
is now one helper, `anonCompanyKey`, so both allowance kinds key the same visitor).
No frontend asset touched ⇒ no `?v=` cache-stamp bump.

**The production verification found a PRE-EXISTING OUTAGE, now fixed (2026-09-24).**
Post-deploy, `/api/market/strip` returned `{"quotes":{}}` for EVERY symbol — not
my clip, not caching, not Yahoo flakiness (interleaved cold tests: strip empty,
demo daily route full one second later). Root cause: Yahoo emits a placeholder
quote row for a session with no OHLC (`close: null` → every price field shaped
`''` by `n()`), and on 2026-09-24 EVERY symbol's series carried one for
2026-09-22. The tape reads the two newest dates directly, `parseFloat('')` → NaN
→ the `Number.isFinite` guard bailed → tape blank for every visitor, silently,
since at least the 9-23 commit and probably much earlier. The pass-through demo
route still "worked" — the empty row only breaks consumers that PARSE the series,
which is why nothing else noticed. Fix, both layers: `buildDailySeries`/
`buildMonthlySeries` in `yahoo-source.js` drop rows with no close (exported for
tests), and the strip filters `dates` to finite closes because its nightly-store
fallback can still hold blobs shaped before the fix. Tests:
`test/yahoo-series-placeholder.test.js` (new, 5, including a tape-shaped
`latest/prior` check against the measured TLT blob).
`WALL_ALL_PAGES=false` set + deployed. Wall week result: 3 signups / 9 days,
0 paid. Measured pre-change: CN 0 sessions ever, SG 73, HK 43 (HK not walled).
Test: `test/geo-wall.test.js`. Kill switch: `GEO_WALL_COUNTRIES=` + deploy.

Open: reopen-10-accounts script `scratchpad/.../reopen/run.js` (7-day comp
trial + email) was BLOCKED by the permission classifier — owner must approve.
awesome-mcp-servers PR #14961 + awesome-remote #578 need a Glama listing
(owner login). Official MCP registry already live since 9/14. Show HN + jojogo
drafts: `docs/growth/show-hn-and-jojogo-2026-09-23.md`.

## Broker/platform API partnership outreach SENT (2026-09-23)

Trigger: AppSumo question from jojogo (TradingView + our screens). Owner said to
send from support@ (overrides the "no cold from support@" rule for this batch).
14 sent via SMTP, all 250-accepted, owner BCC'd: Gotrade, Pearler, Vested,
Sharesies, Hatch, Sarwa, Superhero, Scalable (presse@), TradeZero, Tradier
(sales@), Trading 212 (partnerships@), Freetrade, Stake, tastytrade (api.support@).
TradingView = Gmail draft only (web form, no email). Finviz/DriveWealth skipped
(form only). **Offer made, must be honoured:** free 60-day pilot = production key
+ 20,000 lookups (40k credits, comp a Dev plan); then $299/mo for up to 50,000
lookups, locked 12 months, first 3 partners. SEC-derived tools only (no sp_fund,
no sp_ask). Promised: send real API output for 3 tickers on reply.

## MCP lookup repriced 1 -> 2: MCP and REST now identical (2026-09-23)

Owner decision, finishing the 9/22 ask parity. `COST.mcp_lookup` 2 = `api_lookup`.
No grandfather needed, MEASURED: prod ledger held 8 mcp/api rows, all
rin@gmail.com (desk plan, dev account) from this session's tests. Zero customers.
NB ledger `reason` is `mcp:<slug>`/`api:<slug>`, not the cost key — query by regex.
Keyless MCP tier unaffected (mcp-anon counts calls, not credits).

Tests now assert equality (api-access-gating, public-api-doc-truth,
credit-meter-truth). credit-meter-truth + scripts/render-appsumo-listing.js now
track **v7** (v6 marked superseded); listing collapses to one lookup row and one
ask row "MCP or REST", guarded by an equality assert. 402 adds
`freeAlternativeUrl` (/tools) — a link for the human only; /tools 403s
non-browser UAs.

STILL WRONG, owner not yet asked: mcp-anon.js:156 tells keyless callers the Dev
plan is "about 50 questions" for 200 credits — at mcp_ask 42 it is 4.

## API+MCP: grandfathered for pre-22-Sep LTD buyers; 402s now actionable (2026-09-23)

Two changes, both shipped to the working tree, suite 752/753 (only
`social-compose` fails — selenium not installed here, pre-existing).

**1. Quota 402s are now actionable.** `quotaError()` in `api-response.js` is
shared by `public-api.js` and `mcp-endpoint.js`: adds `used/allowance/
remaining/needed/resetsAt` + `recharge{url,credits,price}` + `upgradeUrl` to
what was bare prose. Keyless MCP callers keep `mcp-anon.js`'s Dev-plan upsell
(they never had a wallet to recharge) — that branch is pinned by a test.
`public-api.md` documents the shape.

**2. API/MCP widened to all LTD tiers purchased on/before 2026-09-22.**
`isLtdApiAccessCohort()` in `lib/tier-limits.js`, consulted by `hasApiAccess`
(app.js) AFTER the refund check and AFTER the tier-3 clause. Fail direction is
INVERTED vs the V2 gates in the same file: this WIDENS, so an unset/unparseable
`LTD_API_ACCESS_CUTOFF` grants nobody. **Ships dark — not live until that env
var is set in prod.**

Purchase date vs redemption date: the DB only had `appsumoRedeemedAt`. Solved
via AppSumo Licensing API — a licence's `created_at` IS the purchase instant.
`scripts/import-grandfathered-licences.js` (dry-run default, `--apply` writes)
sets `user.grandfatheredLicence`, and records unredeemed keys in
`grandfathered_licences`, applied at redemption in app.js.

Measured 9/23 (25 licences): ALL were purchased pre-cutoff. 13 active, of which
**9 are tier 1-2 and newly gain access**; 6 bought-but-unredeemed (the exact
case the importer exists for). So nobody loses anything — it is purely a
widening, which needs no AppSumo approval.

Copy: `frontend-v2/appsumo.html` (tier cards, facts strip, 5 new FAQs, JSON-LD)
and `docs/growth/appsumo-listing-v7.md` (supersedes v6; FAQ answers William's
5 MCP questions; carries a submission blocker — do not publish before the env
var is set and the importer has run). No asset edits ⇒ no cache stamp bump.

Also corrected stale copy found while tracing: appsumo.html said Dossier 10 /
Monitor 5 (real: 21 / 8); seo-pages.js said MCP ask 4, REST ask 8 (real: 42
both). Still stale, NOT fixed: `lifetime.html` meters in "AI Asks" and claims
"full Pro access for life".

NOTE: the AppSumo listing itself cannot be edited via API — the Licensing API
does licences only. Portal paste + William approval, as before. Owner pasted a
licensing key into chat on 9/22; treat as exposed, rotate.


## glm-5.3-flash on MCP+API: VALIDATED AND REJECTED (2026-09-22)

Flash was proposed for the two paid developer surfaces (MCP `sp_ask`, REST
`POST /api/v1/ask`) behind a new `AI_MODEL_API` key. **Phase 1 gating failed —
no code was written.** Numbers below so this is never re-litigated from the
latency file alone.

Ran against local mongod (`flashq`/`flashp` scratch DBs), 6 tickers
(PGR,GM,CRM,META,MSFT,XOM), 2026-09-22 13:25-14:01Z. Raw logs were in the
session scratchpad (gone); the numbers that matter are here.

**PASSED** — `ab-summary-quality`, all six ground-truth gates, but weaker
than 5.3 on two of them: evidence 81.3% (5.3: 89.7%, baseline 86.1%), yield 26
against a bar of 24 (5.3: 34). MSFT alone dropped to `evid=2 yield=2` vs 5.3's
6. Passing, not equal.

**PASSED** — `ab-feature-parity` 24/24 ok. The `keypoints:CRM eur,yen,rupee`
non-USD flag is IDENTICAL on 5.3, so it is pre-existing, not a flash
regression. Neither model meets a literal "0 leaks" bar.

**FAILED** — `probe-llm-capability`, two checks:

- **P13 round-1 tool SET vs baseline: 60% same set (45% exact), bar >=80%.**
  This is the decisive one — it measures the Ask path, which is exactly what
  the change moved. Flash drops relevant tools: `get_red_flags` on "biggest
  risks in Boeing's 10-K", `get_financials` on "Costco reverse DCF",
  `get_ratios_history` on a 5-way growth/FCF compare.
- **P2 strict-JSON idiom attempt 1: FAILED (200, 6464c)** — flash emitted a
  reasoning preamble ("The user wants me to extract...") instead of JSON. 5.3
  parses first try. Affects extractors, not chat, but it is a real regression.

**The premise was wrong, and this is the part worth keeping.** Flash was
pitched as faster on ask. On the *tool-free* path it is. With the 32 tool
schemas attached — i.e. production Ask — the ordering REVERSES:

    chat only, 6 tickers    time     tool calls   tokens
    glm-5.3                 56.3s        20       130,202
    glm-5.3-flash           87.4s        33       178,986
                            1.55x       1.65x      1.37x

Flash's real win is dossier/keypoints (361s vs 834s total) — surfaces the plan
did NOT touch. `docs/benchmarks/model-latency-2026-09-22*.json`'s
`ask_nonstream` row measured the tool-free path; do not cite it for Ask.
Cost still favours flash (~5-7x even at 1.37x tokens), but not latency.

P14 incidentally cleared: flash yields clean JSON at `low`
(`[none:n (omitted):y low:y medium:y]`), so the inherited `/glm-5\.[2-9]/`
-> 'low' regex is safe for flash, just not uniquely optimal. P3/P5/P7/P8/P10/
P10B/P11/P12 all PASS. P12 footnote: flash blocked 0/12 adversarial identity
probes vs 5.3's 1/12 — `leaksIdentity()` is carrying more weight on flash.

**To revisit:** flash is plausible for the summary/extractor surfaces it
actually wins on, gated on fixing P2. It is not right for Ask.

## Documentation section at /docs — 18 pages (2026-09-22)

`backend/docs-pages.js` (new) renders the whole product manual from one frozen
`DOC_PAGES` map, on the `free-tools.js` pattern: routes registered per concrete
path in `app.js` (so an unknown slug 404s with no handler), sitemap entries via
`seo-pages.js:845`, one `layout()` for all 19 URLs.

**Two things here are load-bearing and easy to undo by accident:**

- **No credit number is typed in that file.** Every figure interpolates
  `credits.COST`, and `test/docs-pages.test.js` parses the *rendered HTML* to
  prove it. This is the guard `public-api.md` never had, which is why it drifted
  for months. Do not "simplify" a price to a literal.
- **`'/docs'` is in `WALL_PAGE_EXEMPT_PREFIXES`.** With `WALL_ALL_PAGES=true`
  (live in prod) it is the only product surface readable signed out. Verified by
  booting with the flag on: `/docs/*` -> 200, `/portfolio.html`, `/screener`,
  `/stocks` -> 302 to `/register.html`.

Nav and footer are byte-identical to the rest of the site — confirmed in headless
Chrome against `/support.html`: same innerHTML length (2447 nav / 804 footer),
same links, height, background, border. The docs emit no `<header>`/`<footer>`
and no CSS touching `.nav`/`.footer`; a test asserts both.

Stamp bumped `20260917-uifix2` -> `20260922-docs1` (101 occurrences, 51 files);
`docs-pages.js` added to the scan list in `profile-consolidation.test.js`.

Also fixed: `seo-pages.js:1147` still advertised the pre-reprice API price
("a data lookup costs 1 credit, an AI answer 4") — now 1-2 and 42.

Suite: **712/713**, the one failure the pre-existing `social-compose`
MODULE_NOT_FOUND.

**Still open, unrelated to this work:** `WALL_ALL_PAGES` has no crawler
exemption, so the ~18,000 `/stocks`, `/tools`, `/compare`, `/screens` and
`/research` URLs still in `sitemap.xml` redirect Googlebot to `/register.html`.
Owner parked it deliberately on 2026-09-22. `/docs` is now the one indexable
section.

## AI cost is now measured, not estimated (2026-09-22)

`scripts/ollama-cost-projection.js` (new, read-only) groups `ollama_usage_events`
by **model x purpose** — something no script did before — and prices it against
list rates fetched from ollama.com/pricing on 2026-09-22:

| model | in $/M | cached in | out $/M | **$/mo at today's volume** | % of the $60 allowance |
|---|---|---|---|---|---|
| **glm-5.1** (live) | 1.00 | 0.20 | 3.20 | **$28.91** | 48% |
| glm-5.2 / glm-5.3 | 1.40 | 0.26 | 4.40 | **$40.36** (1.40x) | 67% |
| **glm-5.3-flash** | 0.15 | 0.03 | 0.50 | **$4.36** (0.15x) | 7% |

$28.91 independently reproduces the "~$30/mo, half the allowance" figure that
was hand-derived earlier, which is the cross-check that the method is right.
**glm-5.3's price was recorded nowhere in the repo before this.**

**The 85/15 input/output split in `credits.js` was wrong: the real figure is
95/5 for `chat` and 90/10 for `summary`.** Chat is input-heavy by
construction — every tool round resends the conversation plus the system prompt
and 28 tool schemas while the answer stays short. Because frontier *output*
costs 5x frontier *input*, an input-heavier split makes the anchored cost
**lower**: the 2x rule now implies **3.3 credits**, not 4.4. So `mcp_ask: 4` sits
slightly ABOVE the owner's own rule rather than just under it. **Left as is** —
repricing downward is the owner's call and would need synchronised edits to the
AppSumo listing, seo-pages.js and public-api.md.

Margin is not a constraint either way. At the measured split, an `mcp_ask`
earns **26x** its marginal cost on glm-5.1, **18x** on glm-5.3, **171x** on flash.

**Two measurement traps worth remembering**, both of which produced confident
wrong numbers before being caught:
- `promptTokens`/`completionTokens` are **missing** (not null) on rows written
  before 2026-09-11. `{$ne: ['$promptTokens', null]}` does NOT exclude a missing
  field, so coverage read as 1,530 calls when only **259** carry data — and the
  first cost run priced 15% of the tokens as if it were all of them ($3.93/mo
  instead of $28.91). Use `$isNumber`, and apportion each group's FULL
  `totalTokens` by the ratio measured on its covered subset.
- Coverage is still only **295 of 2,349** calls. Re-run once it is broad.

### Local rig + benchmark
`scripts/dev-local.js` now seeds a **desk**-plan user at `rin@gmail.com` (the
email `marketingDashboardOnly` hardcodes), mints fixed API keys, raises the
local abuse limits, disables `WATCHDOG`/`GURU_PREWARM` (watchdog calls PAID
inference and would pollute telemetry), and prints a full runbook. The previously
seeded `pro` plan passed **neither** `hasApiAccess` nor `monitorGate`, so API,
MCP and Monitor all 402'd locally. Verified end to end: REST, keyed+keyless MCP,
admin dashboard, credit deduction, and a real Ask in ~4s.

`scripts/bench-model-latency.js` (new) fixes the flaw that made the earlier
speed numbers contradict each other: it interleaves models **per case** with a
rotating order instead of running block A then block B, and reports **paired
per-case ratios** with a sign test rather than totals.

### Safety: two production incidents, same root cause
`backend/.env` carries the provider keys AND the production Atlas URI, so any
script calling `dotenv.config()` on it to get an API key inherits the live
database. That caused the 2026-09-07 incident, and again on 2026-09-22 when
`ab-feature-parity.js` deleted live `company_keypoints` rows and force-rebuilt
dossiers/monitor reports for BRK-B/BABA/AAPL — several on glm-5.3, so **prod
cache currently serves glm-5.3 content for those three tickers** (cache only;
self-healing, but unapproved). **Restoring them to glm-5.1 is still OUTSTANDING.**
New `scripts/lib/dev-env.js` makes it structurally impossible: `loadAiEnvOnly()`
parses `.env` and copies only an allowlist (never MONGODB_URI), and
`assertLocalMongo()` refuses any non-local host. Both harnesses now use them and
require an explicit `--db`.

`backend/public-api.md` was stale for months (2/4 credits, the 10,779 blended
token figure, $0.10/credit). Fixed, and `test/public-api-doc-truth.test.js` now
asserts it against `credits.COST` — verified to fail on the old values.


## Ask depth restored on 5.3 — LIVE (2026-09-22, commit 22bcc5c6)

The owner read real 5.3 answers and found them thin; `ab-ask-depth.js` agreed.
**Nothing mechanical was binding** — MAX_ITERS 10, MAX_TOOLCALLS_PER_ROUND 12
and maxTokens 8000 all had headroom. Four ASK_SYSTEM rules were the cause,
because 5.1 under-weighted them and 5.3 follows them literally:

- **THE LIVE WEB said "at most TWO search_web calls" while `WEB_BUDGET.search_web`
  is 3.** A straight bug: a literal model forfeited a third of its web research.
- EFFICIENCY opened "you have a hard budget of a few tool rounds" — reads as
  do-less. Batching BUYS research inside the budget; it now says so.
- STOP DIGGING was written for dead fetches but capped research. Renamed
  DROP DEAD THREADS and scoped to failing calls only.
- STYLE's "concise but complete" was being applied to substance. Now: tight
  prose, complete substance, completeness wins on conflict.

| same 5 questions | 5.3 before | 5.3 after | 5.1 |
|---|---|---|---|
| mean answer chars | 2,731 | **3,082** | 3,870 |
| tool calls / run | 6.2 | **7.8** | 12.0 |
| failed tool calls | 3 | **1** | 13 |
| figures present | 5/5 | 5/5 | 5/5 |
| mean seconds | 17 | 38 | 93 |

69% -> **80%** of 5.1's depth, 26% more research, fewest failed calls of any
run, still 2.4x faster. **Next lever if more is wanted:
`AI_CHAT_REASONING_EFFORT=medium`** — env-only, chat-only, cannot touch the
extractors, breaks no test (the coupling test never sets the env var). Measure
before setting; it will cost some of the speed.

**Method note worth keeping: the prompt is the lever, not the budgets.** Every
instinct said raise the caps. The caps were never the constraint.

## Cross-industry validation: 24/24 on both models (2026-09-22, evening)

Independent of the bench run below, and agreeing with it. Six industries x four
surfaces x two models on local mongo (`brew services start mongodb-community`,
8.3.11 — now installed, so harnesses no longer need the Atlas URI):
insurance PGR, autos GM, SaaS CRM, ads META, hyperscaler MSFT, energy XOM.

**`ab-feature-parity.js`: 24/24 ok on BOTH models, 0 non-USD leaks on both.**
Dossier filled 5/5 AI sections on every ticker for both models; Monitor never
fell back to template. Wall clock **1301.8s (5.1) vs 329.6s (5.3)**.

**`ab-summary-quality.js`, all six gates PASS** (fresh tickers, none of them
the hard cases): parse 6/6 both; evidence **69.4% -> 86.8%**; figures 97.2% ->
**97.4%**; yield **4.0 -> 5.3** changes/filing; segments reconcilable 4/4 both,
median residual 0.001 -> **0.000**; 0 think-leaks, 0 self-converted currency.

**Ask token use is the big cost story, and it is bigger than 23%.** Over the
six questions 5.3 used **0.31x** the tokens (mean 23,008 vs 75,201), because it
closes in 3-5 tool calls where 5.1 takes 7-10 and every round resends the whole
conversation plus 28 tool schemas. At list rates and the measured 95/5 split,
**mean marginal cost per Ask: $0.0835 on 5.1 vs $0.0357 on 5.3 — 57% cheaper.**
The bench's 1.15x is a surface-mix average; on the Ask surface specifically the
multiplier is well under 1. Settle it from `ollama_usage_events` after the flip.

5.3 writes ~30% shorter Ask answers (2,975 vs 4,272 mean chars) but MORE Key
Points (12 sections vs 10-11) and LONGER monitor briefs. Terseness is specific
to the Ask loop, not a general property. Both carried figures on 6/6.

**Round-1 tool-set divergence is not a real blocker** (detail further down):
over the full loop 5.3 calls get_filing_diff on the Berkshire case in both
model orderings. A prompt hole contributed — `ai-chat.js` now routes
"summarise the latest quarter/results/earnings" explicitly at get_filing_diff
+ get_financials(quarterly), which helps both models.

## glm-5.3: speed question RESOLVED, summary slot ready, chat is not (2026-09-22)

Two things below are now superseded — read this first.

**Speed is settled, and 5.3 wins.** `bench-model-latency.js` completed 162 timed
runs (3 tickers x 2 reps x 9 surfaces, interleaved). **Paired medians vs 5.1**
(<1.00x = faster): ask_nonstream **0.35x**, ask_stream **0.30x**, keypoints
**0.50x**, dossier **0.62x**, filing_diff **0.46x**, mcp_ask 0.29x, api_ask
0.25x; monitor is a wash at 0.99x. Ask, dossier and keypoints are 6/6 faster
with sign p=0.031. The block-ordered TOTALS in the same report say the opposite
(5.3 12106s vs 5.1 11112s) — that is exactly the drift artifact the paired
design was built to defeat. **Do not quote the totals.**

**The 1.40x cost multiplier is too high.** It assumed equal token counts, but
5.3 used ~23% fewer input tokens over identical work: **$1.229 -> $1.414 = 1.15x**,
so ~**$33/mo**, not $40.36 — 55% of the allowance, not 67%. (Bench surface mix
is not the production mix, so treat as indicative.)

**Hard-case accuracy re-run** (BRK-B, BABA, TSM, SONY, ASML, NVO at correct
effort): parse **4/6 -> 6/6**, evidence 52% -> 62.5%, figures 96% -> **100%**,
yield 3.3 -> 4.2 per filing. **All 6 gates pass.**

**FIXED: the rollout was unsafe as written.** `applyReasoning` never received
the model name, so effort came from env alone, defaulting summary to 'none'.
"One env key at a time" therefore meant `AI_MODEL_SUMMARY=glm-5.3` as a single
PUT -> 5.3 at 'none' -> the one measured combination that emits **no JSON at
all**, silently, into ~20 template fallbacks. Effort is now **derived from the
resolved model** (`reasoningFor`), env is an explicit override only, and
`test/reasoning-effort-coupling.test.js` pins every cell including "glm-5.1 is
byte-identical to today". `prod.env.example` no longer ships a hard-coded
`=none` that would have survived the flip — **if that key is set explicitly in
Render, delete it before flipping, or the derivation is bypassed.**
Note `KEY=` is an empty string, which means *omit the field*, not *unset*.

**CHAT: FLIP IT. 5.3 is safer than what is in production today.** (Supersedes
the "do NOT flip" note below, which was written before the recency fix and
before the private-company control was run more than once.)

**The staleness hole is closed structurally.** `get_financials` now returns
`latestPeriodEnd`, `latestPeriodAgeDays` and, when a newer filing should exist,
a `stalenessWarning` telling the model to verify with search_filings/fetch_page
before saying "latest". ASK_SYSTEM makes that field binding. The point is that
`loadFundAny()` deliberately falls open to a stale cache, so the payload used to
carry period dates but nothing saying those periods were BEHIND — and a model
cannot detect what it is not told. Whether an answer was right depended on
whether the model happened to double-check the web. Now it does not.

**Threshold bug worth remembering:** the first version flagged at the FILING
DEADLINE (~40d), which marks a current quarter stale for most of its life — on
2026-09-22 Exxon, Meta and Morgan Stanley all sat on a Q2 ending 2026-06-30, 84
days old and perfectly current, because Q3 had not ended. The right interval is
one full period PLUS the next filing's deadline: `92+48` quarterly, `365+95`
annual. Caught by running it against real tickers, not by reasoning.

**Cross-sector result** (`scripts/ab-recency.js`, new — asserts the PERIOD in
the answer, which every tool-volume metric missed). BRK-B, XOM, META, MS, 2 reps:
**both models named Q2 2026 correctly 8/8.** 5.3 did it in 7-26s against 5.1's
47-82s, skipping verification when the data was current and doing it when it was
not (Berkshire).

**The finding that decides it — SpaceX, private, files nothing:**
| | clean declines | FABRICATED figures |
|---|---|---|
| glm-5.1 (in production now) | 1/6 | **5/6** |
| glm-5.3 | 6/6 | **0/6** |
5.1 invents an IPO — "SpaceX's first public quarterly report shows revenue
nearly doubling year-on-year to $7.8bn". That is the incumbent, today. 5.3 never
did it. Migration is now a risk REDUCTION, not a risk.

Scoring note: the first detector scored that fabrication as a correct decline
(it hedged further down) and would have false-flagged a good answer for naming
Rocket Lab (RKLB) as an alternative. For a company that files nothing, the sound
test is that a correct answer quotes NO figures — no dollars, quarters or
percents.

Suite **724/725** (only the pre-existing social-compose selenium gap).


## SUPERSEDED — pre-fix chat assessment, kept for the reasoning

**CHAT: do NOT flip. The round-1 concern was real, and worse than it looked.**
`scripts/ab-ask-depth.js` (new) runs the FULL ask loop instead of P13's round-1
snapshot, because round 1 cannot tell "researches less" from "sequences
differently". Over 10 interleaved runs: 5.3 makes **6.2 tool calls/run vs 11.5**,
in **19s vs 92s**, with **2 failed calls vs 14**, and 10/10 answers carry
figures on both. That all favours 5.3 — and is why this needed an actual read
of the answers rather than another metric.

**The read: on "Summarise Berkshire's latest quarterly results", 5.1 returned
Q2 2026 (ended 30 Jun). 5.3 returned Q1 2026 — one quarter STALE, stated with
full confidence.** 5.1 spent 11 calls and cross-checked search_filings/fetch_page
against the cached fundamentals; 5.3 spent 2, took `get_financials` at face value
and never tested whether newer data existed. Caveat: the local fundamentals
cache was itself on Q1, so this is a *robustness* difference, not a fixed bug —
but that cache lags after every real filing, which is exactly when users ask
"latest results". Stopping early is why 5.3 is fast, and here it cost the answer.

**summary and briefing are ready now; chat is not.** Re-test chat with
`ab-ask-depth.js` after any prompt change that pushes recency-checking.

**API + MCP verified on 5.3**, 23/23 via new `scripts/verify-api-mcp.js`: auth
boundary, all 6 documented REST endpoints, REST ask, all 7 MCP tools over real
Streamable HTTP, and the anonymous MCP tier capping at exactly 2 free asks.
Run it against a FRESHLY booted server — the anon check asserts exact quota.

**Also fixed:** `probe-llm-capability.js` still did `dotenv.config()` on
`backend/.env` and `mongoose.connect(MONGODB_URI)` — i.e. straight to production
Atlas, the same pattern behind both incidents, and it was the one harness never
retrofitted. Now uses `loadAiEnvOnly` + `assertLocalMongo` and requires `--db`.


## Original 2026-09-22 notes (speed section superseded above)

**Nothing is live.** Prod is still `glm-5.1` on all three purposes. The code is
model-agnostic and the flip is three env PUTs. Harnesses are committed:
`scripts/probe-llm-capability.js` (13 structural checks),
`scripts/ab-summary-quality.js` (ground-truth quality gates),
`scripts/ab-feature-parity.js` (keypoints/dossier/monitor/chat end to end).

**The finding that matters: reasoning effort is a property of the MODEL, not the
caller, and `none` is wrong for 5.3.** On the filing-diff prompt —
`none` → it reasons in the *visible* channel, overruns max_tokens,
`finish_reason: length`, **no JSON at all (0/10 filings)**; provider default →
reasons in the hidden channel, overruns it, **content empty**; `low` → clean
JSON in **925 completion tokens** (vs 4000 burned). `AI_SUMMARY_REASONING_EFFORT`
now exists for exactly this, defaulting to `none` so 5.1 is unchanged.
**Flipping the model without also setting effort=low would have silently
emptied ~20 extractors into their template fallbacks.**

**Measured at each model's own best effort (5.1=none, 5.3=low):**
| | 5.1 | 5.3 |
|---|---|---|
| filing-diff parsed (10 US) | 8/10 | **10/10** |
| filing-diff parsed (6 huge/foreign) | 4/6 | **6/6** |
| evidence / figures verified | 71% / 94% | **75% / 96%** |
| usable changes per filing | 4.0 | **4.8** |
| mean extraction latency (16 filings) | 17.5s | **7.3s** |
| Ask end-to-end (3-co compare) | 43k tok | **37k tok** |

**Do NOT trust any single latency reading, including the one above.** Two
identical feature-parity runs hours apart gave opposite answers: 5.3 totalled
**699s then 994s** over the same 12 cases while 5.1 held **707s then 625s**.
Per-case swings on 5.3 were 3-14x (keypoints BRK-B 28s then 122s; Ask BRK-B 12s
then 173s), while 5.1 stayed within ~2x. The shared GPU pool's load dominates.
**5.3 is measurably more ACCURATE; on speed the honest answer is "unresolved,
and higher variance".** Settle it after a flip from `ollama_usage_events`
grouped by `model` over real traffic — never from another hand-run.

Tool calling needs **no changes**: all 32 schemas accepted (enums + arrays),
0/20 text-form tool calls, 0/20 `<think>` leaks, identity deflection intact.
Currency is safe: BABA extracts printed RMB on both models, `repairUnits`
converts, users see the identical $78.7B. Neither model self-converts.

**Two real bugs found and fixed while measuring** (both pre-existing, both
independent of the swap): the Ask loop sliced tool calls past 12 without
sending a `role:'tool'` reply, leaving unmatched `tool_call_id`s that a
provider rejects with a 400 — and 5.1 *already* emits 15-20 calls on a
5-company compare (5.3 emits 20). And every dossier section except the
executive summary had a retry; under concurrency the first attempt times out
often enough that the summary was the section that went missing. BABA dossier
went 1/3 → **4/4 complete** after adding that retry and raising section
timeouts 45s → 90s.

**Round-1 divergence RESOLVED 2026-09-22 — it was a metric artefact plus a
prompt hole, not a model regression.** P13 scored 5.3 at 60% of 20 questions
against *5.1 as ground truth*, which nobody had validated, over round 1 only of
a 12-round loop. Two causes:

1. **Prompt hole.** The routing line mapped `"what changed since last
   quarter/year" → get_filing_diff`. "Summarise Berkshire's latest quarterly
   results" matched no rule, and RECENCY points that shape at
   get_financials(quarterly) alone — so 5.1 calling get_filing_diff there was
   unprompted taste, and 5.3 was following instructions more literally.
   ai-chat.js now routes latest-quarter/results/earnings summaries explicitly.
2. **Round 1 cannot see sequencing.** `scripts/ab-ask-depth.js` runs the full
   ask() loop and compares the tool UNION, answer figures and length.

**Measured, both model orderings, cold cache, local mongo:**
| | 5.1 | 5.3 |
|---|---|---|
| tool calls / run | 11.8 / 9.2 | **6.4 / 6.4** |
| answers carrying figures | 5/5, 5/5 | **5/5, 5/5** |
| failed tool calls | 9 / 5 | **1 / 3** |
| mean seconds | 70 / 64 | **23 / 30** |
| mean answer chars | 4287 / 3967 | 2847 / 2974 |

5.3 calls get_filing_diff on the Berkshire question in BOTH runs — the
"dropped" finding does not survive the full loop. **Caveat: the prompt fix was
live for both runs, so this cannot separate "round 1 was the wrong lens" from
"the new routing rule did it". Both point the same way; neither is isolated.**

**The one replicated difference left: 5.3 never calls get_key_points (5.1
always does), and writes 25-30% shorter answers** (Boeing: 3889 vs 6029 chars).
Both models produced figures on every question, so this is a judgement about
DEPTH, not correctness — and it is the one thing still wanting a human read.
n=5 questions x 1 rep x 2 orderings: small. Latency direction replicated even
with 5.3 paying the cold-cache cost, but still settle it from
`ollama_usage_events` after a flip, not from this.

**Local mongo now exists**: `brew services start mongodb-community` (8.3.11),
so harnesses run against `mongodb://127.0.0.1:27017/<scratch>` — no more
reaching for the Atlas URI.

**Rollout** (approved): local chat first, then briefing → summary → chat, one
env key at a time. Remember `set-render-env.yml` alone does NOT deploy —
dispatch `deploy-render.yml` after, or the value is stored but not live.


## Hard paywall ARMED LIVE 9/15 — the 1-week clock is running

**Status: `WALL_ALL_PAGES=true` is LIVE in production as of 2026-09-15 ~08:00Z.**
The wall is up; every walled page 302s for anonymous and non-paying visitors, and
new signups get the 3-day no-card trial. The week runs to ~2026-09-22. Commits
`f4af1ee5` (wall) + `8f4c131a` (`/licensing` exemption), both deployed.

**Kill switch = unset the var** (`gh workflow run set-render-env.yml -f
key=WALL_ALL_PAGES -f value=` … but an empty value is not a delete — the reliable
revert is setting it to anything other than `true`, i.e. `-f value=false`, which
restores today's open site instantly). Trials already granted keep running to
their own 3-day end; nothing else to unwind.

**⚠️ Render gotcha, found the hard way — set-render-env alone does NOT deploy.**
Setting the var triggers a *Render-native* deploy, and that deploy fails silently
because Render's GitHub connection is broken (see the header of
`deploy-render.yml`), so the old build keeps serving the old env and the wall
stays off while the API reports success. **After any `set-render-env.yml` run,
dispatch `gh workflow run deploy-render.yml` and wait for "deployed", or the
change is only stored, not live.** That is exactly what happened here: the var was
set at 08:0x and the site stayed open until the manual deploy 2m28s later.

**Verified live in production (not just dev-local), all with the flag armed:**
`/`, `/stocks/AAPL`, `/screener`, `/methodology`, `/compare/finviz`,
`/dashboard.html`, `/news.html`, `/tour.html` → 302 `/register.html`; exempt
`/register.html`, `/login.html`, `/upgrade.html`, `/licensing`, `/api`,
`/privacy`, `/terms`, `/support`, `/appsumo.html`, `/robots.txt`, `/sitemap.xml`,
`/llms.txt`, `/assets/app.js` → 200; `/stripe/config` → 200
`signupTrialDays: 3`. A **real production signup** (`support+wallverify@…`,
deleted afterwards — total back to 58 users, 0 trialing) returned
`status: trialing`, `trialEndsAt` +3d exactly (09-15 → 09-18), `price: 0`, no
card; its token got `/`, `/stocks/AAPL`, `/screener` 200; a tampered token 302'd
to register. That also *proves* `REQUIRE_INITIAL_STRIPE_PAYMENT=true` in prod —
the trial branch at app.js:5990 can't run otherwise, and if it were false,
app.js:5982 would hand every free signup `status: 'active'` and the wall would be
free to bypass.

**Reading the week's numbers:** `node scripts/wall-week-report.js` (read-only,
no Stripe key needed) prints the window's signups, trials granted, trials still
live, expired-unpaid, paid, and the trial→paid rate, per day and in total, plus
the whole account base by status for comparison. Baseline at arming time: **0
signups in the window**, base 24 pending / 17 active / 16 cancelled. Re-run it
mid-week and again on ~9/22 — the fixed query is deliberate, so "converted"
can't mean something different at each reading.

**Original build notes:** `WALL_ALL_PAGES` defaults off (`=== 'true'`, revert =
unset/false, no redeploy). `SIGNUP_TRIAL_DAYS=3` was ALREADY live before this
(verified by reading `/stripe/config`; not set by any `set-render-env.yml` run,
so it came from the Render dashboard), so the free-trial card was already
unhidden and trials had been granted since ~9/10 — one, since expired.
Anonymous page → 302 `/register.html`; signed-in-but-inactive (expired trial,
cancelled) → 302 `/upgrade.html` (the checkout path). Paying, live-trial and
AppSumo/lifetime users are untouched.

**Blast radius, measured 9/15 against the prod DB (read-only):** 58 users
total; **20 would pass** the wall (17 `active` + 3 AppSumo/DealMirror grants,
which the wall lets through automatically); **38 blocked** — 24 `pending`
(signed up, never paid) and 16 `cancelled`, i.e. exactly the population the
experiment aims at, each landing on `/upgrade.html`. 0 trialing right now, so
nobody's live trial is cut short.

**The shape:** one page-scoped middleware in `app.js` mounted ahead of
`ssrCacheMw` (which stores GET+200 HTML only, never a 302 — so a walled page
can never be cached) and ahead of every SSR route and `express.static`. Expired
no-card trials are caught on read by `ensureSubscriptionShape`, so the wall
needs no expiry logic and never waits for the nightly sweep. No frontend asset
was touched → **no cache-stamp bump**. `backend/test/hard-paywall.test.js`
(9 static tests). Suite 663/664 — the one failure is the pre-existing
`social-compose` selenium gap.

**Verified live against dev-local (`WALL_ALL_PAGES=true SIGNUP_TRIAL_DAYS=3
REQUIRE_INITIAL_STRIPE_PAYMENT=true`), all states walked:** anonymous `/`,
`/stocks/AAPL`, `/screener`, `/dashboard.html`, `/methodology`, `/verify.html`,
`/compare/*` → 302 register; register/login/forgot-password/privacy/terms/
support/appsumo/upgrade → 200; seeded Pro → every page 200; a real trial signup
via the free-plan card → `status: trialing`, `trialEndsAt` +3d exactly, price 0,
no card → pages 200; that trial backdated in Mongo → 302 `/upgrade.html`;
garbage token → 302 register; flag off → all 200 and `signupTrialDays: 0` (that
last one is dev-local only, where `SIGNUP_TRIAL_DAYS` is unset — prod reports 3).

**The bug the walkthrough caught that reading would not have:** `/stripe/config`
is a ROOT path, so it looks exactly like a page and got walled — and it is how
`register.html` learns `signupTrialDays` to unhide the free-trial card. Walling
it silently kills the entire trial flow while every test stays green. Same class,
found by scanning every root route rather than only the page inventory: `/mcp`
and `/oauth` (machine legs, each authenticates or meters every call), `/.well-known`,
and the attribution redirects `/go` + `/r/<amb-slug>`. **`/r/<publicId>` is the
public research library, i.e. real content, so it stays walled** — the carve-out
is exactly one slug prefix wide and a test pins that it can't widen.
**`/licensing` (+ the `/api` developer landing page) is exempt**: it is where
`bot-blocker.js`'s own 403 body sends a refused crawler, and this file already
states the principle at the `/licensing` route — *a denial that points at an
unreachable page is just a denial*. It also sells bulk data to a different buyer
(RIAs, data desks) than the experiment targets. Live-verified with the flag on:
`/licensing` and `/api` 200 with real titles, `/` and `/stocks/AAPL` still 302;
a test now evaluates the exemption list the way the middleware does so narrowing
a prefix can't silently wall them.

## September launch rate LIVE 9/15 — Monthly $8.99, locked in, self-expiring 10/1

**Live in production.** `/stripe/config` returns `monthlyPromo` (`price: 8.99`,
`listPrice: 24.99`, `until: 2026-09-30`). Anyone who starts a Monthly checkout
this month pays $8.99 via the **`sept-launch-899` Stripe coupon** ($16 off,
`duration: forever`) and keeps that rate while subscribed; October signups return
to $24.99. Commit `e8dc2714`, deployed 9/15 — the set-render-env → deploy-render
dance again (two vars set, then a manual deploy).

**Kill switch:** unset either `LAUNCH_PROMO_COUPON_ID` or `LAUNCH_PROMO_UNTIL`
(or point `UNTIL` at a past instant). The window is read **per request**, so the
offer closes with no deploy and no restart, and the pages follow on their own:
every surface ships the list price in its HTML and only swaps when `/stripe/config`
reports the promo. Proven on a real server — `UNTIL=2026-09-01` → `monthlyPromo:
null`; no coupon id → `null`.

**Why a coupon, not a new Price:** `resolveStripeCheckoutPlan` requires the
configured price id to match product+amount+currency+interval in
`CHECKOUT_STRIPE_PRICE_SPECS` (frozen at boot, monthly `24.99`) and overrides the
plan price with the spec amount, refusing to sell on mismatch — a promo Price
means editing that matcher plus a date gate inside it. A coupon leaves the
matcher, both price ids and every legacy subscriber untouched and puts the
discounted amount where it must be right: the invoice. $24.99 − $16.00 = $8.99.

**Scope:** Monthly only, and **never** on an affiliate-attributed checkout — a
`/go` referral code takes the whole first invoice off, which beats $16, so that
path keeps the code box. Stripe rejects a session carrying both `discounts` and
`allow_promotion_codes`, so it is one or the other, never both.

**The annual cards drop their savings pitch while this runs.** Twelve months at
$8.99 is $107.88 — less than the $199.99 annual — so "Save $100 a year", "two
months free versus $24.99 monthly" and the homepage's $299.88 monthly comparison
are false for the length of the promo. All three are dropped at runtime on
register/upgrade/homepage; the annual card stays on sale with its one-payment
framing, and **the claims come back by themselves** when the promo ends (the
shipped HTML is untouched — a test pins that nothing hardcodes $8.99).

**Verified 9/15 in real headless Chrome** against dev-local with the promo armed:
register summary `$8.99 / was $24.99 / per month` + the locked-in note; the trial
card's day-4 line "subscribe at $8.99/month"; upgrade's Good card `$8.99` with
`$24.99` struck (`getComputedStyle` → `line-through`); homepage Good card + hero
"from $8.99/mo", annual `$299.88` hidden. Then re-verified in **production** by
curl: `/stripe/config` carries the promo, register.html + upgrade.html carry the
wiring. Screenshots: `/tmp/promo-shots/*.png`.

**Known, accepted:** (a) `syncSubscriptionFromStripe` resolves the plan by price
id and stores `subscription.price` from the *list* price, so the stored/API price
reads 24.99 while the customer pays 8.99 — **no UI renders that field** (every
consumer checked) and Stripe's own receipt is unambiguous, so it is latent; the
fix, if ever needed, is a display rule, not a matcher change. (b)
`frontend-v2/assets/app.js` Ask-wall CTAs still say `$24.99/month` (:609, :634) —
deliberately untouched because that file carries the `?v=` stamp cascade; stale
copy until the promo ends, leave it. (c) terms.html, JSON-LD, SEO and comparison
pages keep the $24.99 list price on purpose — they state the standard price, and
the checkout shows the real one.

**Test:** `backend/test/launch-promo.test.js` (8) — the date boundary is
*evaluated from the real helpers*, not re-implemented. Suite 671 pass, 1
pre-existing failure (`social-compose`, selenium not installed).

**Crawlers get the same 302 as humans** — no user-agent special-casing, no
cloaking (`bot-blocker.js` still 403s them first, unchanged). Accepted cost,
stated when the plan was approved: **SEO is dead for the week by design.**
robots.txt + sitemaps stay public so re-indexing is fast after. Bing click guard
is meaningless this week; the metric is trial signups → `begin_checkout` →
trial→paid conversions.

**Still owner-only:** the 12 warm-lead emails
(`notes/2026-09-14-warm-lead-emails.md`) — the higher-expected-value action,
independent of this experiment, and now the natural thing to send *into* the wall
since warm traffic gets the 3-day trial.

**Prod health after the 9/15 deploy (flag off), curled with full browser
headers:** `/`, `/stocks/AAPL`, `/register.html`, `/login.html`, `/upgrade.html`,
`/screener`, `/privacy`, `/robots.txt` all 200, no redirects — behavior byte-for-
byte unchanged. Note `bot-blocker.js` serves its licensing refusal to bare
`curl` even now: use `-A stockportfolio-internal` (or a browser header set) to
read prod JSON endpoints.

## The payment path is PROVEN end to end (9/14) — first time ever

Ran plans 2–10 of the $5K ramp. The headline: **a purchase now demonstrably
works from click to entitlement**, verified against the real app with real
Stripe objects, not asserted. This closes the item open since 9/1 (growth.md
§12a) — though note it was proven in TEST mode, so a live card still has never
completed. Commits `b15db6e3`, `1b82599f`, `919f3484`, `ebcfaf0d`, `b3aafe06`,
`6e248962`.

**Front half (real test-mode payment, owner paid with 4242):** charged exactly
**$250.00**, `client_reference_id` survived the URL parameter, discount applied,
subscription created, email captured.

**Back half (`backend/tmp-webhook-replay.js`, keep this script):** boots the
real app against mongodb-memory-server (Atlas unreachable, dev-local pattern),
seeds a user mirroring a warm lead, takes the **real paid session object**,
repoints `client_reference_id`, signs it the way Stripe does, POSTs it at
`/stripe/webhook`. Results:
- pending `pro-annual` → **active `pro-annual`**, `stripeCustomerId` +
  `stripeSubscriptionId` written, `stripe_paid` lifecycle event recorded.
- **direct-LTD tiers 1, 2 and 3 all mint** a licence with a key and set
  `appsumoTier` correctly. Plan 9's "webhook minting verified" is now real.
- **Briefing** records a `briefing_subscribers` row, fires the welcome mail, and
  correctly grants NO app access.

**The mechanism that makes warm-lead links work, and its one hazard.** A bare
payment link carries no userId, no `client_reference_id` and no subscription
metadata, so the webhook resolves nobody and grants nothing. Appending
`?client_reference_id=<user _id>` makes app.js:9885's `clientRef` fallback
resolve the buyer; the plan is then resolved off the buyer's OWN stored
`subscription.planId` (app.js:4156). **So the link's rung and the lead's stored
plan must agree, or they are charged for one plan and granted another.** Links
are generated per-lead by `tmp-build-lead-links.js`; never send a bare link.

**Stripe objects created (live mode):** coupon `ZWYwJw3s` (−$249.99, once) +
promo `ORIGINAL250` (max 6) so the five who chose Pro at the old $250 rung pay
exactly $250.00 year 1 and renew at $499.99; `allow_promotion_codes` on the Pro
link; **Desk payment link** `buy.stripe.com/cNi8wO1Gs5LW22T5G64sE08` on the
existing $1,999.99 price, carrying `subscription_data.metadata.planId` so it
resolves via metadata rather than the fallback. All 12 leads now have a link.
Also set `STRIPE_PRICE_ID_CREDITS_TOPUP` and `STRIPE_PRICE_ID_BRIEFING_ANNUAL`
(`price_1UCm7zAUeKapY1OPLWq7AhVf` — the OTHER $149 price is the stale
"Intelligence founding" one) on Render.

**Six places the plan was wrong, all measured:**
1. `appsumo.html` already publishes the credits expectation block correctly
   (50/150/400, dossier 10 / monitor 5 / compare 5 / ask 2, matching
   `credits.js`). The **AppSumo listing** is the stale surface — portal-only.
2. The review drip **already ran**: 11 of 14 active buyers are at
   `appsumoReviewStage` 3, one each at 2, 1 and 0. Re-asking would be spam.
3. The 2 unredeemed licences are **unreachable** — AppSumo's webhook carries no
   buyer email, so there is no address to nudge. Only AppSumo can.
4. The direct-LTD "founding flash" pool is **2 users**, not the 10–40 estimated:
   52 of 58 users already carry `appsumoTier`, and the other 24 are the warm
   pending-checkout pool.
5. Plan 8's demo page **already exists** — `/filing-changes` and
   `/filing-changes/:symbol`, live, ungated, verbatim Was→Now.
6. There are **0 `direct-ltd` licences in production** and the August test
   sessions reference users absent from prod Mongo — that rehearsal ran against
   a different database and never proved minting.

**Shipped alongside:** MCP funnel events (`mcp_keyless_cap_hit`,
`mcp_oauth_client_registered`, `mcp_oauth_authorized`). The funnel was blind not
for want of a call site but because `normalizeEventName()` **drops any name
outside `EVENT_NAMES`** — instrumenting without registering logs nothing and
reads as zero demand. Also server-side attribution capture on the
`/filing-changes` pages, gated on an explicit campaign marker because the
capture sets a cookie and `ssr-cache.js:299` refuses to cache any Set-Cookie
response — ungated it would empty the SSR cache for organic and crawler traffic.

**`avisre/stockportfolio-mcp` now exists** (standalone `mcp-server/` subtree,
leak-gate clean, 11/11), package at 0.3.1 with `mcpName` + `repository`. Also a
$1,500 fixed-scope pilot rung on `/licensing`.

**Still owner-only, and nothing I do can produce these:** the npm password
(token `c84b8d`, leaked 9/14, still unrotated); William's email + confirmation
the $39→$59 rise is really 10/1 before `APPSUMO_DEAL_END_AT` is set; a
non-`support@` identity for Plan 6 cold outreach; logins for the 4 MCP
directories and Hacker News; and approval to send the 12 warm-lead emails
(drafts ready in `notes/2026-09-14-warm-lead-emails.md`). **A live card has
still never completed a purchase** — 18 payment-link sessions, all unpaid.

Suite 650/651 throughout (`social-compose` selenium gap, pre-existing).

## MCP reachable from ChatGPT + claude.ai (9/14) — SHIPPED, live, verified

Neither chatbot could use `/mcp` at any price: ChatGPT mandates OAuth 2.1 + DCR
and rejects bearer tokens; claude.ai exposes only OAuth fields
(`anthropics/claude-ai-mcp#112`). Both DO support authless servers. Two phases,
both pushed and confirmed against production. Suite 648/649 (the one failure is
the pre-existing `social-compose` selenium gap).

- **Keyless tier** (`mcp-anon.js`, `08d09ebc`/`0f76b354`): credits-shaped facade
  injected through `buildMcpServer`'s existing `deps`, so no anonymous branch
  exists inside the MCP server. **2** free asks + **50** lookups per IP / 30
  days; **`ANON_MCP_GLOBAL_ASK_DAY=100`** is the real cost control and is
  deliberately NOT the website's 400 — the provider bill is unrecorded, so unit
  cost is unknown. `ANON_MCP_ASK_LIMIT=0` kills the tier. Fails CLOSED if Mongo
  is unreachable.
- **OAuth 2.1 + DCR** (`oauth-mcp.js`, `a0945e3a`/`e07c32d8`): PKCE S256 only,
  public clients, rotating refresh, opaque SHA-256-hashed tokens (chosen over
  JWT so revocation is immediate). Code redemption is one atomic
  `findOneAndDelete` — check-then-delete would let two redemptions of a stolen
  code both win. `client_id`/`redirect_uri` validated BEFORE any redirect, or
  the endpoint is an open redirector.
- **Consent screen is server-rendered with inline CSS/JS on purpose.**
  `login.html` loads `assets/app.js`, so adding a `?next=` there would have
  pulled the whole cache-stamp cascade into an OAuth change. No frontend asset
  was touched; no stamp bump was needed.
- **`bot-blocker.js` was the hidden ship-blocker, twice.** `DENY_PATTERNS` names
  `chatgpt-user` and `claude-user`, so every request this work exists to serve
  — including from a PAYING customer — was 403'd before reaching a route.
  `/mcp` and `/oauth/*` are now exempt (the OAuth register/token legs are
  back-channel calls with no browser headers). Tests pin both.

**Still owner-only / open:**
- `npm token revoke` — the token pasted in chat on 9/14 to publish
  `stockportfolio-mcp@0.3.0` is in that transcript and has NOT been rotated.
- MCP directory listings still unsubmitted; `mcpName` + `repository` fields are
  still absent from `mcp-server/package.json` (would need a 0.3.1), and
  `avisre/stockportfolio-mcp` does not exist.
- **`avisre/prod` is still PUBLIC** and still names the provider.
- Tier 2 LTD API access was built on 9/14 and **deliberately reverted** —
  tier 3 remains the only lifetime tier with API/MCP, as the listing sells it.
- **This file is 1,246 lines against CLAUDE.md's 160-line cap.** Not trimmed
  here because that is 1,000+ lines of the owner's own working memory to
  triage, not a mechanical edit.


## Partner acquisition system (9/13) — built, NOT pushed, NOT deployed

Public front door added on top of the existing (invite-only) customer-ambassador
affiliate infra. 30% commission, attribution, payouts, dashboards were already
live for ambassadors — this phase opens the same machinery to external finance
publishers/creators via self-service application. `node --test` 632/633 (the
one failure is the pre-existing unrelated `social-compose` selenium gap).

- **New:** `POST /api/partners/apply` (public, rate-limited, honeypot) creates
  a `User` (password: null) + `AffiliateProfile(kind:'partner', status:
  'pending_review')`. Reapplying on top of a `declined` profile is allowed in
  place (userId is unique on AffiliateProfile — a second doc was never
  possible, so this is how the decline email's "reapply in 6 months" is kept
  true).
- **New admin routes:** `GET/POST /api/admin/partners/pending|:id/approve|
  :id/decline` (same `x-admin-token` pattern as `/api/admin/affiliates/*`).
  Approve mints a `resetPasswordToken` (7-day) for a still-passwordless user
  and emails an activation link reusing the existing `/api/password/reset`
  flow — no new auth code.
- **Partner terms are a separate versioned document** (`PARTNER_TERMS_VERSION
  = 'partner-v1-2026-09-13'`, `frontend-v2/partner-terms.html`) because the
  ambassador terms literally say "does not recruit external affiliates."
  `/api/affiliate/accept` and `publicProfile()` now branch on `profile.kind`
  to check/stamp the right version — ambassador literals kept byte-identical
  so the existing pinned test (`affiliate-program.test.js:118`) still passes.
- **New pages:** `frontend-v2/partners.html` (public landing, indexable),
  `partners-apply.html` (application form), `partner-terms.html`,
  `admin-partners.html` (token-gated review UI). All extension-less-served by
  the existing `express.static({extensions:['html']})` — no new app.js routes
  needed for the static pages themselves.
- **Dashboard:** `backend/affiliate-dashboard.html` + `assets/affiliate.js`
  now brand/link dynamically by `kind` (one file, no fork), plus new
  promotional-materials and self-service payout-details sections. Cache
  stamp bumped `affiliate.css`/`affiliate.js` → `?v=20260913-partners`
  everywhere both are referenced (dashboard, `affiliate-terms.html`, new
  `partner-terms.html`).
- **4 new mailer.js templates:** `partnerApplicationReceivedEmail`,
  `partnerApplicationNotificationEmail`, `partnerApprovedEmail`,
  `partnerDeclinedEmail` — reuse the generic exported `sendMail()`, no new
  send-wrapper functions.

**Not done / deliberately deferred (MVP scope, called out in the plan, not
oversights):** no auto-approval rules (every application is manual), no
banner/screenshot assets (copy-only promo materials), no main-nav link (page
is reachable at `/partners`, footer-linkable later), no `partners@` inbox
(reuses `support@stockportfolio.pro`).

**Before this goes live:** needs `AFFILIATE_PROGRAM_ENABLED=true` and
`AFFILIATE_COOKIE_SECRET` set (same flags the existing ambassador program
already needs — if ambassadors work today, this needs nothing new env-wise).
Not yet pushed (no local `.git` — see CLAUDE.md) or manually walked end-to-end
against a real SMTP send; model-level logic (schema, kind-aware terms
versioning, reapply-after-decline) was verified against `mongodb-memory-
server` in a throwaway script, not the full HTTP layer.

**Note:** this file is far over the 160-line budget CLAUDE.md sets (pre-existing,
not from this session) — worth a dedicated trim pass before it grows further.

## Revenue-integrity fixes from the growth.md audit (9/12) — committed, NOT pushed

Six independent fixes, all `node --test` verified (628/629 — the one failure is
the pre-existing, unrelated `social-compose` selenium gap, proven pre-existing
by stashing and re-running on clean HEAD), zero regressions.
Triggered by `growth.md`: 37 checkout sessions created all-time, 0 paid.

**A verification pass on 9/13 re-confirmed all six bugs empirically and found
the first pass had been under-inclusive in three sibling paths — now closed.
See "gap closures" at the end of this entry.**

1. **Retired plan ids (`pro`/`power`/`power-monthly`) 500'd or mis-sold.**
   `remapRetiredPlanId()`/`RETIRED_PLAN_ID_REMAP` map them to `pro-annual` at
   every checkout entry point (email login-resume gate, `/api/auth/social`
   resume gate, `POST /api/checkout`), plus `register.html` and the in-app
   "Upgrade to Pro" CTAs, which previously linked `?plan=pro` and silently
   charged Monthly via the `!PLANS[plan]` fallback. **Different bug from the
   already-tracked Dev-price gate below** — this one has no live price by
   design, not a missing env var. Cache stamp bumped `20260907-aipaper3` →
   `20260912-planfix1` (touched `assets/app.js`).
2. **Stripe webhook swallowed processing failures into a 200.** All **8**
   branch-level catches (`checkout.session.completed`, both
   `async_payment_*`, `invoice.paid`, refund, dispute, subscription
   updated/deleted) now `return res.status(500)` on a real error instead of
   `console.error`-and-200, so Stripe redelivers instead of considering a
   failed, possibly-paid event permanently handled. The signature-failure
   catch deliberately stays 400 — an unverifiable signature is not transient.
3. **CSP blocked the 3-D Secure challenge frame.** Added
   `hooks.stripe.com` to `frameSrc`/`formAction` — the account is GB, so SCA
   applies to most cards.
4. **AppSumo `migrate` webhook silently downgraded licence tier**, and
   `upgrade`/`downgrade` could `findOne({licenseKey: undefined})` → first
   doc in the collection → wrong user re-granted. Both fixed; reproduces the
   `khaledaziz130@gmail.com` tier mismatch found in `growth.md` §10.
5. **AppSumo refund never cleared `appsumoTier`/`appsumoRedeemedAt`** — a
   refunded lifetime buyer kept the full credit wallet and permanent
   API/MCP access. `revokeAppSumoAccess` now clears both (mirrors
   `revokeDealMirrorAccess`) and guards an active Stripe subscriber;
   `hasApiAccess` now checks `subscription.status !== 'cancelled'`.
6. **GA4 never received `sign_up`/`begin_checkout`/`purchase`** — consent
   was never threaded to those events, and a server-originated one (the
   Stripe webhook) has no request to source a clientId from anyway. Added
   `User.analyticsConsent` (+ `PendingSignup.consent` for paid-first, no
   live request exists at materialization), and `logFunnelEvent` now falls
   back to the persisted value when the caller supplied no consent signal
   at all. Still a no-op until `GA4_MP_ENABLED=true` on Render.

**Still open, unchanged by this pass:** the owner's live purchase+refund test
(never done, ever — the one thing that actually proves a card can be charged),
secret rotation status, `STRIPE_PRICE_ID_CREDITS_TOPUP` on Render, the 4
AppSumo tier-1 refunds' root cause (asked, not yet confirmed by AppSumo).

**Gap closures (9/13 verification pass).** The 9/12 pass fixed the right bugs
but missed three sibling paths carrying the same defects. All three were
latent — none was reachable by a current user — and all three are now closed
and covered by `test/checkout-resilience.test.js` (which also gives bugs 1 and
2 their first test coverage; the 9/12 pass added tests only for bugs 4-6):
- `POST /api/checkout` **defaulted to `'pro'`** — a retired id — so any
  plan-less call 500'd. Now `remapRetiredPlanId(normalizePlanSelection(plan
  || PRO_ANNUAL_PLAN_ID))`.
- The `/api/auth/social` login-resume gate passed the raw stored planId,
  unlike the email gate that was fixed. (Checked live: all 6 pending users on
  a retired plan are email-auth, so nobody was actually hitting it.)
- `checkout.session.async_payment_succeeded` still swallowed into a 200 —
  and it calls `handleChinaAnnualPassPaid`, i.e. it grants entitlement after
  payment. Latent only because the Alipay/WeChat path is disabled.

**Known, deliberately left:** the nested `Stripe initial invoice lookup failed`
catch inside `checkout.session.completed` is still best-effort (it only gates
`initialPaymentAt`/refund-window recording, and `invoice.paid` records the same
thing as a second chance). CSP also still omits `*.js.stripe.com`, which Stripe
documents for `frame-src`/`script-src` — performance-related, not a blocker.

**This file is 1,100+ lines against its own 160-line budget — flagged to the
owner, not trimmed here** (real judgment calls about what's still load-bearing;
out of scope for this pass).

## Deploy + market round (9/12) — Phases 2+3 committed, NOT pushed, NOT deployed

Branch **`api-mcp-dev-tier`**, cut fresh from `origin/main` (see below) with two
cherry-picks on top: `2ad99eae` (Dev plan) and the Phase 2+3 commit. Backend
604/605 — only the pre-existing selenium `social-compose` failure. mcp-server
11/11, `npm pack` = 3 files (README + dist/server.js + package.json), leak gate
clean. Nothing is live.

**`funds/bond-credit-quality` is a dead end — do not merge it.** It is based on
an old main: `origin/main` is **28 commits ahead** of it and already contains
`7c3de09f` (progressive dossiers) plus newer work (`frontend-v2/1668f45a…txt`,
`discovered-compares.test.js`, the bot-blocker fix). Merging the old branch
would drag main backwards; branch off `origin/main` and cherry-pick instead.
The one conflict was a line-count NOTE in this file.

**Verified, not assumed — the deploy order gate is real.** With no
`STRIPE_PRICE_ID_DEV` in Render, `resolveStripeCheckoutPlan` falls back to the
unconfigured plan config and the checkout route throws
`500 "<plan> Stripe price is not configured"` ([app.js:4539](backend/app.js#L4539)).
So the **owner's Stripe step must land before the push**, or the Dev buy button
500s on the live site. The price is $19.99/mo on the existing product
`stockportfolio.pro`; `scripts/create-dev-stripe-price.sh` creates it and prints
the `gh workflow run set-render-env.yml` line (the owner types the value).

**Phase 2 (npm)** — `mcp-server/src/bridge.js` is a real stdio↔Streamable-HTTP
bridge to `POST /mcp`; the published bundle carries no backend code. Default URL
is the **www** host on purpose: the apex answers 307 → www and `fetch` drops
`Authorization` across a host-changing redirect (measured against a local 307 →
`{"sawAuth":null}`). `prepack` = esbuild bundle + `no-leak-check.js`, so publish
fails closed on any provider-adjacent string. npm name `stockportfolio-mcp` is
free (E404).

**Phase 3 (embeds)** — `/embed/earnings-quality` and `/embed/filing-timeline`
via [embed-widgets.js](backend/embed-widgets.js) + [embed-config.js](backend/embed-config.js)
(SSR, one `<iframe>`, no key, `frame-ancestors *`, `X-Robots-Tag: noindex`,
`s-maxage=900`). All CSS inline and **no `/assets/` reference**, so the widgets
stay out of the `?v=` cache-stamp cascade — `test/embed-widgets.test.js` pins
that. The tool pages and the renderer share `embed-config`, and a test asserts
the published snippet's `src` resolves on the mounted route.

**Stripe step DONE (9/12)** — the blocker is cleared, no longer owner-only.
Live price `price_1UEZfSAUeKapY1OP2RG9UZVb` created on product
`prod_UC7quLwRatRazA` (`stockportfolio.pro`), verified active / 1999 usd / month
/ nickname `Dev — API/MCP` before anything was pointed at it.
`STRIPE_PRICE_ID_DEV` set on Render (HTTP 200, 30 chars). Two bugs in
`create-dev-stripe-price.sh` had to be fixed first — **it could not have run on
this machine as written**: `mapfile` and `${var^^}` are bash 4+, and stock macOS
bash is 3.2.57 (both replaced; read loops + `tr a-z A-Z`). Worse, `jsonlines`
printed a blank line for an empty match, so the clash check's `-s` test was
**always true** and the script reported a phantom "another active price already
uses this amount" on every clean run — it now prints nothing for an empty list.
Verified by running a `/tmp` copy against the live API with the create call
neutralized before running it for real. The only Stripe key on this machine is
the **live** one (`backend/.env`), so there was no test-mode rehearsal path: no
`sk_test_` key exists locally.

**LIVE (9/12)** — pushed and deployed; `origin/main` is `9cea8bab`. Verified
against the real host, not the repo: `/api` 200 (18.5 kB, quotes $19.99/200 and
carries the embeds section); both `/embed/*` routes 200 with `frame-ancestors *`
+ `X-Robots-Tag: noindex` + `s-maxage=900` and **zero** `/assets/` refs;
`/tools/earnings-quality` publishes the iframe snippet while `/tools/dilution`
stays panel-free; `POST /mcp` still 401s.

**Deploys are half-broken — read this before the next push.** `deploy-render.yml`
fails with `404 {"message":"not found: https://api.github.com/repositories/1105594471"}`
— that id **is** `avisre/prod` (verified: unchanged, my push registered), so the
GitHub side is fine and Render's GitHub App can no longer resolve this repo. It
is intermittent, not new: the identical 404 hit at 01:03 and deploys at 07:35,
13:46 and 14:38 then succeeded. A manual retry at 19:15 also 404'd, yet the code
is live — so it deployed by some other path (Render dashboard, or Render's own
on-push deploy). There is no workaround in-repo: no deploy hook secret exists
(only `RENDER_API_KEY`, `ALPHA_VANTAGE_API_KEY`), the workflow sends only
`{"clearCache":"do_not_clear"}`, and `repos/avisre/prod/hooks` is still empty.
When the workflow's trigger 404s, the code may still have shipped — **check the
live site, not the run's conclusion.** Owner fix: reconnect the repo in Render
(service `srv-d4kc6schg0os73al6t10`, Settings → Build & Deploy → Repository).

**FIXED (9/12): the `/api` page pointed at an npm package that does not exist.**
It handed visitors `"command": "npx", "args": ["-y", "stockportfolio-mcp"]` and
promised the seven tools appear — `registry.npmjs.org/stockportfolio-mcp` is
**404**. Root finding: the npm package was never the gate. The hosted
`POST /mcp` is reachable from every major client with no install at all, so
`renderApiLanding` now ships three keyless-install configs instead — Cursor's
native `url` + `headers`, Claude Desktop via the `mcp-remote` bridge (its
config is stdio-only; a `url` entry is silently dropped and takes its
neighbours with it), and the one-line `claude mcp add --transport http` for
Claude Code. `stockportfolio-mcp` is gone from the live page until published;
`mcp-server/README.md` keeps its npx line, which is true once the package
ships. `dev-plan.test.js` pins the hosted URL and asserts the npm name is
**absent** — flip that one assertion back after `npm publish`.

**Still unproven: the purchase path.** No public endpoint exposes the resolved
price, `POST /api/checkout` is behind `authMiddleware` (401 before price
resolution), and the only Stripe key here is live — so a test-mode rehearsal is
impossible (no `sk_test_` key exists locally). Price resolution is verified by
construction (env var written to the right service at 18:59, price active /
1999 usd / month / exact product name / unique in the account), but nobody has
completed a Dev checkout. Owner can confirm in 30s: `/api` → Dev buy button →
Stripe shows $19.99/month, then abandon before paying.

**Next**: `npm publish` (fixes the live page) → directory listings (slug is
`io.github.avisre/stockportfolio-mcp`, confirmed from the remote + `gh auth
status`) → customer announcement copy (Step 6, not written yet).

## Viral growth plan for the MCP + API — Phase 1 shipped (9/11, committed as 2ad99eae)

Full plan: `~/.claude/plans/i-wan-to-advertsie-snappy-llama.md`. Owner decisions
locked: cheap self-serve Dev plan (not free), npm publish with a CLOSED-SOURCE
package, $0 budget, built-in virality. 5 phases; this is Phase 1 (the
conversion point every later loop feeds).

**Phase 1 done — the Dev plan exists and `/api` can sell it:**
- **Dev tier**: planId `dev`, **$19.99/mo, 200 credits**, no trial, on its **own
  new Stripe price** (owner creates it on product `stockportfolio.pro`). It was
  briefly $24.99/250 sharing Monthly's price id under a no-new-Stripe-objects
  constraint; the owner lifted that for this rung on 9/11 ("separate it") and it
  returned to the growth plan's price. A distinct amount also keeps
  `resolveStripeCheckoutPlan`'s amount+product matcher unambiguous — a second
  $24.99/mo price on the same product would have matched twice and refused.
- **Disambiguation kept as belt-and-braces.** While the ids were shared,
  `getPlanConfigByPriceId` (first-match-wins, Dev's branch above Monthly's) would
  have re-resolved every Monthly renewal as Dev — and `userTier('dev')` is
  `'free'`, so paying Monthly customers would silently lose the web app. Both
  fixes stay: (a) `ambiguousStripePriceIds()` returns null for any id claimed by
  two distinct plans, and (b) `syncSubscriptionFromStripe` consults
  `metadata.planId` **before** the price id, with a round-trip check so an
  unknown value can't fall into `getPlanConfig`'s Monthly default. Nothing
  collides today; a mis-set env var is all it takes.
- **Entitlement stays narrow**: `userTier()` returns `'free'` for an active
  `dev` plan; `hasApiAccess()` adds `'dev'`. Dossier/Monitor already out of reach.
- **Priced leak closed**: Ask (`/api/ai/chat`) has NO tier gate, only credit
  metering, so Dev's flat 200 credits would have bought 100 web asks against
  Monthly's 50 — for $5 less a month. Refused with code
  `API_PLAN_NO_WEB_ASK`, before the wallet is consulted.
- **Credit repricing (same day)**: `mcp_ask` 2→**4**, `api_ask` 4→**8** (REST
  stays exactly 2x MCP); lookups unchanged at 1/2. Anchor is 2x frontier
  ($10/$50 per M tokens) applied to the **measured `chat`-shaped call at 13,820
  tokens**, not the 10,779 all-purposes blend credits.js used before — that
  blend is dragged down by shorter `summary` calls. The published AppSumo cost
  table (`docs/growth/appsumo-listing-v6.md` + `.txt`) moved with it;
  `credit-meter-truth.test.js` pins that sync. **Unaffected by the plan reprice**
  — these are frontier-anchored, not plan-anchored.
- **Split now recorded**: `ollama-usage-tracker.js` `publicEvent()` carries
  `promptTokens`/`completionTokens`. It used to read them in `finish()` and
  discard them, which made the anchor's 85/15 assumption unmeasurable in
  principle. After a few weeks, replace the assumption with data.
- **`/api` landing page**: `renderApiLanding()` in `seo-pages.js` — real
  captured NVDA payload (not a mock-up), 7-tool table, copy-paste Claude
  Desktop/Cursor `mcpServers` config, $19.99 CTA with per-call costs. Routed in
  app.js, in the sitemap core routes, exempted in `bot-blocker.js` (`/^\/api$/`).
- **register.html**: `dev` in PLANS + PLAN_VALUE + DIRECT_PLANS (so `?plan=dev`
  renders a clean single-plan checkout instead of falling back to Monthly).
  Deliberately NOT a picker card — it is a developer direct-link plan.
- Tests: `test/dev-plan.test.js`; `api-access-gating.test.js` and
  `public-api.test.js` amended. Suite green except the pre-existing
  `selenium-webdriver` gap in `scripts/social-compose.js`, unrelated. No
  `assets/*.js` or `system.css` edit → **no cache-stamp bump**.
- **Owner-only, still to do**: create the NEW **$19.99/mo** recurring Stripe
  price on product `stockportfolio.pro` and set `STRIPE_PRICE_ID_DEV` to it.
  Unset is survivable (checkout resolves by amount+product) but the amount must
  stay unique in the account. Nothing is deployed.
- **Found, NOT fixed**: `frontend-v2/terms.html` (~line 66) enumerates "current
  pricing" and does not list the Dev plan. Legal copy was deliberately left
  untouched (plan Phase 1, item 5) — the owner decides that wording.

**Phase 2 next** (npm closed-source publish + directory listings), then embeds,
referral credits, and API SEO pages. Hard gate in the plan: phases 3-5 wait
until the Dev tier is live; a Wave-1 outreach buyer committing preempts all.

Note: CLAUDE.md's "there is no local `.git`" line is now stale — this repo has
a working `.git` and `gh` is authenticated as `avisre` (per `dev-doctor.sh`).
Also HANDOFF is at 916 lines, well over its 160-line budget.

## Progressive dossier serving (9/11, on funds/bond-credit-quality, NOT yet committed/deployed)

Dossier builds now publish a "partial" (every data section, narrative empty)
to `company_dossiers` right after gathering (~23s of a ~99s build), before
`onStage('writing')`; the finished payload overwrites it. `peekDossier` serves
fresh partials to polls (payload carries `partial: true`; frontend renders it,
shows a note, keeps polling); `cachedDossier` skips partials (lease/build
re-checks must not treat a draft as done); partials older than
`DOSSIER_PARTIAL_STALE_MS` (10 min, builder died mid-write) are a miss so a
non-poll request rebuilds. app.js poll path peeks BEFORE returning 202 (was:
inflight check first, which hid the partial from same-instance pollers).
Frontend stamp `?v=20260911-progserve1` in dossier.html. Tests:
`test/dossier-progressive.test.js` + read paths verified against real Mongo
with a synthetic WIT partial (served/skipped/stale-miss all correct).
Measured on a forced BABA rebuild: content at 23s, full at 99s (was 99s blind).

## ADR dossier fix + credit-charge fix pushed (9/11, commit fc1061bd)

NTES dossier failed + customer charged 10 credits. Both fixed and pushed to
`funds/bond-credit-quality` (NOT deployed to Render yet — needs a deploy to
go live). Full plan in `~/.claude/plans/humming-conjuring-harbor.md`.

- **ADRs work end to end**: gate removed in `fundamentals-fetch.js`
  (currency read from Yahoo stamp BEFORE backfill), `sec-source.js` unit
  selection pinned to reporting currency (was mixing USD convenience
  translations into CNY rows), `fx-conversion.js` runs at cache write with a
  quote-anchored EPS guard (VALE stamps BRL but values are USD — converting
  understated revenue 5.6x), per-share math on ADS basis
  (`valuation-dcf.js`, `insights.js`), 20-F/40-F as annual forms everywhere
  (watchdog, monitors, keypoints, filing-diff, filing-fetcher, ai-chat),
  20-F item map 3.D/4/5/11 in `filing-sections.js` (minChars beats
  self-citation matches in risk factors).
- **Credits charged only after successful build** (`app.js` dossier route):
  `costKey`/`planId` hoisted above the build IIFE (block-scoped there, would
  have thrown → every build 404), reservation map
  `_dossierReserved` prevents overdraft across concurrent tabs, release
  strictly after spend.
- EPS basis gotcha: filed `dilutedEPS` is ALREADY per-ADS; ordinary-share
  count is for statement-internal series only. Yahoo `SharesOutstanding` is
  ADS-basis (= marketCap÷price).
- `mergeWithCached` in fundamentals-fetch preserves nightly-only keys
  (dividends) — an on-demand rebuild no longer clobbers them.
- Measured: NTES 18 annual yrs, rev $15.72B, DCF $115.63, P/E band sane;
  15-ADR sweep OK (9 of 16 fall back to Yahoo's 4 yrs — IFRS filers lack
  us-gaap XBRL tags; ifrs-full taxonomy support = deferred follow-up).
- Tests 577/578 (pre-existing selenium failure in social-compose). New
  `test/dossier-credits.test.js` (6 structural tests).
- **Open**: refund for wrongly-charged users still deferred by owner
  (`credits.grant()` is the idempotent tool; affected rows = dossier spends
  with no matching company_dossiers doc). Full end-to-end NTES dossier build
  on prod never run (user interrupted — costs real AI credits).
- Gotcha hit: an AAPL-only `scripts/refresh-fundamentals.js` run rewrites
  `top-100-fundamentals-index.json` with count=1 — always restore via
  `git checkout` if a single-symbol run is used for testing.

## Public API + hosted MCP endpoint shipped, NOT deployed (9/11)

Owner overrode `next-feature-ranking.md`'s "do not build" (3-buyer/rights-
verification gate) and explicitly chose to include `sp_fund` despite the
Yahoo redistribution-rights conflict in `corpus-license-terms.md` — both
called out and accepted before building, not missed.

**New**: `backend/api-keys.js` (hashed `sp_live_...` keys, `api_keys`
collection), `backend/public-api.js` (`/api/v1/*`: financials/filing/
compare/screen/fund/ask + health), `backend/mcp-endpoint.js` (`/mcp`,
Streamable HTTP, stateless — SDK confirmed v1.30.0 by installing it, not
guessed), `backend/api-response.js` (shared envelope/citation), self-serve
`/api/account/api-keys` CRUD behind existing `authMiddleware`. Docs:
`backend/public-api.md`.

**The identity bridge `credits.js`'s header called out as missing is now
closed**: a new `apiKeyAuth` middleware in `app.js` resolves a key to its
owner and populates `req.userId/user/subscription/tier` exactly like
`authMiddleware` does — so `effectiveAskLimit()` and every existing
`credits.check/spend` call site work unmodified, and an API/MCP caller
spends from the SAME wallet as their web account.

**Pricing (revised same session, per owner direction) and access, both now
live-gated, not just at key issuance:**
- `credits.js` COST: `mcp_lookup: 1`, `mcp_ask: 2`, `api_lookup: 2`,
  `api_ask: 4` — REST API is exactly 2x MCP by owner instruction, not an
  independent guess. `mcp_ask` (the only cost with real inference behind
  it — lookups are cache/SEC/Yahoo, zero LLM) is anchored to measured
  frontier pricing: Claude Fable 5.1 AND GPT-6 Astra both $10/$50 per M
  input/output tokens as of 2026-09 (cross-checked via the claude-api skill
  and a live web search — they independently match), and this product's
  measured ~10,779 tokens/call blended average prices out to ≈1.7 credits
  at the existing $0.10/credit rate. The 85/15 input/output split used to
  get there is an assumption, not a measurement — `ollama-usage-tracker.js`
  only ever stored the combined total (a gap already flagged below), so the
  split itself still isn't recoverable from stored data.
- Access is now `app.js`'s new `hasApiAccess`/`apiAccessGate`: **Power/Desk
  or AppSumo/DealMirror tier 3 only** — deliberately narrower than Monitor's
  `isLifetimeBuyer()` (any LTD tier). DealMirror tier 3 was included by
  inference (owner said "AppSumo" specifically; the codebase treats AppSumo
  and DealMirror as parallel everywhere else in `credits.js`/`tier-limits.js`)
  — flag to the owner if that wasn't intended. Checked live on every call
  (key creation AND each API/MCP request), so a downgrade takes effect
  immediately; listing/revoking existing keys stays ungated so a downgraded
  account can still manage what it already has. `/api/credits` now also
  returns `hasApiAccess` so `profile.js`'s price line can gate on it, same
  as the existing `hasMonitor`/`aiPaperBeta` rows.
- New `backend/test/api-access-gating.test.js` pins both the 2x pricing
  relationship and the gate's exact tier list (source-text asserted, same
  pattern as `ai-paper-gating.test.js`) so either can't silently drift.

**Verified live against a real local boot** (`scripts/dev-local.js`), not
just unit tests: logged in as the seeded dev user, created a real key,
hit `/api/v1/financials/AAPL` (real SEC data back), drove `/mcp` with the
actual MCP SDK client (`tools/list` + `sp_financials` MSFT), then confirmed
`/api/credits` showed BOTH spends (`api:earnings-quality` AAPL,
`mcp:earnings-quality` MSFT) on the one web account's ledger — proves the
bridge, not just that routes return 200.

The existing stdio `mcp-server/` package (local dev / Claude Desktop) is
untouched and not the public launch surface.

**Regression caught and fixed**: adding the `COST` keys tripped
`profile-consolidation.test.js`'s "price list names every billable action"
guard — correctly, since a user could otherwise be surprised by an
undisclosed charge. `profile.js`'s price list now shows all four
(`MCP lookup/ask`, `API lookup/ask`), gated behind `hasApiAccess` so it's
invisible to accounts that can't reach the feature. Two `frontend-v2/
assets/*.js` edits this session → **two** stamp bumps on `profile.js`'s own
independent stamp (separate from the shared app.js/system.css one):
`20260908-cmpcredit1` → `20260911-apicost1` → `20260911-apicost2`, kept in
sync in `profile.html` and the pin in `ask-threads.test.js:314`. Full suite:
569/570 (`social-compose` pre-existing, missing `selenium-webdriver`,
unrelated). Both the tier gate (blocks a plain-Pro seeded account, opens
after promoting it to Desk in Mongo) and the 2x pricing (1 vs 2 credits for
the same lookup on MCP vs REST) were verified live against
`scripts/dev-local.js`, not just asserted in tests.

**Owner action before this reaches real external users**: nothing code-side
is blocking — it's live on a local boot only. Before a real launch:
(1) decide whether `sp_fund` really ships given the rights exposure just
waived, not just accepted in the abstract; (2) `avisre/prod` is still
flagged public elsewhere in this file — a public API surface makes that
more consequential, not less; (3) confirm DealMirror tier 3 belongs in the
access gate alongside AppSumo tier 3 (inferred, not explicitly stated);
(4) `PUBLIC_API_RATE_LIMIT` (default 60/min) is still a first guess, not
measured against real external traffic — the credit costs, at least, are
now anchored to something real.

**Follow-on, same session: public page reconciled + a real key-management UI
built (owner asked "where will pricing/docs live" — the honest answer was
"nowhere public yet").**
- Found `/licensing` (`backend/seo-pages.js` `renderLicensing()`) already
  live-advertised MCP access under a DIFFERENT, stale model: per-seat,
  bundled with the $5–15K/yr bulk corpus licence, sold via an email quote,
  "monthly quota" (the old stdio server's local `quota.json`, not this
  session's credit ledger). Owner chose **replace**, not run both. Rewrote
  the section (new `#mcp-api` block) to state the real system: self-serve,
  Power/Desk/AppSumo-DealMirror-tier-3 only, credit-metered 1/2/2/4, no
  quote needed — kept the bulk-corpus pricing block untouched since that
  product is real and unrelated. No test pinned the old copy, so this was a
  pure content swap, no test churn.
- Backend key routes had **no UI** — a qualifying customer would have had
  to `curl` `/api/account/api-keys` themselves. Owner chose to build it now.
  New "Developer access" `<details class="psec">` section on `profile.html`
  (after Usage, ships `hidden`), `mountApiKeys()` in `profile.js` (generate
  → show raw key once + copy button, list by prefix/label/last-used, revoke
  with a confirm), gated on the new `hasApiAccess` field `/api/credits` now
  returns — same reveal pattern as `admin-section`. Third `profile.js` edit
  this session → third stamp bump, `20260911-apicost2` → `20260911-apikeyui1`,
  synced in `profile.html` + `ask-threads.test.js:314`. Full suite still
  569/570.
- **Verified in an actual browser, not just curl** — real headless Chrome
  driven over raw CDP (Node's built-in `WebSocket`, no Playwright/Puppeteer
  in this repo): logged in via a same-origin `fetch` (sets the real
  `sp_auth` cookie), navigated to `/profile.html`, and drove the full
  generate → list → revoke cycle through actual DOM clicks — new key
  appeared with its live prefix, revoke fired the confirm dialog and
  flipped the row to "revoked". Also confirmed the section is genuinely
  `hidden` (not just failing to load) for a demoted-back-to-Pro account.
  **Found and worked around, but didn't fix**: this machine's Chrome
  152 still sends "HeadlessChrome" in `navigator.userAgent` even under
  `--headless=new`, which `bot-blocker.js` correctly 403s (it's doing its
  job) — the verification run used `BOT_BLOCK_ENABLED=false` on
  `dev-local.js` only, nothing prod-facing touched.

## The 403 turned into an inbound licensing channel (9/11, after the block)

The block below creates the channel every earlier licensing idea lacked: a
refused crawler's operator reads 403s, so the refusal now carries the offer.
Three surfaces a blocked agent can still fetch were all misconfigured for it —
each pointed at the owner's personal Gmail, and `llms.txt` (the file AI
companies read deliberately) said nothing about licensing at all.

**Shipped:** `bot-blocker.js` FORBIDDEN_BODY now names `support@stockportfolio.pro`
+ the `/licensing` URL; `/licensing` added to `EXEMPT_PATH_PATTERNS` (a denial
pointing at a blocked page is useless) with a test asserting it; `robots.txt`
contact + a "denied ≠ unavailable" note; licensing sections in `llms.txt` and
`llms-full.txt`; new `seoPages.renderLicensing()` + `/licensing` route + sitemap
`coreRoutes`. Full suite 563/564 — the one failure (`social-compose.test.js`,
missing `selenium-webdriver`) is pre-existing and unrelated.

**Outreach (now sent — see the doc's send tables for the live record):**
`docs/growth/mcp-api-lab-outreach.md` — long-form MCP/API pitch + 3-wave send
sequence. **10 sends total, all 2026-09-11, all SMTP-accepted, zero replies**
(replies land in support@). All from `support@` on the owner-accepted risk
recorded in the doc.

- 4 microcap IR firms + Mistral `contact@mistral.ai`
- Chinese labs, bilingual EN+中文: Zhipu `service@zhipuai.cn` (商务合作),
  Moonshot `growth@moonshot.cn`, MiniMax `api@minimaxi.com` (商务合作),
  Alibaba Qwen `qianwen_opensource@alibabacloud.com` (no BD intake exists — the
  QwenLM org address is the only route in)
- Perplexity `publishers@perplexity.ai` — Western-lab batch, carries the
  owner-directed **quiet-door acquisition signal**

**Form-only, owner action** (no email exists anywhere): OpenAI Data Partnerships,
Microsoft PCM, 01.AI (Feishu 生态合作), Baidu (ERNIE enterprise). **No intake at
all** — not form-only, genuinely no door: DeepSeek, xAI, Anthropic, Meta, Google.
**Never send the quiet door to Microsoft** — their published policy refuses
unsolicited proposals, and the hint would risk the legitimate licensing
submission. Of the seven Western labs only Perplexity has a channel that can
carry the signal; the rest have no corp-dev route (those deals move via bankers
and warm intros). Full reasoning + per-lab field mappings in the doc.

Two constraints found while writing it:
(1) `sp_fund` is Yahoo-derived (`asset-profile.js:6`), so the sellable surface is
SEC-only — selling the full MCP contradicts `corpus-license-terms.md`;
(2) `next-feature-ranking.md` already ruled MCP/API "do not build now" pending
**three buyers committing to a price**, so Wave 1 is a demand test, not a build.
`mcp-directory-listings.md` already has finished registry copy — submit, don't rewrite.

NOTE: this file is 1,000+ lines against CLAUDE.md's 160-line cap. Needs a trim pass.

## Bot-blocker re-deployed after a Render bandwidth alert (9/11)

Render emailed 9/10: Hobby-plan workspace (5GB/mo bandwidth) at 70%+ usage 10
days into the month. Root cause matches the 9/5 analysis below almost
exactly — 68% of traffic is bots, Meta's AI crawler alone was 53% of ALL
traffic, and the fix built that day was reverted before shipping. The
bandwidth cost that made the 9/5 revert decision uncertain ("never measured")
is now measured and is the new evidence to act on.

**Re-implemented and shipped**, per owner decision to accept the same
tradeoffs as 9/5 (social-preview cards break; the small chatgpt.com/
copilot.microsoft.com human referral trickle stops):
- `backend/bot-blocker.js` (new) — 4-layer defense: UA denylist, IP
  verification (reverse+forward DNS) for anything claiming Googlebot/Bingbot,
  browser-header consistency check, per-IP nav rate limit. Fails open on an
  unseen IP; a DNS failure never becomes "impostor". `stats()` exposed at
  `GET /api/admin/bot-blocker/stats`.
- `frontend/robots.txt` rewritten: default `Disallow: /`, explicit `Allow: /`
  only for Googlebot/Googlebot-Image/Google-InspectionTool/Storebot-Google/
  Bingbot/BingPreview. `Google-Extended` gets its own explicit refusal.
- Mounted in `app.js` right after `compression()`, ahead of every rate
  limiter, `ssrCacheMw`, and `express.static`. Reuses the existing
  `isRawBodyWebhookPath` helper (passed in, not re-derived) so `/stripe/
  webhook` and `/appsumo/webhook` can never drift out of sync with the
  exemption list — the spec's own "most dangerous edge."
- Tests: `backend/test/bot-blocker.test.js` (new, 13 tests, mocks
  `dns.promises` via `node:test`'s built-in mock) and
  `backend/test/robots-policy.test.js` (new, 7 tests — the load-bearing one
  asserts robots.txt's Allow-listed agents exactly match
  `bot-blocker.js`'s `ALLOWED_UAS`, so the two files can't silently drift).
- Env switches documented in `backend/prod.env.example`:
  `BOT_BLOCK_ENABLED` (kill switch), `BOT_BLOCK_DRY_RUN` (canary — log/count
  without blocking), `BOT_BLOCK_BYPASS_TOKEN`, `BOT_BLOCK_NAV_MAX`.

**Owner action before this does anything in prod**: set
`BOT_BLOCK_DRY_RUN=true` on Render via `gh workflow run set-render-env.yml
-f key=BOT_BLOCK_DRY_RUN -f value=true` BEFORE this merges, so the first
deploy ships in canary mode. After ~24h, check `stats()` (impostor count
near 0, forged-browser/rate-limit counts near 0, verified count growing) and
Search Console/Bing Webmaster crawl stats haven't dropped, then flip
`BOT_BLOCK_DRY_RUN=false` via the same workflow. Real success signal: the
Render billing dashboard trending down over the following days
(https://dashboard.render.com/w/tea-cspuc9pu0jms7384ahsg/billing).

## Compare pages: "Listed YYYY" cells + 52-week fallback — 9/8 ship

Owner report ("free version shows em-dash in the performance area", LB-vs-MUR):
LB listed 2024, so its 3/5/10-year return cells rendered bare `—` — honest but
reads as broken. `seo-extra.js`:
- `compareData` now computes `listedA/listedB` (first monthly-close year) and
  `fmtRet()`; uncovered return windows render `Listed 2024` instead of `—`, on
  BOTH the free and pro pages (shared via the return object + pro destructure).
- New `fiftyTwoWeekRange(data)`: quote `52WeekHigh/Low` wins; when missing,
  fall back to the last 12 unadjusted monthly bars' `2. high`/`3. low` (real
  prices, monthly granularity, <12 months = no fabricated range). Belt-and-
  suspenders: a 9/8 census via the app's own `loadFundamentals` found ZERO
  renderable (screen-index) tickers missing the quote — an earlier "2,023
  missing" count was my own filename-mapping artifact (`symbolToFile` maps
  `[^A-Z0-9]`→`_`, not dot→underscore). Dead tickers already 302 at
  `metricsFor`, so no route guard was needed.
- Pinned in `seo-research.test.js`: "Listed YYYY" test (3 pins free + 3 pro)
  and `fiftyTwoWeekRange` unit test (quote wins / monthly fallback / <12mo
  nulls). Suite: seo-research 25/25, then full suite.

## Dossier Analyst cards: true-scale bars + dead-space kill — DEPLOYED (9/8)

Owner reported (Agilent dossier, Analyst mode): flat/compressed bars in
"Visual evidence" + dead space in both decision-grid cards. Fix is
frontend-only, dossier page only:

- `frontend-v2/assets/dossier.js` — `miniBars()` floor 8→3 (true scale);
  new `trendChangeLine()` (first→latest: `+N.N pts` for pct metrics,
  `×N.N total`/`±N% total` for dollars, '' when endpoints missing);
  `decisionTrends()` renders a `2019→2026 · <change>` sub-line under each
  row label. Rows: Revenue / opMarginPct / fcf / roicPct.
- `frontend-v2/dossier.html` — v3 CSS block: grid sections are flex
  columns; `.dos-trends { flex:1; align-content:space-evenly }`; rows
  `126px minmax(110px,1fr) 86px`, 56px `.dos-mini-bars`;
  `.dos-decision-copy { flex:1; justify-content:space-evenly }`;
  `.dos-key-strip { margin-top:auto }` (tiles bottom-anchored). ≤820px
  stacks naturally; ≤520px bars 40px. Stamp →
  `assets/dossier.js?v=20260908-dostrend1` (dossier.html only; the shared
  `20260907-aipaper3` app.js/system.css stamp is pinned by
  profile-consolidation and untouched).
- Verified via `/tmp/dosstub/server.js` stub (port 5077, serves
  frontend-v2 + Agilent fixture + injects `sp_dossier_mode_v1=analyst`):
  desktop 1440px + mobile 400px screenshots, DOM has 4 dos-trend-rows with
  change sub-lines and no empty-state string. NOTE: the API's `fy` values
  are 4-digit year strings (`fiscalDateEnding.slice(0,4)`,
  dossier-analysis.js:196) — a `FY19`-style fixture makes
  `financialReadings` print "NaN% a year" (`Number('FY19')` is NaN);
  fixture must use `2019` etc. 400px headless window clips the page edge
  page-wide (nav included) — pre-existing headless quirk, not from this
  change. Deployed 9/8: commit 8cafb07 via the flip-public → push → workflow
  success → flip-private ritual; live HTML serves ?v=20260908-dostrend1 and the
  bundle contains trendChangeLine. No tests pin dossier.js.

## Compare pro page: collapsible metric groups — DEPLOYED (9/8, commit `2d197d3b`)

Follow-up to the probe fix below. `renderComparePagePro` now renders one
`<tbody class="cmp-sec">` per group (7 groups; first "Size and latest FY"
fully open, the rest collapsed with ONE teaser row visible — `cmp-prev` —
and the remaining rows hidden). Group rows are click/Enter toggles
(`role=button`, `aria-expanded`); chevron `▾/▸` and an "N metrics" count
badge in the header. Also fixed the free-page probe's one-shot flag: the
`sp2up` sessionStorage flag is now consumed on the `?sp=2` load itself
(before: the visit right after an upgrade silently did nothing — likely
part of "Firefox still shows the old page"). Pins in `seo-research.test.js`
(cmp-sec cmp-open, exactly 7 groups, exactly 6 cmp-prev teaser rows).
Shipped per the standing sequence (deploy 34179227473 green, repo back
private); live free page verified (probe present, no pro leakage). Owner
click test pending: logged-in core/pro visit to any /compare page should
auto-upgrade and show the collapsible layout.

## Compare paid-upgrade probe fixed (cookie gate) — DEPLOYED (9/8, commit `6db2adfd`)

The 9/8 compare-split ship (`9a067766`) never upgraded anyone: the in-page
probe gated on `localStorage.getItem('token')`, but auth is 100% cookie-based
(`sp_auth` HttpOnly + `sp_logged_in=1` marker; login never writes localStorage)
→ probe exited early for every real user. Owner confirmed: logged in on prod,
still the free page. Fix in `backend/seo-extra.js` (free-page probe): gate on
the `sp_logged_in=1` cookie marker regex (same one V2.token uses), plain
`fetch('/api/session')` with no Authorization header — same-origin fetch
carries `sp_auth`, which authTokenFromRequest accepts. The verdict sections'
`tok?{headers}:{}` fallback was already correct. Regression pin added in
`seo-research.test.js` (probe must match `sp_logged_in=1`; the localStorage
hard-gate `…getItem('token')…if(!tok)return;` sequence is banned). Shipped
per the standing sequence (deploy 34177438338 green, repo back private);
live free page verified: probe gate present, no pro-design leakage
(`AI VERDICT`/`cmp-grp` absent). NOTE: the local working tree's
`backend/seo-extra.js` is MISSING commit `bcc62b01`'s discovered-compares
block (removed the local file wholesale from the clone would have reverted
it) — the fix was applied onto the clone's file instead; the local tree is
behind the repo for seo-extra.js. Owner: a logged-in core/pro visit to any
`/compare/...` now auto-upgrades; `?sp=2` stays as the manual path; if that
still shows the free page, the account tier isn't core/pro — check
`/api/session` `"tier"`.

## Credit recharge — phase 2: Stripe serialization bug (the real one) — DEPLOYED & OWNER-CONFIRMED (9/8, commit `d5de8475`)

Phase 1 (auth gate, `6334cdb6`) got the owner's click past 401 — and surfaced the
actual defect: 500 "Unable to start checkout right now." on every logged-in
click. Root cause: authMiddleware sets `req.userId = user._id` (raw mongoose
ObjectId, app.js:4733); the topup route was the ONLY checkout call site passing
it raw to Stripe (`client_reference_id: req.userId`, app.js:6430). Proven by
localhost interception (no Stripe contact): stripe-node SDK serializes a
non-string object param by walking its properties → request body carried
`client_reference_id[buffer]=<binary>` → Stripe rejects the unknown bracketed
param → create throws → 500. This is why ZERO `credit_topup` sessions were ever
creatable. All other call sites already used `user._id.toString()`.

- Fix: `client_reference_id: req.userId.toString()` (one line, backend/app.js).
- Pins: pricing-ladder bans the raw form; NEW hermetic
  `backend/test/stripe-param-encoding.test.js` intercepts the SDK's actual
  request encoding on localhost (http server + `{host,port,protocol}` client
  config, zero Stripe contact) — asserts plain string encoding, reproduces the
  bracketed `[buffer]` bug as the control case. Suite 540/541 (social-compose
  pre-existing).
- Shipped `d5de8475` (fast-forwarded the owner's sitemap commit `bcc62b01`),
  deploy run 34176378243 green, repo private again.
- **Owner live-tested: checkout opens — recharge fixed end-to-end.** Remaining
  unobserved hop: if they paid, the webhook +150 grant (idempotent) should show
  as "Recharge — credits added" in profile → Usage.

## Bing recs: IndexNow key hosted + sitemap picks up externally-discovered compare pairs — DEPLOYED (9/8, commit bcc62b01)

Bing recs 105/106 shared one root cause: `/compare/*` renders ANY pair live but
the sitemap only emitted algorithmic pairs (sector-adjacency + POPULAR). Fix in
an isolated worktree off origin/main (uncommitted owner work untouched):

- `seo-extra.js`: `noteDiscoveredCompare(a,b)` — records pairs that actually
  render with metrics on both sides to `backend/discovered-compares.json`
  (deduped, bounded 1000, 5s write-behind; same snapshot contract as
  indexable-shares/filing-diff-symbols). Fired from free `renderComparePage`.
- `seo-pages.js`: `buildSitemapInventory()` merges that snapshot into the
  comparisons shards (deduped vs `comparePairs()`, tickerMtime lastmod).
- `frontend-v2/1668f45a03ea53cf94c51b61c43163d4.txt`: IndexNow key file.

Verified live: key file 200; PANW-vs-SNDK 200 + recorded on first post-deploy
render; URL submitted via BWT API (quota 99/day left); sitemap resubmitted via
BWT API (GetFeeds Success, 25,831 URLs); IndexNow POST → 202. Pair lands in the
live sitemap within the 30-min inventory TTL after a render. Recs clear on
Bing's next scan. Recs 107 (noindex /login+/news — intentional) and 108
(backlinks) left alone. BWT API key inline/temp only (never stored in repo).

**Re-checked 9/11 (owner: "why isn't the Bing issue fixed yet") — the tiles are
a lagging indicator, and Bing is converging.** All three tiles still show; the
fix is live and the index is filling in. Measured via the BWT API, not guessed:
`GetFeeds` shows the sitemap index last crawled **9/10**, Status Success,
UrlCount 22,474 — vs 22,198 URLs actually published (core 94 / stocks 1,506 /
comparisons 6,350 / metrics 13,880 / diffs 368). `GetCrawlStats` is the real
signal: **InIndex 24,255 (9/3) → 29,598 (9/10)**, +5.3K in a week at ~400–2,600
pages crawled/day, 4xx ≈ 0, robots-blocked 3–4. So Bing is indexing ~800
pages/day net, and the red "missing from your sitemaps" rec should age out.
Corrected a wrong first read: the per-statement pages (`/stocks/X/revenue` …)
are NOT missing — all 11 live in the `metrics-*` shards (I had grepped the
wrong shard; AAPL 11/11 in metrics-1). Also drained the 9-URL local
`seo-data/indexnow-queue.json` (statement-page changes) → IndexNow HTTP 200,
queue now 9 submitted, and resubmitted the sitemap (`SubmitFeed` → `d:null`).
**Still unknown, owner-only:** the red tile's "Investigate" list names the exact
URLs, and there is no API for it — probed `GetRecommendations`,
`GetSiteScanResults`, `GetRecommendedUrls`, `GetCrawlIssues` (all empty) and
`GetCrawlIssues` is genuinely empty, so this is a UI-only read. Owner must open
the tile and paste the list; only then is it worth changing the sitemap.
IndexNow drains weekly (in `refresh-fundamentals.yml`, last run 9/6, next
~9/13), not continuously — that is the queue's normal cadence, not a bug.

## Credit recharge fixed (auth gate + expired-session recovery) — DEPLOYED (9/8, commit 6334cdb6)

Diagnosis first (all read-only): Stripe has **zero** `credit_topup` sessions ever
created and Atlas **zero** `topup` ledger rows — recharge never worked. The only
logged attempt (owner 9/7 19:11Z) was `POST /api/credits/topup` → **401**. Server
side always fine (price active $14.99, env set, route + idempotent webhook
sound). The defect was recharge.html having no logged-out state and no 401
recovery — a dead button showing the raw API error.

- Fix (frontend-only, `frontend-v2/recharge.html`, mirror of profile.html's
  `#locked`): `#recharge-locked` gate shown when `!window.V2.token()` (price
  card stays hidden, nothing wired); on 401 from the topup call → "Your session
  expired — please log in again." + button swaps to `/login.html?next=%2Frecharge.html`.
- Pins in `pricing-ladder.test.js` (`recharge.html gates on auth…`). No stamp
  bump — recharge.html references shared assets only, isn't a stamped asset.
- Local-verified via headless CDP against a static serve: logged-out shows the
  gate; logged-in shows the card + wired button; stubbed-401 click shows the
  recovery message and the login link. Suite 539/540 (social-compose pre-existing).
- Shipped: clone → commit `6334cdb6` → public → push (one transient 403 on
  push, retry worked) → deploy run 34175621999 green → private again. Live
  markup verified via curl.
- **Owner's one live test remains** (live Stripe writes are hard-blocked): while
  logged in, click "Recharge 150 credits — $14.99" — Stripe checkout opening
  proves the fix; paying also proves the webhook grant (+150, reason
  "Recharge — credits added").

## AI Paper beta: live research feed + pause & edit + owner steering — DEPLOYED (9/7, commit 618ada51)

Stamp now `20260907-aipaper3` (45 files). 537 tests, 536 pass (social-compose =
missing selenium-webdriver, pre-existing). ai-paper suites: 33/33.

- **Live feed**: every tool call/result is emitted and persisted as a capped
  (120) `buildLog: String[]` on the doc (`logStamp` mm:ss UTC lines, mind label
  baked into research lines at the emit layer). Chat-SSE `ai_paper` frames stay
  instant; ask.html + dashboard poll /detail (2.5s) and append new lines by
  index (dedupe counters `paperFeedSeen` / `aiPaperFeedSeen`).
- **Pause**: `activeBuilds` registry + `assertLive()` checks at every round top,
  between tool calls, and every create() stage boundary → `PauseError` →
  `pauseBuild` sets status `'paused'` (keeps `setup {guruId, constraints}` +
  feed; NOT a failure). `POST /stop` → `stopBuild` (registry flag; falls back to
  pausing a building doc after a restart). Resume = `ai_portfolio_setup` with
  the FULL edited setup; constraints (≤5 × ≤140 chars) injected into BOTH minds
  as "OWNER'S HARD REQUIREMENTS".
- **Steering** `applySteering(userId, action, params)`: only committed/tracking,
  zero AI; `rules` (≤5 × ≤160 → `steeringRules` + injected into nightly review
  prompt), `allocate` (guruPct/aiPct % of TOTAL, fixWeights, official closes,
  weighted-avg basis on the growing slot), `override` (same dollars at new
  close). Each success logs a decision type `'steering'`, persona `'owner'`.
- **REAL BUG fixed**: spreading a mongoose subdoc (`{...pos}`) into `$set`
  copies `$__`/`_doc` internals → cast wrote STALE positions (allocate looked
  successful but doc kept originals + new cash = inconsistent). Fixed with
  `plainPos(p)` = `p.toObject()` in both steering writers. Positions still
  written by exactly two paths (construction commit + steering) — pinned.
- Shipped 9/7: 49 files, commit `618ada51`, Render deploy green, repo private
  again; live stamp `20260907-aipaper3` verified on /ask, /stop 401-gated.
  Owner-tested against the local in-memory server (rin seeded, pw 'devlocal').
  Also: HANDOFF.md is 730 lines vs the 160-line guideline — trim next session.

## Credit meter rewritten on profile → Usage — LOCAL, NOT DEPLOYED (9/7)

Stamp `20260907-creditmeter1` (44 files + profile.js). 504 tests, 503 pass
(`social-compose` = missing `selenium-webdriver`, pre-existing).

Three shipped defects, all visible in one seeded month (screenshots taken via
`scripts/dev-local.js`-style in-memory boot; harness in the session scratchpad):

1. **A recharge rendered as `Credit use −0 credits`.** `topup` rows are positive
   deltas; `activityLabel` had no case for them and the row renderer clamped
   with `Math.max(0, -delta)`. A $14.99 purchase had no receipt anywhere.
2. **The per-feature split vanished above the activity cap.** It was summed
   client-side from the 12–20 capped `recent` rows and hidden when they fell
   short of `used()`. Now `credits.monthBreakdown()` — one uncapped aggregate —
   so the split always adds up; `creditSplit()` stays as the legacy fallback.
3. **`dossier-compare` was in no bucket.** It counted toward the covered≥used
   check but no feature row, silently under-reporting Dossier spend, and showed
   in the ledger as an unexplained "Credit use".

Also: `balance()` now returns `plan`/`purchased` (wallet composition was
invisible), Deep Dossier (30) reached the price list, `/api/credits` takes
`activityLimit` (clamped 1–200) for "show the whole month", and the panel leads
with remaining + a running-balance ledger + a pace line.

## Expense ratios now come from the filed prospectus — LOCAL, NOT DEPLOYED (9/7)

Follow-on to the holdings work below; owner called expense ratio one of the most
important metrics for choosing a fund. Stamp is now `20260907-fees1` (44 files).
483 tests, 482 pass (`social-compose` = missing `selenium-webdriver`, pre-existing).

**Measured first.** Yahoo is accurate for ETFs and unreliable for mutual funds:

| | Yahoo | filed | |
|---|---|---|---|
| SWPPX | 1.24% | 0.02% | 62x |
| FZROX | 0.99% | 0.00% | — |
| FXAIX | 0.69% | 0.015% | 46x |
| FSKAX | 0.66% | 0.015% | 44x |
| VWELX | 0.99% | 0.24% | 4x |
| DODGX | 0.00% | 0.51% | zero |
| VTSAX | 0.08% | 0.04% | 2x |
| VOO SPY GLD TLT SCHD ARKK XLK QQQ SGOV VNQ BND JEPI | correct | correct | ✓ |

The wrong values track the fund's Morningstar **category average**, so the
cheapest index funds are the worst hit — the exact funds people pick on cost.
This is the same class of error (FXAIX 1.53%) that pulled the ETF grade on 9/3.

**Source: the prospectus fee table, per share class.** Every '40 Act fund tags
it in XBRL on Form 485BPOS (`oef:ExpensesOverAssets`, `oef:NetExpensesOverAssets`,
management/12b-1/other/acquired-fund legs). New `backend/fund-fees.js`;
`sec-fund-index.js` holds the EDGAR plumbing now shared with `fund-holdings.js`
(ticker→series/class map, filing lookup, instance fetch). Verified against 24
funds: every mutual fund now matches its prospectus, and IVV/IWM/SOXX/EFA/AGG/HYG
resolve too.

**Two things to know:**
- A class-context match is mandatory — one prospectus covers the whole trust, so
  reading the first fee fact in the document returns a *sibling fund's* fee.
  Guarded by test.
- Some filings ship the fee table only as inline XBRL inside a 40MB HTML doc
  with no extracted instance (iShares' 2026-07-27 485BPOS for IVV). The module
  walks back up to 3 recent 485BPOS + 2 recent 497s and takes the first that
  parses, so IVV resolves from the 2025-07-22 filing. **The filing date always
  travels with the number** and is shown on the tile.

**Wiring:** `fetchAssetProfile` races the lookup against `FEE_TIMEOUT_MS = 2500`
(cold 2-8s, cached 30 days in Mongo + memory) and leaves the pending fetch
running so it warms the cache. Fallback order: filed → Yahoo **for ETFs only** →
null. A mutual fund with no filed table shows nothing, deliberately. New
`GET /api/assets/:symbol/fees` lets the page correct the tile on the same visit
instead of waiting out the 30-minute profile cache. `profile.fees` also carries
the gross/net/management/12b-1/other/acquired-fund breakdown, unused so far.

Not done: nothing else on the fund page is cross-checked against a filed source
— net assets, yield and the trailing returns are all still Yahoo's.

## Fund holdings: complete portfolios from N-PORT + 3 measured bugs — LOCAL, NOT DEPLOYED (9/7)

Owner asked why ETFs/funds don't show all holdings and why not all ETFs are
findable. Four causes, all measured, all fixed. Stamp `20260907-holdings1`
(44 files). 466 tests, 465 pass (`social-compose` fails on a missing
`selenium-webdriver` — pre-existing).

1. **Yahoo's `topHoldings` module returns exactly 10 rows for every fund** —
   verified across SPY/VOO/QQQ/VTI/ARKK/VFIAX/JEPI/SCHD/IWM/VXUS. The
   `.slice(0, 15)` was never the constraint. New `backend/fund-holdings.js`
   pulls the complete portfolio from the fund's latest **SEC Form N-PORT**
   (VOO 520, VTSAX 3,546, BND 17,409, IVV 508). New paged route
   `GET /api/assets/:symbol/holdings`; the fund page renders Yahoo's ten first
   and swaps in the full list with its as-of date and a link to the filing.
   **Issuer files are NOT usable**: iShares' and Vanguard's holdings endpoints
   both answer 200 with an Akamai HTML shell, not data (measured 9/7 — my own
   first pass mis-read those as working because I checked status+size, not
   content). GLD/IBIT correctly return nothing: grantor trusts file no N-PORT.
   Lag is real and labelled — N-PORT is public ~60 days after the period end.
   Consistent with the 9/3 "if we can't verify it we won't have it" call: this
   is the primary filing with its date shown, not a derived figure.
2. **Sector exposure was empty on every fund page, and the public
   `etf-sector-concentration` tool returned zero rows.** Yahoo sends
   `sectorWeightings`/`bondRatings` as `[{realestate: 0.018}]`, and
   `normalizeWeights` read `.name`/`.weight` off that and filtered everything
   out. Fixed; SPY now shows 11 sectors, BND 6 rating buckets.
3. **ETF-overlap tool** intersected two ten-row lists and called it portfolio
   overlap. Now full N-PORT portfolios: VOO vs VTI = 517 shared securities,
   **88.4%** overlap (was "10 shared holdings").
4. **Search couldn't reach most ETFs.** `local.concat(remote).slice(0, limit)`
   put the 99-company directory ahead of everything, so "v"/"s"/"i"/"a" each
   filled all 8 slots with equities and zero funds. Now both sources are ranked
   on one relevance scale with a floor of `limit/2` for funds. Yahoo *itself*
   returns no funds for 1–2 letter queries, so `scripts/build-fund-directory.js`
   generates `frontend/data/top-funds.json` (205 funds, every name and AUM from
   a live quote, nothing typed from memory). Also: `.L` suffixes slipped the
   old `{2,4}` filter (SPYY.L was offered for "SPY" and would 404).
   **Still excluded by design:** non-US listings (IWDA.AS, ARKK.L) — enabling
   them needs `symbolKey`'s dot→dash rule reworked, since it would turn
   `IWDA.AS` into `IWDA-AS` and 404.

Rebuild the directory with `node scripts/build-fund-directory.js` (run from
`backend/`, it needs `yahoo-finance2`). Not yet checked: whether Yahoo's 100×
expense-ratio error (FXAIX, found 9/3) still stands — the fund page still shows
that number.

**This file is 600+ lines against a 160-line budget; it needs a trim pass.**

## Credit wallet halved for NEW buyers only — LOCAL, NOT DEPLOYED (9/6)

`LTD_CREDIT_ALLOWANCE_V2 = {1:50, 2:150, 3:400}` in `credits.js`, gated on
`CREDIT_ALLOWANCE_V2_EFFECTIVE_FROM` (unset = nobody on V2). Mirrors the
`LTD_MONITOR_CAP_V2` / `isMonitorCapV2Cohort` pattern in `lib/tier-limits.js`:
**all 18 existing buyers keep 100/300/800 permanently**, and an account that cannot be
classified (bare tier, no redemption date) fails closed to V1 — it never loses half its
wallet by accident. The five `credits.balance/check` call sites in `app.js` now pass
`req.user` instead of the bare tier so the cohort is readable.

**Why: measured, not guessed.** `ollama_usage_events`, 30 days: 24.47M tokens, 2,270 calls,
**~82k tokens per charged credit**. Ollama Pro is $20/mo = **$60 of usage credits**;
glm-5.1 is $1.00/M in, $3.20/M out (~$1.20/M blended here) → current spend **~$30/mo, half
the allowance**. (glm-5.3 at effort=low used ~14% FEWER tokens than 5.1 on the same
Ask question and 4.3x fewer on a diff extraction — re-measure the blended rate from
`ollama_usage_events` grouped by `model` once anything is flipped; 5.3's own per-M
price is still unrecorded here.) One tier-3 buyer spending a full 800 = 65.9M tokens ≈ **$80/mo, more than
the whole plan**. Heaviest real customer month ever: **118 credits**. One account (almost
certainly the owner's testing) is **18.76M tokens = 77% of everything**.

The Ask floor (30/100/300) is what protects the halved tiers: V2 wallets buy fewer Asks
than the floor, so the OR-gate floor governs and no buyer loses questions.

Published everywhere: listing v5 doc, `frontend-v2/appsumo.html`, the portal draft.
`credit-meter-truth.test.js` gained a cohort test; 453/454 (social-compose pre-existing).

**`CREDIT_ALLOWANCE_V2_EFFECTIVE_FROM` = `2026-09-06T00:00:00Z` is SET on Render** (9/6, via
the new `set-render-env.yml` dispatch workflow — the API key is a write-only repo secret, so
that workflow is the only path to it from a local session). Latest redemption before the line
was 9/5 17:46 UTC, so all 18 buyers are grandfathered. **It stays inert until `c5d7decc` is
deployed** — Render still cannot fetch the repo. Also: `ollama-usage-tracker.js` reads
`prompt_tokens`/`completion_tokens` at :148-149 but persists only `totalTokens` — storing
the split turns the ±20% blended-rate estimate into an exact margin figure.

## Listing v5: PRODUCT deployed, **AppSumo listing still UNCHANGED** (9/6)

**Read this first:** the code and stockportfolio.pro are live with the credit meter. The
**AppSumo listing itself has not been touched** — same Ask-count tiers, same 4 original
1920x1080 images, same "Best for: Small businesses", same "Uses AI: No". Changing it means
editing the portal draft and submitting it, which only the owner can do. Do not assume any
listing change has shipped.

`docs/growth/appsumo-listing-v5.md` (v4 marked superseded). Dossier and Monitor get a
section each; **credits are priced in reports** (100/300/800 = 10/30/80 dossiers or
20/60/160 monitor reports) because "100 credits" told a buyer nothing. Driven by Alex
(T1→T2, 9/4: "clarify the credits on the AppSumo website, rather than the questions
limit"; "report first, then chat") and Kris (8/30: "the true value lies in the dossier and
filing monitor reports").

**The bug the listing would have shipped:** Ask was metered twice. `credits.spend` debited
the wallet at `app.js:7530/:7557` while `effectiveAskLimit` hard-stopped Ask at 30/100/300
— so v4's "100 credits, Ask costs 2" overstated Starter by 67%. Now an **OR-gate**
(`app.js:7452`): allowed when `credits.check().ok` **or** the counter is under cap. Every
tier widens (T1 30→up to 50 Asks), nobody loses the floor they own, and non-LTD plans are
unaffected because their wallet is exactly 2× their Ask limit.
**Also caught: v4 line 99 said "unlimited companies"** — no tier grants that
(`lib/tier-limits.js` = 12/40/unlimited, live page = 1/4/8). v5 publishes 1/4/8.

**`backend/test/credit-meter-truth.test.js` (new, 5 tests)** is the guard: it asserts the
OR-gate is still in `app.js`, that the listing document's tables equal `credits.js`
(wallet, derived report counts, per-action costs, and that the worked example sums to 300),
that "unlimited companies" never returns, and that the listing never prices Deep Dossier
while `dossier.js` can't request it. It failed on my own first draft of the copy.

**Site aligned:** `appsumo.html` (credits + 1/4/8 kept), `index.html` pricing cards carry
each plan's allowance, tagline → "Detailed research reports on stocks, built from real SEC
data." (Alex's words; 6 sites + `anon-ask-trial` pin), `llms.txt` report-first,
`ask.html`/`profile.js` show credits — killing the "0 / 30 Ask questions used this month"
line Alex named. `/api/ai/chat/quota` gained an additive `credits` + `cost` block.
Pre-spend cost now shows on dossier and monitor **before** the click. Removed two
unbuyable promises: Deep Dossier pricing and the `$14.99/150 credits` top-up link
(prod returns `TOPUP_UNAVAILABLE` until the Render env var is set).
Stamp `20260905-fallback3` → **`20260906-credits1`**, 91 occurrences, 44 files.
Suite **452/453** (`social-compose` selenium import, pre-existing).

**Deployed** as `b716edaf` + `e46e6613` (owner triggered it manually in Render; verified on
prod — stamp `20260906-credits1`, `/appsumo` shows 100/300/800 credits and 1/4/8, the new
tagline and `llms.txt` are live). **The tier-spec email to William is now unblocked.**

**The auto-deploy is still broken, and now we know why.** The workflow's `curl -f` was
hiding the body; it now prints it. The key is fine and can see `srv-…6t10 prod` — Render's
own reply is `{"message":"not found: https://api.github.com/repositories/1105594471"}`,
i.e. **Render cannot reach the GitHub repo** for API-triggered deploys (1105594471 =
`avisre/prod`). Fix is in Render/GitHub, not in code: reconnect the repo on the service
(Settings → Build & Deploy → Repository) or grant Render's GitHub App access at
github.com/settings/installations. Owner-only — interactive OAuth.

**`avisre/prod` is PUBLIC** (`gh api repos/avisre/prod --jq .private` → `false`), against
HANDOFF's 9/3 "repo verified back to private". `backend/ai-client.js`,
`ollama-usage-tracker.js` and `CLAUDE.md` are tracked and name the provider, so the trade
secret CLAUDE.md protects is world-readable while this stands. Not changed by me — flipping
repo visibility is the owner's call.

**Still owner-only:** the two William emails (the "Uses AI: No" flag one is independent),
`STRIPE_PRICE_ID_CREDITS_TOPUP` on Render to re-enable the top-up line, and replies to Kris
(Monitor) and Gattomorto (his three asks — market-cap filter, multi-portfolio, CSV import
with date/qty/price — are all already shipped).

**This file is 540+ lines against CLAUDE.md's 160 cap and needs a trim.**

## Bots: server-side block built then reverted same day (9/5)

Built `backend/bot-blocker.js` (403 all bots except Google/Bing, 4-layer
verification) plus a rewritten `frontend/robots.txt` and two test files.
**Owner reverted it the same day** — code deleted, `robots.txt` restored to the
prior allow-all version, no trace left in `app.js`. Full rationale, traffic
measurements (68% of traffic was bots, Meta alone 53%) and the design that was
reverted are preserved in `docs/growth/bot-crawler-situation-2026-09-05.md` if
this gets revisited.

Also confirmed: `~/.nvm/.../v22.22.0/bin/node` **does not exist on this
machine**; the working binary is `/opt/homebrew/bin/node` (v26.4.0). CLAUDE.md
is stale on this.

## AppSumo relist on a credit meter + the email queue that had never run (9/5)

**The find:** `scheduled_emails` held 12 jobs (onboarding + review asks, one pair per
buyer since 8/14), all `status:scheduled`, 11 overdue, `lastError` empty — never
attempted. `scripts/run-scheduled-emails.js` was complete but wired to no cron;
nothing read `dueAt`. Fixed and drained: **13 emails sent, 0 failed.**

**Two real bugs found while draining, both silent:**
1. `run-scheduled-emails.js` used raw-driver `findOneAndUpdate(...).value`. Driver is
   **6.20.0**, which returns the bare document — `.value` is always `undefined`, so
   every review claim read as a loss and was skipped, *after* the `$set` had already
   landed and permanently blocked that user. Fixed with `includeResultMetadata: true`.
   Four users were poisoned by the first run; claims cleared, jobs reopened, all four
   sent on the re-run. Only raw-driver call in the repo; Mongoose calls are unaffected.
2. The inactive-48h pass keyed solely on `meaningful_activation` funnel events, which
   are **zero for every account** — so it would have mailed all 13 customers "you
   haven't got started", including Kris and pkotynski, *daily* once crontab'd. Now also
   counts real usage (credit_ledger/dossier_views/ask_reports + stocks/alerts/
   watchlists/portfolios). Nudges dropped 13 → 3, and the 3 are genuinely dormant
   (ian.sterk99 T3, thunderconlive T3, analyzewithzen).

**Credit meter (the relist):** `credits.js` now has explicit `LTD_CREDIT_ALLOWANCE =
{1:100, 2:300, 3:800}`, replacing derived `askLimit x2` (60/200/600) for LTD accounts.
**Every tier goes UP** — verified against all 13 live buyers, zero downgrades — so no
grandfather clause and no AppSumo downgrade approval needed. `ENABLE_TIER_V2_LIMITS`
and `MONITOR_CAP_V2_EFFECTIVE_FROM` stay OFF: one meter only, companies/portfolios/
history stay unlimited, 19yr history on every tier. Test added, 448 tests, 447 pass
(only pre-existing `social-compose` selenium failure).

**Listing v4 drafted, NOT submitted:** `docs/growth/appsumo-listing-v4-credit-model.md`.
Report-first (Dossier + Monitor lead, Ask last) on Kris's and Alex's direct feedback;
supersedes the Ask-first v3. Owner must email William for the "Uses AI: No" flag and
the tier spec — never the portal (version mapping bug).

**Data fixes:** Khaled was on a Desk *trial* (10,000 credits, 4 Oct cliff, invisible to
email since `trialing` != `active`) instead of the intended Investor — set to tier 2 /
cap 100 / active / no trial end (snapshot in scratchpad). gattomorto marked
`appsumoReviewStage:2` so the queue stops asking a customer who already reviewed 9/1.

**Also:** nav is report-first (dropdown renamed Ask AI -> Research, Dossier+Monitor lead;
mobile promoted to peers). Ask limit 25-vs-50 contradiction fixed in `llms.txt`,
`index.html:731`, `ai-chat.js:13` (code is 50). Cache stamp `20260904-recharge1` ->
`20260905-relist1`, 91 occurrences, 44 files.

**Credit top-ups — half done.** A matching LIVE price already existed and had simply
never been wired: `price_1UAUOtAUeKapY1OPUcSIaloi` ("Credit refill — stockportfolio.pro",
$14.99 one-time USD, active). Set in `backend/.env` and validated against the route's
own checks (active + unit_amount 1499 + usd) — local would sell.
**OWNER: set the same var on Render** — no RENDER_API_KEY or CLI on this machine, so
prod still returns `TOPUP_UNAVAILABLE` and the listing's "$14.99 for 150 credits" line
stays a promise prod cannot keep until it is set. Also: `ai_chat_feedback` has 0
rows because no frontend calls the thumbs endpoint; `trendbm` has never had a review
ask; this file is 441 lines against the 160-line cap in CLAUDE.md and needs trimming.

## Ask bug: `search_filings` could serve a stale 10-K as "the latest" — FIXED AND DEPLOYED (9/4, confirmed by owner 9/5)

Root cause of a real AppSumo refund. Traced from AppSumo's 9/4 refund-summary
email (2 refunds, no names/reasons given) → matched by tier+timestamp to the
two `appsumolicenses` deactivations in Mongo → one buyer (Khaled Aziz,
khaledaziz130@gmail.com) had redeemed, asked Ask one NVDA question, and
canceled 39 min later. His AppSumo exit-survey reason ("Old data, not
fresh") checked out: his Ask session got NVIDIA's **FY2025 10-K** (filed
2025-02-26) when the real latest was the **FY2026 10-K** (filed 2026-02-25,
already sitting in our own `filing_text` cache).

- **Cause**: `toolSearchFilings` (`ai-chat.js`, tool `search_filings`) queries
  `efts.sec.gov/LATEST/search-index` with no sort param — EDGAR ranks by
  relevance, not recency. Reproduced live: a plain "risk factors" / forms=10-K
  query for NVDA returned 2023→2024→2025→2026 in that order, so the 2025
  filing (position 3) looked as good as the 2026 one (position 4) to the
  model, which picked it and called it "the latest."
- **Scope check**: `grep -rl efts.sec.gov backend/` — `search_filings` is the
  **only** place in the backend that hits EDGAR's relevance search. Every
  other filing-dependent tool (`get_segments`, `get_key_points`,
  `get_governance`, `get_esg`, `get_unit_economics`, `get_filing_diff`,
  `get_red_flags`, `get_peer_context`, Filing Monitor, the dossier builder)
  already routes through `watchdog.fetchRecentFilings` →
  `data.sec.gov/submissions/CIK{cik}.json`, SEC's own chronological feed —
  not affected by this bug.
- **Fix** (`ai-chat.js`, `toolSearchFilings`): when a query names one ticker
  and restricts to periodic forms (10-K/10-Q) with no date range — the "what
  does the latest filing say" shape — cross-check against
  `watchdog.fetchRecentFilings` (same reliable source the rest of the product
  uses) and merge those in as `confirmedLatest: true`. All returned results
  are now sorted newest-first regardless, so recency is never something the
  model has to infer from list order.
- **Verified live against real EDGAR, 15 tickers across 15 GICS sectors**
  (NVDA, MSFT, JPM, XOM, JNJ, WMT, DIS, CAT, NEE, PLD, LIN, TSLA, UNH, KO,
  BA): 15/15 now return the actual latest 10-K as the top result, each
  flagged `confirmedLatest`. XOM needed its documented CIK-override fallback
  (shell/co-registrant CIK issue, already handled by `watchdog`) to confirm
  ground truth — matched exactly once resolved.
- Full suite: 441/442 (`social-compose.test.js` fails on missing
  `selenium-webdriver`, pre-existing, unrelated to this change).
- **Not yet deployed** — needs the usual Render trigger dance + cache-stamp
  check (this change touches no frontend assets, so no `?v=` bump needed).
- Reply to Khaled not sent — his refund already processed; a courtesy note
  once this ships would be a fair reason to re-engage.
- The other 9/2 refund ("Product's functionality was too limited" /
  "Lacking Depth") traced to a license that was **never redeemed** — no site
  activity at all in the purchase window, so that complaint reflects the
  AppSumo listing page or a reflexive refund-flow click, not product use.
  Not actionable, no identity recoverable from our DB (AppSumo's webhook
  carries no buyer email).

## Earlier sessions, 9/1–9/3 — all shipped, condensed (was ~320 lines)

- **9/3 CEO decisions, deployed (`8936689`)**: fixed `/api/assets/:symbol/profile`
  returning null performance for every ETF (Yahoo dropped the fields Ask relied
  on); new public `/filing-changes/:symbol` pages (verbatim Was→Now quotes,
  AI narrative stays gated); fixed affiliate `/accept` 409-ing every partner
  profile; 18-lead B2B outreach kit built (nothing sent — owner-gated).
  Sitemap diffs-shard cache-invalidation race found and fixed (shard served
  353 URLs while the index omitted it for 90 min post-restart).
- **ETF A–E grading — built, tested, then stripped same day, owner's call.**
  Yahoo reports FXAIX's expense ratio as 1.53% (real 0.015%, a 100× error)
  with no reliable way to detect a bad figure from a good one. Owner: "if we
  can't verify it we won't have it." **Don't re-propose without a fix for the
  underlying data-verification gap.** Three unrelated bug fixes from that
  session were kept (ETF performance nulls, unknown-ticker 500, leveraged-ETF
  regex).
- **9/2 shipped and live**: Monitor Normal-mode verified-quote cards; AI menu
  reorder (Dossier → Monitor → Ask); MRR ladder + GATTOMORTO referral code;
  Monitor cap v2 (1/4/8) wired but shipped dark (`MONITOR_CAP_V2_EFFECTIVE_FROM`
  blank — inert until set); customer-thread bug pass (AppSumo tier-3 session
  bug, nav badge escaping, unread-badge-vanishes bug, boot-time index fixes).
- **Graphite rebrand — tried and fully reverted same day.** Owner picked it
  from a preview, hated it live, full revert via the push-clone (NOT the
  "pre-change backup" tar, which was taken after the edit and was worthless).
  **Lesson kept**: next color change restores from git/push-clone, never an
  ad-hoc tar snapshot.
- **9/1 strategy + shipped state**: Strategy v3 approved (warm humans + founder
  B2B + $149/yr Intelligence founding SKU), honest bound $2,000/mo recurring
  conditional on B2B converting. Direct checkout channel measured at $0 MRR
  ever; AppSumo is the only paying channel. New pricing ladder shipped live
  (`2cd178c1`+`74a7fdab`), boot-crash root cause fixed (yahoo-finance2 moved
  from devDependencies).

Full detail on any of the above (exact commits, verification steps, dollar
figures) is in git history and `notes/2026-09-0{1,2,3}-*.md` if it's ever
needed again — not repeated here since none of it has an open action item.

## Owner actions pending

This list was fully rewritten 9/11 — the previous version dated to 9/1–9/2
and referenced deploys/gates long since resolved by later sessions (see git
log for what actually shipped since). If a topic below has a more detailed
section elsewhere in this file dated later than the item, that section is
the current source of truth.

1. **Bot-blocker canary → enforce** (this session, see top entry): set
   `BOT_BLOCK_DRY_RUN=true` on Render before merge, check `stats()` after
   ~24h, then flip to `false`.
2. **Secrets exposed in local transcripts, never rotated as of 9/5**
   (`docs/growth/SESSION-HANDOFF-2026-09-05.md` §8): `STRIPE_SECRET_KEY`
   (live), `STRIPE_WEBHOOK_SECRET`, `JWT_SECRET`, `SMTP_PASS`,
   `GOOGLE_CLIENT_SECRET`, `OLLAMA_API_KEY` — rotate at source AND on Render
   back-to-back per key (checkout/webhooks break if they're out of sync
   mid-rotation). Also revoke the old GitHub PAT. **Status since 9/5 unknown
   from this file — verify before assuming either way.**
3. **`STRIPE_PRICE_ID_CREDITS_TOPUP` on Render** — repeatedly flagged (9/5
   through 9/8) as set locally but not on Render, so prod returns
   `TOPUP_UNAVAILABLE`. Check current status before re-flagging.
4. **AppSumo listing v5 + William emails** — `docs/growth/appsumo-listing-v5.md`
   is the current copy; check the latest `Listing v5:` -prefixed commits for
   whether the William reply/portal update actually went out.
5. **Monthly Ollama Cloud bill** — the one input needed to state AI margin in
   dollars (formula: cost per credit = bill ÷ credits consumed). Owner-only.
6. **`avisre/prod` repo visibility** — flagged public as of 9/6, which
   exposes `ai-client.js`/`ollama-usage-tracker.js` naming the AI provider
   (a stated trade secret). Owner's call whether/when to flip back private.

## Render / deploy mechanics

- **Deploy automation**: `../trigger-deploy.sh` (workspace root, next to the
  env backup) does the whole dance — flip public via gh → POST
  `/v1/services/srv-d4kc6schg0os73al6t10/deploys` → poll → flip private,
  auto-retries the known ~50s `build_failed` flake. `RENDER_API_KEY` lives in
  the env backup file (owner pasted it 9/2 and directed it be stored there) —
  the script auto-reads it; no export needed.
  PERMANENT fix (owner, 2 min): re-authorize Render's GitHub App with access
  to avisre/prod → its webhook installs (repo currently has 0 webhooks —
  verified live 9/2) → push auto-deploys, dance dead forever.
- Render cannot clone private repo: flip `avisre/prod` public → deploy → flip
  back. First build sometimes no-error `build_failed` ~50s — retrigger.
- **Render env: per-key PUT only, never collection PUT** (8/31 incident).
- Stamp ritual: any `frontend-v2/assets/*` or `system.css` edit ⇒ new `?v=`
  on ALL pages + server-rendered (free-tools.js, comparison-pages.js,
  seo-pages.js, app.js, affiliate-dashboard.html) + pinning tests.
- Local tree LAGS GitHub on README, workflows refresh-fundamentals.yml,
  docs/, 504 frontend/data/fundamentals/*.json — do NOT copy those back.

## Working rules

- Node: PATH node is v26.4.0 at `/opt/homebrew/bin/node` — use it for
  everything. The old nvm v22.22.0 path in earlier entries above no longer
  exists on this machine (corrected 9/5, confirmed still true 9/11); tests
  from `backend/`; deps in `backend/node_modules`; no `rg`.
- Measure, don't estimate. No `sleep N`; no interactive auth via Bash.
- AI provider identity is a trade secret — never surface. Never store keys;
  inline/temp only. No anti-bot workarounds. Customer email only from
  support@ via /admin/messages (owner approves); NEVER cold email from
  support@ — separate identity for cold outreach.
- MONGODB_URI + STRIPE_SECRET_KEY parse from `render-env-backup-20260831.env`
  (workspace root; 8/31 snapshot also pasted into the 9/1 session — rotate
  exposed secrets, owner action #8). Bing key
  `~/.local/share/secrets/bing_webmaster.txt` (curl works; python
  requests gets ConnectionReset).