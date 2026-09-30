# Claude plugin directory — submission package

**Status 2026-10-01: route changed, plugin fixed, submission blocked on a browser sign-in.**

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

## What is left, and whose step it is

1. **Sign in to claude.ai in a browser we can drive** (owner — credentials are not
   mine to enter). The submission portal is behind a claude.ai login.
2. **Connect GitHub** on claude.ai for this organization, if the portal reports
   *"GitHub isn't connected for this Claude organization"* (owner — it is an OAuth
   grant to `avisre`).
3. Everything after that — repository, Validate, listing details, data-handling
   answers, the four compliance acknowledgements, Submit for review — is form work.

`claude.ai/directory/manage` is the page; the repository is
`avisre/stockportfolio-claude-plugin`, plugin path empty (root), tracked branch
`main`.
