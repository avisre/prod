// Transactional email for new-user signup:
//   1. a marketing/onboarding welcome email to the new user
//   2. a notification email to the site owner
//
// Configured entirely via env (SMTP). If SMTP is not configured the module
// safely no-ops (logs a warning) so signup never fails because of email.
//
// SMTP setup: authorize the support mailbox (for example, Namecheap Private
// Email) and store its app/mailbox password in Render secrets:
//   SMTP_HOST=mail.privateemail.com  SMTP_PORT=465  SMTP_SECURE=true
//   SMTP_USER=support@stockportfolio.pro  SMTP_PASS=<mailbox password>
//   MAIL_FROM is intentionally ignored for customer-facing mail. All product
//   messages use the verified support identity below so customers never receive
//   lifecycle email from a founder's personal address. OWNER_NOTIFICATION_EMAIL
//   may remain the founder's address for internal alerts only.

const nodemailer = require('nodemailer');
const directLtd = require('./direct-ltd');
const tierLimits = require('../lib/tier-limits');
const SUPPORT_EMAIL = 'support@stockportfolio.pro';
const SUPPORT_FROM = `StockPortfolio.pro Support <${SUPPORT_EMAIL}>`;

// Env is read lazily so this module works regardless of require order
// relative to dotenv.config().
function config() {
  return {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true', // true for port 465
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: SUPPORT_FROM,
    support: SUPPORT_EMAIL,
    owner: process.env.OWNER_NOTIFICATION_EMAIL || 'avinashsreekumar007@gmail.com',
    appUrl: process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro',
  };
}

function isMailerConfigured() {
  const c = config();
  // Never treat a personal Gmail (or any other mailbox) as a valid sender for
  // customer lifecycle mail. The SMTP credential must belong to the support
  // mailbox whose identity is used in the From and Reply-To headers.
  return Boolean(
    c.host &&
    c.user &&
    c.pass &&
    c.user.trim().toLowerCase() === SUPPORT_EMAIL
  );
}

function smtpStatus() {
  const c = config();
  const user = c.user.trim().toLowerCase();
  return {
    configured: isMailerConfigured(),
    hostPresent: Boolean(c.host),
    port: c.port,
    secure: c.secure,
    user: c.user || null,
    userIsSupport: user === SUPPORT_EMAIL,
    from: c.from,
    replyTo: c.support,
  };
}

let cachedTransporter = null;
function getTransporter() {
  if (!isMailerConfigured()) return null;
  if (!cachedTransporter) {
    const c = config();
    cachedTransporter = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      auth: { user: c.user, pass: c.pass },
    });
  }
  return cachedTransporter;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function welcomeEmail(name, appUrl) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const safeFirst = escapeHtml(first);
  const dash = `${appUrl.replace(/\/$/, '')}/dashboard.html`;
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <h1 style="font-size:22px;margin:0 0 12px">Welcome to Stock Portfolio Pro, ${safeFirst} 👋</h1>
    <p style="font-size:15px;line-height:1.6;color:#334155">
      Your account is ready. Here's how to get the most out of it:
    </p>
    <ul style="font-size:15px;line-height:1.7;color:#334155;padding-left:18px">
      <li>Add your holdings — tickers, quantities, and purchase prices.</li>
      <li>Track allocation, fundamentals, and performance in one calm dashboard.</li>
      <li>No broker connection required; your data stays yours.</li>
    </ul>
    <p style="margin:22px 0">
      <a href="${dash}" style="background:#6d5cff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block">Open your dashboard</a>
    </p>
    <p style="font-size:13px;color:#64748b;line-height:1.6">
      Questions? Just reply to this email. Not financial advice.<br/>
      — The Stock Portfolio Pro team
    </p>
  </div>`;
  const text = `Welcome to Stock Portfolio Pro, ${first}!

Your account is ready. Add your holdings, then track allocation, fundamentals, and performance in one dashboard.

Open your dashboard: ${dash}

Questions? Just reply to this email. Not financial advice.
— The Stock Portfolio Pro team`;
  return { html, text };
}

function ownerEmail({ name, email, plan }) {
  const when = new Date().toISOString();
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
    <h2 style="margin:0 0 10px">New signup 🎉</h2>
    <table style="font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 10px 4px 0;color:#64748b">Name</td><td>${escapeHtml(name) || '(not provided)'}</td></tr>
      <tr><td style="padding:4px 10px 4px 0;color:#64748b">Email</td><td>${escapeHtml(email)}</td></tr>
      <tr><td style="padding:4px 10px 4px 0;color:#64748b">Plan</td><td>${escapeHtml(plan) || '(unknown)'}</td></tr>
      <tr><td style="padding:4px 10px 4px 0;color:#64748b">When</td><td>${when}</td></tr>
    </table>
  </div>`;
  const text = `New signup\nName: ${name || '(not provided)'}\nEmail: ${email}\nPlan: ${plan || '(unknown)'}\nWhen: ${when}`;
  return { html, text };
}

