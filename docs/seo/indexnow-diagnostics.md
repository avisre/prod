# IndexNow queue diagnostics

Generated: **2026-09-11T18:25:24.592Z**
- Queue file: `/Users/drasharaghavan/prod/seo-data/indexnow-queue.json`
- Counts: `submitted` 9
- Changed in last 24h: **9**

The existing IndexNow sender remains unchanged and must be invoked by the approved data-refresh/deployment workflow. This queue is non-blocking: a failed submission records an error and exponential backoff; page publishing must continue.
