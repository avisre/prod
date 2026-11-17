'use strict';

// One-time code for first-time email verification (owner, 2026-11-18).
//
// The verification email carries a 6-digit code next to the link. The person
// types the code on /verify-email.html in the browser they signed up in, which
// proves the inbox works without leaving the page (and without a mail scanner
// or a different device getting in the way of the link).
//
// Storage: only an HMAC of the code is kept, keyed with the server secret and
// bound to the account id, so a database read cannot be brute-forced offline
// into the code (a bare SHA-256 of six digits could be, in under a second).
//
// Guessing: the attempt counter is per account and is NOT reset when a new
// code is sent. Ten wrong guesses in total leave a 1-in-100,000 chance of
// getting in without the inbox; after that only the link works. Each guess is
// counted by a conditional $inc before the comparison, so parallel requests
// cannot spend more than the cap.

const crypto = require('crypto');

const CODE_DIGITS = 6;
const MAX_ATTEMPTS = 10;

function newCode() {
  return String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

function codeHash(secret, userId, code) {
  return crypto.createHmac('sha256', String(secret || '')).update(`${String(userId)}:${String(code)}`).digest('hex');
}

// People paste "123 456" or "123-456" from the email; anything that is not six
// digits once separators are removed is refused without spending a guess.
function normalizeCode(input) {
  const digits = String(input == null ? '' : input).replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${CODE_DIGITS}}$`).test(digits) ? digits : null;
}

// Sets a fresh code on the (unsaved) user document and returns the plain code
// for the one email. Expiry is the link's (emailVerifyExpires); the caller
// sets both together.
function issue(user, secret) {
  const code = newCode();
  user.emailVerifyCode = codeHash(secret, user._id, code);
  if (!Number.isFinite(Number(user.emailVerifyCodeAttempts))) user.emailVerifyCodeAttempts = 0;
  return code;
}

function clear(user) {
  user.emailVerifyCode = null;
}

function equalHex(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Check a typed code. Returns { ok: true, user } on a match, or
// { ok: false, reason } where reason is one of:
//   'format'  - not six digits (no guess spent)
//   'no_code' - no code outstanding (already verified, or never sent)
//   'expired' - the code (and its link) has expired; send a new one
//   'locked'  - every guess has been used; only the link works now
//   'wrong'   - a guess was spent; attemptsLeft says how many remain
async function check(User, userId, input, { secret, now = new Date() } = {}) {
  const code = normalizeCode(input);
  if (!code) return { ok: false, reason: 'format' };
  const user = await User.findOneAndUpdate(
    {
      _id: userId,
      emailVerifyCode: { $ne: null },
      emailVerifyExpires: { $gt: now },
      emailVerifyCodeAttempts: { $lt: MAX_ATTEMPTS }
    },
    { $inc: { emailVerifyCodeAttempts: 1 } },
    { new: true }
  );
  if (!user) {
    const current = await User.findById(userId);
    if (!current || !current.emailVerifyCode) return { ok: false, reason: 'no_code' };
    if (Number(current.emailVerifyCodeAttempts || 0) >= MAX_ATTEMPTS) return { ok: false, reason: 'locked', attemptsLeft: 0 };
    return { ok: false, reason: 'expired' };
  }
  if (equalHex(user.emailVerifyCode, codeHash(secret, user._id, code))) return { ok: true, user };
  const attemptsLeft = Math.max(0, MAX_ATTEMPTS - Number(user.emailVerifyCodeAttempts || 0));
  return { ok: false, reason: attemptsLeft > 0 ? 'wrong' : 'locked', attemptsLeft };
}

function message(result) {
  switch (result && result.reason) {
    case 'format': return 'Enter the 6-digit code from the email.';
    case 'no_code': return 'There is no code waiting for this account. Send a new verification email.';
    case 'expired': return 'That code has expired. Send a new verification email and use the new code.';
    case 'locked': return 'Too many incorrect codes. Open the link in the verification email instead.';
    default: {
      const left = Number(result && result.attemptsLeft) || 0;
      return `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
    }
  }
}

module.exports = { CODE_DIGITS, MAX_ATTEMPTS, newCode, codeHash, normalizeCode, issue, clear, check, message };
