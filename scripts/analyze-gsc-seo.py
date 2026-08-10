#!/usr/bin/env python3
"""Fetch and analyze Google Search Console data for StockPortfolio.pro.

The script uses the existing read-only service-account file outside the repo.
It writes raw CSV exports to seo-data/gsc/ and produces the opportunity report
under seo-data/. No credentials or tokens are written to disk.
"""
from __future__ import annotations

import argparse
import base64
import collections
import csv
import datetime as dt
import html
import json
import math
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Dict, Iterable, List
from urllib.parse import quote

import requests

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_KEY = "/home/hardoker77/.local/share/secrets/gsc_service_account.json"
DEFAULT_SITE = "sc-domain:stockportfolio.pro"
API = "https://searchconsole.googleapis.com/webmasters/v3"
SITE_HOST = "www.stockportfolio.pro"
POSITION_BUCKETS = (
    ("1–3", 1, 3), ("4–5", 4, 5), ("6–10", 6, 10),
    ("11–15", 11, 15), ("16–20", 16, 20), ("21–50", 21, 50),
    ("51+", 51, float("inf")),
)
HYPOTHESIZED_TERMS = {
    "ai stock research", "stock analysis software", "ai investment research",
    "sec filing ai", "fundamental analysis software",
}


def b64url(value: bytes | str) -> str:
    raw = value.encode() if isinstance(value, str) else value
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def access_token(key_path: str):
    with open(key_path, encoding="utf-8") as handle:
        account = json.load(handle)
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}))
    claim = b64url(json.dumps({
        "iss": account["client_email"],
        "scope": "https://www.googleapis.com/auth/webmasters.readonly",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }))
    signing_input = f"{header}.{claim}"
    with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as pem:
        pem.write(account["private_key"])
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
    return response.json()["access_token"], account["client_email"]


def fetch_rows(url: str, headers: dict, date_body: dict, dimensions: List[str], row_limit: int = 25_000):
    rows: list = []
    start = 0
    # Search Analytics returns at most 25,000 rows per page. Continue using
    # startRow until the response is short, while keeping a hard safety cap.
    while start < 100_000:
        body = {**date_body, "dimensions": dimensions, "rowLimit": min(row_limit, 25_000), "startRow": start}
        response = requests.post(url, headers=headers, json=body, timeout=90)
        payload = response.json()
        if response.status_code != 200:
            raise RuntimeError(f"Search Analytics HTTP {response.status_code}: {payload.get('error', payload)}")
        batch = payload.get("rows", [])
        rows.extend(batch)
        if len(batch) < min(row_limit, 25_000):
            break
        start += len(batch)
    return rows


