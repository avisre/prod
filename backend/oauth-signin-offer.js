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

function plural(n, word) {
    return `${n} ${word}${Number(n) === 1 ? '' : 's'}`;
}

function longDate(value) {
    const d = value ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// What the free connector trial includes, in one sentence (mcp-trial.js config).
function trialTerms({ lookups, asks, days }) {
    return `${plural(lookups, 'data lookup')} and ${plural(asks, 'AI answer')}, for ${plural(days, 'day')} from your first request. One trial per account; it does not renew.`;
}

// Shown under the sign-in form to someone with no session: a free account made
// here gets the connector trial (oauth-signup.js), the only free way in. The
// form proves the connector request by sending back the client_id and
// redirect_uri this page was opened with.
function trialSignupHtml({ clientId, redirectUri, trial, price, credits = 200 } = {}) {
    return `<div class="offer" id="trial">
  <h2>No account yet? Start a free connector trial</h2>
  <p>Create a free account here and use this connector with ${escapeHtml(trialTerms(trial || {}))} After that it needs the Monthly plan (${escapeHtml(money(price))}/month, ${Number(credits)} credits a month).</p>
  <form id="ts">
    <input type="hidden" id="ts-client" value="${escapeHtml(clientId)}">
    <input type="hidden" id="ts-redirect" value="${escapeHtml(redirectUri)}">
    <div style="position:absolute;left:-9999px" aria-hidden="true"><label for="ts-website">Website</label><input id="ts-website" type="text" tabindex="-1" autocomplete="off"></div>
    <label for="ts-e">Email</label><input id="ts-e" type="email" autocomplete="email" required>
    <label for="ts-p">Password</label><input id="ts-p" type="password" autocomplete="new-password" minlength="8" required>
    <p class="fine">At least 8 characters, with an uppercase letter, a lowercase letter and a number.</p>
    <button type="submit">Create free account and continue</button>
    <div class="err" id="ts-err"></div>
  </form>
</div>`;
}

// The signup form's submit handler. Same-origin fetch, like the sign-in form;
// a reload then lands on the consent screen with the new session.
function trialSignupScript() {
    return `<script>
document.getElementById('ts').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  var err = document.getElementById('ts-err'); err.textContent = '';
  try {
    var r = await fetch('/oauth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({
        email: document.getElementById('ts-e').value,
        password: document.getElementById('ts-p').value,
        website: document.getElementById('ts-website').value,
        client_id: document.getElementById('ts-client').value,
        redirect_uri: document.getElementById('ts-redirect').value
      })
    });
    if (!r.ok) { var b = await r.json().catch(function(){return {};}); err.textContent = b.message || 'Sign-up failed.'; return; }
    location.reload();
  } catch (_) { err.textContent = 'Sign-up failed. Please try again.'; }
});
</script>`;
}

// Shown under the sign-in form to someone with no session.
function signupOfferHtml({ price, lookupCost, askCost, credits = 200, canResume = true, secondary = false } = {}) {
    const after = canResume
        ? 'After checkout you come straight back here to finish connecting.'
        : 'After checkout, reconnect from your assistant and sign in.';
    return `<div class="offer">
  <h2>${secondary ? 'Or start with the Monthly plan' : 'No account yet?'}</h2>
  <p>The Monthly plan is ${escapeHtml(planSummary({ price, lookupCost, askCost, credits }))}</p>
  <a class="btn" href="${escapeHtml(SIGNUP_URL)}">Get the Monthly plan</a>
  <p class="fine">${escapeHtml(after)}</p>
</div>`;
}

// Shown above the Allow button to a signed-in account whose plan has no
// connector access. It informs; it does not block — Allow still works, and the
// connection picks a new plan up on the next call.
function noAccessNoticeHtml({ price, lookupCost, askCost, credits = 200 } = {}) {
    return `<div class="offer warn">
  <h2>Your plan does not include this connector</h2>
  <p>You can still connect, but every request will be refused until the account has a plan that includes it. The Monthly plan is ${escapeHtml(planSummary({ price, lookupCost, askCost, credits }))}</p>
  <a class="btn" href="${escapeHtml(UPGRADE_URL)}" target="_blank" rel="noopener">See plans</a>
  <p class="fine">Opens in a new tab. This page updates by itself once the plan is active.</p>
</div>`;
}

// Consent screen, signed-in account on a live connector trial: what is left,
// when it ends, and what comes after.
function trialNoticeHtml(status, { price, credits = 200 } = {}) {
    const st = status || {};
    const when = st.started
        ? `It ends on ${longDate(st.endsAt)} (${plural(st.daysLeft, 'day')} left).`
        : `The ${plural(st.days, 'day')} start with your first request.`;
    return `<div class="offer warn">
  <h2>Free connector trial</h2>
  <p>You have ${plural(st.lookupsLeft, 'data lookup')} and ${plural(st.asksLeft, 'AI answer')} left. ${escapeHtml(when)} One trial per account; it does not renew. After it, this connector needs the Monthly plan (${escapeHtml(money(price))}/month, ${Number(credits)} credits a month).</p>
</div>`;
}

// Consent screen, signed-in account whose connector trial is over: ended by
// date or used up. Connecting still works; calls are refused until a plan.
function trialEndedNoticeHtml(status, { price, lookupCost, askCost, credits = 200 } = {}) {
    const st = status || {};
    const why = st.ended ? 'Your free connector trial has ended.' : 'You have used everything in your free connector trial.';
    return `<div class="offer warn">
  <h2>${escapeHtml(why)}</h2>
  <p>You can still connect, but every request will be refused until the account has a plan that includes this connector. The trial does not renew. The Monthly plan is ${escapeHtml(planSummary({ price, lookupCost, askCost, credits }))}</p>
  <a class="btn" href="${escapeHtml(UPGRADE_URL)}" target="_blank" rel="noopener">See plans</a>
  <p class="fine">Opens in a new tab. This page updates by itself once the plan is active.</p>
</div>`;
}

// ChatGPT's app guidelines also cover this screen when ChatGPT is the client:
// no trial, price, plan offer or checkout link, and no new-account signup
// (owner decision 2026-10-26). What they allow is saying the account lacks an
// entitlement and linking to an informational page about plans, which is the
// homepage's plans section. ChatGPT returns to chatgpt.com/connector/oauth/...
// (or the legacy chatgpt.com/connector_platform_oauth_redirect), so the
// redirect_uri host identifies it; openai.com is covered for older clients.
const INFO_URL = '/?utm_source=connector&utm_campaign=chatgpt#pricing';
const HOME_URL = '/?utm_source=connector&utm_campaign=chatgpt';

function isChatGptRedirect(redirectUri) {
    let host;
    try { host = new URL(String(redirectUri || '')).hostname.toLowerCase(); } catch (_) { return false; }
    return ['chatgpt.com', 'openai.com'].some((d) => host === d || host.endsWith(`.${d}`));
}

// Signed out, ChatGPT: where an account comes from, without an offer.
function neutralSigninHtml() {
    return `<div class="offer">
  <h2>No account yet?</h2>
  <p>Accounts are created on the StockPortfolio.pro website. Once you are signed in there, come back to this page to connect.</p>
  <a class="btn" href="${escapeHtml(HOME_URL)}" target="_blank" rel="noopener">Go to StockPortfolio.pro</a>
  <p class="fine">Opens in a new tab. This page continues by itself once you are signed in.</p>
</div>`;
}

// Consent, ChatGPT, account without connector access (never had it, or its
// connector allowance is over): what is unavailable, and where plans are described.
function neutralNoAccessNoticeHtml({ ended = false } = {}) {
    const why = ended ? 'This account’s connector allowance is over' : 'This account does not include this connector';
    return `<div class="offer warn">
  <h2>${escapeHtml(why)}</h2>
  <p>You can still connect, but every request will be refused until the account includes connector access.</p>
  <a class="btn" href="${escapeHtml(INFO_URL)}" target="_blank" rel="noopener">See what is included</a>
  <p class="fine">Opens in a new tab. This page updates by itself once the account has access.</p>
</div>`;
}

// Consent, ChatGPT, account on a live connector trial: what is left, stated as
// the account's allowance.
function neutralAllowanceNoticeHtml(status) {
    const st = status || {};
    const when = st.started
        ? ` until ${longDate(st.endsAt)}`
        : `, for ${plural(st.days, 'day')} from the first request`;
    return `<div class="offer warn">
  <h2>Connector allowance</h2>
  <p>This account has ${plural(st.lookupsLeft, 'data lookup')} and ${plural(st.asksLeft, 'AI answer')} left${escapeHtml(when)}. It does not renew.</p>
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
    resumeCookie, clearResumeCookie, resumeTarget, signupOfferHtml, noAccessNoticeHtml, pollScript,
    trialTerms, trialSignupHtml, trialSignupScript, trialNoticeHtml, trialEndedNoticeHtml,
    INFO_URL, isChatGptRedirect, neutralSigninHtml, neutralNoAccessNoticeHtml, neutralAllowanceNoticeHtml
};
