# Perplexity: connector proposal and custom-connector setup (2026-10-09)

Status: **submitted 2026-10-09** through Perplexity's Connector Marketplace form (https://pplx.ai/connector-form-submission, a seven-page Google Form), from the owner's Google account. Questions go to connectors@perplexity.ai. An earlier email to that address went out with its links rewritten into Google redirects by the Gmail connector, and one to api@perplexity.ai was bounced by a support bot. Commitments made on the form: 30 days' notice of breaking changes; email support on India working days (4 hours for an outage, one business day for a failing tool, two for questions); three test accounts on request. The text below is the superseded email draft. Perplexity has no public directory to submit to. Its listed ("managed")
connectors are chosen by Perplexity; the documented route is an email to `api@perplexity.ai` or the "Submit a
connector proposal" option in its help centre. Until they list us, a Perplexity Pro, Max or Enterprise user adds us
themselves as a custom connector.

## 1. Proposal email (owner sends, from his own address; support@ never sends cold mail)

To: api@perplexity.ai
Subject: Connector proposal: SEC filing data for US public companies (remote MCP, live)

Hello,

I run StockPortfolio.pro and would like to propose it as a managed connector.

What it is: a remote MCP server that returns financial statements and SEC filing text for US-listed companies.
Every figure comes with its fiscal period and a link to the filing that reports it, and a figure a company did
not report comes back as null instead of an estimate. That makes answers about company financials checkable,
which is the part of finance research where a wrong number does the most damage.

Where it stands:
- Endpoint: https://www.stockportfolio.pro/mcp (Streamable HTTP)
- Sign-in: OAuth 2.1 with dynamic client registration and PKCE, or an API key. There is also a small free
  allowance with no account, so it can be tried without signing up.
- Tools: company search, company fundamentals by fiscal period, filing search, filing content, and a question
  tool that answers from the filings.
- It is published in Claude's connector directory.

I can provide a test account, change anything your review needs, and answer technical questions by email.

Avinash Sreekumar
Founder, StockPortfolio.pro

## 2. What a Perplexity user does today (custom connector)

Settings, Connectors, Add connector, Custom. Server URL `https://www.stockportfolio.pro/mcp`.
- **API key:** paste a key from Profile, Developer access. Works with the server as deployed today.
- **OAuth:** Perplexity registers itself as a public client and then refuses a registration response that has
  no client secret (their forum, thread 5172, open since at least June 2026). `backend/oauth-mcp.js` now issues a
  secret to any registration that returns to `perplexity.ai`. **Not deployed, and not tried from a real Perplexity
  account**; the redirect host is taken from the forum reports, so confirm it on the first real attempt (the
  host list can be extended with `OAUTH_SECRET_REDIRECT_HOSTS`).

## 3. Before sending the proposal

1. Deploy the sign-in change, then add the connector from a Perplexity Pro account by OAuth and by API key and
   run one question end to end. A proposal for a connector that fails their own sign-in will not survive review.
2. Confirm the Claude directory listing loads when logged out, since the email cites it.
