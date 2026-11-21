# Known issues and failures

A running log of production failures: what was seen, what caused it, how it was found and fixed, and what
stops it from happening again. Add new entries at the bottom with the next number. Keep secrets, customer
data and private identifiers out of this file: the repository can be public.

Entry format: **Symptom** (what you see, with exact log lines), **Cause**, **How it was found**
(commands you can re-run), **Fix**, **Prevention**, **If it happens again**.

---

## 1. Render deploys die in `git clone` after a data commit pushed by GitHub Actions (2026-11-21)

**Symptom.** From 12:46 UTC (18:16 IST) to 16:44 UTC (22:14 IST) on 2026-11-21, every Render deploy
failed before the build started. The deploy log stopped at the clone step:

```
==> Cloning from https://github.com/avisre/prod
error: RPC failed; curl 28 Operation too slow. Less than 100000 bytes/sec transferred the last 180 seconds
fatal: early EOF
fatal: fetch-pack: invalid index-pack output
==> Retrying git clone...
```

Render retries about 5 times, which takes about 16 minutes, and then fails the deploy. The site stayed up
on the previous deploy, but nothing new could ship.

**Cause.** The cause was commit `09148717aa`, "data: weekly complete-universe financial reconciliation".
GitHub Actions (`refresh-fundamentals.yml`) pushed it as `stockportfolio-bot` from a depth-1
`actions/checkout`. It rewrote about 5,800 files of `frontend/data/sec-financials/`, about 7.8 GB in total.

When anyone fetched that commit, GitHub counted the objects and then compressed them at about 2 objects
per second. No bytes were sent for minutes, so Render's 100 KB/s-for-180-s floor killed the clone every
time.

Earlier data commits of the same size had been pushed from the dev machine as `stockportfolio-dev`, and
they cloned normally. Why GitHub has to recompress the bot's push is an inference: a depth-1 runner sends
the objects in a form GitHub cannot reuse. What was measured is the stall and that it appears only on the
bot's commit.

Render always shallow-clones the **tip of the tracked branch** (`--depth=1`). So deploying a commit from
another branch, or an older commit ID, still fetched the broken tip and still failed.

**How it was found.**
1. Find the last deploy that succeeded and compare the commits since then:
   `git log --format='%h %an %s' <last-live-sha>..origin/main`. Only one new commit was authored by
   `stockportfolio-bot`, and it was the large data commit.
2. Fetch the tip the way Render does, from a scratch directory, and watch the progress lines:
   ```
   git init /tmp/clonetest && cd /tmp/clonetest
   git fetch --depth 1 --progress https://github.com/avisre/prod <sha>
   ```
   - Broken: `Counting objects: 100% (5760/5760)`, then `Compressing objects: 0% (1/5536)` crawls, with no
     `Receiving objects` line for more than 100 s.
   - Healthy: `Receiving objects` starts within seconds.
3. After the revert, the tip carried the same data as `3d364637cb`, and Render cloned it in normal time.

**Fix.** Commit `3e4e5e4834` reverted the data commit on `main`, which put the data back to `3d364637cb`
and kept every code change. Render cloned it normally, and the deploy went live at 16:44 UTC.

The 2026-11-21 weekly data is therefore not live. To re-apply it, regenerate it on the dev machine with
`scripts/refresh-data-local.sh fundamentals`. Before expecting Render to deploy it, check with the fetch
test in step 2 that GitHub serves the pushed commit quickly.

**Prevention.** Data refreshes no longer run on GitHub at all (owner decision, 2026-11-21). GitHub only
stores what is pushed to it.
- `refresh-fundamentals.yml`, `refresh-quotes.yml`, `refresh-price-history.yml` and the
  `refresh-fundamentals-monthly.yml` redirect were disabled on GitHub and deleted from the repo.
- The same steps now run on the owner's machine through `scripts/refresh-data-local.sh
  quotes|prices|fundamentals`. It makes one local commit as the normal dev identity and never pushes.
- The push goes through the pre-push hook (`scripts/predeploy.js`) like any other change.
- The only GitHub workflows left are `deploy-render.yml` (asks Render to deploy the head of `main`),
  `set-render-env.yml` (manual) and `financial-infrastructure-check.yml` (runs only on the old
  `data-foundation-20261005` branch).

**If it happens again.**
1. If a deploy log shows `curl 28 ... early EOF` at the clone step, run the fetch test in step 2 against
   the tip of `main`.
2. If it stalls in "Compressing objects", the tip commit is the problem, not Render. Revert or replace that
   commit on `main`.
3. Changing Render settings or deploying another branch does not help, because Render clones the tip of
   `main` either way.
