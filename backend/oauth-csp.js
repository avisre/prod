'use strict';

// Chrome enforces `form-action` across redirects, not just against the form's
// own action URL. The consent form POSTs to /oauth/authorize/decision, which
// immediately 302s to the client's redirect_uri — so that origin has to be
// listed too. When it is not, Chrome aborts the navigation with
// net::ERR_ABORTED and the Allow button appears to do nothing at all, which is
// exactly what ChatGPT's connector hit in production while the loopback
// harness (same-origin redirect) passed.
//
// Only ever called with a redirect_uri already checked against the client's
// registered list, so this widens form-action to an origin the client had to
// prove it owns.
function withConsentFormAction(csp, redirectUri) {
    if (!csp) return csp;
    let origin = '';
    try {
        origin = new URL(String(redirectUri)).origin;
    } catch (_) {
        return csp;
    }
    if (!origin || origin === 'null') return csp;
    return String(csp).replace(/form-action[^;]*/i, (directive) => (
        directive.includes(origin) ? directive : `${directive} ${origin}`
    ));
}

module.exports = { withConsentFormAction };
