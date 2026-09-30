# Claude plugin directory — submission package

**Status 2026-10-01: BOTH SUBMISSIONS ARE IN. The plugin bundle is `Publish requested` (waiting for an
Anthropic reviewer) and the MCP connector is `In review`, listing slug `stockportfolio`. Nothing here is
blocked on us any more; the verdict arrives by email at the primary contact.**

Everything the plugin needs is in place and verified from outside. Two things
happened since this doc was written on 9/25, and both are recorded below: the
submission route moved off the Console form, and the plugin itself was **shipping
broken tool names** until today.

## The route moved — submit at claude.ai, not platform.claude.com

Anthropic's [Publish to the directory](https://claude.com/docs/directory/publish)
docs, read 2026-10-01:

> You submit from a claude.ai account, and the listing belongs to the organization
> you submit from. […] **The earlier Claude Console form for plugin submissions is
> no longer supported.**

- **Portal:** <https://claude.ai/directory/manage> — "Submit new", then choose
  **Plugin bundle** or **MCP connector**. `platform.claude.com/plugins/submit` is
  dead; `clau.de/plugin-directory-submission` redirects to the docs page above.
- **Eligibility:** *"Plan: Pro, Max, Team, or Enterprise. Free accounts can't
  submit."* The account here is **Claude Pro** (`organizationType: claude_pro`,
  `stripe_subscription`), and on Pro *"you submit from your own account and there's
  no role to check."* So the old **$50/month Team blocker is gone** — it applied to
  the retired route.
- **GitHub must be connected to claude.ai.** *"The portal checks that your connected
  GitHub account can push to the repository."* A GitHub connection made in a
  different Claude organization does not carry over.
- **Two submissions, not one.** *"If you have a remote MCP server, always submit it
  as an MCP connector, even when a plugin you're submitting already references it."*
  So: the **plugin bundle** from `avisre/stockportfolio-claude-plugin`, and the
  **MCP connector** at `https://www.stockportfolio.pro/mcp`. Submitting both from
  the same organization is what lets the two listings be paired.
- **Review:** automated validation + security scan on every version, then a human
  reviewer for a new listing. A version that passes is not live until **Publish** is
  selected. `plugin.json`'s `version` must be raised with every release.

The listing reaches claude.ai web/desktop/mobile and Cowork, and a plugin added
there is also available in Claude Code.

## The plugin was shipping seven tools that don't exist — fixed 10/01

The hosted `/mcp` endpoint was rebuilt for directory clients in `a3a3ff74` and now
serves **six** tools under new names (`backend/mcp-endpoint.js:26-32`):

```
search_companies  get_company_fundamentals  search_filings  get_filing  ask_filings  sp_health
```

The plugin's `.mcp.json` points at that endpoint, but its `SKILL.md`, its command and
its README still described the **local npm bridge's** seven `sp_*` tools. Four of
them (`sp_financials`, `sp_compare`, `sp_screen`, `sp_fund`) do not exist on the
connected server at all, and two were renamed — so the skill was instructing Claude
to call tools that were not there, which is exactly the failure mode the skill exists
to prevent. Rewritten against the live `tools/list`, plus:

- the keyless allowance corrected to **3 research answers** and 50 data lookups per
  rolling 30-day window (it said 2), and stated as applying to an *unconnected*
  caller rather than only after connecting;
- fund data stated as REST-only (`/api/v1/fund/:symbol` — verified to exist), since
  no fund tool is on this connector any more;
- the `npx -y stockportfolio-mcp` line dropped: an unpinned launcher is a **Blocking**
  finding in the directory's validation, and the local bridge is a separate product
  with its own README.

