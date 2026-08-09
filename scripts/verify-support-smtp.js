'use strict';

// No-send diagnostic for the customer mailer. It authenticates to SMTP with
// transporter.verify() but never sends a message.
// Run from the repository root after setting the Render/local SMTP variables:
//   node scripts/verify-support-smtp.js

const nodemailer = require('../backend/node_modules/nodemailer');
const mailer = require('../backend/mailer');

const status = mailer.smtpStatus();
console.log(JSON.stringify(status, null, 2));

if (!status.userIsSupport) {
  console.error('SMTP_USER must be exactly support@stockportfolio.pro; no connection attempted.');
  process.exit(2);
}
if (!status.hostPresent || !process.env.SMTP_PASS) {
  console.error('SMTP_HOST and SMTP_PASS are required; no connection attempted.');
  process.exit(2);
}

const c = mailer.config();
const transporter = nodemailer.createTransport({
  host: c.host,
  port: c.port,
  secure: c.secure,
  auth: { user: c.user, pass: c.pass },
});

transporter.verify()
  .then(() => {
    console.log('SMTP authentication verified for support@stockportfolio.pro. No email was sent.');
  })
  .catch((error) => {
    console.error(`SMTP verification failed: ${error && error.message ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