function customerLifecycleEmail({ name, type, plan, tier, appUrl, redeemedAt }) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const safeFirst = escapeHtml(first);
  const dashboard = `${String(appUrl || '').replace(/\/$/, '')}/dashboard.html`;
  const safeDashboard = escapeHtml(dashboard);
  const isAppSumo = type === 'appsumo_redeemed';
  const subject = isAppSumo
    ? 'Your StockPortfolio.pro AppSumo access is active'
    : 'Your StockPortfolio.pro subscription is active';
  const detail = isAppSumo
    ? `Your AppSumo lifetime plan${plan ? ` (${escapeHtml(plan)})` : ''} is now linked to this account.`
    : `Your paid subscription${plan ? ` (${escapeHtml(plan)})` : ''} is now active.`;
  const textDetail = isAppSumo
    ? `Your AppSumo lifetime plan${plan ? ` (${plan})` : ''} is now linked to this account.`
    : `Your paid subscription${plan ? ` (${plan})` : ''} is now active.`;
  // Inventory what the redeemed tier actually opens. Buyer activation emails
  // used to name no surfaces at all, and a customer who bought via AppSumo ran
  // the product for two months without discovering the Filing Change Monitor
  // he had already paid for.
  //
  // The cap is RESOLVED by lib/tier-limits.js, never restated here. This line
  // used to hardcode 12/40/unlimited, so once the V2 caps go live a buyer capped
  // at 8 would have been emailed a promise of "unlimited companies" on the day
  // they paid. redeemedAt selects the cohort, so a grandfathered buyer still
  // reads their original number; falling back to now is correct because this
  // email IS the redemption event.
  const monitorCapText = tierLimits.monitorCapLabel({
    appsumoRedeemedAt: redeemedAt || new Date(),
    appsumoTier: Number(tier) || null
  }) || 'unlimited companies';
  const includesItems = [
    'Research Dossiers — an initiation-grade report on any of 6,000+ US stocks, in plain English, no prompting',
    `Filing Change Monitor — watch ${monitorCapText} and get a plain-English summary of each new filing`,
    'Every number cited to the filing it came from — never guessed'
  ];
  const includesHtml = isAppSumo ? `
    <p style="font-size:15px;line-height:1.6;color:#334155;margin:18px 0 6px"><strong>Your plan includes:</strong></p>
    <ul style="font-size:14px;line-height:1.7;color:#334155;margin:0;padding-left:20px">${includesItems.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '';
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <h1 style="font-size:22px;margin:0 0 12px">Access confirmed, ${safeFirst}</h1>
    <p style="font-size:15px;line-height:1.6;color:#334155">${detail}</p>${includesHtml}
    <p style="margin:22px 0"><a href="${safeDashboard}" style="background:#6d5cff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block">Open your dashboard</a></p>
    <p style="font-size:13px;color:#64748b;line-height:1.6">Need help? Reply to this email or write to ${SUPPORT_EMAIL}.<br/>— StockPortfolio.pro Support</p>
  </div>`;
  const includesText = isAppSumo ? `\n\nYour plan includes:\n${includesItems.map((i) => `- ${i}`).join('\n')}` : '';
  const text = `Access confirmed, ${first}\n\n${textDetail}${includesText}\n\nOpen your dashboard: ${dashboard}\n\nNeed help? Reply to this email or write to ${SUPPORT_EMAIL}.\n— StockPortfolio.pro Support`;
  return { subject, html, text };
}

function internalCustomerEventEmail({ name, email, type, plan, tier, occurredAt }) {
  const label = type === 'appsumo_redeemed' ? 'New AppSumo buyer activated' : 'New paid subscriber activated';
  const when = occurredAt instanceof Date ? occurredAt.toISOString() : new Date().toISOString();
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
    <h2 style="margin:0 0 10px">${escapeHtml(label)}</h2>
    <table style="font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 10px 4px 0;color:#64748b">Name</td><td>${escapeHtml(name) || '(not provided)'}</td></tr>
      <tr><td style="padding:4px 10px 4px 0;color:#64748b">Email</td><td>${escapeHtml(email)}</td></tr>
      <tr><td style="padding:4px 10px 4px 0;color:#64748b">Channel</td><td>${type === 'appsumo_redeemed' ? 'AppSumo' : 'Stripe'}</td></tr>
      <tr><td style="padding:4px 10px 4px 0;color:#64748b">Plan</td><td>${escapeHtml(plan) || '(unknown)'}</td></tr>
      ${tier ? `<tr><td style="padding:4px 10px 4px 0;color:#64748b">AppSumo tier</td><td>${escapeHtml(tier)}</td></tr>` : ''}
      <tr><td style="padding:4px 10px 4px 0;color:#64748b">When</td><td>${escapeHtml(when)}</td></tr>
    </table>
  </div>`;
  const text = `${label}\nName: ${name || '(not provided)'}\nEmail: ${email || '(unknown)'}\nChannel: ${type === 'appsumo_redeemed' ? 'AppSumo' : 'Stripe'}\nPlan: ${plan || '(unknown)'}${tier ? `\nAppSumo tier: ${tier}` : ''}\nWhen: ${when}`;
  return { subject: `${label}: ${email || 'unknown'}`, html, text };
}

function passwordResetEmail(name, resetUrl) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const safeFirst = escapeHtml(first);
  const safeUrl = escapeHtml(resetUrl);
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <h1 style="font-size:22px;margin:0 0 12px">Reset your password</h1>
    <p style="font-size:15px;line-height:1.6;color:#334155">
      Hi ${safeFirst}, we got a request to reset the password for your Stock Portfolio Pro account.
      Click the button below to choose a new one. This link expires in 1 hour and can be used once.
    </p>
    <p style="margin:22px 0">
      <a href="${safeUrl}" style="background:#6d5cff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block">Reset my password</a>
    </p>
    <p style="font-size:13px;color:#64748b;line-height:1.6">
      If the button doesn't work, paste this link into your browser:<br/>
      <a href="${safeUrl}" style="color:#6d5cff;word-break:break-all">${safeUrl}</a>
    </p>
    <p style="font-size:13px;color:#64748b;line-height:1.6">
      Didn't request this? You can safely ignore this email — your password won't change.<br/>
      — The Stock Portfolio Pro team
    </p>
  </div>`;
  const text = `Reset your password

Hi ${first}, we got a request to reset the password for your Stock Portfolio Pro account.
Open this link to choose a new one (expires in 1 hour, single use):

${resetUrl}

Didn't request this? You can safely ignore this email — your password won't change.
— The Stock Portfolio Pro team`;
  return { html, text };
}

