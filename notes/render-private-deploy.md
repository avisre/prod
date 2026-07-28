# Private Render deployment runbook

The `prod` Render service must remain connected to the private GitHub repository
`avisre/prod`, branch `main`. Do not change repository visibility as part of a
deployment.

If Render logs report that it cannot clone the repository:

1. Open the Render GitHub App installation for the `avisre` account.
2. Add `avisre/prod` under Repository access (or grant access to all required
   repositories).
3. Reconnect the `avisre` GitHub deployment credential in Render Account
   Settings → Git Deployment Credentials.
4. In the `prod` service Settings → Git Credentials, select that credential and
   confirm the repository and `main` branch.
5. Push a harmless verification commit and confirm a `new_commit` deploy reaches
   `live` without a clone warning.

The authenticated Render CLI may trigger an emergency deploy, but the normal
path is a private GitHub push with Render auto-deploy enabled. Never put GitHub,
Render, MongoDB, SMTP, X or LinkedIn credentials in this repository.
