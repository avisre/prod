#!/usr/bin/env python3
"""Ask Google, per URL, whether it is indexed — and why not when it is not.

Search Console's Coverage report is a bucket count with no URLs in it, so it can
say "6,580 crawled - not indexed" but never which pages or what Google objected
to. The URL Inspection API answers that one URL at a time, with the verdict, the
coverage state, the last crawl time, and the canonical Google actually chose.
Sampling it per tier turns a bucket count into a diagnosis.

Read-only, same service account as gsc-stats.py. Quota is 2,000 inspections per
day per property, so treat the sample sizes as a budget.

  python3 scripts/gsc-index-audit.py --tiers /tmp/tiers.json
  python3 scripts/gsc-index-audit.py --url https://www.stockportfolio.pro/stocks/AAPL
  python3 scripts/gsc-index-audit.py --sitemaps-only
"""
import argparse
import datetime as dt
import importlib.util
import json
import os
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SITE = "sc-domain:stockportfolio.pro"
INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
SITEMAPS = "https://searchconsole.googleapis.com/webmasters/v3/sites/{site}/sitemaps"


def load_stats_module():
    spec = importlib.util.spec_from_file_location("gsc_stats", os.path.join(HERE, "gsc-stats.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inspect(session, token, site, url):
    resp = session.post(
        INSPECT,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"inspectionUrl": url, "siteUrl": site, "languageCode": "en-US"},
        timeout=30,
    )
    if resp.status_code != 200:
        return {"error": f"HTTP {resp.status_code}: {resp.text[:200]}"}
    return (resp.json() or {}).get("inspectionResult", {})


def age_days(stamp):
    if not stamp:
        return None
    try:
        when = dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt.datetime.now(dt.timezone.utc) - when).days


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", default=DEFAULT_SITE)
    parser.add_argument("--key", default=None)
    parser.add_argument("--tiers", default=None, help="JSON file of {tier: [urls]} from /tmp/tier-sample.js")
    parser.add_argument("--url", action="append", default=[], help="inspect one URL (repeatable)")
    parser.add_argument("--sitemaps-only", action="store_true")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    args = parser.parse_args()

    stats = load_stats_module()
    key_path = args.key or stats.DEFAULT_KEY
    token, identity = stats.access_token(key_path)
    print(f"service account: {identity}")
    session = requests.Session()

    # --- Sitemaps: status, discovered URL count, last read -------------------
    if not args.tiers and not args.url or args.sitemaps_only:
        resp = session.get(
            SITEMAPS.format(site=args.site),
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        if resp.status_code != 200:
            print(f"sitemaps HTTP {resp.status_code}: {resp.text[:300]}", file=sys.stderr)
        else:
            rows = (resp.json() or {}).get("sitemap", [])
            print(f"SITEMAPS for {args.site}: {len(rows)}")
            for row in rows:
                print(f"  {row.get('path','')}")
                print(f"    type={row.get('type')} lastDownloaded={row.get('lastDownloaded')} "
                      f"errors={row.get('errors')} warnings={row.get('warnings')}")
                for child in row.get("contents", []):
                    print(f"    submitted={child.get('submitted')} type={child.get('type')}")
            # Google reports sitemap-level problems in these fields when present.
            # They arrive as strings, so compare numerically — "0" is truthy.
            for row in rows:
                for field in ("errors", "warnings"):
                    if int(row.get(field, 0) or 0):
                        print(f"  !! {row.get('path')} reports {row.get(field)} {field}")
        if args.sitemaps_only:
            return
        if not args.tiers and not args.url:
            return

    # --- URL Inspection ------------------------------------------------------
    plan = {}
    if args.url:
        plan["explicit"] = args.url
    if args.tiers:
        with open(args.tiers, encoding="utf-8") as handle:
            plan.update(json.load(handle))

    results = {}
    for tier, urls in plan.items():
        print(f"\n=== {tier}: {len(urls)} URLs ===")
        rows = []
        for i, url in enumerate(urls, 1):
            found = inspect(session, token, args.site, url)
            if "error" in found:
                print(f"  [{i}/{len(urls)}] ERROR {url} {found['error']}")
                rows.append({"url": url, "error": found["error"]})
                continue
            index_status = found.get("indexStatusResult", {}) or {}
            row = {
                "url": url,
                "verdict": index_status.get("verdict"),
                "coverageState": index_status.get("coverageState"),
                "robotsTxtState": index_status.get("robotsTxtState"),
                "indexingState": index_status.get("indexingState"),
                "pageFetchState": index_status.get("pageFetchState"),
                "lastCrawlTime": index_status.get("lastCrawlTime"),
                "crawlAgeDays": age_days(index_status.get("lastCrawlTime")),
                "googleCanonical": index_status.get("googleCanonical"),
                "userCanonical": index_status.get("userCanonical"),
                "inSitemaps": index_status.get("sitemaps") or [],
                "referringUrls": index_status.get("referringUrls") or [],
            }
            rows.append(row)
            age = f"{row['crawlAgeDays']}d ago" if row["crawlAgeDays"] is not None else "never"
            flag = ""
            if row["googleCanonical"] and row["userCanonical"] and row["googleCanonical"] != row["userCanonical"]:
                flag = f"  CANONICAL MISMATCH -> {row['googleCanonical']}"
            print(f"  [{i}/{len(urls)}] {row['verdict']:<8} {row['coverageState']}  "
                  f"crawl={age} fetch={row['pageFetchState']}{flag}")
            print(f"        {url}")
            time.sleep(0.2)
        results[tier] = rows

    if args.format == "json":
        print(json.dumps(results, indent=2))
        return

    # --- Per-tier rollup -----------------------------------------------------
    print("\n\n========== PER-TIER SUMMARY ==========")
    for tier, rows in results.items():
        good = [r for r in rows if "error" not in r]
        errors = len(rows) - len(good)
        states = {}
        verdicts = {}
        for row in good:
            states[row["coverageState"]] = states.get(row["coverageState"], 0) + 1
            verdicts[row["verdict"]] = verdicts.get(row["verdict"], 0) + 1
        crawls = [r["crawlAgeDays"] for r in good if r["crawlAgeDays"] is not None]
        never = sum(1 for r in good if r["crawlAgeDays"] is None)
        canon = sum(1 for r in good if r["googleCanonical"] and r["userCanonical"]
                    and r["googleCanonical"] != r["userCanonical"])
        print(f"\n{tier}  ({len(good)} inspected, {errors} errors)")
        print(f"  verdicts:  {verdicts}")
        for state, count in sorted(states.items(), key=lambda kv: -kv[1]):
            print(f"    {count:>3}  {state}")
        if crawls:
            print(f"  crawled:   {len(crawls)}/{len(good)}  median age {sorted(crawls)[len(crawls)//2]}d  "
                  f"newest {min(crawls)}d  oldest {max(crawls)}d  never-crawled {never}")
        else:
            print(f"  crawled:   none of {len(good)} have a crawl time (never crawled)")
        if canon:
            print(f"  canonical: {canon} URL(s) where Google chose a different canonical")


if __name__ == "__main__":
    main()
