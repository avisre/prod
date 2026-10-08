'use strict';

// What /oauth/authorize says to someone who cannot use the connector yet.
//
// The screen is the one place an assistant sends a capped trial user that is
// on OUR domain: the ChatGPT app may not show a plan, a price or a checkout
// link (plugin guidelines), and its out-of-allowance message can only say
// "connect an account". Until 2026-10-08 that led to an email and password
// form with nothing for a person who has no account, and to a consent screen
// that let an account without connector access click Allow and then be refused
// on every call.
//
// Two additions, both rendered by app.js from the helpers here:
//   - signed out: the Monthly plan, its price, and a signup link that returns
//     to this same authorization once the payment is through;
//   - signed in without access: the same plan and an upgrade link, above the
//     Allow button rather than after it.
//
// The return trip uses a cookie, not a URL parameter. The authorization request
// is long (PKCE challenge, state, redirect_uri) and passing it through
// /register, Stripe and back would mean a third party's URL riding in ours.
// The cookie holds only the query string of a request that /oauth/authorize
// already accepted, and /oauth/resume sends the browser back to
// /oauth/authorize, which validates the client and redirect_uri again from
// scratch. So the cookie can never send anyone anywhere but our own endpoint.

const RESUME_COOKIE = 'sp_oauth_resume';
const RESUME_MAX_AGE_SECONDS = 2 * 60 * 60;
// A cookie is capped near 4096 bytes including its name and attributes.
const RESUME_MAX_LENGTH = 3500;
// The value register.html accepts as ?next= and hands on through checkout.
const RESUME_NEXT = 'oauth/resume';
const RESUME_PATH = '/oauth/resume';

const SIGNUP_URL = `/register?plan=monthly&next=${encodeURIComponent(RESUME_NEXT)}&utm_source=connector&utm_campaign=oauth_signin`;
const UPGRADE_URL = '/upgrade.html?utm_source=connector&utm_campaign=oauth_no_access';

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(price) {
    const n = Number(price);
    return Number.isFinite(n) && n > 0 ? `$${n.toFixed(2)}` : '';
}

// The Set-Cookie value that remembers this authorization request, or null when
// it is too long to store (the page then simply offers no return trip).
function resumeCookie(queryString, { secure = true } = {}) {
    const qs = String(queryString || '').replace(/^\?/, '');
    if (!qs) return null;
    const value = encodeURIComponent(qs);
    if (value.length > RESUME_MAX_LENGTH) return null;
    return `${RESUME_COOKIE}=${value}; Max-Age=${RESUME_MAX_AGE_SECONDS}; Path=/oauth; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function clearResumeCookie({ secure = true } = {}) {
    return `${RESUME_COOKIE}=; Max-Age=0; Path=/oauth; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// Where /oauth/resume sends the browser: always our own /oauth/authorize, with
// the remembered query, or null when there is nothing usable to resume.
//
// Takes the cookie value as app.js's parseCookieHeader returns it — already
// percent-decoded once, i.e. the original query string. Decoding it again here
// would unescape the redirect_uri inside it and corrupt the request.
function resumeTarget(cookieValue) {
    const qs = String(cookieValue || '').replace(/^\?/, '');
    if (!qs || qs.length > RESUME_MAX_LENGTH) return null;
    const params = new URLSearchParams(qs);
    if (!params.get('client_id') || !params.get('redirect_uri')) return null;
    return `/oauth/authorize?${params.toString()}`;
}

function planSummary({ price, lookupCost, askCost, credits }) {
    const each = [
        Number(lookupCost) > 0 ? `a data lookup costs ${Number(lookupCost)} credits` : '',
        Number(askCost) > 0 ? `an AI answer ${Number(askCost)}` : ''
    ].filter(Boolean).join(', ');
    return `${money(price)} a month, cancel anytime. It includes this connector with ${Number(credits)} credits a month`
        + `${each ? ` (${each})` : ''} and the full StockPortfolio.pro website.`;
}

// Shown under the sign-in form to someone with no session.
function signupOfferHtml({ price, lookupCost, askCost, credits = 100, canResume = true } = {}) {
    const after = canResume
        ? 'After checkout you come straight back here to finish connecting.'
        : 'After checkout, reconnect from your assistant and sign in.';
    return `<div class="offer">
  <h2>No account yet?</h2>
  <p>The Monthly plan is ${escapeHtml(planSummary({ price, lookupCost, askCost, credits }))}</p>
  <a class="btn" href="${escapeHtml(SIGNUP_URL)}">Get the Monthly plan</a>
  <p class="fine">${escapeHtml(after)}</p>
</div>`;
}

// Shown above the Allow button to a signed-in account whose plan has no
// connector access. It informs; it does not block — Allow still works, and the
// connection picks a new plan up on the next call.
function noAccessNoticeHtml({ price, lookupCost, askCost, credits = 100 } = {}) {
    return `<div class="offer warn">
  <h2>Your plan does not include this connector</h2>
  <p>You can still connect, but every request will be refused until the account has a plan that includes it. The Monthly plan is ${escapeHtml(planSummary({ price, lookupCost, askCost, credits }))}</p>
  <a class="btn" href="${escapeHtml(UPGRADE_URL)}" target="_blank" rel="noopener">See plans</a>
  <p class="fine">Opens in a new tab. This page updates by itself once the plan is active.</p>
</div>`;
}

const OFFER_CSS = `.offer{margin-top:22px;padding-top:18px;border-top:1px solid #e8e6e0}
.offer.warn{margin:0 0 20px;padding:14px 16px;border:1px solid #e7c98a;border-radius:10px;background:#fdf8ec}
.offer h2{font-size:15px;margin:0 0 6px}.offer p{font-size:14px;color:#45423c;margin:0 0 12px}
.offer .btn{display:block;text-align:center;padding:11px;border-radius:8px;background:#1c1b18;color:#fff;font-size:15px;font-weight:600;text-decoration:none}
.offer .fine{font-size:12.5px;color:#726e65;margin:10px 0 0}`;

// Reloads the page when the thing it is waiting for becomes true: a session
// (someone signed in or signed up in another tab) or connector access (the
// plan was upgraded in another tab). Polls only while the tab is visible.
function pollScript(waitFor) {
    const field = waitFor === 'access' ? 'hasAccess' : 'signedIn';
    return `<script>
(function () {
  var busy = false;
  function check() {
    if (busy || document.hidden) return;
    busy = true;
    fetch('/oauth/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { if (s && s.${field}) location.reload(); })
      .catch(function () {})
      .then(function () { busy = false; });
  }
  setInterval(check, 4000);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
})();
</script>`;
}

module.exports = {
    RESUME_COOKIE, RESUME_NEXT, RESUME_PATH, RESUME_MAX_AGE_SECONDS, SIGNUP_URL, UPGRADE_URL, OFFER_CSS,
    resumeCookie, clearResumeCookie, resumeTarget, signupOfferHtml, noAccessNoticeHtml, pollScript
};
