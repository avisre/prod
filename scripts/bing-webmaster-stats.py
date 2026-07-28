#!/usr/bin/env python3
"""Read-only Bing Webmaster API report for the registered site."""
import argparse
import csv
import json
import os
import requests
import sys

DEFAULT_KEY = "/home/hardoker77/.local/share/secrets/bing_webmaster.txt"
API = "https://ssl.bing.com/webmaster/api.svc/json"


def call(name, site, key):
    response = requests.get(
        f"{API}/{name}",
        params={"siteUrl": site, "apikey": key},
        timeout=60,
    )
    try:
        payload = response.json()
    except ValueError:
        payload = {"text": response.text[:500]}
    if response.status_code != 200:
        raise RuntimeError(f"{name} HTTP {response.status_code}: {payload}")
    return payload.get("d", payload)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", default=os.environ.get("BING_WEBMASTER_KEY_FILE", DEFAULT_KEY))
    parser.add_argument("--site", default=os.environ.get("BING_WEBMASTER_SITE", "https://www.stockportfolio.pro/"))
    parser.add_argument("--format", choices=("text", "json", "csv"), default="text")
    args = parser.parse_args()
    with open(args.key, encoding="utf-8") as handle:
        key = handle.read().strip()
    if not key:
        raise SystemExit("Bing Webmaster API key file is empty")

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
            "latest": {key: latest_crawl.get(key) for key in (
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
