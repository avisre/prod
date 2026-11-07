# Remaining statement gaps: verified repair path

Investigation, 7 November 2026. This is a diagnosis and an in-memory experiment,
not an implemented extractor change or a completed corpus rebuild.

## What the counts mean

The retained `audit-1107-after` shards reproduce 826 gappy statement rows classified
as `rejected_by_validation` and 600 as `sec_has_mapped_tag` for tier-1 stocks,
across annual and quarterly tables. These are rows with at least one empty period,
not counts of individual cells. Income D&A, cash-flow D&A and EBITDA can all count
the same missing underlying amount. Stocks overlap between categories too.

The largest row groups in these two categories together are D&A (232 validation,
79 mapped), short-term debt (134, 74), long-term debt (120, 61), and EBITDA (117,
34). A tag's existence establishes a candidate, not that its scope, currency,
period, or filing makes it usable.

## Verified examples

| Case | Why the present fallback stops | Filed evidence and repair |
| --- | --- | --- |
| CME, Q3 2026 | Cash-flow anchor `0001156375-26-000068` has no cash `face` record in our store. | Its income statement separately reports $56.0m purchased-intangible amortization and $27.4m D&A for the quarter: $83.4m combined. Read the filing's own layout; do not wait for the next quarterly data set. |
| Alamo (ALG), FY2025 and FY2024 | Cash face is `Depreciation`, `~da`, `AmortizationOfIntangibleAssets`. The blocker is actually `EquipmentExpense`, printed as rental-equipment depreciation. | FY2025: $27.084m + $11.740m + $16.547m = $55.371m. FY2024: $26.865m + $9.992m + $16.227m = $53.084m. Debt-issuance amortization is a separate excluded line. |
| Corsair (CRSR), FY2025 | Cash face has `Depreciation`, `~da`. The second line uses a company-defined amortization concept. | The statement prints $13.962m depreciation and $40.228m amortization. The intangible-assets note independently reports the same $40.228m amortization. The combined amount is $54.190m. Keep both original facts and their receipts. |

Sources checked against the original SEC documents:

- [CME Q3 2026 filing](https://www.sec.gov/Archives/edgar/data/1156375/000115637526000068/cme-20260930.htm), income and cash-flow statements.
- [Alamo FY2025 filing](https://www.sec.gov/Archives/edgar/data/897077/000089707726000016/alg-20251231.htm), cash-flow statement, FY2025/24/23 columns.
- [Corsair FY2025 filing](https://www.sec.gov/Archives/edgar/data/1743759/000119312526067833/crsr-20251231.htm), cash-flow statement and Note 5.
- [SEC data-set publication policy](https://www.sec.gov/data-research/sec-markets-data/financial-statement-data-sets): updates are quarterly; filings after the quarter's last business day enter a subsequent posting. Local files stop at 2026q3; CME's filing was made October 23.

### Experiment and additional correctness finding

An isolated Node process loaded Alamo's companyfacts from the retained November 5
bulk snapshot. In memory only, it added `EquipmentExpense` to the D&A face family
and replaced the single blocker in Alamo's FY2025 filing layout with that tag.
Calling the existing `extract` recovered FY2025 $55.371m and FY2024 $53.084m with
the existing presented-parts derivation and source verification. No repository
code or stored financial data was changed by this experiment. This validates the
identified missing component, not a general unconditional tag mapping.

It also exposed a problem outside the blanks: Alamo FY2023 currently holds
$39.184m from depreciation $23.665m plus intangible amortization $15.519m, both
cited to that SAME FY2025 filing. The filing's FY2023 comparative also presents
$8.789m rental-equipment depreciation. Including all three gives $47.973m.
`faceFill` only visits null cells, so the existing partial sum survives even after
the experimental family extension. A repair must check previously derived sums,
not just fill blanks. This is not a cross-filing restatement comparison.

## Implementation needed

1. **Retain richer statement evidence.** `build-statement-lines.js` currently
   reduces an unrecognized family component to a token such as `~da`, discarding
   its concept and label from the face record. Preserve its taxonomy, concept,
   printed label, order, report/role and numerical/context receipts alongside the
   token. Keep blockers until their meaning is established.
2. **Obtain missing layouts from the original filing.** Extend the original-filing
   path to read presentation/calculation relationships and visible primary
   statement rows for the cited accession. Cache the result by accession. Resolve
   current and historical gaps as needed; quarterly FSDS remains the bulk path.
   Require the registrant's consolidated statement, not a note, parent-only table
   or co-registrant. Presentation order alone is not proof that values are additive.
3. **Resolve components with filing evidence.** Allow a broader standard tag or a
   custom tag only when the statement label, context and relevant reconciliation
   establish the requested component. Alamo's rental depreciation is such a case;
   `EquipmentExpense` must not globally become depreciation. A generic
   "Amortization" label alone is insufficient when its contents are ambiguous.
   Extend `sec-coverage.js` to independently verify the richer receipts.
4. **Check completeness of derived totals.** Compare an existing sum's cited
   components with all components the same statement presents. Correct a derived
   subtotal when a missing component is proved, recording the old/new values and
   reason. Do not overwrite a directly filed total based on a candidate sum.
5. **Keep period and meaning checks.** Match issuer, consolidation scope,
   accession, currency, units, dates, signs and scale. Derive a quarter from YTD
   only when both spans measure the same complete line or component set. Reject
   subtotal double counting and unresolved components. `CostsAndExpenses` still
   does not become operating expenses merely because it resembles that row.
6. **Rebuild and measure.** First produce a per-cell manifest with filled,
   corrected and still-unresolved cases and source receipts. Run regression tests
   for the examples above and adverse cases, then rebuild statement data and its
   digests/indexes and rerun the same row audit. Report changes to individual
   cells separately from the user's row/stock summary.

The examples prove that some remaining cells are recoverable. They do not
establish how many of the 826/600/704 rows will be resolved. That requires the
implementation, per-cell review and corpus rerun. Some cells will properly remain
unavailable because no equivalent total is reported or the evidence is ambiguous.
