# Page data gaps, 2026-10-31

Written by `node scripts/audit-page-gaps.js`. Rows in the CSVs are sorted by market cap (net assets for funds).

## Stocks: 2521 of 5560 pages have a gap

| Gap | Pages | Largest first |
|---|---:|---|
| no_stored_chart | 1238 | SPCX, BRK-A, SKHY, TD, SAN, SMFG, PBR, UL |
| foreign_interim_not_read | 1034 | TSM, ASML, SHEL, NVS, HSBC, AZN, RY, SAP |
| headline_missing (annual totalRevenue) | 752 | SMFG, MDLN, KB, SHG, BBD, BBDO, SYM, APA |
| headline_missing (quarterly totalRevenue) | 560 | AEP, VMRK, EXC, RVMD, FE, ALNY, APA, JHX |
| no_financials | 421 | SPCX, SKHY, IBN, CNI, HONA, VYLR, BSP, CBRS |
| headline_missing (annual totalAssets) | 420 | GEV, ARM, BLK, SNDK, FERG, ALAB, MDLN, SKYD |
| headline_missing (quarterly operatingCashflow) | 108 | SPGI, GD, FDX, APD, BDX, SUNB, CHD, DRI |
| no_market_cap | 55 | MCY, KEN, NGL, BLX, NRP, GSM, SIF, MWG |
| headline_missing (quarterly totalAssets) | 53 | AEP, EXC, MDLN, SN, FE, ALNY, FDXF, JHX |
| headline_missing (annual operatingCashflow) | 34 | SU, DB, VALE, RBC, SFD, GLNG, CNK, FUL |
| headline_missing (annual netIncome) | 33 | DB, RBC, UHAL, UHAL-B, VMI, VAL, EE, TIC |
| headline_missing (quarterly netIncome) | 20 | VTRS, JHX, ICUI, EE, WBI, SMG, WOLF, TRNS |
| no_sector | 17 | NIQ, LION, SI, FACT, IVAI, BPAC, SEV, ROC |
| no_description | 16 | FISV, NIQ, LION, KPLT, SI, FACT, BPAC, SEV |
| headline_missing (annual totalShareholderEquity) | 14 | VLTO, RBC, CNK, AAMI, FLOC, GFR, BOW, HRZN |
| no_price | 12 | AETR, FCDH, MSGK, ASPE, FFTT, MSGR, AZR, GBC |
| sec_filing_not_loaded | 6 | ACM, SAH, OPI, AIV, GYRO, EQS |
| headline_missing (quarterly totalShareholderEquity) | 6 | CNK, USAC, AAMI, PAL, GYRO, BAR |
| stale_price | 4 | HVT-A, UAC, VECA, PYT |

| Cause (from the filing) | Gaps |
|---|---:|
| not_in_filing | 923 |
| older_filing_not_checked | 865 |
| filed_blank | 66 |
| only_by_member | 61 |
| company_tag | 30 |
| discontinued_operations | 25 |
| extraction_dropped | 14 |
| ytd_only_not_derived | 14 |
| filing_unreadable | 2 |

## Funds: 401 of 563 pages have a gap

| Gap | Pages | Largest first |
|---|---:|---|
| no_category | 363 | VIGAX, AGTHX, FCNTX, PRGFX, VWUSX, PDI, PSUS, DNP |
| no_expense_ratio | 358 | PDI, PSUS, DNP, CSQ, UTG, NEA, BPRE, ADX |
| no_yield | 358 | PDI, PSUS, DNP, CSQ, UTG, NEA, BPRE, ADX |
| no_ytd_return | 358 | PDI, PSUS, DNP, CSQ, UTG, NEA, BPRE, ADX |
| no_3y_return | 358 | PDI, PSUS, DNP, CSQ, UTG, NEA, BPRE, ADX |
| no_5y_return | 358 | PDI, PSUS, DNP, CSQ, UTG, NEA, BPRE, ADX |
| no_allocation | 358 | PDI, PSUS, DNP, CSQ, UTG, NEA, BPRE, ADX |
| no_net_assets | 36 | ARCC, GBDC, BSTZ, GOF, TY, USA, BST, RVI |
| no_holdings | 27 | GLD, IBIT, IAU, GLDM, SLV, FBTC, ETHA, USO |
| expense_ratio_first_visit_only | 20 | VTSAX, VFIAX, VTIAX, AIVSX, FCNTX, ANCFX, SWPPX, FSKAX |
| expense_ratio_provider_differs | 10 | SOXX, TQQQ, MGK, UPRO, IYR, ITB, SQQQ, SOXS |
| page_error | 1 | SPLG |
