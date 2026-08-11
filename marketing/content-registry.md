# Campaign content registry

The registry is intentionally small and contains no post text, personal data or
credentials. Add one row for each approved asset before publishing. It records
the stable content/campaign IDs, channel, post/reply type, publication date,
external post ID/URL, destination, CTA, status and paid/boost status. `content_id`
and `campaign_id` are the stable join keys used by first-party events and the
GA4/Clarity reports.

Generate IDs and a tracked URL with:

```bash
node scripts/campaign-link.js --source=x --date=2026-08-11 --kind=post --sequence=01 \
  --content-id=tool-earnings-quality --click-id=x2026081101 --path=/tools/earnings-quality
```

Allowed channels are `x`, `linkedin`, `reddit`, `hackernews`, `creator`,
`newsletter`, and `email`. Keep `destination` to a first-party pathname or the
validated AppSumo bridge; never paste a raw redirect URL into this file.
