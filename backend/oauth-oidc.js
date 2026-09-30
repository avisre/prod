'use strict';

// Helpers for the OpenID Connect surface OpenAI's plugin directory requires:
// /.well-known/openid-configuration and /oauth/userinfo in app.js. They live
// here rather than inline because app.js cannot be booted in a test without a
// database, and the two decisions that actually gate that endpoint — what counts
// as a bearer credential, and what claims are safe to hand back — are worth
// testing for real instead of pinning as source text.

/**
 * Extracts the credential from an Authorization header.
 *
 * The scheme is matched case-insensitively (RFC 7235) and must be followed by a
 * space, so a `Basic` credential — or a header that merely starts with the
 * letters "bearer" — can never be mistaken for a token and handed to the token
 * store.
 */
function bearerToken(header) {
    const value = String(header || '');
    if (value.slice(0, 7).toLowerCase() !== 'bearer ') return '';
    return value.slice(7).trim();
}

/**
 * The claims OpenAI reads to compare a caller's email domain against a ChatGPT
 * Enterprise workspace's verified domains.
 *
 * `sub` is the account id, not the address, so the identifier stays stable if
 * the user later changes email. Returns null when either half is missing, which
 * the caller turns into a 401 rather than serving a claim set with a hole in it:
 * `email_verified: true` is only ever sent alongside the address it describes.
 *
 * email_verified is true because no User document exists until the address is
 * confirmed — registration promotes a PendingSignup to a User only once Stripe
 * or the emailed link confirms it.
 */
function userInfoClaims(resolved, user) {
    const userId = resolved && resolved.userId ? String(resolved.userId) : '';
    const email = user && user.email ? String(user.email) : '';
    if (!userId || !email) return null;
    return { sub: userId, email, email_verified: true };
}

module.exports = { bearerToken, userInfoClaims };