// Post-redemption honest-review drip for AppSumo buyers. Three stages
// (0-indexed stage arg is the stage being sent: 1=24h welcome, 2=day-3 check-in,
// 3=day-10 final ask). CRITICAL: never offer anything in return for a review —
// incentivized reviews (even honest ones) are an AppSumo delisting offense. Send
// the same unconditional request to every buyer; support is a separate option,
// never a reason to suppress or delay a positive, mixed, or critical review.
function appsumoReviewEmail(name, appUrl, stage, reviewUrl, unsubUrl) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const safeFirst = escapeHtml(first);
  const dash = `${String(appUrl).replace(/\/$/, '')}/dashboard.html`;
  const safeReview = escapeHtml(reviewUrl);
  const safeDash = escapeHtml(dash);
  const safeUnsub = escapeHtml(unsubUrl || '');
  const btn = (href, label, bg) => `<a href="${href}" style="background:${bg};color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block">${label}</a>`;
  const foot = (extra) => `
    <p style="font-size:13px;color:#64748b;line-height:1.6">
      ${extra}Reply to this email any time — it reaches me, the founder, directly. Not financial advice.<br/>
      — Avinash, StockPortfolio.pro${safeUnsub ? `<br/><a href="${safeUnsub}" style="color:#94a3b8;font-size:12px">Stop these emails</a>` : ''}
    </p>`;

  let subject, body, textBody;
  if (Number(stage) <= 1) {
    subject = 'Your StockPortfolio.pro lifetime deal is live — here\'s where to start';
    body = `
      <h1 style="font-size:22px;margin:0 0 12px">Welcome aboard, ${safeFirst} 🎉</h1>
      <p style="font-size:15px;line-height:1.6;color:#334155">Thanks for grabbing the lifetime deal. The fastest way to see what makes this different: open any company and ask a question — every answer cites the exact 10-K / 10-Q line it came from, so you can verify it, not just trust it.</p>
      <ul style="font-size:15px;line-height:1.7;color:#334155;padding-left:18px">
        <li>Ask something like "what are the biggest risks in the latest 10-K?" — you'll get a cited answer.</li>
        <li>Run the screener or compare two companies side by side on SEC-filed fundamentals.</li>
      </ul>
      <p style="margin:22px 0">${btn(safeDash, 'Open your dashboard', '#6d5cff')}</p>`;
    textBody = `Welcome aboard, ${first}!\n\nThanks for grabbing the lifetime deal. Fastest way to see what's different: open any company and ask a question — every answer cites the exact 10-K/10-Q line, so you can verify it.\n\nOpen your dashboard: ${dash}\n\nReply any time — it reaches me, the founder, directly.\n— Avinash, StockPortfolio.pro`;
  } else if (Number(stage) === 2) {
    subject = 'Would you share your honest StockPortfolio.pro experience?';
    body = `
      <h1 style="font-size:22px;margin:0 0 12px">Quick check-in, ${safeFirst}</h1>
      <p style="font-size:15px;line-height:1.6;color:#334155">You've had a few days with StockPortfolio.pro. If anything is confusing or not working the way you expected, just reply — I read every message and I'd rather fix it than have you stuck.</p>
      <p style="font-size:15px;line-height:1.6;color:#334155">Whether your experience has been positive, mixed, or critical, would you share an honest review on AppSumo? It helps other investors decide whether the tool fits their research process, and your feedback helps shape what I improve next.</p>
      <p style="margin:22px 0">${btn(safeReview, 'Leave an honest review', '#E8412E')} &nbsp; ${btn(safeDash, 'Back to dashboard', '#6d5cff')}</p>`;
    textBody = `Quick check-in, ${first}.\n\nWhether your experience has been positive, mixed, or critical, would you share an honest AppSumo review? It helps other investors decide whether the tool fits their research process: ${reviewUrl}\n\nIf anything is confusing or not working, reply and I'll help.\n— Avinash, StockPortfolio.pro`;
  } else {
    subject = 'Your honest StockPortfolio.pro review';
    body = `
      <h1 style="font-size:22px;margin:0 0 12px">Thanks for being an early buyer, ${safeFirst}</h1>
      <p style="font-size:15px;line-height:1.6;color:#334155">You've had StockPortfolio.pro for about a week and a half now. Would you leave an honest AppSumo review—including what worked, what didn't, and who you think the tool is best for? Positive, mixed, and critical feedback are all welcome.</p>
      <p style="font-size:15px;line-height:1.6;color:#334155">I read every review to decide what to improve next. If you also need help, reply to this email and I'll do my best to sort it.</p>
      <p style="margin:22px 0">${btn(safeReview, 'Leave an honest review', '#E8412E')}</p>`;
    textBody = `Thanks for being an early buyer, ${first}.\n\nWould you leave an honest AppSumo review—including what worked, what didn't, and who you think the tool is best for? Positive, mixed, and critical feedback are all welcome: ${reviewUrl}\n\nIf you also need help, reply and I'll do my best to sort it.\n— Avinash, StockPortfolio.pro`;
  }

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    ${body}
    ${foot(Number(stage) <= 1 ? 'Something not working? ' : '')}
  </div>`;
  return { subject, html, text: textBody };
}

function campaignLink(appUrl, path) {
  return `${String(appUrl || '').replace(/\/$/, '')}${path}`;
}

function appsumoOnboardingEmail(name, appUrl, onboardingVideoUrl, unsubUrl, channel) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const link = campaignLink(appUrl, '/onboarding?source=email&content_id=appsumo-onboarding');
  const video = onboardingVideoUrl ? `\nOptional walkthrough: ${onboardingVideoUrl}` : '';
  const isDirect = channel === 'direct-ltd';
  const accessLine = isDirect ? 'Your lifetime access is active.' : 'Your AppSumo access is active.';
  const refundDaysNum = directLtd.refundDays();
  const refundTextLine = isDirect
    ? `\n\nRefunds: this purchase was made directly with us, so it carries our own ${refundDaysNum}-day refund window (not AppSumo's separate 60-day policy). To request a refund within that window, reply to this email or contact support@stockportfolio.pro.`
    : `\n\nRefunds: this purchase was made through AppSumo, so refunds go through AppSumo's own 60-day refund process, not us directly.`;
  const refundHtmlLine = isDirect
    ? `<p style="font-size:13px;color:#64748b">Refunds: bought direct, so it carries our own ${refundDaysNum}-day refund window (not AppSumo's separate 60-day policy). Reply to this email or write to ${SUPPORT_EMAIL} within that window to request one.</p>`
    : `<p style="font-size:13px;color:#64748b">Refunds: bought via AppSumo, so refunds go through AppSumo's own 60-day refund process, not us directly.</p>`;
  const text = `Hi ${first},\n\n${accessLine} The fastest first win is one cited research result: choose a ticker, ask one focused question, and open the filing source. Start here: ${link}${video}${refundTextLine}\n\nIf anything is unclear, reply to this email and support@stockportfolio.pro will help.\n— StockPortfolio.pro Support`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial;max-width:560px;color:#0f172a"><h1>Run your first cited result, ${escapeHtml(first)}</h1><p>${accessLine} The fastest first win is one focused stock question with the filing source opened.</p><p><a href="${escapeHtml(link)}" style="background:#111827;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Start the five-minute workflow</a></p>${onboardingVideoUrl ? `<p><a href="${escapeHtml(onboardingVideoUrl)}">Watch the optional walkthrough</a></p>` : ''}${refundHtmlLine}<p style="font-size:13px;color:#64748b">Need help? Reply to this message or write to ${SUPPORT_EMAIL}. ${unsubUrl ? `<a href="${escapeHtml(unsubUrl)}">Stop AppSumo emails</a>` : ''}</p></div>`;
  return { subject: 'Run your first cited StockPortfolio.pro result', html, text };
}

