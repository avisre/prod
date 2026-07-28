# Social browser assistant

This helper opens a dedicated local Chrome profile, verifies an approved draft
against the live StockPortfolio.pro source pages, and fills the X or LinkedIn
composer. It deliberately never clicks Publish/Post. The owner reviews the
draft and performs the final click.

The profile defaults to:

`~/.local/share/stockportfolio-social-profile`

It is outside Git and created with mode `0700`. Do not move cookies, passwords,
tokens or recovery codes into the repository.

## First use

```bash
node scripts/social-compose.js --platform x --draft x-20260729-shares-main
node scripts/social-compose.js --platform linkedin --draft linkedin-20260729-shares
```

The first run opens a visible browser. Complete the platform login/MFA in that
window if prompted. Re-run the command after login if the composer was not yet
available. The browser remains open with the filled draft; review it and click
Publish/Post yourself.

Use `--dry-run` to validate source pages, links, content IDs and character
limits without opening a browser:

```bash
node scripts/social-compose.js --draft x-20260729-shares-main --dry-run
```

The tool performs no replies, quote posts, DMs, likes, follows or automated
engagement. It updates the campaign tracker only when the browser URL changes
to a detected published post URL after the owner confirms publication.
