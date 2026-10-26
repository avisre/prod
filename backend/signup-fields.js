'use strict';

// Signup field checks shared by every email/password signup (owner decision
// 2026-10-26): /api/subscribe and the connector sign-in screen's free-trial
// signup (/oauth/signup, backend/oauth-signup.js) must accept and refuse
// exactly the same things, so the rules live in this one module and each route
// maps the result to its own response helper.
//
// The pure helpers here (email/password validation, SMS-gateway domains) were
// moved verbatim out of app.js so the checks below cannot drift from what the
// rest of the app means by a valid email or an acceptable password.
//
// Errors are plain descriptors ({ status, message, code, field }) rather than
// thrown createHttpErrors: app.js's sendApiError() reads exactly those four
// properties off an error object, so a descriptor can be handed straight to
// it. The messages are the ones /api/subscribe has always answered with —
// moving them here changes nothing on the wire.

// Email-to-SMS gateways (phone-number@carrier). Signup bots use these to text
// strangers' phones via our welcome email — no human signs up with one.
const SMS_GATEWAY_DOMAINS = new Set([
    'vtext.com', 'vzwpix.com',                      // Verizon
    'txt.att.net', 'mms.att.net',                   // AT&T
    'tmomail.net',                                  // T-Mobile
    'messaging.sprintpcs.com', 'pm.sprint.com',     // Sprint
    'msg.fi.google.com',                            // Google Fi
    'sms.myboostmobile.com', 'myboostmobile.com',   // Boost
    'mymetropcs.com', 'email.uscc.net', 'text.republicwireless.com'
]);

function passwordMeetsPolicy(password) {
    if (typeof password !== 'string') return false;
    return password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password);
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function emailLooksValid(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// Provisional display name from an email local-part when no name is supplied
// at sign-up (e.g. "jane.doe@x.com" -> "Jane Doe"). Falls back to "Member".
function deriveNameFromEmail(email) {
    const local = String(email || '').split('@')[0] || '';
    const words = local
        .replace(/[._\-+]+/g, ' ')
        .replace(/[^a-zA-Z ]/g, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
    return words.join(' ') || 'Member';
}

// Honeypot: the register form ships a visually hidden "website" field that
// humans never see or fill. A non-empty value is a form bot. Callers swallow
// the submission (no account, no email, no funnel event) but answer 200 so
// the bot doesn't learn it was detected and adapt.
function signupHoneypotTripped(body) {
    return Boolean(String((body && body.website) || '').trim());
}

/**
 * The shared email/password checks, in /api/subscribe's original order:
 * email required, email valid, not an SMS-gateway address, password
 * required, password policy. Returns null when the fields are acceptable,
 * or the descriptor to answer with.
 */
function signupFieldError(body) {
    const rawEmail = String((body && body.email) || '').trim();
    const normalizedEmail = normalizeEmail(body && body.email);
    if (!rawEmail) {
        return { status: 400, message: 'Please enter your email address.', code: 'EMAIL_REQUIRED', field: 'email' };
    }
    if (!emailLooksValid(rawEmail)) {
        return { status: 400, message: 'Please enter a valid email address.', code: 'EMAIL_INVALID', field: 'email' };
    }
    if (SMS_GATEWAY_DOMAINS.has(normalizedEmail.split('@')[1] || '')) {
        return { status: 400, message: 'Please sign up with a regular email address.', code: 'EMAIL_INVALID', field: 'email' };
    }
    const password = body && body.password;
    if (typeof password !== 'string' || !password) {
        return { status: 400, message: 'Please create a password before continuing.', code: 'PASSWORD_REQUIRED', field: 'password' };
    }
    if (!passwordMeetsPolicy(password)) {
        return {
            status: 400,
            message: 'Password must be at least 8 characters and include uppercase, lowercase, and a number.',
            code: 'PASSWORD_POLICY_FAILED',
            field: 'password'
        };
    }
    return null;
}

// The duplicate-email answer. A separate export, not part of
// signupFieldError(), because /api/subscribe probes it after its Stripe-
// availability check, in exactly that order — see backend/oauth-signup.js
// for the one route that treats it as just another field error.
function signupEmailTakenError() {
    return {
        status: 409,
        message: 'This email is already registered. Use a different email address or sign in with the existing account.',
        code: 'EMAIL_ALREADY_REGISTERED',
        field: 'email'
    };
}

module.exports = {
    SMS_GATEWAY_DOMAINS,
    passwordMeetsPolicy,
    normalizeEmail,
    emailLooksValid,
    deriveNameFromEmail,
    signupHoneypotTripped,
    signupFieldError,
    signupEmailTakenError
};