function appsumoActivationNextEmail(name, appUrl, unsubUrl) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const link = campaignLink(appUrl, '/onboarding?source=email&content_id=appsumo-activation-next');
  const text = `Hi ${first},\n\nTry one of these next: compare two companies, check whether earnings convert to cash, or inspect the latest filing timeline. Start here: ${link}\n\nReply if you want help with a ticker.\n— StockPortfolio.pro Support`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial;max-width:560px;color:#0f172a"><h1>Three useful questions to try next</h1><p>Compare two companies, check whether earnings convert to cash, or inspect the latest filing timeline.</p><p><a href="${escapeHtml(link)}">Continue the research workflow</a></p><p style="font-size:13px;color:#64748b">Reply for help with a ticker. ${unsubUrl ? `<a href="${escapeHtml(unsubUrl)}">Stop AppSumo emails</a>` : ''}</p></div>`;
  return { subject: 'Three useful StockPortfolio.pro questions to try next', html, text };
}

function appsumoInactiveEmail(name, appUrl, unsubUrl) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const link = campaignLink(appUrl, '/onboarding?source=email&content_id=appsumo-inactive');
  const text = `Hi ${first},\n\nIf you have not had a chance to try StockPortfolio.pro, enter one ticker and ask one question. The result includes its source trail: ${link}\n\nIf you need help, reply to this email.\n— StockPortfolio.pro Support`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial;max-width:560px;color:#0f172a"><h1>Try one ticker, ${escapeHtml(first)}</h1><p>Enter a ticker and ask one question. The result includes its source trail so you can verify it.</p><p><a href="${escapeHtml(link)}">Try the workflow</a></p><p style="font-size:13px;color:#64748b">Need help? Reply to this email. ${unsubUrl ? `<a href="${escapeHtml(unsubUrl)}">Stop AppSumo emails</a>` : ''}</p></div>`;
  return { subject: 'Try StockPortfolio.pro with one ticker', html, text };
}

