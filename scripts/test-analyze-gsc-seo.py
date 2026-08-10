#!/usr/bin/env python3
"""Small offline tests for the Search Console analysis helpers."""
import runpy
import unittest


mod = runpy.run_path(__file__.replace("test-analyze-gsc-seo.py", "analyze-gsc-seo.py"))


class AnalysisHelpersTest(unittest.TestCase):
    def test_fractional_position_buckets_have_no_gaps(self):
        bucket = mod["position_bucket"]
        self.assertEqual(bucket(1), "1–3")
        self.assertEqual(bucket(3.8), "4–5")
        self.assertEqual(bucket(5.7), "6–10")
        self.assertEqual(bucket(10.1), "11–15")
        self.assertEqual(bucket(20.5), "21–50")
        self.assertEqual(bucket(51), "51+")

    def test_cluster_and_evidence_boundaries(self):
        cluster = mod["cluster_for"]
        self.assertEqual(cluster("WAB earnings per share"), "earnings/profit")
        self.assertEqual(cluster("company revenue history"), "revenue")
        self.assertEqual(cluster("AAPL vs MSFT"), "comparison")
        self.assertEqual(mod["hypothetical_opportunities"]()[0]["evidence_type"], "HYPOTHESIZED")

    def test_metric_classifier_is_conservative_and_eps_wins_only_when_explicit(self):
        classify = mod["classify_metric_query"]
        self.assertEqual(classify("earnings per share - wab"), "EPS")
        self.assertEqual(classify("diluted EPS WAB"), "EPS")
        self.assertEqual(classify("shares outstanding - wab"), "SHARES_OUTSTANDING")
        self.assertEqual(classify("revenue history AAPL"), "REVENUE")
        self.assertEqual(classify("net profit AAPL"), "NET_INCOME")
        self.assertEqual(classify("dividend history WAB"), "DIVIDEND")
        for query in ("earnings WAB", "profit margin WAB", "net profit margin WAB", "dilution WAB", "sales WAB", "EPS shares outstanding WAB"):
            self.assertEqual(classify(query), "AMBIGUOUS_QUERY")
        self.assertEqual(classify("dividend yield WAB"), "AMBIGUOUS_QUERY")

    def test_ownership_rate_and_material_rule(self):
        audit = mod["metric_ownership_rows"]
        rows = audit([
            {"query": "WAB earnings per share", "page": "https://www.stockportfolio.pro/stocks/WAB/eps", "impressions": 40, "clicks": 2, "position": 4},
            {"query": "WAB earnings per share", "page": "https://www.stockportfolio.pro/stocks/WAB/shares-outstanding", "impressions": 60, "clicks": 1, "position": 2},
            {"query": "WAB earnings", "page": "https://www.stockportfolio.pro/stocks/WAB/shares-outstanding", "impressions": 100, "clicks": 1, "position": 2},
        ])
        self.assertEqual(len(rows), 1, "ambiguous generic query must not enter ownership audit")
        row = rows[0]
        self.assertAlmostEqual(row["intended_ownership_rate"], 0.4)
        self.assertEqual(row["dominant_route_correct"], "no")
        self.assertEqual(row["material_cannibalization"], "yes")
        self.assertEqual(row["evidence_strength"], "STRONG_EVIDENCE")
        self.assertEqual(row["ownership_band"], "WRONG_ROUTE_DOMINANT")
        self.assertEqual(row["total_relevant_metric_impressions"], 100)

    def test_evidence_floor_and_base_stock_competitor(self):
        rows = mod["metric_ownership_rows"]([
            {"query": "revenue WAB", "page": "https://www.stockportfolio.pro/stocks/WAB/revenue", "impressions": 6, "clicks": 0, "position": 8},
            {"query": "revenue WAB", "page": "https://www.stockportfolio.pro/stocks/WAB", "impressions": 3, "clicks": 0, "position": 5},
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["evidence_strength"], "INSUFFICIENT_DATA")
        self.assertEqual(rows[0]["ownership_band"], "INSUFFICIENT_DATA")
        self.assertEqual(rows[0]["material_cannibalization"], "no")
        self.assertEqual(rows[0]["base_stock_page_competing"], "yes")

    def test_reconciliation_and_go_no_go_keep_dimensions_separate(self):
        report = mod["render_baseline_reconciliation"]("2026-08-10T00:00:00Z", {"datasets": {"queries-3m": {"start": "2026-05-10", "end": "2026-08-07"}}}, [])
        self.assertIn("9,332", report)
        self.assertIn("2,270", report)
        self.assertIn("non-additive", report.lower())
        self.assertIn("DIMENSION TOTAL", report)

    def test_classifier_uses_token_boundaries(self):
        classify = mod["classify_metric_query"]
        self.assertEqual(classify("EPSILON WAB"), "AMBIGUOUS_QUERY")
        self.assertEqual(classify("basic EPS WAB"), "EPS")


if __name__ == "__main__":
    unittest.main()
