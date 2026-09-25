# Claude plugin directory — submission package

Target: Anthropic's **plugin directory**, which surfaces in Claude Code and Cowork as
`claude-plugins-official`. Same shape as `mcp-directory-listings.md`: everything
pre-drafted so the human pastes rather than composes.

**Status: prepared, not submitted.** Two preconditions are open — see below.

## Why this route and not the Connectors Directory

Claude's **Connectors Directory** (the claude.ai connector browse list) can only be
submitted from a **Team or Enterprise claude.ai organization**; Organization settings
do not exist on individual plans. Team is a 2-seat minimum at $25/seat/month, so
**$50/month purely to unlock the submission form**, and paying does not buy
acceptance. Deferred as a cost decision.

The plugin directory is free and self-serve. Anthropic's own docs: *"Individual
authors who aren't part of a claude.ai Team or Enterprise organization can sign up
for Console at platform.claude.com and submit there."*

Two consequences to hold onto:

- A plugin listing **does not** put the connector in claude.ai chat. Separate
  directories. The plugin reaches Claude Code and Cowork users, which is the
  developer audience the Dev plan ($19.99/mo, 200 credits) was built for.
- Anthropic *"strongly encourages using connectors that already exist in the
  Connectors Directory"* and says it raises the odds of verification and reduces the
  warnings users see. Ours is not in the directory, so expect more warnings and a
  lower chance of the Verified badge. Disclose, don't hide.

## The submission

- **Form:** <https://platform.claude.com/plugins/submit> (Console org — free to create)
- **Public repo:** <https://github.com/avisre/stockportfolio-claude-plugin>
- **License:** MIT (required — closed-source plugins are not accepted)
- **Bundles:** one remote MCP connector (7 tools) + 2 skills
- **Documentation URL:** <https://www.stockportfolio.pro/docs/api-mcp>
- **Support:** support@stockportfolio.pro

The Console form takes little more than the repo link, so the real listing copy lives
**in the repo** — `README.md` is the storefront a user reads before installing, and
`plugin.json`'s `description` is what the directory shows. Both are written.

## Preconditions — both must be true before submitting

- [ ] **Deploy the annotations fix.** The plugin points at
  `https://www.stockportfolio.pro/mcp`, and that endpoint must serve
  `readOnlyHint: true` on all 7 tools. Verified 2026-09-25: production currently
  returns **7 titles and 0 annotations** — the fix is in the repo, not yet live.
  Directory review requires the hint, so submitting before the deploy fails on a
  point we have already fixed.
- [ ] **Deploy the bot-blocker exemption.** `/docs/api-mcp` and `/privacy` are
  declared to Anthropic and must be readable by their review. Both answered **403**
  to a non-browser fetch before the fix (`anthropic-ai` and `claudebot` are in
  `DENY_PATTERNS`), which is the same trap that blocked the AppSumo listing on 9/23.

## Reviewer test account

Reviewers need credentials for a **fully populated account** to exercise the tools.

- Use the internal test account (`rin@gmail.com` — excluded from all customer,
  funnel and usage counts; never quote it as a customer).
- **Tool calls spend credits.** `mcp_lookup` is 2, `mcp_ask` is 42. Either keep a
  balance on that account or tell them plainly that the **keyless tier is enough to
  exercise every tool** — 2 asks and 50 lookups per 30 days, no key needed at all.
  The keyless path is the honest answer here: it needs no credential handover, and
  every tool is reachable through it.
- Auth is OAuth 2.1 with dynamic client registration, so there is no key to paste:
  connecting opens a sign-in window. Nothing in this plugin asks a user for a key.

## What a reviewer will look at, and the answer

| Question | Answer |
| --- | --- |
| Whose API does it call? | Our own first-party filing service. |
| Any third-party data? | Yes — `sp_fund` returns **third-party fund data we do not own** (costs, holdings, allocation, performance, risk). It is labelled as fund data everywhere and is not presented as SEC company data. |
| Does it write anything? | No. All 7 tools are read-only and declare `readOnlyHint`. |
| Does it collect conversation data or read user files? | No. The MCP ask path runs with an empty history and no holdings, and never persists the exchange — only the website's own ask routes do. |
| Coverage limits? | US-listed companies reporting in USD to the SEC. No international listings, no analyst estimates, no forward data. Stated in the skill, the README and the tool descriptions. |

## Deferred — the Connectors Directory, if it is ever worth $50/month

Needs the 2-seat Team plan, then
`claude.ai/admin-settings/directory/submissions/new`. The portal fields are name
(≤100 chars), tagline (≤55), description (≤2000), 1–5 categories, documentation URL,
privacy policy URL, support contact, a **permanent** URL slug, icon, use cases,
company, auth mode, data handling, test account, and seven compliance
acknowledgments. Submit in `claude.ai`, not Console — the Console escape hatch is
plugins only.

Two extras that route needs and this one does not:

- **An icon.** None exists in the repo: `frontend-v2` carries no icon, logo or
  favicon file at all, and static images live in the legacy `frontend/Media/`
  directory. Do not fabricate a brand asset; it needs the owner's sign-off.
- **A privacy policy URL** (`/privacy` — exists and is fine to declare).

Its escalation path is also worth knowing: every submission lists as a **community
connector** first, and Anthropic may escalate a highly-used one to verified review,
which runs a **functional test of every tool**. That is why the all-tools smoke test
matters — it decides the escalated case, not just the initial one.