function appsumoReviewEligibleEmail(name, appUrl, reviewUrl, unsubUrl) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const link = String(reviewUrl || 'https://appsumo.com/account/products/');
  const text = `Hi ${first},\n\nYou have completed enough research to decide whether StockPortfolio.pro fits your workflow. If you choose to, please leave an honest review on AppSumo—positive, mixed, or critical. There is no reward or rating requested.\n\nReview: ${link}\n\nNeed help? Reply to support@stockportfolio.pro.\n— StockPortfolio.pro Support`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial;max-width:560px;color:#0f172a"><h1>Would you share an honest review?</h1><p>You have now had a chance to use the research workflow. If you choose to, please share an honest AppSumo review—positive, mixed, or critical. No rating or reward is requested.</p><p><a href="${escapeHtml(link)}">Leave an honest review</a></p><p style="font-size:13px;color:#64748b">Need help? Reply to support@stockportfolio.pro. ${unsubUrl ? `<a href="${escapeHtml(unsubUrl)}">Stop AppSumo emails</a>` : ''}</p></div>`;
  return { subject: 'If StockPortfolio.pro helped, an honest review is welcome', html, text };
}

// Partner (external publisher) acquisition program — application intake and
// admin decision emails. Kept separate from the customer-ambassador emails
// above since partners are never expected to be paying customers.
function partnerApplicationReceivedEmail(name, appUrl) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const safeFirst = escapeHtml(first);
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <h1 style="font-size:22px;margin:0 0 12px">Thanks for applying, ${safeFirst}</h1>
    <p style="font-size:15px;line-height:1.6;color:#334155">
      We received your StockPortfolio.pro partner program application. We review every application by hand,
      usually within 2 business days.
    </p>
    <p style="font-size:15px;line-height:1.6;color:#334155">
      If approved, you'll get an email with your unique referral link and next steps to activate your account.
      If we can't approve it right now, we'll let you know why.
    </p>
    <p style="font-size:13px;color:#64748b;line-height:1.6">
      Questions in the meantime? Just reply to this email.<br/>
      — The StockPortfolio.pro team
    </p>
  </div>`;
  const text = `Thanks for applying, ${first}

We received your StockPortfolio.pro partner program application. We review every application by hand, usually within 2 business days.

If approved, you'll get an email with your unique referral link and next steps to activate your account. If we can't approve it right now, we'll let you know why.

Questions in the meantime? Just reply to this email.
— The StockPortfolio.pro team`;
  return { subject: 'Your StockPortfolio.pro partner application is under review', html, text };
}

function partnerApplicationNotificationEmail({ name, email, website, audienceSize, contentFocus, promotionalApproach } = {}, appUrl) {
  const row = (label, value) => `<tr><td style="padding:4px 10px 4px 0;color:#64748b;vertical-align:top">${escapeHtml(label)}</td><td>${escapeHtml(value) || '(not provided)'}</td></tr>`;
  const reviewUrl = `${String(appUrl || '').replace(/\/$/, '')}/admin-partners.html`;
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
    <h2 style="margin:0 0 10px">New partner application</h2>
    <table style="font-size:14px;border-collapse:collapse">
      ${row('Name', name)}
      ${row('Email', email)}
      ${row('Website', website)}
      ${row('Audience size', audienceSize)}
      ${row('Content focus', contentFocus)}
      ${row('Promotional approach', promotionalApproach)}
    </table>
    <p style="margin:16px 0"><a href="${escapeHtml(reviewUrl)}" style="color:#6d5cff">Review pending applications</a></p>
  </div>`;
  const text = `New partner application\nName: ${name || '(not provided)'}\nEmail: ${email}\nWebsite: ${website || '(not provided)'}\nAudience size: ${audienceSize || '(not provided)'}\nContent focus: ${contentFocus || '(not provided)'}\nPromotional approach: ${promotionalApproach || '(not provided)'}\n\nReview: ${reviewUrl}`;
  return { subject: `New partner application: ${email || 'unknown'}`, html, text };
}

function partnerApprovedEmail(name, activationUrl) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const safeFirst = escapeHtml(first);
  const safeUrl = escapeHtml(activationUrl);
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <h1 style="font-size:22px;margin:0 0 12px">You're approved, ${safeFirst} 🎉</h1>
    <p style="font-size:15px;line-height:1.6;color:#334155">
      Welcome to the StockPortfolio.pro partner program. You'll earn 30% commission on referred subscription
      sales, held for 30 days to account for refunds, then paid out once your approved balance reaches $100 USD.
    </p>
    <p style="font-size:15px;line-height:1.6;color:#334155">Next steps:</p>
    <ol style="font-size:15px;line-height:1.7;color:#334155;padding-left:18px">
      <li>Set a password for your account.</li>
      <li>Accept the partner program terms.</li>
      <li>Grab your referral link and promotional materials from your dashboard.</li>
    </ol>
    <p style="margin:22px 0">
      <a href="${safeUrl}" style="background:#6d5cff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block">Activate your account</a>
    </p>
    <p style="font-size:13px;color:#64748b;line-height:1.6">
      If the button doesn't work, paste this link into your browser:<br/>
      <a href="${safeUrl}" style="color:#6d5cff;word-break:break-all">${safeUrl}</a>
    </p>
    <p style="font-size:13px;color:#64748b;line-height:1.6">
      Questions? Just reply to this email.<br/>
      — The StockPortfolio.pro team
    </p>
  </div>`;
  const text = `You're approved, ${first}!

Welcome to the StockPortfolio.pro partner program. You'll earn 30% commission on referred subscription sales, held for 30 days to account for refunds, then paid out once your approved balance reaches $100 USD.