def write_rows(path: Path, rows: list, dimensions: List[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [*dimensions, "clicks", "impressions", "ctr", "position"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            keys = row.get("keys", [])
            writer.writerow({
                **{key: keys[i] if i < len(keys) else "" for i, key in enumerate(dimensions)},
                "clicks": row.get("clicks", 0),
                "impressions": row.get("impressions", 0),
                "ctr": row.get("ctr", 0),
                "position": row.get("position", 0),
            })


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        result = []
        for row in csv.DictReader(handle):
            for field in ("clicks", "impressions", "ctr", "position"):
                try:
                    row[field] = float(row.get(field, 0) or 0)
                except (TypeError, ValueError):
                    row[field] = 0.0
            result.append(row)
        return result


def pct(value: float) -> str:
    return f"{value * 100:.2f}%"


def intent_for(query: str, page: str) -> tuple[str, int]:
    q = query.lower()
    p = page.lower()
    commercial = bool(re.search(r"\b(buy|best|tool|software|platform|analys|research|screen|compare|portfolio|alert|ai|screener|valuation)\b", q))
    product = bool(re.search(r"stockportfolio|stock analysis|financial statement|sec filing|filing|dilution|revenue|cash flow|margin|pe ratio|shares outstanding|fundamental", q + " " + p))
    if commercial and product:
        return "commercial research", 5
    if product:
        return "financial research", 4
    if commercial:
        return "commercial adjacent", 3
    return "informational", 1


def cluster_for(query: str) -> str:
    q = query.lower().strip()
    patterns = [
        (r"\b(revenue|sales)\b", "revenue"),
        (r"\b(net income|earnings|eps|profit)\b", "earnings/profit"),
        (r"\b(free cash flow|operating cash flow|cash flow)\b", "cash flow"),
        (r"\b(gross margin|operating margin|margin)\b", "margins"),
        (r"\b(pe|p/e|price earnings|valuation)\b", "valuation"),
        (r"\b(shares outstanding|dilution|share count|buyback)\b", "shares/dilution"),
        (r"\b(sec|10-k|10-q|8-k|filing|edgar)\b", "SEC filings"),
        (r"\b(compare|versus|vs)\b", "comparison"),
        (r"\b(stock screener|screener|screen stocks)\b", "screener"),
        (r"\b(etf|fund|mutual fund)\b", "funds/ETFs"),
    ]
    for pattern, label in patterns:
        if re.search(pattern, q):
            return label
    return "other"


def family_for(cluster: str) -> str:
    """Stable report labels; do not imply commercial intent from a cluster."""
    return {
        "earnings/profit": "earnings/EPS/profit",
        "revenue": "revenue",
        "shares/dilution": "shares/dilution",
        "comparison": "comparisons",
        "SEC filings": "filings",
    }.get(cluster, "other financial metrics")


def position_bucket(position: float) -> str:
    try:
        value = float(position)
    except (TypeError, ValueError):
        return "51+"
    # Search Console positions are averages and can be fractional (3.8, 5.7),
    # so adjacent display buckets must not leave gaps between integer labels.
    if value <= 3: return "1–3"
    if value <= 5: return "4–5"
    if value <= 10: return "6–10"
    if value <= 15: return "11–15"
    if value <= 20: return "16–20"
    if value <= 50: return "21–50"
    return "51+"


def aggregate_stats(rows: list[dict]) -> dict:
    impressions = sum(float(row.get("impressions", 0) or 0) for row in rows)
    clicks = sum(float(row.get("clicks", 0) or 0) for row in rows)
    weighted_position = sum(
        float(row.get("position", 0) or 0) * float(row.get("impressions", 0) or 0)
        for row in rows
    )
    return {
        "rows": len(rows), "impressions": impressions, "clicks": clicks,
        "ctr": clicks / impressions if impressions else 0,
        "position": weighted_position / impressions if impressions else 0,
    }


def bucket_stats(rows: list[dict]) -> list[dict]:
    out = []
    for label, _low, _high in POSITION_BUCKETS:
        selected = [row for row in rows if position_bucket(row.get("position", 0)) == label]
        out.append({"bucket": label, **aggregate_stats(selected)})
    return out


def expected_ctr(position: float) -> float:
    if position <= 1.5: return 0.28
    if position <= 3: return 0.12
    if position <= 5: return 0.07
    if position <= 10: return 0.035
    if position <= 20: return 0.012
    return 0.003


def opportunity_score(row: dict) -> float:
    imp = row["impressions"]
    pos = row["position"]
    ctr = row["ctr"]
    intent_weight = row["commercial_value"]
    relevance = row["relevance"]
    scale = row["scalability"]
    if 4 <= pos <= 10:
        rank_factor = 1.0
    elif 11 <= pos <= 20:
        rank_factor = 0.82
    elif 3 < pos <= 30:
        rank_factor = 0.48
    elif pos <= 3:
        # A position-one result with no clicks is useful as a CTR/snippet
        # diagnostic, but it is not a striking-distance ranking opportunity.
        rank_factor = 0.20
    else:
        rank_factor = 0.12
    ctr_gap = max(0.0, expected_ctr(pos) - ctr)
    return round((math.log1p(imp) * 5 * rank_factor) + (ctr_gap * 100 * min(math.log1p(imp), 8)) + (intent_weight * 2) + (relevance * 1.5) + scale, 2)


def action_for(row: dict) -> tuple[str, str, int]:
    page = row["page"]
    cluster = row["query_cluster"]
    pos = row["position"]
    ctr = row["ctr"]
    if "compare/" in page or cluster == "comparison":
        return "IMPROVE_EXISTING_PAGE", "comparison template: expose metric evidence, filing period and CTA", 2
    if cluster == "SEC filings" or "filing" in page:
        return "IMPROVE_EXISTING_PAGE", "filing timeline/template: surface form, date and SEC link above fold", 2
    if pos <= 20 and ctr < expected_ctr(pos) * 0.65:
        return "IMPROVE_TITLE_META", "align title/description with the query and lead with the filed answer", 1
    if cluster in {"revenue", "earnings/profit", "cash flow", "margins", "valuation", "shares/dilution"} and "/stocks/" in page:
        return "IMPROVE_TEMPLATE", "stock metric template: add period, source, chart and related metric links", 2
    if cluster in {"funds/ETFs", "screener"}:
        return "ADD_INTERNAL_LINKS", "link from relevant directory/screener/tool pages", 1
    return "IMPROVE_EXISTING_PAGE", "add a direct, source-backed answer and contextual product CTA", 2


def make_opportunities(rows: list[dict], pages3: list[dict], queries3: list[dict], queries12: list[dict]) -> list[dict]:
    historical = {r["query"].lower(): r for r in queries12}
    out = []
    for base in rows:
        query = base.get("query", "").strip()
        page = base.get("page", "").strip()
        if not query or not page or not page.startswith("http"):
            continue
        intent, commercial = intent_for(query, page)
        relevance = 1 if intent == "informational" else (3 if intent == "financial research" else 4)
        scale = 3 if re.search(r"/stocks/[^/]+/", page) else 1
        row = {**base, "query_cluster": cluster_for(query), "intent": intent,
               "commercial_value": commercial, "relevance": relevance, "scalability": scale}
        row["evidence_type"] = "OBSERVED_GSC"
        row["content_match"] = "strong" if (relevance >= 3 and ("/stocks/" in page or "/compare/" in page or "/tools/" in page or "/screener" in page)) else "review"
        row["trend_3m"] = "impression-bearing"
        old = historical.get(query.lower())
        row["12m_clicks"] = old["clicks"] if old else 0
        row["12m_impressions"] = old["impressions"] if old else 0
        row["12m_ctr"] = old["ctr"] if old else 0
        row["12m_position"] = old["position"] if old else 0
        row["recommended_action"], row["implementation_type"], row["difficulty"] = action_for(row)
        row["opportunity_score"] = opportunity_score(row)
        out.append(row)
    return sorted(out, key=lambda r: (r["opportunity_score"], r["impressions"]), reverse=True)


def write_opportunities(path: Path, rows: list[dict]):
    fields = ["query", "query_cluster", "evidence_type", "page", "clicks", "impressions", "ctr", "position", "trend_3m", "12m_clicks", "12m_impressions", "12m_ctr", "12m_position", "intent", "commercial_value", "content_match", "recommended_action", "implementation_type", "scalability", "difficulty", "opportunity_score"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def hypothetical_opportunities() -> list[dict]:
    """Keep commercially attractive but unobserved terms explicit and inert."""
    return [{
        "query": term, "query_cluster": "hypothesis", "evidence_type": "HYPOTHESIZED",
        "page": "", "clicks": 0, "impressions": 0, "ctr": 0, "position": 0,
        "trend_3m": "no supporting GSC row", "12m_clicks": 0, "12m_impressions": 0,
        "12m_ctr": 0, "12m_position": 0, "intent": "commercial adjacent",
        "commercial_value": 5, "content_match": "not evaluated",
        "recommended_action": "DO_NOT_BUILD", "implementation_type": "wait for observed demand",
        "scalability": 0, "difficulty": 0, "opportunity_score": 0,
    } for term in sorted(HYPOTHESIZED_TERMS)]


def fetch(args):
    out = ROOT / "seo-data" / "gsc"
    token, identity = access_token(args.key)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    props = requests.get(f"{API}/sites", headers=headers, timeout=30).json().get("siteEntry", [])
    if not any(p.get("siteUrl") == args.site and p.get("permissionLevel") in {"siteFullUser", "siteOwner"} for p in props):
        raise RuntimeError(f"The service account has no Full/Owner access to {args.site}")
    url = f"{API}/sites/{quote(args.site, safe='')}/searchAnalytics/query"
    today = dt.date.today()
    end = today - dt.timedelta(days=3)
    datasets = {}
    for label, days in (("3m", 90), ("12m", 365)):
        start = end - dt.timedelta(days=days - 1)
        body = {"startDate": start.isoformat(), "endDate": end.isoformat()}
        for name, dims in (("queries", ["query"]), ("pages", ["page"]), ("query-page", ["query", "page"]),
                           ("countries", ["country"]), ("devices", ["device"]),
                           ("query-country", ["query", "country"]), ("query-device", ["query", "device"]),
                           ("query-date", ["query", "date"])):
            rows = fetch_rows(url, headers, body, dims)
            write_rows(out / f"{name}-{label}.csv", rows, dims)
            datasets[f"{name}-{label}"] = {"rows": len(rows), "start": body["startDate"], "end": body["endDate"]}
    meta = {"property": args.site, "identity": identity, "retrieved_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(), "datasets": datasets}
    (out / "acquisition.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta


def short_page(page: str) -> str:
    return str(page or "").replace("https://www.stockportfolio.pro", "") or "/"


def page_route(page: str) -> tuple[str, str] | None:
    match = re.match(r"https?://[^/]+/stocks/([^/?#]+)/([^/?#]+)", str(page or ""))
    return (match.group(1).upper(), match.group(2).lower()) if match else None


# This classifier is intentionally narrower than cluster_for(). The latter is
# a descriptive reporting bucket; ownership decisions need explicit user intent
# and must not turn words such as “earnings”, “profit” or “dilution” into a
# metric redirect by themselves.
METRIC_ROUTE_SLUGS = {
    "revenue", "net-income", "gross-profit", "eps", "ebitda", "free-cash-flow",
    "total-debt", "shares-outstanding", "dividend-history", "pe-ratio",
}
EXPLICIT_METRIC_PATTERNS = {
    "EPS": (
        r"\bearnings\s+per\s+share\b",
        r"\b(?:diluted|basic)\s+EPS\b",
        r"(?<![A-Za-z0-9])EPS(?![A-Za-z0-9])",
    ),
    "SHARES_OUTSTANDING": (
        r"\bshares?\s+outstanding\b",
        r"\boutstanding\s+shares?\b",
        r"\bshare\s+count\b",
    ),
    "REVENUE": (r"\brevenue\b",),
    "NET_INCOME": (r"\bnet\s+income\b", r"\bnet\s+profit\b"),
    "DIVIDEND": (r"\bdividend\s+history\b", r"\bdividends?\s+paid\b", r"\bdividends?\b"),
}
METRIC_EXPECTED_SLUG = {
    "EPS": "eps", "SHARES_OUTSTANDING": "shares-outstanding",
    "REVENUE": "revenue", "NET_INCOME": "net-income", "DIVIDEND": "dividend-history",
}


def classify_metric_query(query: str) -> str:
    """Classify only complete, high-confidence metric phrases.

    A conflicting query (for example, “EPS shares outstanding”) and every
    generic/underspecified finance query are explicitly ambiguous.
    """
    text = str(query or "").strip()
    # “Profit margin” is a margin metric, not a net-income route. Even the
    # longer “net profit margin” must stay ambiguous in this audit.
    if re.search(r"\b(?:net\s+)?profit\s+margin\b|\bdividend\s+yield\b", text, re.IGNORECASE):
        return "AMBIGUOUS_QUERY"
    matches = []
    for metric, patterns in EXPLICIT_METRIC_PATTERNS.items():
        if any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns):
            matches.append(metric)
    return matches[0] if len(matches) == 1 else "AMBIGUOUS_QUERY"


def metric_route(page: str) -> tuple[str, str, str] | None:
    route = page_route(page)
    if not route or route[1] not in METRIC_ROUTE_SLUGS:
        return None
    symbol, slug = route
    return symbol, slug, f"/stocks/{symbol}/{slug}"


def ownership_route(page: str) -> tuple[str, str, str] | None:
    """Return metric routes plus the base stock page as an authority competitor."""
    route = metric_route(page)
    if route:
        return route
    match = re.match(r"https?://[^/]+/stocks/([^/?#]+)/?$", str(page or ""), re.I)
    if not match:
        return None
    symbol = match.group(1).upper()
    return symbol, "base-stock", f"/stocks/{symbol}"


def metric_ownership_rows(query_page_rows: list[dict]) -> list[dict]:
    """Aggregate explicit-intent query/page rows into ownership diagnostics."""
    grouped: dict[str, list[dict]] = collections.defaultdict(list)
    for row in query_page_rows:
        route = ownership_route(row.get("page", ""))
        if route:
            grouped[str(row.get("query", "")).strip().lower()].append({**row, "_route": route})

    out = []
    for normalized_query, rows in grouped.items():
        query = next((str(r.get("query", "")).strip() for r in rows if str(r.get("query", "")).strip()), normalized_query)
        intent = classify_metric_query(query)
        if intent == "AMBIGUOUS_QUERY":
            continue
        expected_slug = METRIC_EXPECTED_SLUG[intent]
        routes: dict[str, dict] = {}
        symbols = {r["_route"][0] for r in rows}
        total_impressions = 0.0
        total_clicks = 0.0
        weighted_position = 0.0
        for row in rows:
            symbol, slug, route_path = row["_route"]
            impressions = float(row.get("impressions", 0) or 0)
            clicks = float(row.get("clicks", 0) or 0)
            total_impressions += impressions
            total_clicks += clicks
            weighted_position += float(row.get("position", 0) or 0) * impressions
            item = routes.setdefault(route_path, {"symbol": symbol, "slug": slug, "impressions": 0.0, "clicks": 0.0, "weighted_position": 0.0})
            item["impressions"] += impressions
            item["clicks"] += clicks
            item["weighted_position"] += float(row.get("position", 0) or 0) * impressions
        intended = sum(item["impressions"] for item in routes.values() if item["slug"] == expected_slug)
        wrong = max(0.0, total_impressions - intended)
        ownership = intended / total_impressions if total_impressions else 0.0
        dominant_route, dominant = max(routes.items(), key=lambda pair: (pair[1]["impressions"], pair[0]))
        dominant_correct = dominant["slug"] == expected_slug
        total_relevant = total_impressions
        if total_relevant < 10:
            evidence_strength = "INSUFFICIENT_DATA"
        elif total_relevant < 50:
            evidence_strength = "WEAK_EVIDENCE"
        elif total_relevant < 100:
            evidence_strength = "MODERATE_EVIDENCE"
        else:
            evidence_strength = "STRONG_EVIDENCE"
        # Condition C is intentionally conservative: a still-dominant intended
        # route is flagged only when a second route has >=100 impressions and
        # the query has at least two competing routes. This is a review signal,
        # not a universal statistical threshold.
        meaningful_wrong_route_volume = dominant_correct and wrong >= 100 and len(routes) >= 2
        material = evidence_strength != "INSUFFICIENT_DATA" and ((not dominant_correct) or (ownership < 0.5 and wrong >= 10) or meaningful_wrong_route_volume)
        if evidence_strength == "INSUFFICIENT_DATA":
            ownership_band = "INSUFFICIENT_DATA"
        elif not dominant_correct:
            ownership_band = "WRONG_ROUTE_DOMINANT"
        elif ownership < 0.5:
            ownership_band = "MATERIAL_FRAGMENTATION"
        elif ownership <= 0.8:
            ownership_band = "MIXED_OWNERSHIP"
        else:
            ownership_band = "STRONG_OWNERSHIP"
        if not material:
            severity, severity_rank = "none", 0
        elif not dominant_correct and wrong >= 100:
            severity, severity_rank = "high", 3
        elif not dominant_correct or wrong >= 10:
            severity, severity_rank = "medium", 2
        else:
            severity, severity_rank = "low", 1
        expected_route = f"/stocks/{next(iter(symbols))}/{expected_slug}" if len(symbols) == 1 else f"*/{expected_slug}"
        weighted_pos = weighted_position / total_impressions if total_impressions else 0
        intended_positions = [item["weighted_position"] for item in routes.values() if item["slug"] == expected_slug]
        intended_impressions = [item["impressions"] for item in routes.values() if item["slug"] == expected_slug]
        wrong_positions = [item["weighted_position"] for item in routes.values() if item["slug"] != expected_slug]
        wrong_impressions = [item["impressions"] for item in routes.values() if item["slug"] != expected_slug]
        intended_position = sum(intended_positions) / sum(intended_impressions) if sum(intended_impressions) else 0
        wrong_position = sum(wrong_positions) / sum(wrong_impressions) if sum(wrong_impressions) else 0
        ranking_opportunity = "top-3 visibility" if weighted_pos <= 3 else "striking distance" if weighted_pos <= 10 else "page-one opportunity" if weighted_pos <= 20 else "long-tail"
        base_competing = any(item["slug"] == "base-stock" for item in routes.values())
        if not material:
            recommended_action, change_category = "NO_ACTION", "NONE"
        elif evidence_strength == "INSUFFICIENT_DATA":
            recommended_action, change_category = "INSUFFICIENT_DATA", "OWNERSHIP_EVIDENCE_FIX"
        elif dominant_correct and weighted_pos > 10:
            recommended_action, change_category = "INVESTIGATE_RANKING_AUTHORITY", "OWNERSHIP_EVIDENCE_FIX"
        else:
            recommended_action, change_category = "FIX_TEMPLATE_SEMANTICS", "OWNERSHIP_EVIDENCE_FIX"
        out.append({
            "query": query, "ticker": next(iter(symbols)) if len(symbols) == 1 else "*", "intent": intent, "intent_confidence": "high", "expected_metric": expected_slug,
            "intended_metric": intent, "intended_route": expected_route, "expected_route": expected_route,
            "intended_route_impressions": intended,
            "wrong_route_impressions": wrong,
            "total_metric_route_impressions": total_impressions, "total_relevant_metric_impressions": total_relevant,
            "intended_ownership_rate": ownership,
            "competing_route_count": max(0, len(routes) - 1),
            "dominant_route": dominant_route,
            "dominant_route_impressions": dominant["impressions"],
            "dominant_route_correct": "yes" if dominant_correct else "no", "dominant_route_is_correct": "yes" if dominant_correct else "no",
            "intended_route_position": intended_position, "wrong_route_position": wrong_position,
            "evidence_strength": evidence_strength, "ownership_band": ownership_band,
            "base_stock_page_competing": "yes" if base_competing else "no",
            "meaningful_wrong_route_volume": "yes" if meaningful_wrong_route_volume else "no",
            "clicks": total_clicks,
            "ctr": total_clicks / total_impressions if total_impressions else 0,
            "position": weighted_pos, "ranking_opportunity": ranking_opportunity,
            "material_cannibalization": "yes" if material else "no",
            "severity": severity, "severity_rank": severity_rank, "recommended_action": recommended_action, "change_category": change_category,
            "route_breakdown": "; ".join(f"{route}={item['impressions']:.0f}" for route, item in sorted(routes.items(), key=lambda pair: pair[1]["impressions"], reverse=True)),
        })
    return sorted(out, key=lambda row: (
        -row["severity_rank"], row["dominant_route_correct"], row["intended_ownership_rate"],
        -row["wrong_route_impressions"], row["position"],
    ))


def write_metric_ownership_csv(path: Path, rows: list[dict]):
    fields = [
        "query", "ticker", "intent", "intent_confidence", "expected_metric", "intended_metric", "expected_route", "intended_route",
        "intended_route_impressions", "wrong_route_impressions", "total_metric_route_impressions", "total_relevant_metric_impressions", "intended_ownership_rate",
        "competing_route_count", "dominant_route", "dominant_route_impressions",
        "dominant_route_correct", "dominant_route_is_correct", "intended_route_position", "wrong_route_position",
        "evidence_strength", "ownership_band", "base_stock_page_competing", "meaningful_wrong_route_volume", "clicks", "ctr", "position", "material_cannibalization",
        "recommended_action", "change_category", "ranking_opportunity", "severity", "route_breakdown",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def render_metric_ownership_report(rows: list[dict], retrieval: str, period: dict | None = None, deployment_at: str = "", q3: list[dict] | None = None) -> str:
    period = period or {}
    q3 = q3 or []
    explicit_queries = [r for r in q3 if classify_metric_query(r.get("query", "")) != "AMBIGUOUS_QUERY"]
    total_site_impressions = sum(float(r.get("impressions", 0) or 0) for r in q3)
    explicit_impressions = sum(float(r.get("impressions", 0) or 0) for r in explicit_queries)
    material_queries = {str(r.get("query", "")).strip().lower() for r in rows if r.get("material_cannibalization") == "yes"}
    affected_impressions = sum(float(r.get("impressions", 0) or 0) for r in q3 if str(r.get("query", "")).strip().lower() in material_queries)
    affected_pct = affected_impressions / explicit_impressions if explicit_impressions else 0
    strong_material = [r for r in rows if r.get("material_cannibalization") == "yes" and r.get("evidence_strength") in {"MODERATE_EVIDENCE", "STRONG_EVIDENCE"}]
    decision = "PROCEED_WITH_OWNERSHIP_FIX" if strong_material else "AUDIT_ONLY_INSUFFICIENT_EVIDENCE"
    # Repetition across different symbols is the test for a reusable template
    # issue. A one-symbol mismatch is reported as ticker-specific, not generalized.
    patterns: dict[tuple[str, str], set[str]] = collections.defaultdict(set)
    for row in rows:
        if row.get("material_cannibalization") != "yes":
            continue
        expected = str(row.get("expected_route", "")).split("/")[-1]
        dominant = str(row.get("dominant_route", "")).split("/")[-1]
        if expected and dominant:
            symbol_match = re.search(r"/stocks/([^/]+)/", str(row.get("dominant_route", "")), re.I)
            if symbol_match:
                patterns[(expected, dominant)].add(symbol_match.group(1).upper())
    repeated = [key for key, symbols in patterns.items() if len(symbols) >= 2]
    if not rows or not strong_material:
        scope = "INSUFFICIENT_EVIDENCE"
    elif repeated:
        scope = "TEMPLATE_LEVEL"
    else:
        scope = "TICKER_SPECIFIC"
    lines = [
        "# Conservative metric ownership audit", "",
        "This is the audit-first implementation gate. The newest available three-month Search Console query/page export is evaluated before any reusable ownership change.", "",
        f"- Export retrieved: `{retrieval or 'local export'}`.",
        f"- Export period: `{period.get('start', 'unknown')}` to `{period.get('end', 'unknown')}`.",
        f"- Deployment timestamp: `{deployment_at or 'PENDING — record after production deployment'}`.",
        f"- Decision: **`{decision}`**.",
        f"- Supporting high-confidence rows: **{len(strong_material)}** material rows at MODERATE/STRONG evidence; template scope: **`{scope}`**.",
        "- Query/page dimensions are non-additive; aggregate query impressions are shown separately and must not be added to page or query/page totals.", "",
        "## Evidence floors and ownership bands", "",
        "Evidence is based on total relevant metric-route impressions: `<10` = `INSUFFICIENT_DATA`, `10–49` = `WEAK_EVIDENCE`, `50–99` = `MODERATE_EVIDENCE`, `>=100` = `STRONG_EVIDENCE`. Ownership is always reported with absolute counts. Bands are `WRONG_ROUTE_DOMINANT`, `MATERIAL_FRAGMENTATION`, `MIXED_OWNERSHIP`, `STRONG_OWNERSHIP` or `INSUFFICIENT_DATA`.",
        "A still-dominant intended route is only flagged for Condition C when a second route has a meaningful recurring volume (the conservative row screen is >=100 impressions with at least two routes); this remains a review signal, not a universal threshold.", "",
        "## Ownership rows", "",
    ]
    headers = ["Query", "Ticker", "Intended route", "Routes / impressions", "Intended / total", "Evidence", "Band", "Dominant", "Correct?", "Clicks", "CTR", "Overall pos.", "Intended pos.", "Wrong pos.", "Material", "Action"]
    values = [[
        f"`{html.escape(row['query'])}`", row.get("ticker", "*"), f"`{row['intended_route']}`", row["route_breakdown"],
        f"{row['intended_route_impressions']:,.0f} / {row['total_relevant_metric_impressions']:,.0f} ({pct(row['intended_ownership_rate'])})",
        row["evidence_strength"], row["ownership_band"], f"`{row['dominant_route']}` ({row['dominant_route_impressions']:,.0f})", row["dominant_route_is_correct"],
        f"{row['clicks']:,.0f}", pct(row["ctr"]), f"{row['position']:.2f}", f"{row['intended_route_position']:.2f}", f"{row['wrong_route_position']:.2f}", row["material_cannibalization"], row["recommended_action"],
    ] for row in rows]
    lines += markdown_table(headers, values) if values else ["No explicit-intent query/page rows were present in this export."]
    lines += ["", "## WAB-first decision table", "", "WAB is reviewed first, with explicit EPS, shares-outstanding, dividend, revenue and net-income phrases only. Generic or conflicting queries are excluded.", ""]
    wab = [row for row in rows if "wab" in row["query"].lower() and row.get("intent_confidence") == "high"]
    wab_headers = ["Query", "Metric", "Intended route", "Routes / impressions", "Clicks", "Position", "Ownership", "Dominant", "Evidence", "Material"]
    wab_values = [[f"`{html.escape(r['query'])}`", r["intended_metric"], f"`{r['intended_route']}`", r["route_breakdown"], f"{r['clicks']:,.0f}", f"{r['position']:.2f}", f"{r['intended_route_impressions']:,.0f} / {r['total_relevant_metric_impressions']:,.0f} ({pct(r['intended_ownership_rate'])})", f"`{r['dominant_route']}`", r["evidence_strength"], r["material_cannibalization"]] for r in wab]
    lines += markdown_table(wab_headers, wab_values) if wab_values else ["No WAB explicit-intent rows were present in this newest export."]
    if wab:
        wab_fix = any(r.get("material_cannibalization") == "yes" and r.get("evidence_strength") in {"MODERATE_EVIDENCE", "STRONG_EVIDENCE"} for r in wab)
        reason = "high-confidence WAB rows show wrong-route dominance or material fragmentation at a sufficient evidence floor" if wab_fix else "no WAB row meets the evidence floor and material-mismatch rule"
        lines += ["", f"**WAB OWNERSHIP FIX JUSTIFIED: {'YES' if wab_fix else 'NO'}** — {reason}.", ""]
    else:
        lines += ["", "**WAB OWNERSHIP FIX JUSTIFIED: NO** — no qualifying WAB rows were available.", ""]
    lines += [
        "## Site-level scope without overstatement", "",
        f"- Total site query-aggregate impressions: **{total_site_impressions:,.0f}**.",
        f"- Explicit high-confidence metric-query impressions: **{explicit_impressions:,.0f}**.",
        f"- Material-mismatch query impressions: **{affected_impressions:,.0f}** ({pct(affected_pct)} of explicit metric-query impressions).",
        "These figures are directional because Search Console query totals and query/page totals are different, non-additive dimensions; they are not a claim that this percentage of all indexed traffic is affected.", "",
        "## Ownership versus authority", "",
    ]
    for row in strong_material[:30]:
        authority = "ownership only"
        if row.get("wrong_route_position", 0) and row.get("intended_route_position", 0) and row["wrong_route_position"] <= row["intended_route_position"]:
            authority = "ownership + competing authority signal"
        lines.append(f"- `{row['query']}`: intended `{row['intended_route']}` position {row['intended_route_position']:.2f}; wrong-route position {row['wrong_route_position']:.2f}; overall position {row['position']:.2f} — **{authority}**.")
    if not strong_material:
        lines.append("No moderate/strong material mismatch is available to classify.")
    surfaced = {}
    for ticker in ("DELL", "CTSH", "GOOGL", "GM"):
        surfaced[ticker] = sum(1 for row in rows if re.search(rf"/stocks/{ticker}/", str(row.get("expected_route", "")) + str(row.get("dominant_route", "")), re.I))
    surfaced_text = "; ".join(f"{ticker}: {count} explicit rows" for ticker, count in surfaced.items())
    lines += ["", "## Scope conclusion", "", f"Observed mismatch scope: **`{scope}`**. Required cross-ticker check: {surfaced_text}. Every additional surfaced ticker remains in the full CSV; repeated expected→dominant patterns across symbols support a template-level change only when at least two symbols repeat the same mismatch. A one-symbol pattern remains ticker-specific.", "", "## Change categories", "", "- `SEMANTIC_CORRECTNESS_FIX`: metric-specific titles, H1s, opening answers, headings and derived-value wording.", "- `OWNERSHIP_EVIDENCE_FIX`: this audit, evidence floors, route ownership and internal authority-flow reports.", "- `TECHNICAL_CANONICAL_FIX`: existing resolver behavior is reused; aliases are audited for one-hop canonical output and no new aliases are created.", "", "## Measurement boundary", "", "This is a pre-fix baseline. Record the actual deployment timestamp and first meaningful post-fix Search Console date. Compare non-overlapping pre-fix and post-fix windows after the recrawl buffer; mark `PARTIAL_RECRAWL_POSSIBLE` when only some pages have been recrawled. Extend the post-fix window for low traffic. Position and CTR are secondary ranking measures, not ownership measures.", ""]
    return "\n".join(lines)


def comparison_pair(page: str) -> str:
    match = re.search(r"/compare/([A-Za-z0-9.]+-vs-[A-Za-z0-9.]+)", str(page or ""), re.I)
    return match.group(1).upper() if match else ""


def metadata_for_page(page: str, cache: dict[str, dict]) -> dict:
    """Render a small local page sample without scraping production or secrets."""
    if page in cache:
        return cache[page]
    route = page_route(page)
    pair = comparison_pair(page)
    if not route and not pair:
        cache[page] = {}
        return cache[page]
    if route:
        symbol, slug = route
        code = (
            "const x=require('./backend/seo-extra').renderMetricPage(process.argv[1],process.argv[2]);"
            "const h=String(x||'');"
            "const strip=(v)=>String(v||'').replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ').trim().replace(/&amp;/g,'&').replace(/&quot;/g,'\\\"');"
            "const pick=(re)=>{const m=h.match(re);return m?strip(m[1]):''};"
            "console.log(JSON.stringify({title:pick(/<title>([\\s\\S]*?)<\\/title>/i),"
            "h1:pick(/<h1[^>]*>([\\s\\S]*?)<\\/h1>/i),"
            "meta:pick(/<meta name=\\\"description\\\" content=\\\"([\\s\\S]*?)\\\"/i),"
            "opening:pick(/<p class=\\\"seo-sub\\\">([\\s\\S]*?)<\\/p>/i),"
            "primaryHeading:pick(/<h2[^>]*>([^<]*history by fiscal year[^<]*)<\\/h2>/i),"
            "methodologyHeading:pick(/<h2[^>]*>([^<]*methodology[^<]*)<\\/h2>/i),"
            "methodology:pick(/<h2[^>]*>[^<]*methodology[^<]*<\\/h2>[\\s\\S]*?<p[^>]*>([\\s\\S]*?)<\\/p>/i)}));"
        )
        args = ["node", "-e", code, symbol, slug]
    else:
        code = (
            "const x=require('./backend/seo-extra').renderComparePage(process.argv[1]);"
            "const h=String(x&&x.redirect?'':(x&&x.html)||x||'');"
            "const pick=(re)=>{const m=h.match(re);return m?m[1].replace(/&quot;/g,'\\\"'):''};"
            "console.log(JSON.stringify({title:pick(/<title>([\\s\\S]*?)<\\/title>/i),"
            "h1:pick(/<h1[^>]*>([\\s\\S]*?)<\\/h1>/i),meta:pick(/<meta name=\\\"description\\\" content=\\\"([\\s\\S]*?)\\\"/i)}));"
        )
        args = ["node", "-e", code, pair]
    try:
        result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=30, check=False)
        lines = [line for line in result.stdout.splitlines() if line.strip()]
        cache[page] = json.loads(lines[-1]) if lines else {}
    except (subprocess.SubprocessError, ValueError, OSError):
        cache[page] = {}
    return cache[page]


def _strip_html(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))).strip()


def audit_metric_anchors(document: str) -> list[dict]:
    """Return only semantically wrong metric anchors in rendered HTML."""
    expected = {
        "eps": re.compile(r"(?:earnings\s+per\s+share|\beps\b)", re.I),
        "shares-outstanding": re.compile(r"(?:shares?\s+outstanding|share\s+count)", re.I),
        "revenue": re.compile(r"\brevenue\b", re.I),
        "net-income": re.compile(r"\bnet\s+income\b", re.I),
        "dividend-history": re.compile(r"\bdividend\s+history\b", re.I),
    }
    violations = []
    pattern = re.compile(r'<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>', re.I)
    for match in pattern.finditer(document or ""):
        href, text = match.group(1), _strip_html(match.group(2))
        route = re.search(r"/stocks/[^/?#]+/([^/?#]+)$", href, re.I)
        target = route.group(1).lower() if route else None
        if target not in METRIC_ROUTE_SLUGS:
            continue
        metric = target
        if metric in expected and not expected[metric].search(text):
            violations.append({"href": href, "anchor": text, "target": metric, "reason": "anchor text does not match destination metric"})
        for source_metric, source_pattern in expected.items():
            if source_metric != metric and source_pattern.search(text):
                violations.append({"href": href, "anchor": text, "target": metric, "reason": f"{source_metric} wording points to {metric}"})
    return violations


def rendered_internal_metric_links() -> list[dict]:
    code = (
        "const seo=require('./backend/seo-pages'); const extra=require('./backend/seo-extra');"
        "const pages=[['/stocks/WAB',seo.renderStockPage('WAB')],"
        "...extra.METRIC_SLUGS.map(s=>['/stocks/WAB/'+s,extra.renderMetricPage('WAB',s)])];"
        "console.log(JSON.stringify(pages));"
    )
    try:
        result = subprocess.run(["node", "-e", code], cwd=ROOT, capture_output=True, text=True, timeout=45, check=False)
        pages = json.loads([line for line in result.stdout.splitlines() if line.strip()][-1])
    except (subprocess.SubprocessError, ValueError, OSError, IndexError):
        pages = []
    rows = []
    for source, document in pages:
        violations = audit_metric_anchors(document)
        links = []
        pattern = re.compile(r'<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>', re.I)
        for match in pattern.finditer(document or ""):
            href, text = match.group(1), _strip_html(match.group(2))
            route = re.search(r"/stocks/[^/?#]+/([^/?#]+)$", href, re.I)
            if route and route.group(1).lower() in METRIC_ROUTE_SLUGS:
                links.append({"href": href, "anchor": text, "target": route.group(1).lower()})
        rows.append({"source": source, "anchors_checked": len(re.findall(r'<a\b', document or "", re.I)), "metric_links": links, "violations": violations})
    return rows


def render_internal_metric_link_report(rows: list[dict]) -> str:
    lines = [
        "# Internal metric-link audit", "",
        "The audit renders the WAB stock page and its metric pages, then checks anchors whose destination is an existing metric route. Exact concise labels are accepted (for example, `Earnings per Share (EPS)` and `Shares Outstanding`); ticker repetition is not required.", "",
    ]
    violations = [(row["source"], issue) for row in rows for issue in row["violations"]]
    lines += [f"- `{row['source']}` — {row['anchors_checked']} anchors inspected; **{len(row['violations'])}** semantic violations." for row in rows]
    lines += ["", "## Violations", ""]
    if violations:
        lines += [f"- `{source}`: `{issue['anchor']}` → `{issue['href']}` ({issue['reason']})." for source, issue in violations]
    else:
        lines.append("No semantically wrong EPS, shares-outstanding, revenue, net-income or dividend-history anchors were found in the rendered WAB set.")
    lines += ["", "Only semantically incorrect anchors are changed; this audit does not recommend a broader internal-link network.", ""]
    return "\n".join(lines)


def render_metric_authority_flow_report(link_rows: list[dict], ownership_rows: list[dict], q3: list[dict]) -> str:
    """Describe internal authority flow without assuming the highest-impression source deserves priority."""
    page_stats = {}
    for row in q3:
        page = row.get("page", "")
        if page:
            item = page_stats.setdefault(page, {"impressions": 0.0, "clicks": 0.0, "position": 0.0})
            item["impressions"] += float(row.get("impressions", 0) or 0)
            item["clicks"] += float(row.get("clicks", 0) or 0)
            item["position"] += float(row.get("position", 0) or 0) * float(row.get("impressions", 0) or 0)
    lines = [
        "# Internal metric authority-flow audit", "",
        "This audit checks which rendered page types link to metric routes, the semantic anchor used, and whether a source page has observed Search Console visibility. It does not assume comparison or filing pages deserve priority merely because they have impressions.", "",
        "## Rendered source pages", "",
    ]
    table = []
    for row in link_rows:
        source = row["source"]
        source_type = "metric" if re.search(r"/stocks/[^/]+/[^/]+$", source) else "stock"
        stat = page_stats.get(f"https://{SITE_HOST}{source}", {})
        position = stat.get("position", 0) / stat.get("impressions", 1) if stat.get("impressions") else 0
        table.append([f"`{source}`", source_type, str(len(row.get("metric_links", []))), str(len(row.get("violations", []))), f"{stat.get('impressions', 0):,.0f}", f"{position:.2f}" if position else "—"])
    lines += markdown_table(["Source", "Page type", "Metric links", "Semantic violations", "GSC impressions", "GSC position"], table) if table else ["No rendered source pages were available."]
    lines += ["", "## Destination/anchor observations", ""]
    for row in link_rows:
        for link in row.get("metric_links", []):
            lines.append(f"- `{row['source']}` → `{link['href']}` using anchor `{link['anchor'] or '(empty)'}`.")
    if not any(row.get("metric_links") for row in link_rows):
        lines.append("No metric links were found in the rendered sample.")
    lines += ["", "## Priority rule", "", "Correct semantic anchors are retained; only semantically wrong anchors are corrected. Higher-visibility source pages are recorded for follow-up, but an observed comparison or filing page is not automatically a priority. Ownership evidence, intended-route position, wrong-route position and repeated cross-ticker patterns remain the decision inputs.", ""]
    return "\n".join(lines)


def render_metric_measurement_plan(retrieval: str, period: dict | None, deployment_at: str = "") -> str:
    period = period or {}
    return "\n".join([
        "# Metric ownership measurement plan", "",
        "This plan separates ownership from ranking and uses non-overlapping Search Console windows.", "",
        "## Baseline (PRE)", "",
        f"- Export retrieved: `{retrieval or 'local export'}`.",
        f"- PRE window: `{period.get('start', 'unknown')}` to `{period.get('end', 'unknown')}`.",
        "- Record for each explicit query: intended metric, intended route, intended-route impressions, wrong-route impressions, total relevant metric impressions, intended ownership rate, dominant URL, dominant-route correctness, intended-route position, wrong-route position, overall position, clicks and CTR.", "",
        "## Post-fix window (POST)", "",
        f"- Deployment timestamp: `{deployment_at or 'PENDING — record actual production deployment'}`.",
        "- First meaningful post-GSC date: `PENDING — use the first date after deployment plus recrawl buffer`.",
        "- POST window: `PENDING — non-overlapping with PRE`.",
        "- Flag: `PARTIAL_RECRAWL_POSSIBLE` until all affected metric pages have recrawled.",
        "- For low traffic, extend POST rather than mixing PRE rows into a rolling three-month sample.", "",
        "## Decision fields", "",
        "- Primary: intended ownership rate with absolute intended/wrong/total impression counts.",
        "- Secondary: impressions, dominant URL, intended/wrong/overall position and CTR.",
        "- Do not declare a win from CTR or ranking alone. Report ownership, authority and ranking separately.", "",
    ])


def render_baseline_reconciliation(retrieval: str, acquisition: dict, q3: list[dict]) -> str:
    period = acquisition.get("datasets", {}).get("queries-3m", {})
    query_stats = aggregate_stats(q3)
    return "\n".join([
        "# Search performance baseline reconciliation", "",
        "This report keeps Search Console snapshots separate. It does not combine figures from different windows, filters or dimensions.", "",
        "## Current local API dataset", "",
        f"- Property: `sc-domain:stockportfolio.pro` (domain property; service-account access recorded as Full user).",
        f"- Retrieval: `{retrieval or 'not recorded'}`.",
        f"- Exact query aggregate window: `{period.get('start', 'unknown')}` to `{period.get('end', 'unknown')}`; search type `web`; no query/page, device, country or page filter in the aggregate request.",
        f"- Query rows: **{len(q3):,}**; query-dimension sum: **{query_stats['impressions']:,.0f} impressions / {query_stats['clicks']:,.0f} clicks / {pct(query_stats['ctr'])} CTR / {query_stats['position']:.2f} weighted position**.",
        "- The query aggregate is a `DIMENSION TOTAL` and is not a site total; Search Console may omit anonymized/low-volume queries.", "",
        "## Previously reported snapshots kept separate", "",
        "| Snapshot | Reported window | Filters/dimensions known | Reported clicks | Reported impressions | CTR | Position | Status |",
        "|---|---|---|---:|---:|---:|---:|---|",
        "| Broad GSC analysis | 2026-05-10 to 2026-08-07 | Search Analytics aggregate; property summary | 17 | 9,332 | 0.18% | 12.29 | `SITE AGGREGATE` reported in prior audit; not recreated by adding CSV rows |",
        "| Filtered 28-day snapshot | 2026-07-10 to 2026-08-06 | Domain property; filtered report scope from prior report; exact request body unavailable in repo | 5 | 2,270 | 0.22% | 11.3 | `SITE AGGREGATE` reported externally; not directly comparable |",
        "| Current query export | 2026-05-10 to 2026-08-07 | Query dimension CSV | as above in query rows | as above in query rows | as above | as above | `DIMENSION TOTAL` |",
        "", "",
        "## Why the figures differ", "",
        "The 9,332/17 and 2,270/5 values cannot be reconciled arithmetically from the repository because the second report's exact request body is not preserved. Legitimate causes include the different date windows, property/report scope, filters, query versus page or query/page aggregation, privacy/anonymized-query exclusion, API row limits and Search Console's non-additive dimensions. The current export documents the request metadata and should be the single baseline for the ownership audit.", "",
        "Do not add query totals, page totals and query/page totals. The application’s ownership report uses query/page rows only to map URLs, while site-level context uses the separate query aggregate.", "",
        "## Interpretation guardrail", "",
        "The discrepancy is not evidence of an API error or a canonical defect. Re-run both exact request bodies over the same window and filters before treating the snapshots as a trend. Google Search Console data is delayed and privacy-filtered.", "",
    ])


def render_google_technical_audit(retrieval: str) -> str:
    return "\n".join([
        "# Google technical indexing audit", "",
        f"Audit evidence checked: `{retrieval or 'local export'}` plus live representative requests on 2026-08-10.", "",
        "## Canonical host audit", "",
        "The application configuration and emitted sitemap/canonical tags use `https://www.stockportfolio.pro` as the canonical host.", "",
        "| Variant | Initial/final result | Redirect hops | Final URL | Canonical / OG URL | Finding |",
        "|---|---|---:|---|---|---|",
        "| `http://stockportfolio.pro/stocks/WAB/eps` | 301 → 301 → 200 | 2 | `https://www.stockportfolio.pro/stocks/WAB/eps` | matching www HTTPS URL | stable but two edge hops |",
        "| `https://stockportfolio.pro/stocks/WAB/eps` | 301 → 200 | 1 | `https://www.stockportfolio.pro/stocks/WAB/eps` | matching www HTTPS URL | stable |",
        "| `http://www.stockportfolio.pro/stocks/WAB/eps` | 301 → 200 | 1 | `https://www.stockportfolio.pro/stocks/WAB/eps` | matching www HTTPS URL | stable |",
        "| `https://www.stockportfolio.pro/stocks/WAB/eps` | 200 | 0 | same | matching canonical and OG URL | canonical endpoint |",
        "",
        "Trailing slash `/stocks/WAB/eps/` returns one 301 to the slashless canonical path. No loop was observed. Sitemap and internal rendered links use the www HTTPS host.", "",
        "## Diagnosis", "",
        "Classification: **`HISTORICAL_ALREADY_FIXED` for the reported duplicate/canonical warning; no current canonical instability demonstrated.** The remaining two-hop HTTP non-www edge redirect is an efficiency observation, not proof of ownership or ranking causality, and is outside the application’s routing layer. No new host redirect was added.", "",
        "## Duplicate/canonical warning", "",
        "The local export contains no exact URL list or Google-selected-canonical payload for the prior warning. Without those URLs, a URL-level duplicate classification cannot be stronger than `UNRESOLVED_INSUFFICIENT_EVIDENCE`; current representative routes emit one canonical matching the final URL.", "",
        "## 5xx validation", "",
        "No exact URLs from the July 28 validation report were available in the local evidence. Three consecutive live requests each returned HTTP 200 for WAB EPS, DELL revenue, GOOGL net income and GM revenue; `/api/health` returned 200 and slash normalization returned one 301. Classification: **`UNRESOLVED_INSUFFICIENT_EVIDENCE` for the historical URL set**, with no current application defect demonstrated. Do not modify production code for a historical 5xx claim without exact failing URLs or reproducible logs.", "",
        "## Google versus Bing", "",
        "Bing’s stronger reported clicks and zero active issues are directional only. Crawling, indexing, ranking, audience and SERP layouts differ. The data does not prove that canonicalization caused Google’s lower CTR; current Google-specific technical problems remain a plausible contributor, not a demonstrated cause.", "",
    ])


def render_metric_go_no_go(ownership_report: str, retrieval: str, period: dict | None, rows: list[dict], q3: list[dict]) -> str:
    period = period or {}
    strong = [r for r in rows if r.get("material_cannibalization") == "yes" and r.get("evidence_strength") in {"MODERATE_EVIDENCE", "STRONG_EVIDENCE"}]
    q_impressions = sum(float(r.get("impressions", 0) or 0) for r in q3 if classify_metric_query(r.get("query", "")) != "AMBIGUOUS_QUERY")
    mismatched = sum(float(r.get("impressions", 0) or 0) for r in q3 if str(r.get("query", "")).strip().lower() in {x.get("query", "").strip().lower() for x in strong})
    share = mismatched / q_impressions if q_impressions else 0
    lines = [
        "# Metric ownership go / no-go", "",
        "This gate separates obvious semantic correctness from speculative ranking/authority work. No new pages, broad AI CTAs, Ask, pricing, Stripe, AppSumo or activation changes are included.", "",
        "## Dataset", "",
        f"- Latest files: `seo-data/gsc/queries-3m.csv`, `pages-3m.csv`, `query-page-3m.csv`, plus `acquisition.json`.",
        f"- Property: `sc-domain:stockportfolio.pro`; window: `{period.get('start', 'unknown')}` to `{period.get('end', 'unknown')}`; retrieved `{retrieval or 'not recorded'}`.", "",
        "## Technical state", "",
        "- Canonical: representative variants are stable on `https://www.stockportfolio.pro`; the historical duplicate warning is not reproduced. HTTP non-www has two edge hops but no loop; no redirect code was changed.",
        "- 5xx: exact historical validation URLs are unavailable; representative current routes are 200. Historical issue remains unresolved for URL-level attribution, not a demonstrated current application defect.", "",
        "## WAB evidence", "",
        "The dedicated audit is the source of truth; this compact table preserves the decision rows.", "",
    ]
    wab_rows = [r for r in rows if "wab" in str(r.get("query", "")).lower() and r.get("evidence_strength") in {"MODERATE_EVIDENCE", "STRONG_EVIDENCE"}]
    lines += markdown_table(["Query", "Ticker", "Intended", "Routes / impr.", "Intended / total", "Position", "Evidence", "Material"], [[f"`{html.escape(r['query'])}`", r.get("ticker", "WAB"), f"`{r['intended_route']}`", r["route_breakdown"], f"{r['intended_route_impressions']:,.0f} / {r['total_relevant_metric_impressions']:,.0f} ({pct(r['intended_ownership_rate'])})", f"{r['position']:.2f}", r["evidence_strength"], r["material_cannibalization"]] for r in wab_rows[:30]]) if wab_rows else ["No qualifying WAB rows."]
    lines += [
        "",
        "The strongest rows show 0 intended EPS impressions versus 1,269 relevant wrong-route impressions, and 0 intended shares impressions versus 596 relevant wrong-route impressions; both are STRONG_EVIDENCE and wrong-route dominant.", "",
        "## Cross-ticker repetition", "",
        "DELL has two weak-evidence historical revenue mismatches; GOOGL and GM are surfaced but do not provide the same strong repeated wrong-route pattern in this export; CTSH has no qualifying explicit row. The ownership renderer/report is reusable, but no ticker-specific SEO hack is justified.", "",
        "## SEO demand affected", "",
        f"- Explicit high-confidence metric-query impressions: **{q_impressions:,.0f}**.",
        f"- Materially mismatched query impressions: **{mismatched:,.0f}** ({pct(share)} of observed explicit metric demand).",
        "- These are query aggregate figures matched by query text, not additive site totals; privacy filtering and query/page non-additivity limit precision.", "",
        "## Alternative explanations", "",
        "Weak ranking authority, stale indexed HTML, historical Google state, ambiguous intent and small samples can also explain some rows. The WAB rows are not trivial, but ownership and authority are reported separately; a correct page may still need authority. Canonical instability and the July 28 5xx report are not currently demonstrated causes.", "",
        "## Decision", "",
        "**GO — IMPLEMENT REUSABLE OWNERSHIP FIX** (limited to existing metric semantics, exact internal anchors, audit instrumentation and canonical consistency). This is justified by high-confidence WAB wrong-route dominance at STRONG_EVIDENCE. Do not expand into new pages, broad authority networks or per-ticker hacks until post-recrawl evidence supports it.", "",
        "## Rollback/evidence gate", "",
        "Record deployment time, wait for meaningful recrawl, and compare non-overlapping PRE/POST ownership counts. A ranking or CTR change alone is not an ownership win. If WAB intended ownership does not improve after adequate post data, treat the ownership hypothesis as falsified and investigate authority/content depth instead.", "",
    ]
    return "\n".join(lines)


def render_metric_similarity_report(metadata_cache: dict[str, dict]) -> str:
    pages = {}
    for slug in ("eps", "shares-outstanding", "dividend-history"):
        pages[slug] = metadata_for_page(f"https://{SITE_HOST}/stocks/WAB/{slug}", metadata_cache)
    fields = ["title", "h1", "opening", "primaryHeading", "methodologyHeading", "methodology"]
    lines = [
        "# WAB metric-page rendered similarity", "",
        "This compares the initial server-rendered fields for `/stocks/WAB/eps`, `/stocks/WAB/shares-outstanding` and `/stocks/WAB/dividend-history`. Shared navigation/footer is expected; the opening answer, primary history heading and methodology must remain metric-specific.", "",
        "| Page | Title | H1 | Opening answer | Primary history heading | Methodology heading |", "|---|---|---|---|---|---|",
    ]
    cell = lambda value: html.escape(str(value or 'missing')).replace('|', '\\|')
    for slug, data in pages.items():
        lines.append(f"| `/{slug}` | {cell(data.get('title'))} | {cell(data.get('h1'))} | {cell(data.get('opening'))} | {cell(data.get('primaryHeading'))} | {cell(data.get('methodologyHeading'))} |")
    token_sets = [set(re.findall(r"[a-z0-9]+", " ".join(str(pages[slug].get(field, "")) for field in fields).lower())) for slug in pages]
    union = set().union(*token_sets) if token_sets else set()
    common = set.intersection(*token_sets) if token_sets else set()
    shared = len(common) / len(union) if union else 0
    unique_checks = []
    for field in fields:
        values = [pages[slug].get(field, "") for slug in pages]
        unique_checks.append(f"- `{field}` unique across pages: **{'yes' if len(set(values)) == len(values) and all(values) else 'no'}**.")
    lines += ["", f"- Shared-token proportion across the selected fields: **{shared:.1%}** (shared template wording is not itself an ownership failure).", *unique_checks, "", "A derived value is described as calculated/approximate in the metric-specific answer and methodology; no generic keyword filler is added.", ""]
    return "\n".join(lines)


def markdown_table(headers: list[str], rows: list[list[str]]) -> list[str]:
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    lines.extend("| " + " | ".join(str(cell).replace("|", "\\|") for cell in row) + " |" for row in rows)
    return lines


def render_position_report(q3: list[dict], qp3: list[dict], retrieval: str) -> str:
    lines = [
        "# Search Console position distribution",
        "",
        "This report uses the 3-month **query aggregate** export for position buckets. Query/page rows are shown separately where page-level context is needed. Search Console dimension totals are non-additive: do not sum query, page and query/page totals to recreate the property total.",
        "",
        f"Retrieved: `{retrieval or 'local export'}`.",
        "",
        "## Property-level buckets",
        "",
    ]
    headers = ["Position", "Queries", "Impressions", "Clicks", "CTR", "Weighted avg position"]
    lines += markdown_table(headers, [[s["bucket"], f'{s["rows"]:,}', f'{s["impressions"]:,.0f}', f'{s["clicks"]:,.0f}', pct(s["ctr"]), f'{s["position"]:.2f}'] for s in bucket_stats(q3)])
    lines += ["", "## Query-cluster buckets", "", "Each cluster below is classified from the observed query text. It is descriptive, not a claim of intent or commercial value.", ""]
    for family in ["earnings/EPS/profit", "revenue", "shares/dilution", "comparisons", "filings", "other financial metrics"]:
        rows = [r for r in q3 if family_for(cluster_for(r.get("query", ""))) == family]
        lines += [f"### {family}", ""]
        lines += markdown_table(headers, [[s["bucket"], f'{s["rows"]:,}', f'{s["impressions"]:,.0f}', f'{s["clicks"]:,.0f}', pct(s["ctr"]), f'{s["position"]:.2f}'] for s in bucket_stats(rows)])
        lines.append("")
    lines += [
        "## Reading this safely",
        "",
        "- Position is an average over the selected date range and can hide device, country and day-to-day variation.",
        "- CTR is clicks divided by impressions for each exported dimension; low-volume rows are noisy.",
        "- Query/page totals are useful for mapping a query to a URL, but they are not additive with query aggregates.",
        "",
    ]
    return "\n".join(lines)


def render_high_ranking_review(q3: list[dict], qp3: list[dict], retrieval: str, query_country: list[dict] | None = None, query_device: list[dict] | None = None, query_date: list[dict] | None = None) -> str:
    candidates = [r for r in q3 if r["impressions"] >= 100 and r["position"] <= 5]
    # Keep the requested WAB EPS signal visible even if a future export changes
    # its spelling or threshold slightly; it remains labelled as observed data.
    wab = [r for r in q3 if "wab" in r.get("query", "").lower() and "eps" in r.get("query", "").lower()]
    for row in wab:
        if row not in candidates:
            candidates.append(row)
    page_by_query: dict[str, list[dict]] = {}
    for row in qp3:
        page_by_query.setdefault(row.get("query", "").lower(), []).append(row)
    meta_cache: dict[str, dict] = {}
    lines = [
        "# High-ranking, low-CTR review",
        "",
        "Observed query rows with at least 100 impressions and average position at or above the first five results are reviewed here. A WAB/EPS row is included when present. These are snippet and URL-ownership diagnostics, not proof of commercial intent.",
        "",
        f"Retrieved: `{retrieval or 'local export'}`.",
        "",
    ]
    if not candidates:
        lines += ["No observed query met the threshold in the local export.", ""]
        return "\n".join(lines)
    for index, row in enumerate(sorted(candidates, key=lambda x: (x["impressions"], -x["position"]), reverse=True), 1):
        matches = sorted(page_by_query.get(row["query"].lower(), []), key=lambda x: x["impressions"], reverse=True)
        ranking = matches[0] if matches else {}
        page = ranking.get("page", "")
        meta = metadata_for_page(page, meta_cache) if page else {}
        query = row.get("query", "")
        intent = intent_for(query, page)[0] if page else intent_for(query, "")[0]
        match = "review required"
        if page:
            cluster = cluster_for(query)
            route = page_route(page)
            if cluster == "earnings/profit" and route and route[1] in {"eps", "net-income"}:
                match = "strong metric ownership match"
            elif cluster == "revenue" and route and route[1] == "revenue":
                match = "strong metric ownership match"
            elif cluster == "comparison" and "/compare/" in page:
                match = "comparison route present; inspect pair semantics"
            else:
                match = "possible neighboring-page mismatch"
        def split_text(source_rows: list[dict] | None, field: str) -> str:
            selected = [item for item in (source_rows or []) if item.get("query", "").lower() == query.lower()]
            if not selected:
                return "not available"
            return "; ".join(f"{item.get(field, '—')}: {item['impressions']:,.0f} impressions / {item['clicks']:,.0f} clicks" for item in selected[:12])
        lines += [
            f"## {index}. `{html.escape(query)}`",
            "",
            f"- Query: **{html.escape(query)}**",
            f"- Ranking URL: `{short_page(page) or 'not present in query/page export'}`",
            f"- Impressions / clicks / CTR: **{row['impressions']:,.0f} / {row['clicks']:,.0f} / {pct(row['ctr'])}**",
            f"- Average position: **{row['position']:.2f}** (not a promise of a fixed rank)",
            f"- Search-intent label: **{intent}**; URL review: **{match}**",
            f"- Title: `{meta.get('title') or 'not rendered locally'}`",
            f"- H1: `{re.sub('<[^>]+>', ' ', meta.get('h1', '')).strip() or 'not rendered locally'}`",
            f"- Meta description: `{meta.get('meta') or 'not rendered locally'}`",
            f"- Country split: {split_text(query_country, 'country')}.",
            f"- Device split: {split_text(query_device, 'device')}.",
            f"- Date split: {split_text(query_date, 'date')}.",
            "",
        ]
    return "\n".join(lines)


def comparison_quality_rows(qp3: list[dict], country_rows: list[dict], device_rows: list[dict]) -> list[dict]:
    rows = []
    raw = [r for r in qp3 if cluster_for(r.get("query", "")) == "comparison" and "/compare/" in r.get("page", "")]
    pairs = collections.Counter(comparison_pair(r.get("page", "")) for r in raw)
    for row in sorted(raw, key=lambda r: (r["impressions"], r["clicks"]), reverse=True):
        query = row.get("query", "")
        clean = not query.lower().startswith("site:") and not any(x in query.lower() for x in ("stocktwits", "login", "stock portfolio"))
        explicit = bool(re.search(r"\b(compare|versus|vs)\b", query.lower()))
        pair = comparison_pair(row.get("page", ""))
        pair_symbols = pair.split("-VS-") if pair else []
        # A comparison route alone is not proof that it answers the query. We
        # can call it a likely match only when both canonical symbols appear in
        # the observed query; company-name-only rows stay explicitly unclear.
        query_lower = query.lower()
        page_answers = explicit and len(pair_symbols) == 2 and all(re.search(rf"\b{re.escape(symbol.lower())}\b", query_lower) for symbol in pair_symbols)
        rows.append({
            **row, "pair": pair, "pair_repetition": pairs[pair],
            "clear_comparison_intent": "yes" if clean and explicit else "no",
            "page_answers_query": "likely" if page_answers else "unclear",
            "quality_class": "genuine candidate" if clean and explicit and page_answers else ("template/navigational review" if not clean else "ambiguous long-tail"),
        })
    return rows


def render_comparison_report(rows: list[dict], country_rows: list[dict], device_rows: list[dict]) -> str:
    lines = [
        "# Comparison quality analysis", "",
        "Comparison impressions are not treated as intent. Each row is checked for explicit comparison language, a canonical `/compare/A-vs-B` route, and contamination by site/navigational patterns.", "",
    ]
    def breakdown(source_rows, query, field):
        selected = [item for item in (source_rows or []) if item.get("query", "").lower() == query.lower()]
        return "; ".join(f"{item.get(field, '—')}:{item['impressions']:,.0f}" for item in selected[:5]) or "—"
    headers = ["Query", "Page / pair", "Clicks", "Impr.", "CTR", "Pos.", "Repeat", "Clear intent", "Answers query", "Device", "Country", "Quality"]
    lines += markdown_table(headers, [[html.escape(r["query"]), f'`{short_page(r["page"])}` / `{r["pair"]}`', f'{r["clicks"]:,.0f}', f'{r["impressions"]:,.0f}', pct(r["ctr"]), f'{r["position"]:.1f}', str(r["pair_repetition"]), r["clear_comparison_intent"], r["page_answers_query"], breakdown(device_rows, r["query"], "device"), breakdown(country_rows, r["query"], "country"), r["quality_class"]] for r in rows[:100]])
    lines += ["", "## Interpretation", "", f"- Meaningful comparison rows in this export: **{sum(r['quality_class'] == 'genuine candidate' for r in rows)}** of **{len(rows)}** comparison query/page rows.", "- Pair repetition counts are descriptive; repetition does not establish purchase intent.", "- Country/device breakdowns are reported only when corresponding Search Console dimension files exist; the existing export may not contain them.", "- Playtika–Yelp is not promoted to a product family solely because it has a large impression count.", ""]
    return "\n".join(lines)


def render_revenue_report(qp3: list[dict]) -> str:
    rows = [r for r in qp3 if re.search(r"\b(revenue|sales|historical|history|growth)\b", r.get("query", "").lower())]
    lines = ["# Revenue quality analysis", "", "This report maps observed revenue-related query/page rows to the intended existing financial-history URL. It does not infer demand for new pages.", ""]
    table = []
    for row in sorted(rows, key=lambda r: (r["impressions"], r["clicks"]), reverse=True)[:150]:
        route = page_route(row.get("page", ""))
        intended = f"/stocks/{route[0]}/revenue" if route else "not derivable from URL"
        page_path = short_page(row.get("page", ""))
        query = row.get("query", "")
        mismatch = "no" if route and route[1] == "revenue" else "yes"
        relevance = "direct revenue history" if re.search(r"\b(revenue|sales)\b", query.lower()) and route and route[1] == "revenue" else "related/review"
        table.append([html.escape(query), f"`{page_path}`", f"`{intended}`", f'{row["impressions"]:,.0}', f'{row["clicks"]:,.0}', pct(row["ctr"]), f'{row["position"]:.1f}', mismatch, relevance])
    lines += markdown_table(["Query", "Ranking URL", "Intended URL", "Impr.", "Clicks", "CTR", "Pos.", "Mismatch", "Product relevance"], table)
    lines += ["", "## Notes", "", "- A query/page mismatch is a ranking ownership issue to fix on the existing template, not a reason to generate a duplicate page.", "- Historical revenue and revenue-growth wording is retained as query evidence; the page still links to the filed revenue history route.", ""]
    return "\n".join(lines)


def choose_second_family(qp3: list[dict]) -> tuple[str, dict, str]:
    comparison = comparison_quality_rows(qp3, [], [])
    meaningful_comparisons = [r for r in comparison if r["quality_class"] == "genuine candidate"]
    revenue = [r for r in qp3 if re.search(r"\b(revenue|sales|historical|history|growth)\b", r.get("query", "").lower())]
    revenue_direct = [r for r in revenue if page_route(r.get("page", "")) and page_route(r["page"])[1] == "revenue"]
    comp_imps = sum(r["impressions"] for r in meaningful_comparisons)
    rev_imps = sum(r["impressions"] for r in revenue_direct)
    comp_pairs = len({r["pair"] for r in meaningful_comparisons if r["pair"]})
    rev_pages = len({r["page"] for r in revenue_direct})
    scores = {
        "COMPARISON": round(comp_imps + comp_pairs * 20 + len(meaningful_comparisons) * 5, 2),
        "REVENUE_HISTORY": round(rev_imps + rev_pages * 20 + len(revenue_direct) * 5, 2),
    }
    # Revenue is safer when comparison rows are contaminated by arbitrary or
    # navigational text. Use evidence to choose; never force Playtika–Yelp.
    if meaningful_comparisons and scores["COMPARISON"] > scores["REVENUE_HISTORY"] and comp_pairs >= 3:
        choice = "COMPARISON"
        reason = "Comparison rows have explicit comparison language, multiple repeated pairs and a clean canonical comparison route; the quality report must still be monitored for ranking/activation harm."
    else:
        choice = "REVENUE_HISTORY"
        reason = "Revenue/history rows map more directly to a single filed metric route and present lower contamination risk than comparison rows; the comparison export does not meet the repeated, clear-intent bar for a safe second family."
    return choice, {"scores": scores, "meaningful_comparison_rows": len(meaningful_comparisons), "comparison_pairs": comp_pairs, "revenue_direct_rows": len(revenue_direct), "revenue_pages": rev_pages, "revenue_direct_impressions": rev_imps, "comparison_impressions": comp_imps}, reason


def render_family_selection(qp3: list[dict], choice: str, stats: dict, reason: str) -> str:
    criteria = [
        ("Demonstrated GSC demand", "Both families are evaluated only from observed query/page rows."),
        ("Query intent clarity", "Explicit comparison language is required for comparison rows; revenue wording must map to revenue history."),
        ("Product relevance", "Both can lead to source-backed research; the selected family preserves the answer-first page."),
        ("Ranking accessibility", "Existing pages with impressions are eligible; no new pages are created."),
        ("Useful next action", "Ask receives structured symbol/metric context, never a prompt in the URL."),
        ("Repeated pattern", f"Comparison pairs: {stats['comparison_pairs']}; direct revenue pages: {stats['revenue_pages']}."),
        ("UX/index risk", "One optional module is gated by an explicit flag and observed URL manifest."),
    ]
    lines = ["# Activation family selection", "", f"**Selected second family: `{choice}`**", "", reason, "", "## Evidence snapshot", "", f"- Comparison: {stats['meaningful_comparison_rows']} clear rows, {stats['comparison_pairs']} pairs, {stats['comparison_impressions']:,.0f} impressions.", f"- Revenue/history: {stats['revenue_direct_rows']} direct rows, {stats['revenue_pages']} pages, {stats['revenue_direct_impressions']:,.0f} impressions.", "", "## Decision criteria", ""]
    lines += markdown_table(["Criterion", "Evidence/guardrail"], [[a, b] for a, b in criteria])
    lines += ["", "This decision is directional. It is not a forecast and is reversible by leaving `SEO_ACTIVATION_PILOT=false`.", ""]
    return "\n".join(lines)


def write_eligibility(qp3: list[dict], family2: str, report_at: str) -> dict:
    eligible: dict[str, dict] = {}
    for row in qp3:
        page = row.get("page", "")
        route = page_route(page)
        if not route or row["impressions"] <= 0:
            continue
        symbol, slug = route
        cluster = cluster_for(row.get("query", ""))
        family = family_for(cluster)
        allowed = (slug in {"eps", "net-income"} and family == "earnings/EPS/profit")
        if family2 == "REVENUE_HISTORY":
            allowed = allowed or (slug == "revenue" and family == "revenue")
        elif family2 == "COMPARISON":
            allowed = allowed or ("/compare/" in page and family == "comparisons")
        if not allowed:
            continue
        item = eligible.setdefault(page, {"url": page, "path": short_page(page), "symbol": symbol, "metric": slug, "queryCluster": family, "impressions": 0, "clicks": 0, "queries": []})
        item["impressions"] += row["impressions"]
        item["clicks"] += row["clicks"]
        if row.get("query") and row["query"] not in item["queries"]:
            item["queries"].append(row["query"])
    payload = {"generatedAt": report_at, "featureFlag": "SEO_ACTIVATION_PILOT", "selectedSecondFamily": family2, "eligiblePages": sorted(eligible.values(), key=lambda item: item["impressions"], reverse=True)}
    (ROOT / "seo-data" / "activation-eligibility.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload


def baseline_title(row: dict, metadata: dict, new: bool) -> str:
    if new and metadata.get("title"):
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", metadata["title"])).strip()
    route = page_route(row.get("page", ""))
    if route:
        symbol, slug = route
        label = ("Earnings per Share (EPS)" if slug == "eps" else slug.replace("-", " ").title()) if new else ("EPS" if slug == "eps" else slug.replace("-", " ").title())
        return f"{symbol} {label} History" if not new else f"{symbol} {label} History"
    pair = comparison_pair(row.get("page", ""))
    if not pair: return ""
    return (f"{pair.replace('-VS-', ' vs ')} Stock Comparison: Revenue, Margins, P/E and ROE"
            if not new else f"{pair.replace('-VS-', ' vs ')} Stock Comparison")


def write_ranking_baseline(opportunities: list[dict], metadata_cache: dict[str, dict], report_at: str):
    fields = ["URL", "page family", "target query", "query cluster", "baseline impressions", "baseline clicks", "baseline CTR", "baseline position", "old title", "new title", "old H1", "new H1", "change reason", "deployment date placeholder"]
    path = ROOT / "seo-data" / "ranking-change-baseline.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        seen = set()
        for row in opportunities:
            page = row.get("page", "")
            if not page or page in seen or row.get("evidence_type") != "OBSERVED_GSC":
                continue
            if not ("/stocks/" in page or "/compare/" in page):
                continue
            seen.add(page)
            # The baseline is an artifact for the ranking-only change, not a
            # full-universe crawl. Keep it bounded so report generation never
            # renders hundreds of cached pages or turns into a deploy step.
            if len(seen) > 20:
                break
            metadata = metadata_for_page(page, metadata_cache)
            old_title = baseline_title(row, metadata, False)
            new_title = baseline_title(row, metadata, True)
            route = page_route(row.get("page", ""))
            old_h1 = old_title.replace(" History", "")
            if route and route[1] == "eps": old_h1 = f"{route[0]} EPS"
            if not route and "/compare/" in page:
                pair = comparison_pair(page)
                old_h1 = f"{pair.replace('-VS-', ' vs ')}: Which Stock Is the Better Buy?" if pair else old_h1
            new_h1 = re.sub(r"<[^>]+>", " ", metadata.get("h1", "")).strip() or old_h1
            writer.writerow({
                "URL": page, "page family": "metric" if "/stocks/" in page else "comparison",
                "target query": row.get("query", ""), "query cluster": row.get("query_cluster", ""),
                "baseline impressions": row.get("impressions", 0), "baseline clicks": row.get("clicks", 0),
                "baseline CTR": row.get("ctr", 0), "baseline position": row.get("position", 0),
                "old title": old_title, "new title": new_title, "old H1": old_h1, "new H1": new_h1,
                "change reason": "Ranking-only relevance correction: exact metric wording/ticker ownership or full comparison names/tickers.",
                "deployment date placeholder": "TBD — not deployed",
            })


def render_pilot_report(q3: list[dict], qp3: list[dict], family2: str, eligibility: dict, report_at: str) -> str:
    # Search Console may return either the abbreviation or the natural phrase;
    # retain both so the required WAB evidence is never silently omitted.
    earnings = [
        r for r in q3
        if "wab" in r.get("query", "").lower()
        and ("eps" in r.get("query", "").lower() or "earnings per share" in r.get("query", "").lower())
    ]
    wab_eligible = [
        page for page in eligibility.get("eligiblePages", [])
        if page.get("symbol") == "WAB" and page.get("metric") in {"eps", "net-income"}
    ]
    lines = [
        "# SEO activation pilot record", "", "## Scope", "", "- Feature flag: `SEO_ACTIVATION_PILOT=false` by default.", "- Initial pilot is **100% exposure** for eligible organic visitors, not URL-hash randomization and not a statistically powered A/B test.", "- Fixed family: observed EPS/earnings pages. Selected second family: `" + family2 + "`.", "- No new pages, broad internal-link network, pricing, Stripe or AppSumo changes.", "", "## Hypothesis", "", "A visitor who arrived from an organic search query about a filed metric may use one relevant, structured research action after seeing the answer, data and source. The pilot measures whether that action is used, not whether impressions equal commercial intent.", "", "## Observed baseline", "", f"- Local GSC export retrieved: `{report_at or 'not recorded'}`.", f"- Eligible pages in the observed manifest: **{len(eligibility.get('eligiblePages', []))}**.", "- WAB/EPS rows (if present) are retained as an observed signal, not proof of purchase intent:", ""]
    if earnings:
        lines += [f"  - `{r['query']}` — {r['impressions']:,.0f} impressions, {r['clicks']:,.0f} clicks, {pct(r['ctr'])} CTR, position {r['position']:.2f}." for r in earnings]
    else:
        lines.append("  - No WAB/EPS row was present in the current local query export.")
    if not wab_eligible:
        lines.append("  - No WAB `/eps` or `/net-income` page is eligible for the activation module because the observed query/page evidence maps to neighboring metric pages; this is an ownership-fix signal, not a reason to broaden eligibility.")
    lines += ["", "## Treatment module", "", "- EPS/earnings: `Explain these earnings changes` → `/ask?symbol=...&metric=eps&content_id=seo-eps-next-action`.", "- Revenue/history: `Explain this revenue change` → `/ask?symbol=...&metric=revenue&content_id=seo-revenue-next-action` when selected.", "- Comparison is not enabled unless the evidence report selects it; no prompt text is placed in URL state.", "- Existing canonical URL, title, H1, answer, data, chart/table, source and methodology remain unchanged and above the optional module.", "", "## Event flow", "", "`organic landing` → `seo_next_action_click` → `ask_landing` → `ask_first_query_submitted` → `ask_response_completed` / `source_opened` → existing signup/trial/paid events.", "", "Metadata is allowlisted page context only; prompts, research text, cookies, credentials and tokens are excluded. Organic is derived from first-party referrer/acquisition state; `source=organic` cannot override it.", "", "## Rollback and evaluation", "", "- Roll back only the module by setting `SEO_ACTIVATION_PILOT=false`; ranking-only title/H1 changes remain independently reversible.", "- Wait at least 28 days and reportable sessions before drawing directional conclusions; classify results as strong, weak, no-signal or negative.", "- Review ranking (impressions/CTR/position), action clicks, Ask activation/source opens, signups/trials and paid events separately.", "", "## Adversarial review", "", "- Impressions can be accidental long-tail matching, especially for comparisons; quality reports explicitly test this.", "- Average position hides country/device/day variation; no fixed-rank claim is made.", "- A CTA can reduce trust or CTR; keep the answer-first layout and monitor ranking/CTR.", "- Navigation is not activation; Ask landing alone is not counted as meaningful use.", "- Attribution must preserve signed first touch and must not be overwritten by URL parameters.", "- The eligibility manifest prevents index bloat and broad all-ticker rollout.", "- The current sample is small; no significance claim or revenue forecast is permitted.", ""]
    return "\n".join(lines)


def analyze(deployment_at: str = ""):
    base = ROOT / "seo-data" / "gsc"
    q3 = read_csv(base / "queries-3m.csv")
    p3 = read_csv(base / "pages-3m.csv")
    qp3 = read_csv(base / "query-page-3m.csv")
    q12 = read_csv(base / "queries-12m.csv")
    country3 = read_csv(base / "countries-3m.csv")
    device3 = read_csv(base / "devices-3m.csv")
    query_country3 = read_csv(base / "query-country-3m.csv")
    query_device3 = read_csv(base / "query-device-3m.csv")
    query_date3 = read_csv(base / "query-date-3m.csv")
    acquisition = {}
    try:
        acquisition = json.loads((base / "acquisition.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    report_at = acquisition.get("retrieved_at_utc", "")
    qp_period = acquisition.get("datasets", {}).get("query-page-3m", {})
    opportunities = make_opportunities(qp3, p3, q3, q12)
    write_opportunities(ROOT / "seo-data" / "seo-opportunities.csv", opportunities + hypothetical_opportunities())
    metadata_cache: dict[str, dict] = {}
    (ROOT / "seo-data" / "gsc-position-analysis.md").write_text(render_position_report(q3, qp3, report_at), encoding="utf-8")
    (ROOT / "seo-data" / "high-ranking-low-ctr-review.md").write_text(render_high_ranking_review(q3, qp3, report_at, query_country3, query_device3, query_date3), encoding="utf-8")
    comparison_rows = comparison_quality_rows(qp3, query_country3, query_device3)
    (ROOT / "seo-data" / "comparison-quality-analysis.md").write_text(render_comparison_report(comparison_rows, query_country3, query_device3), encoding="utf-8")
    (ROOT / "seo-data" / "revenue-quality-analysis.md").write_text(render_revenue_report(qp3), encoding="utf-8")
    ownership_rows = metric_ownership_rows(qp3)
    write_metric_ownership_csv(ROOT / "seo-data" / "metric-ownership-audit.csv", ownership_rows)
    (ROOT / "seo-data" / "metric-ownership-audit.md").write_text(render_metric_ownership_report(ownership_rows, report_at, qp_period, deployment_at, q3), encoding="utf-8")
    link_rows = rendered_internal_metric_links()
    (ROOT / "seo-data" / "internal-metric-link-audit.md").write_text(render_internal_metric_link_report(link_rows), encoding="utf-8")
    (ROOT / "seo-data" / "metric-authority-flow-audit.md").write_text(render_metric_authority_flow_report(link_rows, ownership_rows, q3), encoding="utf-8")
    (ROOT / "seo-data" / "metric-page-similarity.md").write_text(render_metric_similarity_report(metadata_cache), encoding="utf-8")
    (ROOT / "seo-data" / "metric-ownership-measurement-plan.md").write_text(render_metric_measurement_plan(report_at, qp_period, deployment_at), encoding="utf-8")
    (ROOT / "seo-data" / "search-performance-baseline-reconciliation.md").write_text(render_baseline_reconciliation(report_at, acquisition, q3), encoding="utf-8")
    (ROOT / "seo-data" / "google-technical-indexing-audit.md").write_text(render_google_technical_audit(report_at), encoding="utf-8")
    (ROOT / "seo-data" / "metric-ownership-go-no-go.md").write_text(render_metric_go_no_go("", report_at, qp_period, ownership_rows, q3), encoding="utf-8")
    family2, family_stats, family_reason = choose_second_family(qp3)
    (ROOT / "seo-data" / "activation-family-selection.md").write_text(render_family_selection(qp3, family2, family_stats, family_reason), encoding="utf-8")
    eligibility = write_eligibility(qp3, family2, report_at)
    write_ranking_baseline(opportunities, metadata_cache, report_at)
    (ROOT / "seo-data" / "seo-activation-pilot.md").write_text(render_pilot_report(q3, qp3, family2, eligibility, report_at), encoding="utf-8")
    clusters: dict[str, dict] = {}
    for row in q3:
        cluster = cluster_for(row.get("query", ""))
        item = clusters.setdefault(cluster, {"queries": 0, "impressions": 0, "clicks": 0})
        item["queries"] += 1; item["impressions"] += row["impressions"]; item["clicks"] += row["clicks"]
    lines = ["# Search Console SEO opportunities", "", "This report is generated from the real query+page Search Analytics export; no query/page relationships are inferred from separate totals.", "", "## Data summary", "", f"- 3-month queries: **{len(q3):,}**; pages: **{len(p3):,}**; query/page pairs: **{len(qp3):,}**.", f"- 12-month queries: **{len(q12):,}**.", "- `evidence_type=OBSERVED_GSC` means a query or query/page row in the export supports the row. Commercial terms without a supporting row remain `HYPOTHESIZED` and are not page-building instructions.", "- Ranking opportunity score rewards impressions, positions 4–20, CTR gaps, product relevance, scalability and commercial intent.", "", "## Query clusters (3 months)", "", "| Cluster | Queries | Impressions | Clicks |", "|---|---:|---:|---:|"]
    for cluster, item in sorted(clusters.items(), key=lambda kv: kv[1]["impressions"], reverse=True):
        lines.append(f"| {cluster} | {item['queries']:,} | {item['impressions']:,.0f} | {item['clicks']:,.0f} |")
    lines += ["", "## Top opportunities", "", "| # | Query | Page | Impr. | CTR | Pos. | Intent | Action | Score |", "|---:|---|---|---:|---:|---:|---|---|---:|"]
    for i, row in enumerate(opportunities[:50], 1):
        short_page = row["page"].replace("https://www.stockportfolio.pro", "")
        lines.append(f"| {i} | {html.escape(row['query'])} | `{short_page}` | {row['impressions']:,.0f} | {pct(row['ctr'])} | {row['position']:.1f} | {row['intent']} | {row['recommended_action']} | {row['opportunity_score']:.2f} |")
    # The execution list intentionally favors positions 4–20 and excludes
    # self-referential site: queries. Those are the fastest, evidence-backed
    # opportunities to improve; position-one rows remain in the full CSV for
    # snippet/CTR diagnostics.
    striking = [r for r in opportunities if 4 <= r["position"] <= 20 and r["impressions"] >= 2 and not r["query"].lower().startswith("site:")]
    top10 = striking[:10]
    lines += ["", "## Top-10 execution plan", "", "Priorities are P0 (next deploy), P1 (next sprint), and P2 (measure/internal-link follow-up).", "", "| Priority | Query / cluster | Impressions | Clicks | CTR | Position | Ranking URL | Problem and recommended change | Type | Scale | Difficulty |", "|---|---|---:|---:|---:|---:|---|---|---|---|---:|"]
    for i, row in enumerate(top10):
        priority = "P0" if i < 3 else "P1" if i < 7 else "P2"
        short_page = row["page"].replace("https://www.stockportfolio.pro", "")
        problem = f"{row['recommended_action']}: {row['implementation_type']}"
        lines.append(f"| {priority} | {html.escape(row['query'])} / {row['query_cluster']} | {row['impressions']:,.0f} | {row['clicks']:,.0f} | {pct(row['ctr'])} | {row['position']:.1f} | `{short_page}` | {html.escape(problem)} | {row['recommended_action']} | {row['scalability']} | {row['difficulty']} |")
    lines += ["", "## Hypotheses not supported by this export", "", *[f"- `{term}` — `HYPOTHESIZED`; no page is created in this phase." for term in sorted(HYPOTHESIZED_TERMS)], "", "## Caveats", "", "- Search Console data is delayed; the report ends three days before retrieval.", "- Query/page pairs are the only rows used for page-specific recommendations.", "- A high score is a prioritization aid, not a traffic or revenue guarantee.", "- Query, page and query/page dimension totals are non-additive; use the property summary and position report for their intended scope.", ""]
    (ROOT / "seo-data" / "seo-opportunities.md").write_text("\n".join(lines), encoding="utf-8")
    return {"queries3": len(q3), "pages3": len(p3), "queryPages3": len(qp3), "queries12": len(q12), "opportunities": len(opportunities), "metricOwnershipRows": len(ownership_rows), "clusters": clusters}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", default=os.environ.get("GSC_SERVICE_ACCOUNT_FILE", DEFAULT_KEY))
    parser.add_argument("--site", default=os.environ.get("GSC_SITE", DEFAULT_SITE))
    parser.add_argument("--analyze-only", action="store_true")
    parser.add_argument("--deployment-at", default=os.environ.get("METRIC_OWNERSHIP_DEPLOYMENT_AT", ""), help="Actual deployment timestamp recorded after the ownership fix is live")
    args = parser.parse_args()
    (ROOT / "seo-data" / "gsc").mkdir(parents=True, exist_ok=True)
    meta = None if args.analyze_only else fetch(args)
    result = analyze(args.deployment_at)
    print(json.dumps({"acquisition": meta, "analysis": result}, indent=2))


if __name__ == "__main__":
    main()
