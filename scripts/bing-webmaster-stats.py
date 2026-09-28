#!/usr/bin/env python3
"""Read-only Bing Webmaster API report for the registered site.

Every call here is a GET. Nothing in this script submits URLs, changes site
settings, or mutates Bing state.

Usage:
  bing-webmaster-stats.py                 # site-level text summary
  bing-webmaster-stats.py --format json   # full site-level payload
  bing-webmaster-stats.py --week          # last-week report + CSV/JSON exports

Granularity note: GetPageStats/GetQueryStats accept no date-range parameter --
each call returns the whole history every time, in weekly buckets dated on the
Friday that closes the 7 days ending Thursday. "Last week" therefore means the
latest bucket, selected here, not a range asked of the API.
GetRankAndTrafficStats is the only daily-grained source.
"""
import argparse
import csv
import datetime
import json
import os
import re
import requests
import sys

DEFAULT_KEY = os.path.expanduser("~/.local/share/secrets/bing_webmaster.txt")
API = "https://ssl.bing.com/webmaster/api.svc/json"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATE_RE = re.compile(r"/Date\((-?\d+)(?:[+-]\d+)?\)/")
PAGE_FIELDS = ("Query", "Url", "Page", "PageUrl")


def call(name, site, key, **params):
    response = requests.get(
        f"{API}/{name}",
        params={"siteUrl": site, "apikey": key, **params},
        timeout=60,
    )
    try:
        payload = response.json()
    except ValueError:
        payload = {"text": response.text[:500]}
    if response.status_code != 200:
        raise RuntimeError(f"{name} HTTP {response.status_code}: {payload}")
    return payload.get("d", payload)


def parse_date(value):
    """Bing serialises dates as /Date(ms)/. Fall back to ISO, else None."""
    if not value:
        return None
    if isinstance(value, str):
        match = DATE_RE.search(value)
        if match:
            ms = int(match.group(1))
            return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).date()
        try:
            return datetime.date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def as_int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def first_field(row, names):
    for name in names:
        if row.get(name):
            return row[name]
    return ""


def bucket_by_date(rows):
    """Group API rows into {date: [rows]}, dropping rows with no usable date."""
    buckets = {}
    for row in rows or []:
        day = parse_date(row.get("Date"))
        if day is None:
            continue
        buckets.setdefault(day, []).append(row)
    return buckets


def latest_two(buckets):
    keys = sorted(buckets)
    latest = keys[-1] if keys else None
    previous = keys[-2] if len(keys) > 1 else None
    return latest, previous


def normalise(rows, label_fields):
    """Collapse API rows to {label: {impressions, clicks, ctr, position}}."""
    out = {}
    for row in rows:
        label = first_field(row, label_fields)
        if not label:
            continue
        entry = out.setdefault(label, {"impressions": 0, "clicks": 0, "position": 0.0, "_weight": 0})
        impressions = as_int(row.get("Impressions"))
        entry["impressions"] += impressions
        entry["clicks"] += as_int(row.get("Clicks"))
        # Position is an average; weight it by impressions so merged rows stay honest.
        entry["position"] += as_float(row.get("AvgImpressionPosition")) * impressions
        entry["_weight"] += impressions
    for entry in out.values():
        entry["position"] = round(entry["position"] / entry["_weight"], 2) if entry["_weight"] else 0.0
        entry["ctr"] = round(entry["clicks"] / entry["impressions"], 6) if entry["impressions"] else 0.0
        del entry["_weight"]
    return out