Next steps:
1. Set a password for your account.
2. Accept the partner program terms.
3. Grab your referral link and promotional materials from your dashboard.

Activate your account: ${activationUrl}

Questions? Just reply to this email.
— The StockPortfolio.pro team`;
  return { subject: 'Your StockPortfolio.pro partner application is approved', html, text };
}

function partnerDeclinedEmail(name, reason) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const safeFirst = escapeHtml(first);
  const reasonLine = reason ? `<p style="font-size:15px;line-height:1.6;color:#334155">${escapeHtml(reason)}</p>` : '';
  const reasonText = reason ? `\n${reason}\n` : '';
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <h1 style="font-size:22px;margin:0 0 12px">Your partner application, ${safeFirst}</h1>
    <p style="font-size:15px;line-height:1.6;color:#334155">
      Thank you for your interest in the StockPortfolio.pro partner program. We're not able to approve your
      application right now.
    </p>
    ${reasonLine}
    <p style="font-size:15px;line-height:1.6;color:#334155">You're welcome to reapply in 6 months.</p>
    <p style="font-size:13px;color:#64748b;line-height:1.6">
      Questions? Just reply to this email.<br/>
      — The StockPortfolio.pro team
    </p>
  </div>`;
  const text = `Your partner application, ${first}

Thank you for your interest in the StockPortfolio.pro partner program. We're not able to approve your application right now.
${reasonText}
You're welcome to reapply in 6 months.

Questions? Just reply to this email.
— The StockPortfolio.pro team`;
  return { subject: 'Your StockPortfolio.pro partner application', html, text };
}

// Send a single password-reset email. Never throws; returns true only on a
// successful send (false if SMTP isn't configured or the send fails).
async function sendPasswordResetEmail({ to, name, resetUrl } = {}) {
  if (!to || !resetUrl) return false;
  const { html, text } = passwordResetEmail(name, resetUrl);
  return sendMail({ to, subject: 'Reset your Stock Portfolio Pro password', html, text });
}

// Fire onboarding + owner-notification emails for a newly created user.
// Never throws — returns true if at least one send was attempted.
async function sendNewUserEmails({ name, email, plan } = {}) {
  const transporter = getTransporter();
  const c = config();
  if (!transporter) {
    console.warn(`[mailer] SMTP not configured — skipping new-user emails for ${email || '(no email)'}`);
    return false;
  }

  const jobs = [];
  if (email) {
    const w = welcomeEmail(name, c.appUrl);
    jobs.push(transporter.sendMail({
      from: c.from, to: email,
      replyTo: c.support,
      subject: 'Welcome to Stock Portfolio Pro 📈',
      html: w.html, text: w.text,
    }));
  }
  if (c.owner) {
    const o = ownerEmail({ name, email, plan });
    jobs.push(transporter.sendMail({
      from: c.from, to: c.owner,
      replyTo: c.support,
      subject: `New signup: ${email || 'unknown'}`,
      html: o.html, text: o.text,
    }));
  }

  const results = await Promise.allSettled(jobs);
  results.forEach((r) => {
    if (r.status === 'rejected') console.error('[mailer] send failed:', r.reason && r.reason.message);
  });
  return true;
}

// Customer + internal notification for a first paid activation. The caller
// owns idempotency in MongoDB and invokes this only after inserting a unique
// lifecycle event.
async function sendCustomerLifecycleEmails({ name, email, type, plan, tier, occurredAt, redeemedAt } = {}) {
  const transporter = getTransporter();
  const c = config();
  if (!transporter) {
    console.warn(`[mailer] SMTP not configured — skipping ${type || 'customer'} lifecycle mail for ${email || '(no email)'}`);
    return { customerSent: false, ownerSent: false };
  }
  const result = { customerSent: false, ownerSent: false };
  const jobs = [];
  if (email) {
    const customer = customerLifecycleEmail({ name, type, plan, tier, appUrl: c.appUrl, redeemedAt });
    jobs.push(transporter.sendMail({
      from: c.from, to: email, replyTo: c.support,
      subject: customer.subject, html: customer.html, text: customer.text,
    }).then(() => { result.customerSent = true; }));
  }
  if (c.owner) {
    const internal = internalCustomerEventEmail({ name, email, type, plan, tier, occurredAt });
    jobs.push(transporter.sendMail({
      from: c.from, to: c.owner, replyTo: c.support,
      subject: internal.subject, html: internal.html, text: internal.text,
    }).then(() => { result.ownerSent = true; }));
  }
  const settled = await Promise.allSettled(jobs);
  settled.forEach((entry) => {
    if (entry.status === 'rejected') console.error('[mailer] lifecycle send failed:', entry.reason && entry.reason.message);
  });
  return result;
}

// Generic single send (used by the weekly Monitor digest). Never throws;
// no-ops if SMTP isn't configured. Returns true only on a successful send.
// `headers` exists for List-Unsubscribe / List-Unsubscribe-Post (RFC 8058
// one-click). Bulk mail must carry them; transactional mail passes nothing.
async function sendMail({ to, subject, html, text, replyTo, headers } = {}) {
  const transporter = getTransporter();
  const c = config();
  if (!transporter) { console.warn('[mailer] SMTP not configured — skipping send to ' + (to || '(no to)')); return false; }
  if (!to) return false;
  try {
    await transporter.sendMail({ from: c.from, to, subject, html, text, replyTo: replyTo || c.support, ...(headers ? { headers } : {}) });
    return true;
  } catch (e) {
    console.error('[mailer] send failed:', e && e.message);
    return false;
  }
}

