# Growth Measurement V1 test record

This file is updated by the implementation test run. It intentionally contains
no production identifiers, customer data or analytics secrets.

* Branch: `feat/growth-measurement-v1`
* Production deployment: **not performed**
* Production data writes: **none**
* External GA4/Clarity mutation: **none**

Focused V1 attribution/GA4/report tests: **11 passed**.
Full backend suite: **130 passed, 0 failed**.

Syntax checks passed for the backend, frontend runtime, attribution/report,
importer, migration and campaign-link scripts. A fixture report was generated
read-only and a Hacker News campaign URL smoke test preserved its allowlisted
source/content/click IDs. `git diff --check` passed.

Run `npm test` from `backend/` and the focused V1 test before review.