def write_csv(path, header, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


def totals(entries):
    clicks = sum(e["clicks"] for e in entries.values())
    impressions = sum(e["impressions"] for e in entries.values())
    return {"clicks": clicks, "impressions": impressions, "ctr": round(clicks / impressions, 6) if impressions else 0.0}


def window_totals(traffic, end, days=7):
    """Exhaustive site totals for the `days`-day window ending on `end`.

    GetRankAndTrafficStats is the only daily-grained, exhaustive source. The
    per-page list from GetPageStats is top-N, so summing it is NOT the site total:
    for the week ending 2026-09-04 that under-reported impressions ~4.6x (329 vs
    1,502) and over-reported CTR ~3.6x (4.56% vs 1.27%). Every headline figure
    goes through here.
    """
    start = end - datetime.timedelta(days=days - 1)
    rows = []
    for row in traffic:
        day = parse_date(row.get("Date"))
        if day and start <= day <= end:
            rows.append(row)
    clicks = sum(as_int(r.get("Clicks")) for r in rows)
    impressions = sum(as_int(r.get("Impressions")) for r in rows)
    return {
        "clicks": clicks,
        "impressions": impressions,
        "ctr": round(clicks / impressions, 6) if impressions else 0.0,
        "days": len(rows),
    }


PHANTOM_MIN_SHARE = 0.05


def flag_phantom_queries(queries, min_share=PHANTOM_MIN_SHARE):
    """Split off queries that dominate impressions while earning no clicks.

    One synthetic string -- `aap 2024 free cash flow guided flat strategic costs`
    -- was 42.8% of all reported impressions over 105 days with zero clicks. It is
    not a real search, so every CTR computed over it is a denominator artifact
    (sitewide read ~1% when the real figure excluding it was ~7.5%).

    Flagged, never silently dropped: the caller prints them in their own section,
    and both the inclusive and exclusive CTR stay visible.
    """
    total = sum(e["impressions"] for e in queries.values())
    if not total:
        return {}, totals({})
    flagged = {
        name: e for name, e in queries.items()
        if e["clicks"] == 0 and e["impressions"] / total >= min_share
    }
    clean = {name: e for name, e in queries.items() if name not in flagged}
    return flagged, totals(clean)


def delta_table(current, previous, limit=10):
    """Top movers by click change, then impression change as a tiebreak."""
    names = set(current) | set(previous)
    rows = []
    for name in names:
        now = current.get(name, {"clicks": 0, "impressions": 0, "position": 0.0, "ctr": 0.0})
        was = previous.get(name, {"clicks": 0, "impressions": 0, "position": 0.0, "ctr": 0.0})
        rows.append({
            "name": name,
            "clicks": now["clicks"],
            "clicks_delta": now["clicks"] - was["clicks"],
            "impressions": now["impressions"],
            "impressions_delta": now["impressions"] - was["impressions"],
            "position": now["position"],
            "position_delta": round(now["position"] - was["position"], 2) if was["position"] else 0.0,
        })
    gained = sorted(rows, key=lambda r: (r["clicks_delta"], r["impressions_delta"]), reverse=True)[:limit]
    lost = sorted(rows, key=lambda r: (r["clicks_delta"], r["impressions_delta"]))[:limit]
    up = [r for r in gained if r["clicks_delta"] > 0 or r["impressions_delta"] > 0]
    down = [r for r in lost if r["clicks_delta"] < 0 or r["impressions_delta"] < 0]
    return up, down


def md_table(rows, label):
    if not rows:
        return f"| — | — | — | — | — | No {label} rows |"
    out = []
    for r in rows:
        out.append(
            f"| `{r['name']}` | {r['clicks']} | {r['clicks_delta']:+d} | "
            f"{r['impressions']} | {r['impressions_delta']:+d} | {r['position']:.2f} |"
        )
    return "\n".join(out)


def run_week(args, key):
    site = args.site
    page_rows = call("GetPageStats", site, key) or []
    query_rows = call("GetQueryStats", site, key) or []
    traffic = call("GetRankAndTrafficStats", site, key) or []
    crawl = call("GetCrawlStats", site, key) or []
    issues = call("GetCrawlIssues", site, key) or []
    blocked = call("GetBlockedUrls", site, key) or []
    feeds = call("GetFeeds", site, key) or []

    page_buckets = bucket_by_date(page_rows)
    query_buckets = bucket_by_date(query_rows)
    latest, previous = latest_two(page_buckets)
    q_latest, q_previous = latest_two(query_buckets)

    if latest is None:
        raise SystemExit(
            "GetPageStats returned no dated rows. The site may have no Bing "
            "search-performance data yet, or the key lacks access to it."
        )

    pages_now = normalise(page_buckets.get(latest, []), PAGE_FIELDS)
    pages_was = normalise(page_buckets.get(previous, []), PAGE_FIELDS) if previous else {}
    queries_now = normalise(query_buckets.get(q_latest, []), ("Query",)) if q_latest else {}
    queries_was = normalise(query_buckets.get(q_previous, []), ("Query",)) if q_previous else {}

    # Daily site totals for the 7 days ending on the bucket date.
    week_start = latest - datetime.timedelta(days=6)
    daily = []
    for row in traffic:
        day = parse_date(row.get("Date"))
        if day and week_start <= day <= latest:
            daily.append({"date": day.isoformat(), "clicks": as_int(row.get("Clicks")), "impressions": as_int(row.get("Impressions"))})
    daily.sort(key=lambda r: r["date"])

    # Headline figures come from the exhaustive daily source, never from the
    # top-N page list -- see window_totals() for why that distinction matters.
    site_now = window_totals(traffic, latest)
    site_was = window_totals(traffic, previous) if previous else {"clicks": 0, "impressions": 0, "ctr": 0.0, "days": 0}
    phantom_queries, organic_totals = flag_phantom_queries(queries_now)

    out_dir = os.path.join(ROOT, "seo-data", "bing")
    # Header is the contract consumed by scripts/seo/find-search-opportunities.js.
    write_csv(
        os.path.join(out_dir, "pages.csv"),
        ["page", "impressions", "clicks", "ctr", "position"],
        [[name, e["impressions"], e["clicks"], e["ctr"], e["position"]]
         for name, e in sorted(pages_now.items(), key=lambda kv: -kv[1]["impressions"])],
    )
    write_csv(
        os.path.join(out_dir, "queries.csv"),
        ["query", "impressions", "clicks", "ctr", "position"],
        [[name, e["impressions"], e["clicks"], e["ctr"], e["position"]]
         for name, e in sorted(queries_now.items(), key=lambda kv: -kv[1]["impressions"])],
    )

    # GetQueryStats carries no landing page, so a query cannot be attributed to a
    # URL from it alone. GetQueryPageStats resolves that, one call per query, so
    # it is opt-in and capped.
    query_pages = []
    drill = max(0, int(getattr(args, "drill", 0) or 0))
    if drill:
        top = sorted(queries_now.items(), key=lambda kv: -kv[1]["impressions"])[:drill]
        for query, _ in top:
            try:
                for row in call("GetQueryPageStats", site, key, query=query) or []:
                    page = first_field(row, PAGE_FIELDS)
                    if not page:
                        continue
                    query_pages.append([
                        query, page, as_int(row.get("Impressions")),
                        as_int(row.get("Clicks")), as_float(row.get("AvgImpressionPosition")),
                    ])
            except Exception as err:  # one bad query must not lose the whole run
                print(f"warning: GetQueryPageStats failed for {query!r}: {err}", file=sys.stderr)
        write_csv(
            os.path.join(out_dir, "query-pages.csv"),
            ["query", "page", "impressions", "clicks", "position"],
            query_pages,
        )

    latest_crawl = crawl[-1] if crawl else {}
    feed = next((f for f in feeds if str(f.get("Url", "")).endswith("/sitemap.xml")), {}) if isinstance(feeds, list) else {}
    page_totals, prev_totals = totals(pages_now), totals(pages_was)
    snapshot = {
        "site": site,
        "week_ending": latest.isoformat(),
        "week_start": week_start.isoformat(),
        "previous_week_ending": previous.isoformat() if previous else None,
        # Site-level and exhaustive -- this is the headline figure.
        "totals": site_now,
        "previous_totals": site_was,
        # Top-N page list, NOT the site total. Kept for the per-page table only.
        "page_list_totals": page_totals,
        "previous_page_list_totals": prev_totals,
        "phantom_queries": phantom_queries,
        "query_totals_excluding_phantom": organic_totals,
        "daily": daily,
        "pages": pages_now,
        "queries": queries_now,
        "crawl_latest": {k: latest_crawl.get(k) for k in ("Date", "InIndex", "CrawledPages", "CrawlErrors", "BlockedByRobotsTxt", "Code4xx", "Code5xx", "InLinks")},
        "issues_count": len(issues),
        "blocked_count": len(blocked),
        # Kept in full, not just counted: scripts/seo/bing-crawl-triage.js reads
        # these to separate "indexed page now erroring" from "never in sitemap".
        "issues": issues,
        "blocked": blocked,
        "sitemap": {
            "status": feed.get("Status"),
            "urls": feed.get("UrlCount"),
            # Bing returns /Date(ms)/ here too; render it as a date, not raw.
            "last_crawled": (lambda d: d.isoformat() if d else str(feed.get("LastCrawled", "")))(parse_date(feed.get("LastCrawled"))),
        },
    }
    snap_path = os.path.join(out_dir, f"weekly-{latest.isoformat()}.json")
    os.makedirs(out_dir, exist_ok=True)
    with open(snap_path, "w", encoding="utf-8") as handle:
        json.dump(snapshot, handle, indent=2, default=str)

    pages_gained, pages_lost = delta_table(pages_now, pages_was)
    queries_gained, queries_lost = delta_table(queries_now, queries_was)

    def pct(now, was):
        if not was:
            return "n/a"
        return f"{((now - was) / was * 100):+.1f}%"

    report = [
        f"# Bing weekly report — week ending {latest.isoformat()}",
        "",
        f"Generated: **{datetime.datetime.now(datetime.timezone.utc).isoformat()}**",
        f"Site: `{site}`",
        "",
        "> Bing reports search performance in weekly buckets dated on the Friday that closes",
        "> the 7 days ending Thursday. This is the latest complete bucket; the API exposes no",
        "> date-range filter, so week-over-week is computed against the preceding bucket",
        f"> (`{previous.isoformat() if previous else 'none available'}`).",
        "",
        "## Week totals",
        "",
        "Site-level, from `GetRankAndTrafficStats` (daily-grained, exhaustive). The",
        "per-page list behind the tables below is top-N (100 rows, capped by Bing) and",
        "is deliberately not summed here: doing so under-reported impressions by 3.8-4.6x",
        "depending on the week and over-reported CTR by the same factor.",
        "",
        "| Metric | This week | Last week | Change |",
        "|---|---:|---:|---:|",
        f"| Clicks | {site_now['clicks']} | {site_was['clicks']} | {pct(site_now['clicks'], site_was['clicks'])} |",
        f"| Impressions | {site_now['impressions']} | {site_was['impressions']} | {pct(site_now['impressions'], site_was['impressions'])} |",
        f"| CTR | {site_now['ctr'] * 100:.2f}% | {site_was['ctr'] * 100:.2f}% | — |",
        f"| Days reported | {site_now['days']} | {site_was['days']} | — |",
        f"| Pages with impressions | {len(pages_now)} | {len(pages_was)} | — |",
        f"| Queries with impressions | {len(queries_now)} | {len(queries_was)} | — |",
        "",
        "### Query-level CTR, with phantom queries separated",
        "",
        "> `GetQueryStats` returns a capped top-N list (100 rows, no pagination",
        "> parameter), so these are *not* site totals and must not be read as such --",
        "> the gap to the Week totals above is unattributed long-tail, not a loss.",
        "",
        "| Basis | Queries | Impressions | Clicks | CTR |",
        "|---|---:|---:|---:|---:|",
        f"| As returned by Bing | {len(queries_now)} | {totals(queries_now)['impressions']} | {totals(queries_now)['clicks']} | {totals(queries_now)['ctr'] * 100:.2f}% |",
        f"| Excluding flagged | {len(queries_now) - len(phantom_queries)} | {organic_totals['impressions']} | {organic_totals['clicks']} | {organic_totals['ctr'] * 100:.2f}% |",
        "",
        *(
            [
                "Flagged: zero-click queries holding >="
                f" {PHANTOM_MIN_SHARE * 100:.0f}% of all query impressions. These are synthetic or",
                "natural-language strings, not searches anyone makes, so a CTR computed over",
                "them is a denominator artifact rather than a snippet failure.",
                "",
                "| Query | Impressions | Share of all |",
                "|---|---:|---:|",
            ]
            + [
                f"| `{name}` | {e['impressions']} | "
                f"{e['impressions'] / max(1, totals(queries_now)['impressions']) * 100:.1f}% |"
                for name, e in sorted(phantom_queries.items(), key=lambda kv: -kv[1]["impressions"])
            ]
            + [""]
            if phantom_queries
            else ["No query exceeded the phantom threshold this week.", ""]
        ),
        "## Daily (site-level, from GetRankAndTrafficStats)",
        "",
        "| Date | Clicks | Impressions |",
        "|---|---:|---:|",
    ]
    report += [f"| {d['date']} | {d['clicks']} | {d['impressions']} |" for d in daily] or ["| — | — | No daily rows in range |"]
    report += [
        "",
        "## Top gaining pages",
        "",
        "| Page | Clicks | Δ | Impressions | Δ | Position |",
        "|---|---:|---:|---:|---:|---:|",
        md_table(pages_gained, "page"),
        "",
        "## Top losing pages",
        "",
        "| Page | Clicks | Δ | Impressions | Δ | Position |",
        "|---|---:|---:|---:|---:|---:|",
        md_table(pages_lost, "page"),
        "",
        "## Top gaining queries",
        "",
        "| Query | Clicks | Δ | Impressions | Δ | Position |",
        "|---|---:|---:|---:|---:|---:|",
        md_table(queries_gained, "query"),
        "",
        "## Top losing queries",
        "",
        "| Query | Clicks | Δ | Impressions | Δ | Position |",
        "|---|---:|---:|---:|---:|---:|",
        md_table(queries_lost, "query"),
        "",
        "## Index and crawl health",
        "",
        f"- Sitemap: {snapshot['sitemap']['status']} · {snapshot['sitemap']['urls']} URLs · last crawled {snapshot['sitemap']['last_crawled']}",
        f"- In index: **{latest_crawl.get('InIndex', 0)}** · crawled {latest_crawl.get('CrawledPages', 0)} · errors {latest_crawl.get('CrawlErrors', 0)}",
        f"- 4xx: {latest_crawl.get('Code4xx', 0)} · 5xx: {latest_crawl.get('Code5xx', 0)} · blocked by robots.txt: {latest_crawl.get('BlockedByRobotsTxt', 0)}",
        f"- Active crawl issues: **{len(issues)}** · blocked URLs: **{len(blocked)}**",
        "",
        "## Files written",
        "",
        f"- `seo-data/bing/pages.csv` ({len(pages_now)} rows) — input for `scripts/seo/find-search-opportunities.js`",
        f"- `seo-data/bing/queries.csv` ({len(queries_now)} rows)",
        (f"- `seo-data/bing/query-pages.csv` ({len(query_pages)} rows) — query→landing-page map"
         if drill else "- `seo-data/bing/query-pages.csv` — not built (pass `--drill=N`)"),
        f"- `seo-data/bing/weekly-{latest.isoformat()}.json` (raw snapshot)",
        "",
        "Figures come straight from the Bing Webmaster API. Nothing here is inferred or",
        "back-filled; an absent row means Bing reported no data for it.",
        "",
    ]
    report_path = os.path.join(ROOT, "docs", "seo", f"bing-weekly-{latest.isoformat()}.md")
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(report))

    print(json.dumps({
        "week_ending": latest.isoformat(),
        "previous_week_ending": previous.isoformat() if previous else None,
        "totals": site_now,
        "previous_totals": site_was,
        "page_list_totals": page_totals,
        "phantom_queries": len(phantom_queries),
        "pages": len(pages_now),
        "queries": len(queries_now),
        "daily_rows": len(daily),
        "written": [
            os.path.relpath(os.path.join(out_dir, "pages.csv"), ROOT),
            os.path.relpath(os.path.join(out_dir, "queries.csv"), ROOT),
            os.path.relpath(snap_path, ROOT),
            os.path.relpath(report_path, ROOT),
        ] + ([os.path.relpath(os.path.join(out_dir, "query-pages.csv"), ROOT)] if drill else []),
    }, indent=2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", default=os.environ.get("BING_WEBMASTER_KEY_FILE", DEFAULT_KEY))
    parser.add_argument("--site", default=os.environ.get("BING_WEBMASTER_SITE", "https://www.stockportfolio.pro/"))
    parser.add_argument("--format", choices=("text", "json", "csv"), default="text")
    parser.add_argument("--week", action="store_true", help="build the last-week report and write exports")
    parser.add_argument("--query", help="with --format json: drill into landing pages for one query")
    parser.add_argument("--drill", type=int, default=0, metavar="N",
                        help="with --week: resolve landing pages for the top N queries "
                             "via GetQueryPageStats (one extra API call per query)")
    args = parser.parse_args()
    if not os.path.exists(args.key):
        raise SystemExit(
            f"Bing Webmaster API key file not found: {args.key}\n"
            "Get it from Bing Webmaster Tools > Settings > API Access > API Key, then:\n"
            "  mkdir -p ~/.local/share/secrets\n"
            "  printf '%s' 'YOUR_KEY' > ~/.local/share/secrets/bing_webmaster.txt\n"
            "  chmod 600 ~/.local/share/secrets/bing_webmaster.txt"
        )
    with open(args.key, encoding="utf-8") as handle:
        key = handle.read().strip()
    if not key:
        raise SystemExit("Bing Webmaster API key file is empty")

    if args.week:
        return run_week(args, key)

    if args.query:
        print(json.dumps(call("GetQueryPageStats", args.site, key, query=args.query), indent=2, default=str))
        return

    sites = call("GetUserSites", args.site, key)
    feeds = call("GetFeeds", args.site, key)
    traffic = call("GetRankAndTrafficStats", args.site, key) or []
    crawl = call("GetCrawlStats", args.site, key) or []
    issues = call("GetCrawlIssues", args.site, key) or []
    blocked = call("GetBlockedUrls", args.site, key) or []
    quota = call("GetUrlSubmissionQuota", args.site, key)
    latest_crawl = crawl[-1] if crawl else {}
    report = {
        "site": args.site,
        "sites": sites,
        "feeds": feeds,
        "traffic": {
            "days": len(traffic),
            "clicks": sum(int(row.get("Clicks", 0)) for row in traffic),
            "impressions": sum(int(row.get("Impressions", 0)) for row in traffic),
            "nonzeroDays": sum(1 for row in traffic if row.get("Clicks", 0) or row.get("Impressions", 0)),
        },
        "crawl": {
            "days": len(crawl),
            "latest": {key_: latest_crawl.get(key_) for key_ in (
                "Date", "InIndex", "CrawledPages", "CrawlErrors", "BlockedByRobotsTxt", "Code4xx", "Code5xx", "InLinks"
            )},
        },
        "issues": issues,
        "blocked": blocked,
        "quota": quota,
    }
    if args.format == "json":
        print(json.dumps(report, indent=2, default=str))
        return
    feed = next((item for item in feeds if item.get("Url", "").endswith("/sitemap.xml")), {})
    if args.format == "csv":
        writer = csv.writer(sys.stdout)
        writer.writerow(["site", "verified", "sitemap_status", "sitemap_urls", "sitemap_last_crawled", "clicks", "impressions", "traffic_days", "indexed", "crawled_pages", "crawl_errors", "active_issues", "blocked_urls", "daily_quota", "monthly_quota"])
        verified = next((item.get("IsVerified") for item in sites if item.get("Url") == args.site), "") if isinstance(sites, list) else ""
        latest = report["crawl"]["latest"]
        writer.writerow([args.site, verified, feed.get("Status", ""), feed.get("UrlCount", ""), feed.get("LastCrawled", ""), report["traffic"]["clicks"], report["traffic"]["impressions"], report["traffic"]["days"], latest.get("InIndex", ""), latest.get("CrawledPages", ""), latest.get("CrawlErrors", ""), len(issues), len(blocked), quota.get("DailyQuota", "") if isinstance(quota, dict) else "", quota.get("MonthlyQuota", "") if isinstance(quota, dict) else ""])
        return
    print(f"Bing Webmaster report: {args.site}")
    print(f"Sitemap: {feed.get('Status', 'unknown')} · {feed.get('UrlCount', 'unknown')} URLs · last crawled {feed.get('LastCrawled', 'unknown')}")
    print(f"Traffic: {report['traffic']['clicks']} clicks · {report['traffic']['impressions']} impressions · {report['traffic']['days']} days")
    print(f"Latest crawl: {latest_crawl.get('InIndex', 0)} indexed · {latest_crawl.get('CrawledPages', 0)} crawled · {latest_crawl.get('CrawlErrors', 0)} errors")
    print(f"Active crawl issues: {len(issues)} · blocked URLs: {len(blocked)}")
    print(f"Submission quota: {quota}")


if __name__ == "__main__":
    main()
