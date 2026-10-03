# Local Ask answer review

Start from the repository root:

```sh
node scripts/dev-ask-review.js
```

Open **http://127.0.0.1:5056/**. Generate the short and complex examples, or enter your own question in Simple or Analyst mode. Each answer shows displayed word count, prose/table word count, chart count and response time. Follow-ups can use the last custom conversation. Example questions run independently.

The backend calls the actual Ask engine and configured AI connection, using the existing authorized AI-only environment loader. It serves the actual product renderer and chart styles. It binds to loopback, permits one active request and reads the verified SEC dataset without on-demand refreshes. No account database, production application server, background jobs or account memory are started. Account/portfolio-specific tools are consequently unavailable. This preview is for answer and visualization review, not authentication or billing checks.

The two generated examples from this session are saved locally in `docs/qa/local-ask-review-2026-10-04/`. To reopen those actual model responses after restarting:

```sh
node scripts/dev-ask-review.js --examples docs/qa/local-ask-review-2026-10-04
```

The saved QA files are untracked. Without them, the preview still starts and the buttons generate new examples. New questions make actual AI requests. Regeneration can produce a different answer; invalid output receives the production rewrite/fallback behavior. The preview reports partial answers as partial.

Use `ASK_REVIEW_PORT=5057` for a different port. Stop the process with Ctrl+C. Nothing is deployed by this command.
