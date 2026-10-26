'use strict';

// Free connector signup — POST /oauth/signup (owner decision 2026-10-26).
//
// WHY THIS EXISTS: the free MCP trial is ONLY for "MCP customers" — accounts
// created through the connector sign-in screen (/oauth/authorize) when an
// assistant sends someone who has no account. Website signups stay paid-first
// exactly as before: /api/subscribe and /api/auth/social still answer 402
// PAID_PLAN_REQUIRED for plan=free. This route is therefore the ONE free
// path, and it is connector-only by construction — it creates nothing until
// the caller proves a live connector request by naming a registered OAuth
// client and one of its EXACT redirect_uris, validated the same way
// GET /oauth/authorize validates them. A bare POST from anywhere else
// creates no account.
//
// The account is shaped like /api/subscribe's free branch: plan FREE_PLAN_ID,
// status active, activatedAt now, no subscription trial dates and no
// paymentRequiredAt — plus mcpTrial = { eligible: true, grantedAt, clientId },
// the ONLY place that flag is ever set. It is what the keyed /mcp routes read
// to decide the account runs on the one-per-account trial (mcp-trial.js),
// whose row never resets: the allowance does not refill, does not roll into a
// new month, and does not come back after a paid plan lapses.
//
// Built as a factory over injected dependencies (the public-api.js pattern),
// so the behaviour is testable without booting app.js. Every dependency is
// passed in, including the User model and the mailer, and nothing here
// requires app.js.

const fields = require('./signup-fields');
const offer = require('./oauth-signin-offer');

function connectorSignupHandler(deps) {
    if (!deps || typeof deps.getClient !== 'function' || !deps.User) {
        throw new Error('connectorSignupHandler requires { getClient, User, ... }');
    }
    const {
        getClient,
        User,
        hashPassword,
        planConfig,
        ensureSubscriptionShape,
        attachSignupAttribution,
        recordCustomerLifecycleEvent,
        sendNewUserEmails,
        trackFunnel,
        createUserToken,
        setAuthCookie,
        trackingRequestFields,
        sendApiError,
        now = () => new Date()
    } = deps;

    return async function handleConnectorSignup(req, res) {
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            // Honeypot: the same silent swallow as /api/subscribe — a bot that
            // fills the hidden field gets a 200 and no account, so it learns
            // nothing about having been detected.
            if (fields.signupHoneypotTripped(body)) return res.status(200).json({ ok: true });

            // Proof of a live connector request, BEFORE anything is created.
            // client_id and its exact redirect_uri are checked the way
            // GET /oauth/authorize checks them, which is what makes the free
            // path connector-only: a bare POST from anywhere else cannot make
            // an account.
            const clientId = String(body.client_id || '');
            const redirectUri = String(body.redirect_uri || '');
            const client = await getClient(clientId).catch(() => null);
            if (!client || !redirectUri || !Array.isArray(client.redirectUris) || !client.redirectUris.includes(redirectUri)) {
                return res.status(400).json({
                    message: 'Please start the sign-in from your assistant\u2019s connection screen and try again.',
                    code: 'OAUTH_CLIENT_UNKNOWN'
                });
            }

            // ChatGPT's sign-in screen offers no signup (oauth-signin-offer.js:
            // its app guidelines rule out a trial and new-account sign-up), so
            // a request naming a ChatGPT redirect is refused rather than
            // granted the trial by a hand-made POST.
            if (offer.isChatGptRedirect(redirectUri)) {
                return res.status(403).json({
                    message: 'Create your account on the StockPortfolio.pro website, then return to this page to connect.',
                    code: 'OAUTH_SIGNUP_UNAVAILABLE'
                });
            }

            // The same field checks /api/subscribe applies, from the module
            // both routes share, so the two entry points cannot drift.
            const fieldError = fields.signupFieldError(body);
            if (fieldError) return sendApiError(res, fieldError);

            const normalizedEmail = fields.normalizeEmail(body.email);
            const existing = await User.findOne({ email: normalizedEmail }).select('_id');
            if (existing) return sendApiError(res, fields.signupEmailTakenError());

            const hashedPassword = await hashPassword(String(body.password));
            const displayName = fields.deriveNameFromEmail(normalizedEmail);
            const grantedAt = now();
            const requestFields = trackingRequestFields(req, res);

            const user = new User({ name: displayName, email: normalizedEmail, password: hashedPassword });
            attachSignupAttribution(user, requestFields);
            // Shaped like /api/subscribe's free branch: an active free plan
            // from the first moment, activated now — and no subscription
            // trial dates, no paymentRequiredAt: this account owes nothing.
            user.subscription = ensureSubscriptionShape(user);
            user.subscription.status = 'active';
            user.subscription.planId = planConfig.planId;
            user.subscription.planName = planConfig.planName;
            user.subscription.price = planConfig.price;
            user.subscription.currency = planConfig.currency;
            user.subscription.billingInterval = planConfig.billingInterval;
            user.subscription.stripePriceId = planConfig.stripePriceId || null;
            user.subscription.trialStartedAt = null;
            user.subscription.trialEndsAt = null;
            user.subscription.activatedAt = grantedAt;
            user.subscription.renewedAt = null;
            user.subscription.lastPaymentAt = null;
            user.paymentRequiredAt = null;
            user.initialRefundStatus = 'not_eligible';
            // The eligibility flag is the only thing that separates a
            // connector trial account from a website one, and this is the
            // only place it is ever set.
            user.mcpTrial = { eligible: true, grantedAt, clientId };
            user.markModified('subscription');
            await user.save();

            recordCustomerLifecycleEvent(user, 'signup', { source: 'connector' })
                .catch((e) => console.error('[customers] connector signup registry error:', e && e.message));
            // New signup: onboarding email + owner notification, exactly the
            // way /api/subscribe's branch does (fire-and-forget).
            sendNewUserEmails({ name: displayName, email: normalizedEmail, plan: planConfig.planName })
                .catch((e) => console.error('[mailer] new-user email error:', e && e.message));
            trackFunnel('signup', user._id, planConfig.planName, {
                authMethod: 'email',
                selectedPlan: planConfig.planId,
                source: 'connector',
                ...requestFields
            });
            trackFunnel('signup_completed', user._id, planConfig.planName, {
                eventName: 'signup_completed',
                dedupeKey: `signup-complete:${String(user._id)}`,
                authMethod: 'email',
                selectedPlan: planConfig.planId,
                source: 'connector',
                ...requestFields
            });

            // Signed in immediately, the way /api/login does: the sign-in
            // screen reloads into the consent screen with this cookie.
            setAuthCookie(res, createUserToken(user), req);
            return res.status(200).json({ ok: true });
        } catch (error) {
            if (error && error.code === 11000) {
                // The unique index is the real gate; the probe above is the
                // friendly face of it. Two concurrent signups with one email
                // still create exactly one account.
                return sendApiError(res, fields.signupEmailTakenError());
            }
            console.error('[oauth-signup] failed:', error && error.message);
            return res.status(500).json({ message: 'Sign-up failed. Please try again.' });
        }
    };
}

module.exports = { connectorSignupHandler };