// Trial lifecycle emails (no-card trial drip).
function trialEndingEmail(name, appUrl, daysLeft, upgradeUrl, unsubUrl) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const safeFirst = escapeHtml(first);
  const dash = `${String(appUrl).replace(/\/$/, '')}/dashboard.html`;
  const safeUpgrade = escapeHtml(upgradeUrl);
  const safeDash = escapeHtml(dash);
  const safeUnsub = escapeHtml(unsubUrl || '');
  const btn = (href, label, bg) => `<a href="${href}" style="background:${bg};color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block">${label}</a>`;
  const foot = (extra) => `
    <p style="font-size:13px;color:#64748b;line-height:1.6">
      ${extra}Reply to this email any time — it reaches me, the founder, directly. Not financial advice.<br/>
      — Avinash, StockPortfolio.pro${safeUnsub ? `<br/><a href="${safeUnsub}" style="color:#94a3b8;font-size:12px">Stop these emails</a>` : ''}
    </p>`;

  const subject = `Your Pro trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  const body = `
    <h1 style="font-size:22px;margin:0 0 12px">Your Pro trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}, ${safeFirst}</h1>
    <p style="font-size:15px;line-height:1.6;color:#334155">You've been exploring with full access to Pro features — 10-K/10-Q answers with citations, the screener, side-by-side compare, and the red-flag scanner. If you've found them useful, keep going with a paid plan.</p>
    <ul style="font-size:15px;line-height:1.7;color:#334155;padding-left:18px">
      <li>Every question links to the exact SEC filing and line it came from — verify, don't just trust.</li>
      <li>Screen the whole S&P 500 by your rules, or compare two stocks head-to-head on fundamentals.</li>
      <li>Spot red flags automatically — risk patterns that matter in downturns.</li>
    </ul>
    <p style="margin:22px 0">${btn(safeUpgrade, 'Upgrade to Pro', '#6d5cff')}</p>`;
  const textBody = `Your Pro trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}, ${first}.\n\nYou've had full access to 10-K/10-Q answers, the screener, compare, and red-flags. If you've found them useful, keep going with a paid plan.\n\nUpgrade: ${upgradeUrl}\n\nReply any time — it reaches me, the founder, directly.\n— Avinash, StockPortfolio.pro`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    ${body}
    ${foot('Something not working? ')}
  </div>`;
  return { subject, html, text: textBody };
}

function trialExpiredEmail(name, appUrl, upgradeUrl, unsubUrl) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const safeFirst = escapeHtml(first);
  const dash = `${String(appUrl).replace(/\/$/, '')}/dashboard.html`;
  const safeUpgrade = escapeHtml(upgradeUrl);
  const safeDash = escapeHtml(dash);
  const safeUnsub = escapeHtml(unsubUrl || '');
  const btn = (href, label, bg) => `<a href="${href}" style="background:${bg};color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block">${label}</a>`;
  const foot = (extra) => `
    <p style="font-size:13px;color:#64748b;line-height:1.6">
      ${extra}Reply to this email any time — it reaches me, the founder, directly. Not financial advice.<br/>
      — Avinash, StockPortfolio.pro${safeUnsub ? `<br/><a href="${safeUnsub}" style="color:#94a3b8;font-size:12px">Stop these emails</a>` : ''}
    </p>`;

  const subject = 'Your Pro trial ended — pick up where you left off';
  const body = `
    <h1 style="font-size:22px;margin:0 0 12px">Your trial ended, ${safeFirst}</h1>
    <p style="font-size:15px;line-height:1.6;color:#334155">Your Pro trial is no longer active. If you hit a moment where you wanted to see a 10-K answer, run the screener, or spot a red flag — those are the moments to upgrade. Your portfolio and watchlist are saved.</p>
    <p style="font-size:15px;line-height:1.6;color:#334155">Questions about what the Pro plan includes, or need help deciding? Just reply to this email. I read every message.</p>
    <p style="margin:22px 0">${btn(safeUpgrade, 'Upgrade to Pro', '#6d5cff')}</p>`;
  const textBody = `Your Pro trial ended, ${first}.\n\nYour portfolio and watchlist are saved. If you'd like to see the 10-K answers, screener, and red-flags again, upgrade to a paid plan.\n\nUpgrade: ${upgradeUrl}\n\nQuestions? Reply any time.\n— Avinash, StockPortfolio.pro`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    ${body}
    ${foot('')}
  </div>`;
  return { subject, html, text: textBody };
}

// --- Research Briefing (paid newsletter, sold separately from every app plan) ---
//
// Deliberately plain about what was and was not bought. The briefing is sold
// to people who may already hold a lifetime app deal, so the single most
// likely support ticket is "did I just pay twice for the same thing?" — both
// emails below answer that before it is asked.

function briefingWelcomeEmail({ name, priceUsd, companiesPerMonth, appUrl } = {}) {
  const first = (String(name || '').trim().split(/\s+/)[0]) || 'there';
  const perMonth = Number(companiesPerMonth) || 2;
  const amount = Number(priceUsd) || 149;
  const text = `Hi ${first},

You're in — thank you. Here's exactly what you've bought, so there are no surprises later.

