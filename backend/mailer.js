// Transactional email for new-user signup:
//   1. a marketing/onboarding welcome email to the new user
//   2. a notification email to the site owner
//
// Configured entirely via env (SMTP). If SMTP is not configured the module
// safely no-ops (logs a warning) so signup never fails because of email.
//
// Gmail setup: enable 2-Step Verification, create a 16-char App Password, then:
//   SMTP_HOST=smtp.gmail.com  SMTP_PORT=465  SMTP_SECURE=true
//   SMTP_USER=you@gmail.com   SMTP_PASS=<app password>
//   MAIL_FROM="Stock Portfolio Pro <you@gmail.com>"
//   OWNER_NOTIFICATION_EMAIL=you@gmail.com

const nodemailer = require('nodemailer');

// Env is read lazily so this module works regardless of require order
// relative to dotenv.config().
function config() {
  return {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true', // true for port 465
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from:
      process.env.MAIL_FROM ||
      (process.env.SMTP_USER ? `Stock Portfolio Pro <${process.env.SMTP_USER}>` : ''),
    owner: process.env.OWNER_NOTIFICATION_EMAIL || 'avinashsreekumar007@gmail.com',
    appUrl: process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro',
  };
}

function isMailerConfigured() {
  const c = config();
  return Boolean(c.host && c.user && c.pass);
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
      subject: 'Welcome to Stock Portfolio Pro 📈',
      html: w.html, text: w.text,
    }));
  }
  if (c.owner) {
    const o = ownerEmail({ name, email, plan });
    jobs.push(transporter.sendMail({
      from: c.from, to: c.owner,
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

// Generic single send (used by the weekly Monitor digest). Never throws;
// no-ops if SMTP isn't configured. Returns true only on a successful send.
async function sendMail({ to, subject, html, text } = {}) {
  const transporter = getTransporter();
  const c = config();
  if (!transporter) { console.warn('[mailer] SMTP not configured — skipping send to ' + (to || '(no to)')); return false; }
  if (!to) return false;
  try {
    await transporter.sendMail({ from: c.from, to, subject, html, text });
    return true;
  } catch (e) {
    console.error('[mailer] send failed:', e && e.message);
    return false;
  }
}

module.exports = { sendNewUserEmails, sendPasswordResetEmail, isMailerConfigured, sendMail, config, escapeHtml };