Pushed as `1376fc6` on `avisre/stockportfolio-claude-plugin` (public, MIT, 7 files,
plugin at the repository root — which also avoids the "scripts the validator couldn't
follow" hold). `claude plugin validate .` passes.

## Preconditions — re-verified against production 2026-10-01

- [x] **The annotations are live.** `tools/list` from the deployed endpoint returns
      **6 tools, all 6 carrying `readOnlyHint: true`** — read from the live endpoint,
      not from the repo. (`sp_health` keyless reports `tool_count: 6`.)
- [x] **The bot-blocker exemption is live.** `/docs/api-mcp` and `/privacy` return
      **200** to an `anthropic-ai/1.0` UA — `anthropic-ai` and `claudebot` are in
      `DENY_PATTERNS`, the trap that blocked the AppSumo listing on 9/23. `/docs` and
      `/docs/api-mcp/extra` still 403, so the exemption is not over-broad. Note
      `/terms` is 200 for every UA now, browser or not — the 9/25 note calling it a
      negative control is stale.

## Reviewer test account

Reviewers need credentials for a **fully populated account** to exercise the tools.

- Use the internal test account (`rin@gmail.com` — excluded from all customer,
  funnel and usage counts; never quote it as a customer).
- **Tool calls spend credits.** `ask_filings` is the metered AI tool. The honest
  answer is that the **keyless tier is enough to exercise every tool** — 3 questions
  and 50 lookups per rolling 30 days, no key needed at all — so no credential
  handover is required.
- Auth is OAuth 2.1 with dynamic client registration, so there is no key to paste:
  connecting opens a sign-in window. Nothing in this plugin asks a user for a key.

## What a reviewer will look at, and the answer

| Question | Answer |
| --- | --- |
| Whose API does it call? | Our own first-party filing service. |
| Any third-party data? | Not through this connector. Fund data (costs, holdings, allocation) is third-party data we do not own and it was removed from `/mcp`; it is REST-only at `/api/v1/fund/:symbol` and is labelled as fund data wherever it appears. |
| Does it write anything? | No. All 6 tools are read-only and declare `readOnlyHint`. |
| Does it collect conversation data or read user files? | No. The ask path runs with an empty history and no holdings, and never persists the exchange — only the website's own ask routes do. |
| Coverage limits? | US-listed companies reporting in USD to the SEC. No international listings, no analyst estimates, no forward data. Stated in the skill, the README and the tool descriptions. |

## How the two submissions were made (both 10/01)

`claude.ai/directory/manage` is the page; the repository is
`avisre/stockportfolio-claude-plugin`, plugin path empty (root), tracked branch
`main`. The owner signed in once; everything after that was form work.

**Plugin bundle — 5 steps, submitted, `Publish requested`.** The listing carries
`icon`, `privacyPolicyUrl`, `supportUrl` and `termsOfServiceUrl` — fields
`claude plugin validate` does not recognise (it warns and strips them at load)
but the *directory* asks for by name, so they stay in `plugin.json`. Link count
went 4 of 6 → **6 of 6** once `/support` and `/terms` were added; both had been
measured 200 to an `anthropic-ai` UA first (`/contact` and `/help` are still
403). The push webhook was set up without the secret entering any transcript:
rotate → capture the payload URL and secret into a file by redirect → build the
hook body with Node → `gh api --input`.

**MCP connector — 10 steps, submitted, `In review`.** The two things worth
keeping:
- **Step 2 flagged all six tools "Missing title annotation. Add
  annotations.title."** The checker reads `ToolAnnotations.title`, which is a
  *separate field* from `Tool.title`; only the top-level field was set. Fixed in
  `backend/mcp-endpoint.js` and `backend/mcp-apps.js` as
  `annotations: { title: def.title, ...def.annotations }` (`10c5769a`, deployed,
  re-measured live — all six now carry it). **A connected server's tool list is
  only re-read when you reconnect**: Step 1 → `Change` → paste the URL →
  `Connect and authorize` → approve. The suggestions cleared on the first
  re-read after the deploy.
- **Auth is declared `Required when the server asks` + Dynamic Client
  Registration**, which the portal renders as *"No sign-in. Anyone can
  connect."* That is accurate — `/mcp` answers `initialize` and `tools/list`
  anonymously and never 401s for the free tier — but it means a directory user
  is not forced to sign in, and meets the keyless wall (3 asks + 50 lookups per
  30 days) rather than an OAuth prompt. `Always required` is one click away on
  the connector's Settings tab if we ever want every directory user signed in;
  it would contradict this README's keyless-start paragraph, which is why it was
  not chosen.

**Data-handling answers, and why they are what they are.** API ownership *We own
the API* (the LLM hop is a subprocessor, not the API we serve), health data *No*,
sponsored content *No*, read/write *Read only*, and all seven compliance
acknowledgements checked against the connector pre-submission checklist. The
`Additional notes` field discloses the one third-party hop in plain words:
`ask_filings` sends the question text to a third-party language-model provider,
the other five tools reach nobody, tool arguments are never stored, and request
metadata is kept up to 30 days. Same facts as the README's Data handling
section.

**Test & launch** carries the reviewer path: login URL, the reviewer account, the
scopes, and the six tool calls that were run against production with their
results. The credentials live at `~/.config/stockportfolio/reviewer-account.txt`
(mode 600) — the same `openai-review@stockportfolio.pro` account the OpenAI
submission uses, which is deliberate: it is a test account with no personal
data, and the keyless tier exercises every tool anyway.

## The connector in your own account — installed 10/01

Separate from the directory submission: the same endpoint is now a **custom connector on the owner's own
claude.ai account**, the Claude-side counterpart of the ChatGPT connector. Added at
`claude.ai/customize/connectors` → **Add** → **Add custom connector** (connectors moved here from Settings —
`/settings/connectors` now just points at Customize). Name `StockPortfolio`, URL
`https://www.stockportfolio.pro/mcp`, auth **`Sign in now` + Dynamic Client Registration**.

- The picker **auto-detected `No sign-in`**, which is the UI's reading of our `defer_auth` declaration and is
  the same judgement call recorded below. `Sign in now` was chosen here instead because this is a personal
  install: it runs the real OAuth handshake so the account is bound from the first tool call. CIMD is
  deliberately unsupported on our server, so the registration method must be switched from its `cimd` default
  to `dcr` — the same path ChatGPT takes.
- It authorized on our own `/oauth/authorize` consent screen and the connector page then listed **all six
  tools** under Tool permissions.
- **It is bound to `openai-review@stockportfolio.pro`** — that is the session the scratch Chrome profile
  happened to hold, not a deliberate choice. `Disconnect` on the same page rebinds it to another account.

**It cannot be exercised yet: the Claude Pro plan is past due and paused.** Billing names
**Discover •••• 4563**; the composer's send button is `disabled`, so no message can be sent and no tool can
be called in a chat. Updating the payment method and paying the overdue invoice restores access in about a
minute, with the billing cycle reset to start that day at no extra charge. The two directory submissions are
unaffected so far — `/directory/manage` shows them normally with no plan warning — but a paid plan is a
directory eligibility requirement, so this is worth clearing promptly.

## Judgement calls, if they need revisiting

- **The connector's auth declaration** — see above. One click on Settings.
- **Reusing the OpenAI reviewer account for Anthropic too.** A second account
  would be cleaner but needs an email confirmation cycle; this one is
  purpose-built and carries no customer data.
- **The custom icon is a GitHub raw URL**
  (`raw.githubusercontent.com/avisre/stockportfolio-claude-plugin/main/icon.png`,
  512×512, 200 OK). The default was our favicon, `/Media/icon.png` — it serves
  only to a request carrying browser headers, so a directory fetch could have
  come back empty.