What arrives: ${perMonth} companies a month, written up by hand. What the business does, what the numbers say in plain language, every figure traceable back to an SEC filing, and the case against the company set out as clearly as the case for it. No buy signals and no price targets.

When: the first issue reaches you within two weeks, then twice monthly.

What it is not: it is not app access, and it does not change any plan or lifetime deal you already hold — those stay exactly as they are. It is also research, not personalised investment advice. I don't know your circumstances and nothing in it is a recommendation to buy or sell.

Billing: $${amount.toFixed(2)} a year, cancel any time by replying to this email. If the first two issues aren't useful to you, reply and I'll refund you in full.

Reply to this message any time — it reaches me directly, and if there's a company you want examined I'd like to hear it.

— Avinash
StockPortfolio.pro`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial;max-width:560px;color:#0f172a"><h1>You're in, ${escapeHtml(first)}</h1><p>Thank you. Here is exactly what you have bought, so there are no surprises later.</p><p><strong>What arrives:</strong> ${perMonth} companies a month, written up by hand — what the business does, what the numbers say in plain language, every figure traceable back to an SEC filing, and the case against the company set out as clearly as the case for it. No buy signals, no price targets.</p><p><strong>When:</strong> the first issue reaches you within two weeks, then twice monthly.</p><p><strong>What it is not:</strong> it is not app access, and it changes nothing about any plan or lifetime deal you already hold. It is research, not personalised investment advice — I do not know your circumstances, and nothing in it is a recommendation to buy or sell.</p><p><strong>Billing:</strong> $${amount.toFixed(2)} a year, cancel any time by replying to this email. If the first two issues are not useful to you, reply and I will refund you in full.</p><p>Reply to this message any time — it reaches me directly. If there is a company you want examined, I would like to hear it.</p><p style="font-size:13px;color:#64748b">— Avinash, StockPortfolio.pro · ${SUPPORT_EMAIL}</p></div>`;
  return { subject: `You're subscribed to the Research Briefing`, html, text };
}

function briefingOwnerEmail({ email, name, priceUsd, alreadyACustomer } = {}) {
  const amount = Number(priceUsd) || 149;
  const who = `${name ? `${name} · ` : ''}${email || 'unknown'}`;
  const overlap = alreadyACustomer
    ? 'ALSO holds an app account — check their existing plan before replying so you do not sell them something they have.'
    : 'No app account on this email — cold briefing buyer.';
  const text = `Briefing sale: ${who}\n$${amount.toFixed(2)}/yr\n${overlap}\n\nDo now: add to the send list and reply personally within 24h.`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial;max-width:560px;color:#0f172a"><h2>Briefing sale</h2><p><strong>${escapeHtml(who)}</strong><br>$${amount.toFixed(2)}/yr</p><p>${escapeHtml(overlap)}</p><p>Do now: add to the send list and reply personally within 24h.</p></div>`;
  return { subject: `Briefing sale: ${email || 'unknown'}`, html, text };
}

/**
 * Buyer confirmation + owner alert for a paid briefing subscription. The
 * caller owns idempotency (briefingSubscription.record() returns true only on
 * a genuine first insert), so a webhook redelivery never re-sends either mail.
 *
 * Failures are logged and swallowed per-message: the buyer's receipt must not
 * depend on the owner alert succeeding, and neither must return a rejection
 * into a Stripe webhook handler that has to answer 200.
 */
async function sendBriefingPaidEmails({ name, email, priceUsd, companiesPerMonth, alreadyACustomer } = {}) {
  const transporter = getTransporter();
  const c = config();
  if (!transporter) {
    console.warn(`[mailer] SMTP not configured — skipping briefing emails for ${email || '(no email)'}`);
    return { customerSent: false, ownerSent: false };
  }
  const jobs = [];
  if (email) {
    const w = briefingWelcomeEmail({ name, priceUsd, companiesPerMonth, appUrl: c.appUrl });
    jobs.push(['customer', transporter.sendMail({
      from: c.from, to: email, replyTo: c.support,
      subject: w.subject, html: w.html, text: w.text
    })]);
  }
  if (c.owner) {
    const o = briefingOwnerEmail({ email, name, priceUsd, alreadyACustomer });
    jobs.push(['owner', transporter.sendMail({
      from: c.from, to: c.owner, replyTo: c.support,
      subject: o.subject, html: o.html, text: o.text
    })]);
  }
  const results = await Promise.allSettled(jobs.map(([, p]) => p));
  const out = { customerSent: false, ownerSent: false };
  results.forEach((r, i) => {
    const kind = jobs[i][0];
    if (r.status === 'rejected') console.error(`[mailer] briefing ${kind} send failed:`, r.reason && r.reason.message);
    else if (kind === 'customer') out.customerSent = true;
    else out.ownerSent = true;
  });
  return out;
}

module.exports = { sendNewUserEmails, sendBriefingPaidEmails, briefingWelcomeEmail, briefingOwnerEmail, sendCustomerLifecycleEmails, customerLifecycleEmail, sendPasswordResetEmail, appsumoReviewEmail, appsumoOnboardingEmail, appsumoActivationNextEmail, appsumoInactiveEmail, appsumoReviewEligibleEmail, trialEndingEmail, trialExpiredEmail, isMailerConfigured, smtpStatus, sendMail, config, escapeHtml, SUPPORT_EMAIL, partnerApplicationReceivedEmail, partnerApplicationNotificationEmail, partnerApprovedEmail, partnerDeclinedEmail };
