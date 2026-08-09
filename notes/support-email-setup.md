# Support email setup

Customer lifecycle messages must be sent through the mailbox `support@stockportfolio.pro`. The personal Gmail identity used for the connected browser/Gmail integration is not a customer sender and must not be used for these messages.

## Render production

In the Render **prod** service, add/update these secret environment variables (do not commit their values):

```text
SMTP_HOST=mail.privateemail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=support@stockportfolio.pro
SMTP_PASS=<support mailbox password or app password>
SUPPORT_INBOX_EMAIL=support@stockportfolio.pro
APP_PUBLIC_URL=https://www.stockportfolio.pro
```

`SMTP_USER` is intentionally required to be the exact support address. A personal Gmail credential is rejected by the mailer even if `MAIL_FROM` is set, so customer mail cannot silently fall back to the founder's identity.

## Verify without sending

After saving the Render secrets and restarting the service, run the no-send check from a local shell with the same values or in a Render shell:

```bash
node scripts/verify-support-smtp.js
```

The check uses SMTP `verify()` only. It does not send a message, print the password, or expose credentials. A successful result confirms that the support mailbox can authenticate and that all customer mail will use `support@stockportfolio.pro` for both `From` and default `Reply-To`.

If verification fails, reset the support mailbox password in Namecheap Private Email and replace only `SMTP_PASS` in Render. Do not put the password in Git, a `.env` file committed to the repository, a browser session, or a marketing queue.

The application continues to allow signup when SMTP is unavailable, but lifecycle messages remain queued/skipped until this verification succeeds. No customer emails should be replayed retroactively or sent in bulk without a reviewed recipient list.
