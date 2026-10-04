# Ask rollback — 4 October 2026

The user requested reverting the Ask changes and deploying the rollback.

## Scope

Ask's server prompts, tool responses, synthesis and streaming behavior, segment tool, and client chart rendering are restored to commit `730507cc`, before the Ask enhancements in `d426e4b4`, `4f94545c`, `2527d118`, and `73186a12`. New answer-validation, segment-evidence and Sankey modules, their feature tests, and the local Ask review harness are removed. Existing Ask tests and production deployment validation remain.

The verified SEC financial adapter and universe, current financial/provider datasets and snapshots, security dependency upgrades, supported-provider configuration migration, and genuine sitemap last-modified checks are retained. Shared frontend missing-value parsing and HTML attribute escaping are retained. This rollback restores earlier behavior; it does not assert that answers retain the removed post-generation validation.

The shared asset stamp is `20261004-askrollback1`, applied to frontend pages, server-rendered references and pinned tests. The original dirty developer checkout is untouched.

## Release checks

- Syntax checks and scoped whitespace checks pass.
- Ask server, legacy segment extractor, and Ask CSS match `730507cc` exactly. The frontend runtime differs from that baseline only in missing-value parsing and HTML escaping.
- Financial datasets, verified adapter, dependency manifests and deployment workflow match the preceding production release exactly.
- Existing regressions: 312 passed, zero failed or skipped, on Node 22.23.3. Committed dataset validation passes: 5,724 issuer files and 4,872,473 verified values; zero structural/provenance errors. Coverage remains 6,099 securities, 4,440 ready issuers and 4,498 screenable listings. Root and backend dependency installs report zero vulnerabilities. GitHub's deployment gate independently repeats regressions, validates datasets, exhaustively renders public pages and checks resource acceptance before deploying the triggering SHA.
- Historical Ask readiness reports and QA artifacts document the superseded enhancements; they do not describe the rollback.
