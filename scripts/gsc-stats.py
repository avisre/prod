#!/usr/bin/env python3
"""Read-only Google Search Console performance report.

The service-account JSON stays outside the repository. Examples:
  python3 scripts/gsc-stats.py --days 28
  python3 scripts/gsc-stats.py --site sc-domain:stockportfolio.pro --format json
"""
import argparse
import base64
import csv
import datetime as dt
import json
import os
import subprocess
import tempfile
import time
import urllib.parse

import requests

DEFAULT_KEY = "/home/hardoker77/.local/share/secrets/gsc_service_account.json"
DEFAULT_SITE = "https://www.stockportfolio.pro/"
API = "https://searchconsole.googleapis.com/webmasters/v3"


def b64url(value):
    raw = value.encode() if isinstance(value, str) else value
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def access_token(key_path):
    with open(key_path, encoding="utf-8") as handle:
        service_account = json.load(handle)
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}))
    claim = b64url(json.dumps({
        "iss": service_account["client_email"],
        "scope": "https://www.googleapis.com/auth/webmasters.readonly",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }))
    signing_input = f"{header}.{claim}"
    with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as pem:
        pem.write(service_account["private_key"])
        pem_path = pem.name
    try:
        signed = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", pem_path],
            input=signing_input.encode(), capture_output=True, check=True,
        ).stdout
    finally:
        os.unlink(pem_path)
    response = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": f"{signing_input}.{b64url(signed)}",
        }, timeout=30,
    )
    response.raise_for_status()
    return response.json()["access_token"], service_account["client_email"]


def date_range(args):
    end = dt.date.fromisoformat(args.end) if args.end else dt.date.today() - dt.timedelta(days=3)
    start = dt.date.fromisoformat(args.start) if args.start else end - dt.timedelta(days=max(args.days, 1) - 1)
    if start > end:
        raise SystemExit("--start must be on or before --end")
    return {"startDate": start.isoformat(), "endDate": end.isoformat()}


def query(url, headers, date_body, dimensions, row_limit):
    body = {**date_body, "rowLimit": row_limit}
    if dimensions:
        body["dimensions"] = dimensions
    response = requests.post(url, headers=headers, json=body, timeout=60)
    payload = response.json()
    if response.status_code != 200:
        raise RuntimeError(f"HTTP {response.status_code}: {payload.get('error', payload)}")
    return payload.get("rows", [])


def properties(headers):
    response = requests.get(f"{API}/sites", headers=headers, timeout=30)
    payload = response.json()
    if response.status_code != 200:
        raise RuntimeError(f"sites.list HTTP {response.status_code}: {payload.get('error', payload)}")
    return payload.get("siteEntry", [])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", default=os.environ.get("GSC_SERVICE_ACCOUNT_FILE", DEFAULT_KEY))
    parser.add_argument("--site", default=os.environ.get("GSC_SITE", DEFAULT_SITE))
    parser.add_argument("--days", type=int, default=28)
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--row-limit", type=int, default=25)
    parser.add_argument("--format", choices=("text", "json", "csv"), default="text")
    args = parser.parse_args()
    token, identity = access_token(args.key)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    date_body = date_range(args)
    encoded_site = urllib.parse.quote(args.site, safe="")
    url = f"{API}/sites/{encoded_site}/searchAnalytics/query"
    report = {
        "site": args.site,
        "identity": identity,
        "properties": properties(headers),
        **date_body,
        "totals": query(url, headers, date_body, [], args.row_limit),
        "pages": query(url, headers, date_body, ["page"], args.row_limit),
        "queries": query(url, headers, date_body, ["query"], args.row_limit),
    }
    if args.format == "json":
        print(json.dumps(report, indent=2))
        return
    if args.format == "csv":
        writer = csv.writer(__import__("sys").stdout)
        writer.writerow(["section", "key", "clicks", "impressions", "ctr", "position", "permission"])
        for prop in report["properties"]:
            writer.writerow(["property", prop.get("siteUrl", ""), "", "", "", "", prop.get("permissionLevel", "")])
        for section in ("totals", "pages", "queries"):
            for row in report[section]:
                writer.writerow([section, " | ".join(row.get("keys", [])) or "TOTAL", row.get("clicks", 0), row.get("impressions", 0), row.get("ctr", 0), row.get("position", 0), ""])
        return
    print(f"GSC report: {args.site} ({date_body['startDate']} → {date_body['endDate']})")
    print(f"Service account: {identity}")
    for label in ("totals", "pages", "queries"):
        print(f"\n{label.upper()}")
        rows = report[label]
        if not rows:
            print("  (no data)")
        for row in rows:
            keys = ", ".join(row.get("keys", [])) or "TOTAL"
            print(f"  {keys[:100]} clicks={row['clicks']:.0f} impressions={row['impressions']:.0f} ctr={row['ctr'] * 100:.1f}% position={row['position']:.1f}")


if __name__ == "__main__":
    main()
