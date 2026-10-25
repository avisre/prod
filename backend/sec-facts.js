'use strict';
// Deterministic extraction. No network, provider data, split guesses, or FX.
const p = require('./sec-coverage');
const DAY = 86400000;
// A fiscal quarter is usually 13 weeks, but a 16/12/12/12-week calendar opens
// with a 112-day first quarter (Albertsons, Kroger); 105 days dropped it.
const QUARTER_MAX_DAYS = 119;
const EXTRACTION_VERSION = '20261025-rev2';
const VALIDATION_VERSION = '20261005-validation3';
function partialRevenueConcept(sic, concept) { return /^(602|603|609|63)/.test(String(sic || '')) && /RevenueFromContract|SalesRevenue/.test(concept || ''); }
const mapping = (gaap, ifrs = [], scope = 'entity') => ({ 'us-gaap': gaap, 'ifrs-full': ifrs, scope });
const MAPS = {
 income: {
  // 'RevenuesNetOfInterestExpense' was misspelt here without its first "s", which
  // left every broker-dealer that reports net revenues (Morgan Stanley, Goldman
  // Sachs) with no revenue at all. Regulated utilities report operating revenue;
  // a business development company's top line is its total investment income.
  totalRevenue:mapping(['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet','RevenueFromContractWithCustomerIncludingAssessedTax','RevenuesNetOfInterestExpense','RegulatedAndUnregulatedOperatingRevenue','GrossInvestmentIncomeOperating'],['RevenueFromContractsWithCustomers','Revenue']),
  // IFRS filers such as Novartis and Sanofi report net sales and other revenues
  // as two lines with no total; the two are added below when, and only when,
  // the filing's own gross profit plus cost of sales confirms the sum.
  netIncome:mapping(['NetIncomeLoss','ProfitLoss','NetIncomeLossAvailableToCommonStockholdersBasic'],['ProfitLossAttributableToOwnersOfParent','ProfitLoss']),
  operatingIncome:mapping(['OperatingIncomeLoss'],['ProfitLossFromOperatingActivities']),
  grossProfit:mapping(['GrossProfit'],['GrossProfit']),
  costOfRevenue:mapping(['CostOfRevenue','CostOfGoodsAndServicesSold','CostOfGoodsSold'],['CostOfSales']),
  sellingGeneralAndAdministrative:mapping(['SellingGeneralAndAdministrativeExpense'],['SellingGeneralAndAdministrativeExpense']),
  researchAndDevelopment:mapping(['ResearchAndDevelopmentExpense','ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost','ResearchAndDevelopmentExpenseSoftwareExcludingAcquiredInProcessCost'],['ResearchAndDevelopmentExpense']),
  operatingExpenses:mapping(['OperatingExpenses'],['OperatingExpense']),
  interestExpense:mapping(['InterestExpense','InterestExpenseNonoperating','InterestAndDebtExpense','InterestExpenseOperating'],['InterestExpense']),
  premiums:mapping(['PremiumsEarnedNet'],['InsuranceRevenue']),
  investmentIncome:mapping(['InvestmentIncomeNet'],[]),
  interestIncome:mapping(['InvestmentIncomeInterest','InterestIncomeOperating','InterestAndDividendIncomeOperating'],['InterestIncome','RevenueFromInterest','InterestRevenueCalculatedUsingEffectiveInterestMethod']),
  netInterestIncome:mapping(['InterestIncomeExpenseNet'],['InterestRevenueExpense']),
  nonInterestIncome:mapping(['NoninterestIncome'],[]),
  // Bank and insurer lines read for the industry panels. Each is a filed face
  // line, not a ratio: noninterest expense, the credit-loss provision, and the
  // insurance underwriting lines. The provision tags are the CECL-era names;
  // ProvisionForLoanLossesExpensed is the loan component some banks file beside
  // ProvisionForOtherLosses, so it is a fallback only when the combined line is
  // absent. A bank that files none of them gets no provision ratio.
  nonInterestExpense:mapping(['NoninterestExpense'],[]),
  provisionForCreditLosses:mapping(['ProvisionForLoanLeaseAndOtherLosses','ProvisionForLoanLossesExpensed','ProvisionForCreditLosses','ProvisionForLoanAndLeaseLosses'],[]),
  netInvestmentIncome:mapping(['NetInvestmentIncome'],[]),
  lossesAndLossAdjustmentExpense:mapping(['PolicyholderBenefitsAndClaimsIncurredNet'],[]),
  // Amortisation of deferred policy acquisition costs plus other underwriting
  // expense is the underwriting expense total where a P&C filer tags both.
  policyAcquisitionExpense:mapping(['DeferredPolicyAcquisitionCostAmortizationExpense'],[]),
  otherUnderwritingExpense:mapping(['OtherUnderwritingExpense'],[]),
  incomeTaxExpense:mapping(['IncomeTaxExpenseBenefit'],['IncomeTaxExpenseContinuingOperations']),
  incomeBeforeTax:mapping(['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest','IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],['ProfitLossBeforeTax']),
  // A partnership reports earnings per unit, not per share (AllianceBernstein Holding, Natural Resource Partners).
  eps:mapping(['EarningsPerShareBasic','NetIncomeLossPerOutstandingLimitedPartnershipUnitBasicNetOfTax','EarningsPerShareBasicAndDiluted','NetIncomeLossPerOutstandingLimitedPartnershipAndGeneralPartnershipUnitBasicAndDiluted','IncomeLossFromContinuingOperationsPerBasicShare','IncomeLossFromContinuingOperationsPerBasicAndDilutedShare'],['BasicEarningsLossPerShare','BasicAndDilutedEarningsLossPerShare'],'parent'),
  weightedAverageSharesOutstanding:mapping(['WeightedAverageNumberOfSharesOutstandingBasic','WeightedAverageNumberOfShareOutstandingBasicAndDiluted'],['WeightedAverageNumberOfSharesOutstandingBasic','WeightedAverageShares'],'parent'),
  weightedAverageSharesDiluted:mapping(['WeightedAverageNumberOfDilutedSharesOutstanding','WeightedAverageNumberOfShareOutstandingBasicAndDiluted'],['AdjustedWeightedAverageShares'],'parent'),
  // A filer with no dilutive securities reports one figure tagged as both basic and diluted.
  dilutedEPS:mapping(['EarningsPerShareDiluted','NetIncomeLossNetOfTaxPerOutstandingLimitedPartnershipUnitDiluted','EarningsPerShareBasicAndDiluted','NetIncomeLossPerOutstandingLimitedPartnershipAndGeneralPartnershipUnitBasicAndDiluted','IncomeLossFromContinuingOperationsPerDilutedShare','IncomeLossFromContinuingOperationsPerBasicAndDilutedShare'],['DilutedEarningsLossPerShare','BasicAndDilutedEarningsLossPerShare'],'parent'),
  // Helper inputs sit last so they can never set a row's period ahead of an original field.
  revenueFromSaleOfGoods:mapping([],['RevenueFromSaleOfGoods']),
  otherRevenue:mapping([],['OtherRevenue']),
  // A company's own total under a line the revenue rule above does not read: a
  // gas utility's regulated operating revenue, an IFRS filer's "revenue and
  // operating income". A helper input, used only to fill a year that has no
  // revenue at all (see the income rules below).
  reportedRevenueTotal:mapping(['RegulatedOperatingRevenue'],['RevenueAndOperatingIncome']),
  // Rows the company page always showed but nothing read (2026-10-17 audit:
  // blank for every stock although SEC has them). Last, so they never set a
  // row's period. Plain "Depreciation" is not D&A and is not read.
  depreciationAndAmortization:mapping(['DepreciationDepletionAndAmortization','DepreciationAndAmortization','DepreciationAmortizationAndAccretionNet'],['DepreciationAndAmortisationExpense','AdjustmentsForDepreciationAndAmortisationExpense']),
  otherNonOperatingIncome:mapping(['OtherNonoperatingIncomeExpense','NonoperatingIncomeExpense'],[]),
  // Profit or loss of a business being sold, after tax. Read so that a year whose revenue is
  // restated to continuing operations is not divided into cash flows that still include the
  // sold business (AppLovin FY2024: $3.22bn continuing revenue against $2.10bn of total
  // operating cash flow read as a 65% free-cash-flow margin; the apps business it sold in
  // 2025 was in the cash but not the revenue). Last and fill-only, so it never sets a period.
  discontinuedOperations:mapping(['IncomeLossFromDiscontinuedOperationsNetOfTax','IncomeLossFromDiscontinuedOperationsNetOfTaxAttributableToReportingEntity','IncomeLossFromDiscontinuedOperationsNetOfTaxIncludingPortionAttributableToNoncontrollingInterest'],['ProfitLossFromDiscontinuedOperations'])
 },
 balance: {
  // Total liabilities and equity equals total assets on every balance sheet; a
  // filer that tags only that line still reported its total assets. Partnerships
  // and LLCs report partners' capital or members' equity in place of stockholders' equity.
  totalAssets:mapping(['Assets','LiabilitiesAndStockholdersEquity'],['Assets','EquityAndLiabilities']),
  totalShareholderEquity:mapping(['StockholdersEquity','PartnersCapital','MembersEquity','StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest','PartnersCapitalIncludingPortionAttributableToNoncontrollingInterest','LimitedLiabilityCompanyLlcMembersEquityIncludingPortionAttributableToNoncontrollingInterest'],['EquityAttributableToOwnersOfParent','Equity']),
  totalLiabilities:mapping(['Liabilities'],['Liabilities']),
  // The filed total of liabilities and equity. Liabilities plus parent equity misses noncontrolling
  // interests and temporary equity: 18,044 of 46,116 annual sums on 2026-10-17 (Air Products FY2025
  // $38.73bn against $41.06bn filed).
  totalLiabilitiesAndEquity:mapping(['LiabilitiesAndStockholdersEquity'],['EquityAndLiabilities']),
  totalCurrentAssets:mapping(['AssetsCurrent'],['CurrentAssets']),
  totalCurrentLiabilities:mapping(['LiabilitiesCurrent'],['CurrentLiabilities']),
  cashAndCashEquivalentsAtCarryingValue:mapping(['CashAndCashEquivalentsAtCarryingValue','Cash'],['CashAndCashEquivalents']),
  // The first tag is filed by no current filer (0 of 4,120 on 2026-10-17); banks use the second.
  loans:mapping(['FinancingReceivableRecordedInvestmentExcludingAccruedInterestAfterAllowanceForCreditLoss','FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss','LoansAndLeasesReceivableNetReportedAmount'],['LoansAndAdvancesToCustomers']),
  deposits:mapping(['Deposits','DepositsDomestic'],['DepositsFromCustomers']),
  inventory:mapping(['InventoryNet'],['Inventories']),
  currentNetReceivables:mapping(['AccountsReceivableNetCurrent','ReceivablesNetCurrent','AccountsReceivableNet'],['TradeAndOtherCurrentReceivables','CurrentTradeReceivables']),
  goodwill:mapping(['Goodwill'],['Goodwill']),
  longTermDebt:mapping(['LongTermDebtNoncurrent'],['NoncurrentBorrowings']),
  shortTermDebt:mapping(['DebtCurrent'],['CurrentBorrowings','CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings']),
  shortTermBorrowings:mapping(['ShortTermBorrowings'],['ShorttermBorrowings']),
  currentLongTermDebt:mapping(['LongTermDebtCurrent'],['CurrentPortionOfLongtermBorrowings','CurrentPortionOfNoncurrentBorrowings']),
  shortLongTermDebtTotal:mapping(['DebtLongtermAndShorttermCombinedAmount','LongTermDebtAndShortTermBorrowings'],['Borrowings']),
  commonStockSharesOutstanding:mapping(['CommonStockSharesOutstanding'],['NumberOfSharesOutstanding']),
  retainedEarnings:mapping(['RetainedEarningsAccumulatedDeficit'],['RetainedEarnings']),
  // Long-term asset lines, each as its own filed line: until 2026-10-10 only
  // goodwill was read, so "Total long-term assets" had nothing to unfold into
  // (Fair Isaac files six of these). Balance facts are instants and cannot add
  // a reporting period. No remainder is computed for a line that is not filed.
  totalNonCurrentAssets:mapping(['AssetsNoncurrent','NoncurrentAssets'],['NoncurrentAssets']),
  propertyPlantEquipment:mapping(['PropertyPlantAndEquipmentNet','PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization'],['PropertyPlantAndEquipment']),
  operatingLeaseRightOfUseAsset:mapping(['OperatingLeaseRightOfUseAsset'],['RightofuseAssets']),
  intangibleAssetsExcludingGoodwill:mapping(['IntangibleAssetsNetExcludingGoodwill'],['IntangibleAssetsOtherThanGoodwill']),
  longTermInvestments:mapping(['LongTermInvestments','MarketableSecuritiesNoncurrent'],[]),
  deferredTaxAssets:mapping(['DeferredIncomeTaxAssetsNet','DeferredTaxAssetsNetNoncurrent'],['DeferredTaxAssets']),
  otherNonCurrentAssets:mapping(['OtherAssetsNoncurrent'],['OtherNoncurrentAssets']),
  // Page rows with no reading until 2026-10-17. The combined "payables and
  // accrued liabilities" line is broader than accounts payable and is not read.
  currentAccountsPayable:mapping(['AccountsPayableCurrent','AccountsPayableTradeCurrent'],['TradeAndOtherCurrentPayablesToTradeSuppliers']),
  otherCurrentAssets:mapping(['OtherAssetsCurrent','PrepaidExpenseAndOtherAssetsCurrent'],['OtherCurrentAssets']),
  cashAndShortTermInvestments:mapping(['CashCashEquivalentsAndShortTermInvestments'],[]),
  shortTermInvestments:mapping(['ShortTermInvestments','MarketableSecuritiesCurrent','AvailableForSaleSecuritiesDebtSecuritiesCurrent'],['CurrentInvestments']),
  totalNonCurrentLiabilities:mapping(['LiabilitiesNoncurrent'],['NoncurrentLiabilities']),
  otherNonCurrentLiabilities:mapping(['OtherLiabilitiesNoncurrent'],['OtherNoncurrentLiabilities']),
  commonStock:mapping(['CommonStockValue','CommonStocksIncludingAdditionalPaidInCapital','CommonStockValueOutstanding'],['IssuedCapital']),
  treasuryStock:mapping(['TreasuryStockValue','TreasuryStockCommonValue'],['TreasuryShares'])
 },
 cash: {
  operatingCashflow:mapping(['NetCashProvidedByUsedInOperatingActivities','NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],['CashFlowsFromUsedInOperatingActivities','CashFlowsFromUsedInOperatingActivitiesContinuingOperations']),
  // A filer with a discontinued business tags operating cash flow in two parts
  // and no total (Dollar Tree, DuPont, Dover, Johnson Controls, FIS, Darden);
  // the two filed parts are added below.
  // Nvidia, among others, files its capital spending under the productive-assets
  // tag (property, equipment and intangibles in one line), and property companies
  // under capital improvements. Without these the page had no free cash flow for
  // any year after the filer changed tag. The plain property tag still wins.
  // Measured 2026-10-10: 1,968 of 5,138 issuers had no latest-year figure; in a
  // sample of 70, these tags cover about half and the rest file no such line.
  // The IFRS element is "...ClassifiedAsInvestingActivities"; the short name
  // listed first never matched a foreign filer.
  capitalExpenditures:mapping(['PaymentsToAcquirePropertyPlantAndEquipment','PaymentsToAcquireProductiveAssets','PaymentsForCapitalImprovements','PaymentsToAcquireOilAndGasPropertyAndEquipment'],['PurchaseOfPropertyPlantAndEquipment','PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities','PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets']),
  cashflowFromInvestment:mapping(['NetCashProvidedByUsedInInvestingActivities','NetCashProvidedByUsedInInvestingActivitiesContinuingOperations'],['CashFlowsFromUsedInInvestingActivities']),
  cashflowFromFinancing:mapping(['NetCashProvidedByUsedInFinancingActivities','NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'],['CashFlowsFromUsedInFinancingActivities']),
  dividendPayout:mapping(['PaymentsOfDividends','PaymentsOfOrdinaryDividends','PaymentsOfDividendsCommonStock','PaymentsOfCapitalDistribution'],['DividendsPaid','DividendsPaidClassifiedAsFinancingActivities']),
  dividendPayoutCommonStock:mapping(['PaymentsOfDividendsCommonStock'],['DividendsPaidToEquityHoldersOfParentClassifiedAsFinancingActivities']),
  paymentsForRepurchaseOfCommonStock:mapping(['PaymentsForRepurchaseOfCommonStock','PaymentsForRepurchaseOfEquity'],['PaymentsToAcquireOrRedeemEntitysShares']),
  shareBasedCompensation:mapping(['ShareBasedCompensation','AllocatedShareBasedCompensationExpense'],['AdjustmentsForSharebasedPayments']),
  depreciationDepletionAndAmortization:mapping(['DepreciationDepletionAndAmortization','DepreciationAndAmortization','DepreciationAmortizationAndAccretionNet'],['AdjustmentsForDepreciationAndAmortisationExpense','DepreciationAndAmortisationExpense']),
  operatingCashflowContinuing:mapping(['NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],['CashFlowsFromUsedInOperatingActivitiesContinuingOperations']),
  operatingCashflowDiscontinued:mapping(['CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations'],['CashFlowsFromUsedInOperatingActivitiesDiscontinuedOperations']),
  // Page rows with no reading until 2026-10-17. Working-capital changes are
  // kept as filed: a positive figure is an increase in the balance (Apple
  // FY2025 receivables +6.68bn filed, +6.37bn on the balance sheet), so the
  // page shows the cash effect of an asset line with its sign reversed.
  // The statement's net income line has its own name: it is consolidated net
  // income, not necessarily the income statement's figure for the parent.
  cashFlowNetIncome:mapping(['ProfitLoss','NetIncomeLoss'],[]),
  changeInReceivables:mapping(['IncreaseDecreaseInAccountsReceivable','IncreaseDecreaseInReceivables','IncreaseDecreaseInAccountsAndNotesReceivable'],[]),
  changeInInventory:mapping(['IncreaseDecreaseInInventories','IncreaseDecreaseInRetailRelatedInventories'],[]),
  changeInOperatingAssets:mapping(['IncreaseDecreaseInOtherOperatingAssets','IncreaseDecreaseInPrepaidDeferredExpenseAndOtherAssets'],[]),
  changeInAccountsPayable:mapping(['IncreaseDecreaseInAccountsPayable','IncreaseDecreaseInAccountsPayableTrade','IncreaseDecreaseInAccountsPayableAndAccruedLiabilities'],[]),
  changeInOperatingLiabilities:mapping(['IncreaseDecreaseInOtherOperatingLiabilities'],[]),
  // Issued, repaid and net short-term borrowing are separate filed lines; no
  // net figure is computed from them.
  proceedsFromIssuanceOfLongTermDebt:mapping(['ProceedsFromIssuanceOfLongTermDebt'],['ProceedsFromNoncurrentBorrowings']),
  repaymentsOfLongTermDebt:mapping(['RepaymentsOfLongTermDebt'],['RepaymentsOfNoncurrentBorrowings']),
  proceedsFromRepaymentsOfShortTermDebt:mapping(['ProceedsFromRepaymentsOfShortTermDebt','ProceedsFromRepaymentsOfCommercialPaper'],[]),
  proceedsFromIssuanceOfCommonStock:mapping(['ProceedsFromIssuanceOfCommonStock'],['ProceedsFromIssueOfOrdinaryShares','ProceedsFromIssuingShares']),
  changeInCashAndCashEquivalents:mapping(['CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect','CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseExcludingExchangeRateEffect','CashAndCashEquivalentsPeriodIncreaseDecrease'],['IncreaseDecreaseInCashAndCashEquivalents','IncreaseDecreaseInCashAndCashEquivalentsBeforeEffectOfExchangeRateChanges'])
 }
};
// A narrower tag stands in for the full figure only when the filing shows the
// difference is nil: net income to common equals net income when no preferred
// dividend is reported, and continuing-operations cash flow equals total cash
// flow when no discontinued operating cash flow is reported.
const DISCONTINUED_EPS = [...['IncomeLossFromDiscontinuedOperationsNetOfTax','DiscontinuedOperationIncomeLossFromDiscontinuedOperationNetOfTax'].flatMap(t=>['PerDilutedShare','PerBasicShare','PerBasicAndDilutedShare'].map(x=>'us-gaap:'+t+x)),
 'us-gaap:IncomeLossFromDiscontinuedOperationsNetOfTax','us-gaap:IncomeLossFromDiscontinuedOperationsNetOfTaxAttributableToReportingEntity','us-gaap:IncomeLossFromDiscontinuedOperationsNetOfTaxIncludingPortionAttributableToNoncontrollingInterest'];
const STAND_INS = {
 'us-gaap:NetIncomeLossAvailableToCommonStockholdersBasic':['us-gaap:PreferredStockDividendsIncomeStatementImpact','us-gaap:DividendsPreferredStock','us-gaap:PreferredStockDividendsAndOtherAdjustments','us-gaap:NetIncomeLossAttributableToNoncontrollingInterest'],
 'us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations':['us-gaap:CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations'],
 'ifrs-full:CashFlowsFromUsedInOperatingActivitiesContinuingOperations':['ifrs-full:CashFlowsFromUsedInOperatingActivitiesDiscontinuedOperations'],
 'us-gaap:NetCashProvidedByUsedInInvestingActivitiesContinuingOperations':['us-gaap:CashProvidedByUsedInInvestingActivitiesDiscontinuedOperations'],
 'us-gaap:NetCashProvidedByUsedInFinancingActivitiesContinuingOperations':['us-gaap:CashProvidedByUsedInFinancingActivitiesDiscontinuedOperations'],
 // Continuing-operations EPS is the company's EPS when it has no discontinued operations: Halliburton, Oshkosh and
 // Hexcel tag their only EPS line so for FY2025 (2026-10-25 scan: 43 blank diluted and 41 blank basic latest years
 // filled; 15 more report a discontinued line beside it and stay blank).
 ...Object.fromEntries(['PerDilutedShare','PerBasicShare','PerBasicAndDilutedShare'].map(x=>['us-gaap:IncomeLossFromContinuingOperations'+x,DISCONTINUED_EPS]))
};
// Tags added on 2026-10-06 for filers that use nothing else. They are tried only
// after every original tag in either taxonomy has come up empty, so no figure
// that was already extracted can change.
// The two basic-and-diluted EPS tags joined on 2026-10-17 (the second is a partnership's,
// Cheniere Energy Partners from 2022): an IFRS filer's own diluted EPS (Entera, Gravity)
// or a filer's main EPS line (Optex) must win over them.
const LAST_RESORT = new Set(['us-gaap:EarningsPerShareBasicAndDiluted','us-gaap:NetIncomeLossPerOutstandingLimitedPartnershipAndGeneralPartnershipUnitBasicAndDiluted','us-gaap:NetIncomeLossAvailableToCommonStockholdersBasic','us-gaap:LiabilitiesAndStockholdersEquity','ifrs-full:EquityAndLiabilities','us-gaap:PartnersCapital','us-gaap:MembersEquity',
 'us-gaap:PartnersCapitalIncludingPortionAttributableToNoncontrollingInterest','us-gaap:LimitedLiabilityCompanyLlcMembersEquityIncludingPortionAttributableToNoncontrollingInterest',
 'us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations','ifrs-full:CashFlowsFromUsedInOperatingActivitiesContinuingOperations','us-gaap:RegulatedAndUnregulatedOperatingRevenue','us-gaap:GrossInvestmentIncomeOperating','us-gaap:NetIncomeLossPerOutstandingLimitedPartnershipUnitBasicNetOfTax','us-gaap:NetIncomeLossNetOfTaxPerOutstandingLimitedPartnershipUnitDiluted',
 'us-gaap:WeightedAverageNumberOfShareOutstandingBasicAndDiluted','ifrs-full:BasicAndDilutedEarningsLossPerShare']);
const DISCONTINUED_ADDED = [...MAPS.income.discontinuedOperations['us-gaap'].map(t=>'us-gaap:'+t),...MAPS.income.discontinuedOperations['ifrs-full'].map(t=>'ifrs-full:'+t)];
const OUTFLOWS = new Set(['capitalExpenditures','dividendPayout','dividendPayoutCommonStock','paymentsForRepurchaseOfCommonStock','repaymentsOfLongTermDebt','treasuryStock']);
// Tags first read on 2026-10-17. Like the 2026-10-06 additions they fill a
// figure but never add a year or quarter of their own. Tags that were already
// read for another field (NetIncomeLoss, ProfitLoss, DepreciationDepletionAndAmortization)
// are not listed: they set periods before and still do.
const ROWS_ADDED = ['InterestExpenseNonoperating','InterestAndDebtExpense','DepreciationAndAmortization','DepreciationAmortizationAndAccretionNet','OtherNonoperatingIncomeExpense','NonoperatingIncomeExpense',
 'NoninterestExpense','ProvisionForLoanLeaseAndOtherLosses','ProvisionForLoanLossesExpensed','ProvisionForCreditLosses','ProvisionForLoanAndLeaseLosses','NetInvestmentIncome','PolicyholderBenefitsAndClaimsIncurredNet','DeferredPolicyAcquisitionCostAmortizationExpense','OtherUnderwritingExpense','DepositsDomestic',
 'FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss','LoansAndLeasesReceivableNetReportedAmount','AccountsPayableCurrent','AccountsPayableTradeCurrent','OtherAssetsCurrent','PrepaidExpenseAndOtherAssetsCurrent','CashCashEquivalentsAndShortTermInvestments','ShortTermInvestments','MarketableSecuritiesCurrent','AvailableForSaleSecuritiesDebtSecuritiesCurrent','LiabilitiesNoncurrent','OtherLiabilitiesNoncurrent','CommonStockValue','CommonStocksIncludingAdditionalPaidInCapital','TreasuryStockValue','TreasuryStockCommonValue',
 'PaymentsOfOrdinaryDividends','IncreaseDecreaseInAccountsReceivable','IncreaseDecreaseInReceivables','IncreaseDecreaseInAccountsAndNotesReceivable','IncreaseDecreaseInInventories','IncreaseDecreaseInOtherOperatingAssets','IncreaseDecreaseInPrepaidDeferredExpenseAndOtherAssets','IncreaseDecreaseInAccountsPayable','IncreaseDecreaseInAccountsPayableTrade','IncreaseDecreaseInAccountsPayableAndAccruedLiabilities','IncreaseDecreaseInOtherOperatingLiabilities',
 'ProceedsFromIssuanceOfLongTermDebt','RepaymentsOfLongTermDebt','ProceedsFromRepaymentsOfShortTermDebt','ProceedsFromRepaymentsOfCommercialPaper','ProceedsFromIssuanceOfCommonStock','CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect','CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseExcludingExchangeRateEffect','CashAndCashEquivalentsPeriodIncreaseDecrease'].map(t=>'us-gaap:'+t);
// Dossier fields still blank where SEC has the line under another tag (2026-10-17 scan of every
// issuer's latest year): the IFRS names of SG&A, interest expense, D&A, share-based payments, buybacks
// and shares outstanding; the narrower US GAAP R&D, buyback, SBC and common-dividend lines; and the
// one share count or EPS a filer with no dilution tags as both. Each is read last and only fills.
// Not read: G&A alone (selling is often a separate line), total costs and expenses as operating
// expenses, finance costs as interest expense (sec-coverage INCOMPATIBLE), plain cash or cash with restricted cash as cash, plain depreciation as D&A.
// The IFRS names of rows that read only US GAAP, or an IFRS name no filer uses (2026-10-17: 0 of 581
// IFRS filers tag WeightedAverageNumberOfSharesOutstandingBasic; 491 tag WeightedAverageShares). Exact
// counterparts only: not long-term borrowings as long-term debt (sec-coverage INCOMPATIBLE), not trade and
// other payables as accounts payable, and not the IFRS working-capital adjustments, which carry the
// opposite sign to the US GAAP increase-decrease lines the page reverses.
const IFRS_ADDED = ['OperatingExpense','RevenueFromInterest','InterestRevenueCalculatedUsingEffectiveInterestMethod','WeightedAverageShares','LoansAndAdvancesToCustomers','DepositsFromCustomers','CurrentTradeReceivables',
 'CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings','ShorttermBorrowings','TradeAndOtherCurrentPayablesToTradeSuppliers','OtherCurrentAssets','CurrentInvestments','NoncurrentLiabilities','OtherNoncurrentLiabilities','IssuedCapital','TreasuryShares',
 'DividendsPaidClassifiedAsFinancingActivities','DividendsPaidToEquityHoldersOfParentClassifiedAsFinancingActivities','ProceedsFromNoncurrentBorrowings','RepaymentsOfNoncurrentBorrowings','ProceedsFromIssueOfOrdinaryShares','ProceedsFromIssuingShares',
 'IncreaseDecreaseInCashAndCashEquivalents','IncreaseDecreaseInCashAndCashEquivalentsBeforeEffectOfExchangeRateChanges'].map(t=>'ifrs-full:'+t);
// The same line under the tag some filers use, from the 2026-10-17 audit of every blank against SEC's facts: the 2024
// operating half of interest expense (the nonoperating half is read above), a bank's total interest and dividend
// income, cash with no equivalents, receivables on an unclassified or broader face line, common stock at its
// outstanding par, a partnership's distributions, a retailer's inventory change. Related tags the audit also found
// (G&A for SG&A, Depreciation for D&A, LongTermDebt with its current part, finite-lived intangibles alone, the
// deferred-tax net) are not the line and stay unread. The continuing-operations investing and financing totals stand in
// for the total only when the same filing reports no discontinued flow (STAND_INS); as fill-only tags a quarter never
// follows its year onto them, which put later filings' restated figures over 91 quarters' own totals.
const EQUIVALENTS_ADDED = ['InterestExpenseOperating','InterestAndDividendIncomeOperating','Cash','ReceivablesNetCurrent','AccountsReceivableNet','CommonStockValueOutstanding',
 'PaymentsOfCapitalDistribution','IncreaseDecreaseInRetailRelatedInventories','NetCashProvidedByUsedInInvestingActivitiesContinuingOperations','NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'].map(t=>'us-gaap:'+t);
// A fill-only tag that is part of the row's line fills it only when the same filing, on the same date, reports no other
// part (measured 2026-10-17): cash beside its cash equivalents (CIK 1737523: $0.60m cash, $1.21m equivalents), accounts
// receivable beside a noncurrent part (CIK 1590715), distributions beside ordinary dividends (CIK 1637207: $4.8m, $169.3m).
const FILL_GUARDS = {'us-gaap:Cash':['us-gaap:CashEquivalentsAtCarryingValue'],'us-gaap:AccountsReceivableNet':['us-gaap:AccountsReceivableNetNoncurrent'],
 'us-gaap:PaymentsOfCapitalDistribution':['us-gaap:PaymentsOfDividends','us-gaap:PaymentsOfOrdinaryDividends','us-gaap:PaymentsOfDividendsCommonStock']};
// Total interest income is never below the same filing's net interest income or loan interest. Where a bank tags a
// sub-line as interest income it is (measured 2026-10-17: 244 years at 38 issuers, CIK 862831 FY2012 $0.56m beside
// $97.6m total interest and dividend income), so the filed total is read. Only when that filing reports the larger
// total: outside banking the net line is often signed as an expense and interest-and-fee income includes fees, and
// as a floor alone they cleared 360 true figures (CIK 887733 $0.1m interest income beside a $33.6m "net").
const TOTAL_INTEREST='us-gaap:InterestAndDividendIncomeOperating';
const TOTAL_FLOORS = {'us-gaap:InvestmentIncomeInterest':['us-gaap:InterestIncomeExpenseNet','us-gaap:InterestAndFeeIncomeLoansAndLeases'],
 'us-gaap:InterestIncomeOperating':['us-gaap:InterestIncomeExpenseNet','us-gaap:InterestAndFeeIncomeLoansAndLeases']};
const FILLS_ADDED = ['us-gaap:ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost','us-gaap:ResearchAndDevelopmentExpenseSoftwareExcludingAcquiredInProcessCost','us-gaap:WeightedAverageNumberOfShareOutstandingBasicAndDiluted','us-gaap:PaymentsOfDividendsCommonStock','us-gaap:PaymentsForRepurchaseOfEquity','us-gaap:AllocatedShareBasedCompensationExpense',
 'ifrs-full:SellingGeneralAndAdministrativeExpense','ifrs-full:InterestExpense','ifrs-full:BasicAndDilutedEarningsLossPerShare','ifrs-full:DepreciationAndAmortisationExpense','ifrs-full:AdjustmentsForDepreciationAndAmortisationExpense','ifrs-full:NumberOfSharesOutstanding','ifrs-full:PaymentsToAcquireOrRedeemEntitysShares','ifrs-full:AdjustmentsForSharebasedPayments',
 ...IFRS_ADDED,...EQUIVALENTS_ADDED,...['PerDilutedShare','PerBasicShare','PerBasicAndDilutedShare'].map(x=>'us-gaap:IncomeLossFromContinuingOperations'+x)];
// A figure one of them gives yields to the line the statement presents (a note's share-based expense, $900k,
// is not the cash-flow add-back of $588k), and a quarter does not follow its year onto one of them.
// Fill-only like FILLS_ADDED, so a presented total line still takes its place (sec-facts extract, equity REITs).
const LEASE_REVENUE='OperatingLeaseLeaseIncome';
const FILLS=new Set([...FILLS_ADDED,'us-gaap:'+LEASE_REVENUE]);
const BORROWED = {income:['depreciationAndAmortization'],cash:['cashFlowNetIncome']};
const FORM = /^(10-K|10-Q|20-F|40-F|6-K)(\/A)?$/;
function scope(concept, fallback) {
 if (['NetIncomeLoss','NetIncomeLossAvailableToCommonStockholdersBasic','StockholdersEquity','PartnersCapital','MembersEquity','ProfitLossAttributableToOwnersOfParent','EquityAttributableToOwnersOfParent'].includes(concept)) return 'parent';
 if (['ProfitLoss','StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest','PartnersCapitalIncludingPortionAttributableToNoncontrollingInterest','LimitedLiabilityCompanyLlcMembersEquityIncludingPortionAttributableToNoncontrollingInterest','Equity'].includes(concept)) return 'consolidated';
 return fallback;
}
// Total debt from the debt lines a balance sheet presents (SEC statement data sets, pre.txt),
// each already a verified figure of this row from that filing. Two failures it settles: a
// "total" tag filed in a note can be one facility (Ball 2025: $2m against $7.0bn presented),
// and one current line filed under two tags was summed with itself (both $39.7m, one line on
// the face). It fills only when the face and the row agree both ways: every presented debt
// line is a figure the row holds, and every debt figure the row holds is presented. Amazon
// files its current debt in a note, inside "accrued expenses" on the face, so its total stays.
function presentedDebt(out,row,presented,document) {
 const T='shortLongTermDebtTotal',source=f=>out.sources[row._sources[f][0]];
 const anchor=out.sources[(row._sources.totalAssets || [])[0]]?.accessionNumber,tags=anchor && presented.get(anchor);
 if(!tags?.length)return;
 const direct=f=>row[f]!==null && !row._derivations?.[f] && row._sources[f]?.length===1 && source(f).accessionNumber===anchor && p.verifiedField(out,row,f);
 const parts=[];
 for(const tag of tags) {
  const f=[...p.DEBT_PARTS,T].find(f=>direct(f) && source(f).concept===tag);
  if(!f)return presentedFacts(out,row,anchor,tags,document);
  if(f===T || parts.includes(f))return;
  parts.push(f);
 }
 if(parts.includes('shortTermDebt') && parts.some(f=>f==='currentLongTermDebt' || f==='shortTermBorrowings'))return;
 if(new Set(parts.map(f=>row._scopes[f])).size!==1)return;
 // A held figure off the face is a part of some other line, unless it is a presented current line filed again under the other tag.
 const pair=['shortTermBorrowings','currentLongTermDebt'],twin=f=>pair.includes(f) && parts.includes(pair[1-pair.indexOf(f)]) && row[f]===row[pair[1-pair.indexOf(f)]];
 // From any filing: a figure another filing gives for this date is still a debt line of the row.
 const off=p.DEBT_PARTS.filter(f=>!parts.includes(f) && row[f]!==null);
 // DebtCurrent on the face includes both current parts by definition (Ball 2025: $2m current portion of a $21m line).
 // A current-debt total from another filing that equals the presented current lines is those lines (DoubleDown 2023:
 // $38.8m current portion on the 6-K face, the same $38.8m as the 20-F's current borrowings).
 const current=parts.filter(f=>pair.includes(f));
 const twins=off.filter(f=>twin(f) || pair.includes(f) && parts.includes('shortTermDebt') && Math.abs(row[f])<=Math.abs(row.shortTermDebt) || f==='shortTermDebt' && current.length && row[f]===current.reduce((sum,c)=>sum+row[c],0));
 if(off.some(f=>!twins.includes(f) && !(f==='shortTermDebt' && row._derivations?.shortTermDebt?.formula==='sum_fields' && row._derivations.shortTermDebt.inputs.every(i=>parts.includes(i) || twins.includes(i)))))return;
 parts.sort((x,y)=>p.DEBT_PARTS.indexOf(x)-p.DEBT_PARTS.indexOf(y));
 const value=parts.reduce((sum,f)=>sum+row[f],0);
 // A current-debt sum of one line filed under both tags counts it twice.
 let removed=false;
 if(row._derivations?.shortTermDebt?.formula==='sum_fields' && row._derivations.shortTermDebt.inputs.some(i=>twins.includes(i))){
  for(const map of [row._sources,row._scopes,row._derivations])delete map.shortTermDebt;row.shortTermDebt=null;removed=true;
 }
 if(!removed && row[T]===value && (row._derivations?.[T] || row._sources[T]?.length===1))return;
 // A filed total is kept, often principal where the face shows carrying amounts, unless it is
 // smaller than one of its own lines and so cannot be the total.
 if(row[T]!==null && !row._derivations?.[T] && row[T]>=Math.max(...parts.map(f=>row[f])))return;
 row[T]=value;row._sources[T]=parts.map(f=>row._sources[f][0]);row._scopes[T]=row._scopes[parts[0]];delete row._signs[T];
 row._derivations[T]={formula:'sum_presented_lines',inputs:parts,inputValues:parts.map(f=>row[f]),presentedConcepts:parts.map(f=>source(f).concept)};
}

// A presented debt line the row holds no figure for (Agilent 2025 presents "LongTermDebt", which cannot be the
// long-term debt field because that tag includes the current portion) is read as the filing's own fact for the
// line: the anchor filing, the row's date, an instant, the row's currency, one value. Total debt is filled only
// when every line on the face reads that way and passes the line rules (sec-coverage presentedDebtFacts); it
// never replaces a total the row already has.
function presentedFacts(out,row,anchor,tags,document) {
 const T='shortLongTermDebtTotal';
 if(row[T]!==null || !document?.facts)return;
 const concepts=tags.filter(t=>!/^(PreferredStock|ConvertiblePreferredStock|CommonStockValue|CommitmentsAndContingencies|Allowance)/.test(t)),facts=[];
 for(const concept of concepts) {
  const found=[];
  for(const taxonomy of ['us-gaap','ifrs-full'])for(const x of document.facts[taxonomy]?.[concept]?.units?.[row.reportedCurrency] || [])if(x.accn===anchor && x.end===row.fiscalDateEnding && !x.start && FORM.test(x.form || '') && Number.isFinite(x.val))found.push({...x,start:null,taxonomy,concept,unit:row.reportedCurrency});
  if(!found.length || new Set(found.map(x=>x.val)).size!==1)return;
  facts.push(found[0]);
 }
 if(!p.presentedDebtFacts(concepts,facts.map(f=>f.val),row))return;
 row[T]=facts.reduce((sum,f)=>sum+f.val,0);row._sources[T]=facts.map(f=>factSource(out,f));row._scopes[T]=scope(concepts[0],'entity');delete row._signs[T];
 row._derivations[T]={formula:'sum_presented_facts',inputValues:facts.map(f=>f.val),presentedConcepts:concepts};
}
// Total liabilities and equity is total assets by definition. Where the figure read differs, the filing that gave the
// row its total assets supplies the line, or else a filing whose figure equals it (U-Haul 2023-12-31: later 10-Qs tag
// $20.1bn at a date that is not their balance-sheet date, the original $19.0bn beside $19.0bn of assets). A gap that
// remains is rounding between filings (American Express 2021: $189bn assets restated in round billions, $188.548bn).
function liabilitiesAndEquity(out,row,document) {
 const T='totalLiabilitiesAndEquity';
 if(row[T]===null || row.totalAssets===null || row[T]===row.totalAssets || !document?.facts || row._sources.totalAssets?.length!==1 || row._derivations?.totalAssets)return;
 const anchor=out.sources[row._sources.totalAssets[0]]?.accessionNumber,found=[];
 for(const [taxonomy,concept] of [['us-gaap','LiabilitiesAndStockholdersEquity'],['ifrs-full','EquityAndLiabilities']])
  for(const x of document.facts[taxonomy]?.[concept]?.units?.[row.reportedCurrency] || [])if(x.end===row.fiscalDateEnding && !x.start && FORM.test(x.form || '') && Number.isFinite(x.val))found.push({...x,start:null,taxonomy,concept,unit:row.reportedCurrency});
 const newest=list=>list.sort((x,y)=>y.filed.localeCompare(x.filed)||y.accn.localeCompare(x.accn))[0];
 const same=found.filter(x=>x.accn===anchor),pick=same.length?(new Set(same.map(x=>x.val)).size===1?same[0]:null):newest(found.filter(x=>x.val===row.totalAssets));
 if(!pick || pick.val===row[T])return;
 row[T]=pick.val;row._sources[T]=[factSource(out,pick)];row._scopes[T]=scope(pick.concept,'entity');delete row._signs[T];delete row._derivations[T];
}
function factSource(out,f) {
 const s={type:'sec_xbrl_fact',cik:out.cik,taxonomy:f.taxonomy,concept:f.concept,unit:f.unit,rawValue:f.val,periodStart:f.start,periodEnd:f.end,form:f.form,filingDate:f.filed,accessionNumber:f.accn,filingUrl:`https://www.sec.gov/Archives/edgar/data/${Number(out.cik)}/${f.accn.replace(/-/g,'')}/${f.accn}-index.htm`,linkage:'xbrl_fact',...(f.annualFiling?{annualFiling:f.annualFiling}:{}),...(f.filedStart?{filedPeriodStart:f.filedStart,periodCorrection:'year_tagged_on_quarter_context'}:{}),...(f.original?{originalDocument:f.original,verificationMethod:'original_inline_xbrl'}:{verificationMethod:'company_facts'}),accountingBasis:f.taxonomy==='ifrs-full'?'IFRS':'US GAAP',scope:scope(f.concept,'entity'),retrievedAt:out.fetchedAt,extractionVersion:EXTRACTION_VERSION};
 const id=p.digest({...s,retrievedAt:null}).slice(0,24);out.sources[id]=s;return id;
}

// An investment company under ASC 946 (a business development company, a listed credit fund) files its
// financial highlights: net asset value per share and the InvestmentCompany* ratios. Its loans and
// securities are bought and sold through operating cash flow, so it has no free cash flow. Measured
// 2026-10-25 on the company facts of every issuer we cover: 49 file both in a 10-K since 2024, all BDCs
// with no SIC (ARCC, MAIN, FSK, OBDC); biotechs, Medallion and WisdomTree file one tag or two, never both.
function investmentCompany(document,asOf) {
 const g=document.facts?.['us-gaap'] || {},since=String(Number(asOf.slice(0,4))-2)+asOf.slice(4);
 const filed=t=>Object.values(g[t]?.units || {}).some(fs=>Array.isArray(fs) && fs.some(f=>/^10-K/.test(f?.form || '') && (f.filed || '')>=since));
 return filed('NetAssetValuePerShare') && Object.keys(g).filter(t=>/^InvestmentCompany/.test(t) && filed(t)).length>=3;
}
// SEC Financial Statement Data Sets store a period end as a MONTH END: Hershey's 10-Q 0001628280-26-050900
// is for the quarter ended 2026-06-28, but the 2026q3 data set files it at 20260630 — sub.txt's period and every
// num.txt ddate — so a lookup by the row's exact end (the company-facts date) found nothing at all for the 383
// covered issuers whose latest quarter does not end on a month end, 42 of them with no EPS on it. The data-set
// date of a period end is the end itself when it is a month end, else the nearest month end within 10 days
// (2026-06-28→2026-06-30, 2026-07-03→2026-06-30, 2026-01-03→2025-12-31; 2026-06-15 is 15 days from either month
// end and stays itself). The cited-filing requirement keeps the rounding safe: the line must come from a filing
// this row already cites, and one filing never reports two periods within 10 days.
function dataSetDate(end) {
 const t=Date.parse(end);if(!Number.isFinite(t))return end;
 const d=new Date(t),y=d.getUTCFullYear(),m=d.getUTCMonth(),last=new Date(Date.UTC(y,m+1,0)),prev=new Date(Date.UTC(y,m,0));
 if(d.getUTCDate()===last.getUTCDate())return end;
 const near=Math.abs(last-t)<=Math.abs(prev-t)?last:prev;
 return Math.abs(near-t)/DAY<=10?near.toISOString().slice(0,10):end;
}
function extract(document, evidence, {asOf = p.day(new Date().toISOString()), statementLines = []} = {}) {
 const issuer = p.cik(document?.cik);
 if (!issuer || issuer !== p.cik(evidence?.cik) || !document.facts || typeof document.facts !== 'object') throw new Error('SEC_IDENTITY_MISMATCH');
 const out = {schemaVersion:1,extractionVersion:EXTRACTION_VERSION,reportingSic:String(evidence.sic || ''),validationVersion:VALIDATION_VERSION,cik:issuer,issuerName:document.entityName || evidence.issuerName || '',fetchedAt:new Date().toISOString(),factsDigest:p.digest(document),income:{annualReports:[],quarterlyReports:[]},balance:{annualReports:[],quarterlyReports:[]},cash:{annualReports:[],quarterlyReports:[]},sources:{},issues:[]};
 if(investmentCompany(document,asOf))out.investmentCompany=true;
 const rows = [];
 const wanted = new Map();
 for(const fields of Object.values(MAPS)) for(const def of Object.values(fields)) for(const taxonomy of ['us-gaap','ifrs-full']) for(const concept of def[taxonomy]) wanted.set(taxonomy + ':' + concept,true);
 for(const guards of Object.values(STAND_INS)) for(const concept of guards) wanted.set(concept,true);
 const fillGuards=[...new Set([...Object.values(FILL_GUARDS),...Object.values(TOTAL_FLOORS)].flat())].filter(concept=>!wanted.has(concept));for(const concept of fillGuards)wanted.set(concept,true);
 wanted.set('us-gaap:CostsAndExpenses',true);wanted.set('us-gaap:'+LEASE_REVENUE,true);
 // Tags introduced on 2026-10-06 may fill a figure but never add a reporting
 // period of their own, so the set of years and quarters is what it was.
 // A figure a guard turned down is recorded, so neither a presented line under the same tag nor the same-filing
 // last-good rule (sec-last-good.js) puts it back: FBS Global 2025 cash of S$4.0m beside S$5.3m of equivalents was.
 const rejected=new Map(),reject=(st,basis,end,field,tag)=>{const k=st+'|'+basis+'|'+end+'|'+field;if(!rejected.has(k))rejected.set(k,new Set());rejected.get(k).add(tag);};
 const added=new Set(['us-gaap:'+LEASE_REVENUE,...LAST_RESORT,...Object.values(STAND_INS).flat(),'us-gaap:CostsAndExpenses','us-gaap:RevenuesNetOfInterestExpense','ifrs-full:RevenueFromSaleOfGoods','ifrs-full:OtherRevenue','us-gaap:CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations','ifrs-full:CashFlowsFromUsedInOperatingActivitiesDiscontinuedOperations',...DISCONTINUED_ADDED,...ROWS_ADDED,...FILLS_ADDED,...fillGuards]);
 for(const [taxonomy, concepts] of Object.entries(document.facts)) for(const [concept, def] of Object.entries(concepts)) {
  if(!wanted.has(taxonomy + ':' + concept)) continue;
  for(const [unit, facts] of Object.entries(def.units || {})) for(const f of facts) {
   const end=p.day(f.end),start=f.start?p.day(f.start):null,filed=p.day(f.filed),val=p.number(f.val);
   if(val===null || !end || !filed || end>asOf || filed>asOf || !FORM.test(f.form || '') || !/^\d{10}-\d{2}-\d{6}$/.test(f.accn || '') || (f.start && !start)) continue;
   const days=start?(Date.parse(end)-Date.parse(start))/DAY+1:null;
   if(days !== null && days <= 0) continue;
   rows.push({taxonomy,concept,unit,val,start,end,days,filed,form:f.form,accn:f.accn,original:f._original || null});
  }
 }
 // L3Harris's FY2025 10-K tags the year's revenue ($21.865bn) and cost of revenue on the fourth-quarter context
 // (2025-10-04 to 2026-01-02) and its 2024 comparative on both the year and the quarter; its own release puts
 // Q4 2025 at $5.6bn. In an annual filing whose quarter context repeats the figure of a year it also files as a
 // year, a quarter figure is the year's: it is dropped as a quarter, and at a year end with no year figure it
 // moves to the year's span when it exceeds every nine-month 10-Q figure for that year, which a quarter cannot.
 {
  const filings=new Map(),drop=new Set();
  for(const r of rows)if(/^(10-K|20-F|40-F)(\/A)?$/.test(r.form)){if(!filings.has(r.accn))filings.set(r.accn,new Map());const g=filings.get(r.accn),k=r.taxonomy+':'+r.concept+'|'+r.unit;if(!g.has(k))g.set(k,[]);g.get(k).push(r);}
  for(const groups of filings.values()){
   const starts=new Map();for(const g of groups.values())for(const r of g)if(r.days>=340 && r.days<=380){const n=starts.get(r.end) || new Map();n.set(r.start,(n.get(r.start) || 0)+1);starts.set(r.end,n);}
   for(const g of groups.values()){
    const year=g.filter(r=>r.days>=340 && r.days<=380),quarter=g.filter(r=>r.days>=75 && r.days<=QUARTER_MAX_DAYS && r.val!==0);
    const copied=quarter.filter(q=>year.some(y=>y.end===q.end && y.val===q.val));
    if(!copied.length)continue;
    for(const q of copied)drop.add(q);
    for(const q of quarter){
     if(copied.includes(q) || year.some(y=>y.end===q.end) || !starts.has(q.end))continue;
     const start=[...starts.get(q.end)].sort((x,y)=>y[1]-x[1])[0][0];
     const nine=rows.filter(r=>r.taxonomy===q.taxonomy && r.concept===q.concept && r.unit===q.unit && r.start===start && r.days>=250 && r.days<=290 && /^10-Q/.test(r.form));
     if(!nine.length || !nine.every(n=>Math.sign(n.val)===Math.sign(q.val) && Math.abs(q.val)>Math.abs(n.val)))continue;
     drop.add(q);rows.push({...q,start,days:(Date.parse(q.end)-Date.parse(start))/DAY+1,filedStart:q.start});
    }
   }
  }
  if(drop.size){const kept=rows.filter(r=>!drop.has(r));rows.length=0;for(const r of kept)rows.push(r);}
 }
 // Canadian National files its audited annual statements in a 6-K on the day of the 40-F that
 // incorporates them, and the 40-F's own XBRL is one cover-page share count (every year since
 // 2016; Vision Marine does the same beside its 20-F). That 6-K is the year's annual report, so
 // its facts count as annual, and each source names both the 6-K and the annual filing.
 if(rows.some(r=>r.form==='6-K')){
  const annualOn=new Map(),tagged=new Set(rows.filter(r=>/^(20-F|40-F)$/.test(r.form)).map(r=>r.filed));
  for(const concepts of Object.values(document.facts))for(const def of Object.values(concepts || {}))for(const facts of Object.values(def?.units || {}))for(const f of facts)if(/^(20-F|40-F)$/.test(f.form || '') && p.day(f.filed) && /^\d{10}-\d{2}-\d{6}$/.test(f.accn || ''))annualOn.set(p.day(f.filed),{form:f.form,accessionNumber:f.accn,filingDate:p.day(f.filed)});
  const la=evidence.latestAnnual;if(/^(20-F|40-F)$/.test(la?.form || '') && p.day(la.filingDate))annualOn.set(la.filingDate,{form:la.form,accessionNumber:la.accessionNumber,filingDate:la.filingDate});
  for(const r of rows)if(r.form==='6-K' && annualOn.has(r.filed) && !tagged.has(r.filed))r.annualFiling=annualOn.get(r.filed);
 }
 const annualForm=r=>/^(10-K|20-F|40-F)(\/A)?$/.test(r.form) || !!r.annualFiling;
 const byConceptUnit=new Map(),byEnd=new Map(),sourceCache=new Map();
 for(const row of rows){const key=row.taxonomy+':'+row.concept+'|'+row.unit;const concept=byConceptUnit.get(key) || [];concept.push(row);byConceptUnit.set(key,concept);const ending=byEnd.get(row.end) || [];ending.push(row);byEnd.set(row.end,ending);}
 const a=evidence.latestAnnual;
 const annualAccessions=new Set(a?[a.accessionNumber,...(a.amendments || []).map(x=>x.accessionNumber)]:[]);
 for(const r of rows)if(a && r.annualFiling?.accessionNumber===a.accessionNumber)annualAccessions.add(r.accn);
 const annualEnds=new Set(rows.filter(r=>!added.has(r.taxonomy+':'+r.concept) && r.days>=340 && r.days<=380 && annualForm(r)).map(r=>r.end));
 if(a) annualEnds.add(a.reportDate);
 const quarterEnds=new Set(rows.filter(r=>!added.has(r.taxonomy+':'+r.concept) && r.days>=75 && r.days<=QUARTER_MAX_DAYS).map(r=>r.end));
 for(const end of annualEnds) quarterEnds.add(end);
 // Original core tags only: the last-resort tags must not widen what counts as a candidate currency.
 const coreTags=new Set();for(const [st,field] of [['income','netIncome'],['income','totalRevenue'],['balance','totalAssets'],['balance','totalShareholderEquity'],['cash','operatingCashflow']])for(const taxonomy of ['us-gaap','ifrs-full'])for(const concept of MAPS[st][field][taxonomy])if(!LAST_RESORT.has(taxonomy+':'+concept))coreTags.add(taxonomy+':'+concept);
 function currency(end, annual) {
  const restrict = annual && a?.reportDate===end;
  const sets=[];
  for(const [st,field] of [['income','netIncome'],['income','totalRevenue'],['balance','totalAssets'],['balance','totalShareholderEquity'],['cash','operatingCashflow']]) {
   const def=MAPS[st][field];
   const found=new Set((byEnd.get(end) || []).filter(r=>r.end===end && /^[A-Z]{3}$/.test(r.unit) && def[r.taxonomy]?.includes(r.concept) && !LAST_RESORT.has(r.taxonomy+':'+r.concept) && (!restrict || annualAccessions.has(r.accn)) && (st==='balance'?r.days===null:annual?r.days>=340&&r.days<=380:r.days!==null&&r.days<=380)).map(r=>r.unit));
   if(found.size) sets.push(found);
  }
  const possible=sets.length?[...sets[0]].filter(u=>sets.every(s=>s.has(u))):[];
  // Reporting-currency facts are strings and intentionally kept outside numeric rows.
  const declared=new Set();
  if(/^[A-Z]{3}$/.test(evidence.reportingCurrency || ''))declared.add(evidence.reportingCurrency);
  for(const concept of ['EntityReportingCurrencyISOCode','EntityReportingCurrency']) for(const facts of Object.values(document.facts.dei?.[concept]?.units || {})) for(const f of facts) if(annualAccessions.has(f.accn) && /^[A-Z]{3}$/.test(String(f.val))) declared.add(f.val);
  if(declared.size===1 && possible.includes([...declared][0])) return [...declared][0];
  if(possible.length===1) return possible[0];
  // A foreign filer often prints a US-dollar "convenience translation" of the
  // current year beside its own currency (Alibaba, PDD, JD, NetEase: 253 issuers
  // on 2026-10-06, some stuck at 2017 because of it). Each filing carries the
  // reporting currency for the current year and its comparatives but the
  // translation for the current year only, so within the filing that reports
  // this period the reporting currency has clearly more core figures.
  if(possible.length>1){
   const reporting=(byEnd.get(end) || []).filter(r=>coreTags.has(r.taxonomy+':'+r.concept) && annualForm(r) && possible.includes(r.unit) && (!restrict || annualAccessions.has(r.accn))).sort((x,y)=>y.filed.localeCompare(x.filed)||y.accn.localeCompare(x.accn))[0];
   if(reporting){
    const counts=new Map();for(const r of rows)if(r.accn===reporting.accn && coreTags.has(r.taxonomy+':'+r.concept) && possible.includes(r.unit))counts.set(r.unit,(counts.get(r.unit) || 0)+1);
    const ranked=[...counts].sort((x,y)=>y[1]-x[1]);
    if(ranked.length>1 && ranked[0][1]>=ranked[1][1]*1.5 && ranked[0][1]>=4) return ranked[0][0];
   }
  }
  out.issues.push({code:'AMBIGUOUS_CURRENCY',periodEnd:end,currencies:possible});return null;
 }
 function select(candidates, key) {
  if(!candidates.length)return null;
  candidates.sort((x,y)=>y.filed.localeCompare(x.filed)||y.accn.localeCompare(x.accn));
  const first=candidates[0];
  const same=candidates.filter(r=>r.accn===first.accn && r.start===first.start && r.end===first.end);
  if(new Set(same.map(r=>r.val)).size>1){out.issues.push({code:'AMBIGUOUS_FACT',field:key,accession:first.accn,periodEnd:first.end});return {ambiguous:true};}
  return first;
 }
 function source(f) {
  if(sourceCache.has(f))return sourceCache.get(f);
  const id=factSource(out,f);sourceCache.set(f,id);return id;
 }
 const yearRevenueLine=new Map(),yearLines=new Map();let quartersAsFiled=true;
 // Statement lines from SEC's Financial Statement Data Sets (statement-lines.js): a
 // figure on the face of a filing whose tag the company-facts feed does not carry.
 // A line fills an empty figure in a period built above, from a filing the period's
 // row already cites, and never adds a year, a quarter or a derived figure.
 const lineIndex=new Map(),startsAt=new Map();
 const presented=new Map(),capexIndex=new Map(),columnIndex=new Map();
 for(const l of Array.isArray(statementLines)?statementLines:[]){
  if(l?.k==='debt'){if(/^\d{10}-\d{2}-\d{6}$/.test(l.a || '') && Array.isArray(l.c))presented.set(l.a,l.c);continue;}
  if(l?.k==='capex'){
   if(/^\d{10}-\d{2}-\d{6}$/.test(l.a || '') && FORM.test(l.m || '') && p.day(l.e) && p.day(l.d) && (l.q===1 || l.q===4) && /^[A-Z]{3}$/.test(l.u || '') && Array.isArray(l.c) && l.c.length && [l.t,l.l,l.v].every(x=>Array.isArray(x) && x.length===l.c.length) && l.v.every(Number.isFinite)){if(!capexIndex.has(l.e))capexIndex.set(l.e,[]);capexIndex.get(l.e).push(l);}
   continue;
  }
  if(l?.k==='columns'){
   if(/^\d{10}-\d{2}-\d{6}$/.test(l.a || '') && FORM.test(l.m || '') && p.day(l.e) && p.day(l.d) && l.q===0 && /^[A-Z]{3}$/.test(l.u || '') && MAPS.balance[l.f] && [l.g,l.v,l.ta].every(x=>Array.isArray(x) && x.length>=2) && l.g.length===l.v.length && l.v.length===l.ta.length && new Set(l.g).size===l.g.length && [...l.v,...l.ta].every(Number.isFinite)){if(!columnIndex.has(l.e))columnIndex.set(l.e,[]);columnIndex.get(l.e).push(l);}
   continue;
  }
  if(!l || !MAPS[l.s]?.[l.f] || !p.day(l.e) || !p.day(l.d) || !Number.isFinite(l.v) || !/^\d{10}-\d{2}-\d{6}$/.test(l.a || '') || !FORM.test(l.m || '') || !l.t || !l.c)continue;
  const k=l.s+'|'+l.f+'|'+l.e;if(!lineIndex.has(k))lineIndex.set(k,[]);lineIndex.get(k).push(l);
 }
 function fillFromLines(st,basis,row,end,cur) {
  const cited=new Map(),cite=id=>{const s=out.sources[id];if(s?.accessionNumber && !cited.has(s.accessionNumber))cited.set(s.accessionNumber,s);};
  for(const ids of Object.values(row._sources))ids.forEach(cite);
  // A statement with no figure of its own takes the filings, and the span, of the period's other statements.
  const empty=!cited.size;
  if(empty)for(const other of ['income','balance','cash'])for(const r of out[other][basis+'Reports'])if(r.fiscalDateEnding===end)for(const ids of Object.values(r._sources))ids.forEach(cite);
  if(!cited.size)return;
  const start=st==='balance'?null:row.periodStart || (empty?startsAt.get(basis+'|'+end):null) || null;
  if(st!=='balance'){if(!start)return;const days=(Date.parse(end)-Date.parse(start))/DAY+1;if(basis==='annual'?days<340 || days>380:days<75 || days>QUARTER_MAX_DAYS)return;}
  const qtrs=st==='balance'?0:basis==='annual'?4:1,restrict=basis==='annual' && a?.reportDate===end;
  for(const field of Object.keys(MAPS[st])) {
   const held=(row._sources[field] || []).map(id=>out.sources[id]),weak=held.length && (!row._derivations?.[field] || row._derivations[field].formula==='ytd_difference') && held.every(s=>s && FILLS.has(s.taxonomy+':'+s.concept));
   if(row[field]!==null && !weak)continue;
   const unit=/(?:EPS|^eps$)/.test(field)?cur+'/shares':cur;
   let candidates=(lineIndex.get(st+'|'+field+'|'+dataSetDate(end)) || []).filter(l=>l.q===qtrs && (l.u===unit || (unit===cur+'/shares' && l.u===cur)) && cited.has(l.a) && (!restrict || annualAccessions.has(l.a)) && l.d>=end && l.d<=asOf
    && (basis!=='annual' || /^(10-K|20-F|40-F)(\/A)?$/.test(l.m) || !!cited.get(l.a).annualFiling));
   // SEC's data set can disagree with the filing it is built from. J.M. Smucker's FY2026 10-K tags
   // cash of $58.6M on its balance sheet (us-gaap, no dimension); the data set lists 0, the value of a
   // fixed-zero fact on a dimension. A standard tag on no dimension is read against the company facts
   // of the same filing and period: their one figure wins, and two different ones leave the line out.
   candidates=candidates.map(l=>{
    if(l.g || !document.facts[l.t])return l;
    const filed=new Set(Object.entries(document.facts[l.t][l.c]?.units || {}).filter(([u])=>u===unit || u===l.u).flatMap(([,fs])=>fs)
     .filter(f=>f.accn===l.a && p.day(f.end)===end && (f.start?p.day(f.start):null)===start).map(f=>p.number(f.val)).filter(v=>v!==null));
    return !filed.size || filed.has(l.v)?l:filed.size===1?{...l,v:[...filed][0],dataSetValue:l.v}:null;
   }).filter(Boolean);
   if(!candidates.length)continue;
   candidates.sort((x,y)=>y.d.localeCompare(x.d)||y.a.localeCompare(x.a));
   let same=candidates.filter(l=>l.a===candidates[0].a);
   // EPS filed per class: the common stock's figure is the company's when every other
   // class is preferred (Oruka 2025: common -1.85, Series B preferred -154.03). Two common
   // classes with different figures leave the cell blank and keep each class's own figure
   // for its listing (Berkshire Q2 2026: Class A 17,868, Class B 11.91).
   if(new Set(same.map(l=>l.v)).size>1){const common=same.filter(l=>/^ClassOfStock=(?:CommonStock|OrdinaryShares)$/.test(l.g || ''));if(common.length && same.every(l=>common.includes(l) || /Preferred/i.test(l.g || '')))same=common;}
   if(new Set(same.map(l=>l.v)).size>1){
    if((field==='eps' || field==='dilutedEPS') && same.every(l=>/^ClassOfStock=[^;=]+;?$/.test(l.g || ''))){
     const from=cited.get(same[0].a);
     for(const c of same){
      if(rejected.get(st+'|'+basis+'|'+end+'|'+field)?.has(c.t+':'+c.c))continue;
      const s={type:'sec_xbrl_fact',cik:issuer,taxonomy:c.t,concept:c.c,unit,rawValue:c.v,periodStart:start,periodEnd:end,form:c.m,filingDate:c.d,accessionNumber:c.a,filingUrl:`https://www.sec.gov/Archives/edgar/data/${Number(issuer)}/${c.a.replace(/-/g,'')}/${c.a}-index.htm`,linkage:'xbrl_fact',...(from.annualFiling?{annualFiling:from.annualFiling}:{}),
       verificationMethod:'statement_line',dataSet:'SEC Financial Statement Data Sets',presentationLabel:c.l,periodQuarters:c.q,dimension:c.g,...(c.dataSetValue!==undefined?{dataSetValue:c.dataSetValue}:{}),accountingBasis:from.accountingBasis || 'US GAAP',scope:MAPS[st][field].scope,retrievedAt:out.fetchedAt,extractionVersion:EXTRACTION_VERSION};
      const id=p.digest({...s,retrievedAt:null}).slice(0,24);out.sources[id]=s;
      (row._classes ??= {})[field] ??= {};row._classes[field][c.g.replace(/^ClassOfStock=/,'').replace(/;$/,'')]={v:c.v,id};
     }
    }
    continue;
   }
   const l=same[0],from=cited.get(l.a);
   if(rejected.get(st+'|'+basis+'|'+end+'|'+field)?.has(l.t+':'+l.c))continue;
   const s={type:'sec_xbrl_fact',cik:issuer,taxonomy:l.t,concept:l.c,unit,rawValue:l.v,periodStart:start,periodEnd:end,form:l.m,filingDate:l.d,accessionNumber:l.a,filingUrl:`https://www.sec.gov/Archives/edgar/data/${Number(issuer)}/${l.a.replace(/-/g,'')}/${l.a}-index.htm`,linkage:'xbrl_fact',...(from.annualFiling?{annualFiling:from.annualFiling}:{}),
    verificationMethod:'statement_line',dataSet:'SEC Financial Statement Data Sets',presentationLabel:l.l,periodQuarters:l.q,...(l.g?{dimension:l.g}:{}),...(l.dataSetValue!==undefined?{dataSetValue:l.dataSetValue}:{}),accountingBasis:from.accountingBasis || 'US GAAP',scope:MAPS[st][field].scope,retrievedAt:out.fetchedAt,extractionVersion:EXTRACTION_VERSION};
   const id=p.digest({...s,retrievedAt:null}).slice(0,24);out.sources[id]=s;
   const negate=OUTFLOWS.has(field);
   row[field]=negate?-Math.abs(l.v):l.v;row._sources[field]=[id];row._scopes[field]=s.scope;if(negate)row._signs[field]=-1;else delete row._signs[field];delete row._derivations[field];
   if(st!=='balance')row.periodStart=start;
  }
 }
 // Capital spending as the sum of the capital-spending lines the cash-flow statement presents (statement-lines
 // capexLine). It fills a period with no figure, or one read from a single presented line of the same filing
 // that the sum includes: Mattel 2025 presents $110.6m of other property, plant and equipment and its tools,
 // dies and molds on a tag of its own, $182.0m in all. A standard capex tag the row already holds is kept.
 function presentedCapex(basis,row,end,cur) {
  const F='capitalExpenditures',held=(row._sources[F] || []).map(id=>out.sources[id]),own=!row._derivations?.[F];
  const weak=held.length && own && held.every(s=>s && FILLS.has(s.taxonomy+':'+s.concept)),single=held.length===1 && own && held[0]?.verificationMethod==='statement_line';
  if(row[F]!==null && !weak && !single || !row.periodStart)return;
  const cited=new Map();for(const ids of Object.values(row._sources))for(const id of ids){const s=out.sources[id];if(s?.accessionNumber && !cited.has(s.accessionNumber))cited.set(s.accessionNumber,s);}
  const q=basis==='annual'?4:1,restrict=basis==='annual' && a?.reportDate===end;
  const l=(capexIndex.get(dataSetDate(end)) || []).filter(x=>x.q===q && x.u===cur && cited.has(x.a) && (!restrict || annualAccessions.has(x.a)) && x.d>=end && x.d<=asOf
   && (basis!=='annual' || /^(10-K|20-F|40-F)(\/A)?$/.test(x.m) || !!cited.get(x.a).annualFiling)).sort((x,y)=>y.d.localeCompare(x.d)||y.a.localeCompare(x.a))[0];
  if(!l || single && (l.c.length<2 || held[0].accessionNumber!==l.a || !l.c.includes(held[0].concept)))return;
  // A standard tag is read against the company facts of the same filing and span, as fillFromLines does.
  const values=[];
  for(let i=0;i<l.c.length;i++){
   let v=l.v[i];
   if(l.t[i]!=='custom' && document.facts[l.t[i]]){
    const filed=new Set(Object.entries(document.facts[l.t[i]][l.c[i]]?.units || {}).filter(([u])=>u===cur).flatMap(([,fs])=>fs)
     .filter(f=>f.accn===l.a && p.day(f.end)===end && (f.start?p.day(f.start):null)===row.periodStart).map(f=>p.number(f.val)).filter(x=>x!==null));
    if(filed.size>1)return;if(filed.size===1)v=[...filed][0];
   }
   values.push(v);
  }
  if(!p.presentedCapexFacts(l.c,values))return;
  const value=-Math.abs(values.reduce((n,v)=>n+v,0));
  if(single && value===row[F])return;
  const from=cited.get(l.a),ids=l.c.map((concept,i)=>{
   const s={type:'sec_xbrl_fact',cik:issuer,taxonomy:l.t[i],concept,unit:cur,rawValue:values[i],periodStart:row.periodStart,periodEnd:end,form:l.m,filingDate:l.d,accessionNumber:l.a,filingUrl:`https://www.sec.gov/Archives/edgar/data/${Number(issuer)}/${l.a.replace(/-/g,'')}/${l.a}-index.htm`,linkage:'xbrl_fact',...(from.annualFiling?{annualFiling:from.annualFiling}:{}),
    verificationMethod:'statement_line',dataSet:'SEC Financial Statement Data Sets',presentationLabel:l.l[i],periodQuarters:l.q,...(values[i]!==l.v[i]?{dataSetValue:l.v[i]}:{}),accountingBasis:from.accountingBasis || 'US GAAP',scope:MAPS.cash[F].scope,retrievedAt:out.fetchedAt,extractionVersion:EXTRACTION_VERSION};
   const id=p.digest({...s,retrievedAt:null}).slice(0,24);out.sources[id]=s;return id;
  });
  row[F]=value;row._sources[F]=ids;row._scopes[F]=MAPS.cash[F].scope;row._signs[F]=-1;
  row._derivations[F]={formula:'sum_presented_capex',inputValues:values,presentedConcepts:[...l.c]};
 }
 // A balance sheet presented in segment columns (statement-lines columnSum): the columns are the one
 // axis whose members' Assets sum exactly to this row's own total assets, and a field the filing shows
 // only per column is the sum of those (Berkshire's 10-Q for 2026-06-30: cash 35,096 + 5,513 = 40,609;
 // PP&E 39,409 + 185,815 = 225,224 — the company-facts feed drops every dimensional fact, so neither
 // figure ever reached the row). Only a still-null cell, from a filing the row cites, newest first.
 function presentedColumns(basis,row,end,cur) {
  if(row.totalAssets===null)return;
  const cited=new Map();for(const ids of Object.values(row._sources))for(const id of ids){const s=out.sources[id];if(s?.accessionNumber && !cited.has(s.accessionNumber))cited.set(s.accessionNumber,s);}
  if(!cited.size)return;
  const restrict=basis==='annual' && a?.reportDate===end;
  for(const field of Object.keys(MAPS.balance)) {
   if(row[field]!==null)continue;
   const hits=(columnIndex.get(dataSetDate(end)) || []).filter(x=>x.f===field && x.u===cur && cited.has(x.a) && (!restrict || annualAccessions.has(x.a)) && x.d>=end && x.d<=asOf
    && (basis!=='annual' || /^(10-K|20-F|40-F)(\/A)?$/.test(x.m) || !!cited.get(x.a).annualFiling)).sort((x,y)=>y.d.localeCompare(x.d)||y.a.localeCompare(x.a));
   if(!hits.length)continue;
   const same=hits.filter(x=>x.a===hits[0].a);
   if(same.length>1)continue;
   const l=same[0];
   if(!['ProductOrService','BusinessSegments'].includes(l.x) || !l.ta.every(v=>v>0) || p.number(row.totalAssets)!==l.ta.reduce((n,v)=>n+v,0))continue;
   const from=cited.get(l.a),ids=l.g.map((member,i)=>{
    const s={type:'sec_xbrl_fact',cik:issuer,taxonomy:l.t,concept:l.c,unit:cur,rawValue:l.v[i],periodStart:null,periodEnd:end,form:l.m,filingDate:l.d,accessionNumber:l.a,filingUrl:`https://www.sec.gov/Archives/edgar/data/${Number(issuer)}/${l.a.replace(/-/g,'')}/${l.a}-index.htm`,linkage:'xbrl_fact',...(from.annualFiling?{annualFiling:from.annualFiling}:{}),
     verificationMethod:'statement_line',dataSet:'SEC Financial Statement Data Sets',presentationLabel:l.l,periodQuarters:l.q,dimension:l.x+'='+member,accountingBasis:from.accountingBasis || 'US GAAP',scope:MAPS.balance[field].scope,retrievedAt:out.fetchedAt,extractionVersion:EXTRACTION_VERSION};
    const id=p.digest({...s,retrievedAt:null}).slice(0,24);out.sources[id]=s;return id;
   });
   row[field]=l.v.reduce((n,v)=>n+v,0);row._sources[field]=ids;row._scopes[field]=MAPS.balance[field].scope;
   row._derivations[field]={formula:'sum_member_columns',axis:l.x,members:[...l.g],inputValues:[...l.v],memberAssets:[...l.ta],presentedConcept:l.c};
  }
 }
 function resolve(st,field,end,cur,basis) {
  const def=MAPS[st][field],unit=/(?:EPS|^eps$)/.test(field)?cur+'/shares':/Shares/.test(field)?'shares':cur;
  const restrict=basis==='annual' && a?.reportDate===end;
  const asReportedQuarter=basis==='quarterly' && st!=='balance' && !!a && end<=a.reportDate && Date.parse(a.reportDate)-Date.parse(end)<330*DAY;
  // Revenue: a filing often carries both "revenue from contracts with customers"
  // and its total revenues, and the contract figure used to win. For a landlord,
  // an equipment renter, a lender or a commodity trader that is a fraction of
  // the business: on 2026-10-06, 187 covered companies were understated, 86 of
  // them by more than 20% (American Tower $0.9bn of $10.6bn, ADM $25bn of
  // $80bn, American Express $41bn of $72bn). Within the newest filing that
  // reports the period, the total is the largest of the revenue lines — or net
  // revenues, where a financial firm reports them, since that is its top line.
  let revenueFirst=null,revenueStart=null;
  if(field==='totalRevenue') {
   // A revenue figure for a different span than the year's net income (a merger
   // stub tagged with the same year end) would set the wrong period for the row.
   // The chosen line must cover the same span the row already had: the span of
   // the line the original order would have picked, or, where there was none,
   // of the year's net income. A merger stub tagged with the same year end
   // would otherwise set the wrong period for the whole row.
   if(basis==='annual'){
    const annualRows=tag=>(byConceptUnit.get(tag+'|'+unit) || []).filter(r=>(!restrict || annualAccessions.has(r.accn)) && r.end===end && r.days>=340 && r.days<=380 && annualForm(r)).sort((x,y)=>y.filed.localeCompare(x.filed)||y.accn.localeCompare(x.accn));
    for(const taxonomy of ['us-gaap','ifrs-full']){for(const concept of def[taxonomy]){if(added.has(taxonomy+':'+concept) || partialRevenueConcept(out.reportingSic,concept))continue;const rows=annualRows(taxonomy+':'+concept);if(rows.length){revenueStart=rows[0].start;break;}}if(revenueStart)break;}
    if(!revenueStart)for(const tag of ['us-gaap:NetIncomeLoss','us-gaap:ProfitLoss','ifrs-full:ProfitLossAttributableToOwnersOfParent','ifrs-full:ProfitLoss']){const rows=annualRows(tag);if(rows.length){revenueStart=rows[0].start;break;}}
   }
   const pickFor=test=>{
    const picks=[];
    for(const taxonomy of ['us-gaap','ifrs-full']) for(const concept of def[taxonomy]) {
     if(partialRevenueConcept(out.reportingSic,concept))continue;
     const candidates=(byConceptUnit.get(taxonomy+':'+concept+'|'+unit) || []).filter(r=>(!restrict || annualAccessions.has(r.accn)) && r.end===end && test(r) && (!revenueStart || r.start===revenueStart));
     if(!candidates.length)continue;
     candidates.sort((x,y)=>y.filed.localeCompare(x.filed)||y.accn.localeCompare(x.accn));
     const first=candidates[0],same=candidates.filter(r=>r.accn===first.accn && r.start===first.start);
     if(new Set(same.map(r=>r.val)).size===1)picks.push({row:first,taxonomy,concept});
    }
    if(!picks.length)return null;
    // Stay inside the filing the original line came from: switching to a later
    // filing would silently swap an as-reported year for a restated one (eBay
    // 2014 is $17.9bn as filed and $8.8bn restated after the PayPal spin-off).
    // Only a year that had no revenue before takes the newest filing.
    const original=picks.find(x=>!added.has(x.taxonomy+':'+x.concept));
    const newest=original?original.row:picks.slice().sort((x,y)=>y.row.filed.localeCompare(x.row.filed)||y.row.accn.localeCompare(x.row.accn))[0].row;
    const filing=picks.filter(x=>x.row.accn===newest.accn && x.row.start===newest.start);
    if(filing.length<2)return filing[0];
    const largest=Math.max(...filing.map(x=>x.row.val));
    // A financial firm's top line is revenue net of interest expense.
    const net=filing.find(x=>x.concept==='RevenuesNetOfInterestExpense');
    if(net && net.row.val>=largest*0.25 && /^6/.test(String(out.reportingSic || '')))return net;
    // The filing's own arithmetic names the total: gross profit plus cost of
    // revenue, or operating income plus total costs, equals exactly one line.
    const fact=names=>{for(const name of names){const rows=(byConceptUnit.get(newest.taxonomy+':'+name+'|'+unit) || []).filter(r=>r.accn===newest.accn && r.end===end && r.start===newest.start);if(rows.length && new Set(rows.map(r=>r.val)).size===1)return rows[0].val;}return null;};
    const gross=fact(['GrossProfit']),cost=fact(MAPS.income.costOfRevenue[newest.taxonomy]),operating=fact(newest.taxonomy==='us-gaap'?['OperatingIncomeLoss']:['ProfitLossFromOperatingActivities']),costs=fact(['CostsAndExpenses']);
    const expenses=fact(['OperatingExpenses']),selling=fact(['SellingGeneralAndAdministrativeExpense']),pretax=fact(MAPS.income.incomeBeforeTax[newest.taxonomy]);
    const sum=(...parts)=>parts.every(x=>x!==null)?parts.reduce((n,x)=>n+x,0):null;
    // General Motors: operating income plus operating expenses is total revenue.
    // Chevron: pre-tax income plus total costs. Walmart: operating income plus
    // cost of sales plus selling and administrative expense.
    for(const total of [sum(gross,cost),sum(operating,costs),sum(operating,expenses),sum(pretax,costs),sum(operating,cost,selling)]) {
     if(total===null)continue;
     const match=filing.filter(x=>Math.abs(x.row.val-total)<=Math.abs(total)*0.001);
     // Two lines carrying the same confirmed amount are the same total.
     if(match.length && new Set(match.map(x=>x.row.val)).size===1)return match[0];
    }
    // With nothing in the filing to arbitrate: a line under four fifths of the
    // largest is plainly a part (rent, leasing and interest are not customer
    // contracts), so the largest is the total. A narrower gap can be excise tax
    // or intercompany sales either way, and the original choice stands.
    const legacy=filing[0];
    // Revenue including taxes collected for the government is not a larger
    // total than revenue excluding them (Cronos, excise duty), and a line that
    // is exactly a thousand or a million times another is a scale slip in the
    // filing (SS Innovations), not a bigger business.
    const rivals=filing.filter(x=>!(x.concept==='RevenueFromContractWithCustomerIncludingAssessedTax' && filing.some(y=>y.concept==='RevenueFromContractWithCustomerExcludingAssessedTax'))
     && !(legacy.row.val>0 && [1e3,1e6].some(k=>Math.abs(x.row.val/legacy.row.val-k)<=k*0.001)));
    const top=Math.max(...rivals.map(x=>x.row.val));
    return legacy.row.val<top*0.8?rivals.find(x=>x.row.val===top):legacy;
   };
   // A quarter reports on the same line its fiscal year was read from, so the
   // quarters and the year describe the same thing.
   if(basis==='quarterly' && yearRevenueLine.size){const years=[...yearRevenueLine.keys()].sort(),year=years.find(e=>e>=end) || years.at(-1),line=yearRevenueLine.get(year).split(':');revenueFirst={taxonomy:line[0],concept:line[1]};}
   else revenueFirst=pickFor(r=>basis==='annual'?r.days>=340&&r.days<=380 && annualForm(r):r.days>=75&&r.days<=QUARTER_MAX_DAYS);
   // A quarter with no three-month figure is derived from year-to-date figures;
   // it must use the same line the year-to-date total was chosen from.
   if(!revenueFirst && basis==='quarterly')revenueFirst=pickFor(r=>r.days>=160&&r.days<=380);
  }
  const tags=['us-gaap','ifrs-full'].flatMap(taxonomy=>def[taxonomy].map(concept=>[taxonomy,concept]));
  // A fill-only tag of either taxonomy comes after every original one: an IFRS filer's own dividends
  // line wins over a US GAAP common-dividend fact from the years it filed under US GAAP.
  const late=t=>LAST_RESORT.has(t.join(':')) || FILLS.has(t.join(':'));
  const ordered=[...tags.filter(t=>!late(t)),...tags.filter(late)];
  // Net income attributable to the parent in the year and consolidated net
  // income in its quarters are different figures; a quarter is read from the
  // line its fiscal year used whenever that line is filed for the quarter.
  // A per-share line that only fills gaps is often a later filing's split-restated
  // comparative (Comstock Q3 2015: -11.81 as filed, -59.05 under the basic-and-diluted
  // tag after the 2016 1-for-5 reverse split), so it never displaces a filed EPS line.
  if(basis==='quarterly' && field!=='totalRevenue' && yearLines.has(field)){const lines=yearLines.get(field),years=[...lines.keys()].sort(),line=lines.get(years.find(e=>e>=end) || years.at(-1));if(!((unit.endsWith('/shares') && added.has(line)) || FILLS.has(line)))ordered.sort((x,y)=>(y.join(':')===line)-(x.join(':')===line));}
  if(revenueFirst)ordered.sort((x,y)=>(y[0]===revenueFirst.taxonomy && y[1]===revenueFirst.concept)-(x[0]===revenueFirst.taxonomy && x[1]===revenueFirst.concept));
  for(const [taxonomy,concept] of ordered) {
   if(field==='totalRevenue' && partialRevenueConcept(out.reportingSic,concept))continue;
   let all=(byConceptUnit.get(taxonomy+':'+concept+'|'+unit) || []).filter(r=>(!restrict || annualAccessions.has(r.accn)) && (!revenueStart || r.end!==end || r.start===revenueStart));
   // The newest year's annual figures are as reported in its own annual report.
   // Its quarters must be too: next year's 10-Qs restate them as comparatives
   // (Aptiv's 2025 quarters after a spin-off), and a restated quarter beside an
   // as-reported year no longer adds up to it.
   if(asReportedQuarter && quartersAsFiled){const filed=all.filter(r=>r.filed<=a.filingDate);if(filed.some(r=>r.end===end))all=filed;}
   const candidates=all.filter(r=>r.end===end && (st==='balance'?r.days===null:basis==='annual'?r.days>=340&&r.days<=380 && annualForm(r):r.days>=75&&r.days<=QUARTER_MAX_DAYS));
   // A full-year figure mis-dated as the fourth quarter (NiSource, in SEC's
   // feed) is not a quarter: the same filing gives the same amount for the year.
   if(basis==='quarterly' && st!=='balance')for(let i=candidates.length-1;i>=0;i--){const c=candidates[i];if(c.val!==0 && all.some(r=>r.accn===c.accn && r.end===c.end && r.days>=340 && r.val===c.val))candidates.splice(i,1);}
   const selected=select(candidates,field);
   if(selected?.ambiguous)return null;
   const guards=['netIncome','operatingCashflow','cashflowFromInvestment','cashflowFromFinancing','eps','dilutedEPS'].includes(field) && STAND_INS[taxonomy+':'+concept];
   const parts=FILL_GUARDS[taxonomy+':'+concept],floors=TOTAL_FLOORS[taxonomy+':'+concept];
   const differs=f=>guards && rows.some(r=>guards.includes(r.taxonomy+':'+r.concept) && r.end===f.end && r.accn===f.accn && r.start===f.start && r.val!==0)
    || parts && rows.some(r=>parts.includes(r.taxonomy+':'+r.concept) && r.end===f.end && r.accn===f.accn && r.val!==0)
    || floors && [floors,[TOTAL_INTEREST]].every(tags=>rows.some(r=>tags.includes(r.taxonomy+':'+r.concept) && r.end===f.end && r.accn===f.accn && r.start===f.start && r.val>f.val));
   if(selected && differs(selected)){reject(st,basis,end,field,taxonomy+':'+concept);continue;}
   if(selected){if(basis==='annual'){if(field==='totalRevenue')yearRevenueLine.set(end,taxonomy+':'+concept);else if(ordered.length>1){if(!yearLines.has(field))yearLines.set(field,new Map());yearLines.get(field).set(end,taxonomy+':'+concept);}}return {value:selected.val,refs:[source(selected)],start:selected.start,scope:scope(concept,def.scope)};}
   if(basis==='quarterly' && st!=='balance' && unit===cur) {
    const ytd=select(all.filter(r=>r.end===end && r.days>=160 && r.days<=380),field);
    if(ytd?.ambiguous)return null;
    if(ytd) {
     const prev=select(all.filter(r=>r.start===ytd.start && r.end<end && r.days>=ytd.days-QUARTER_MAX_DAYS && r.days<=ytd.days-75 && r.filed<=ytd.filed && (!/\/A$/.test(ytd.form) || r.accn===ytd.accn)),field);
     if(prev?.ambiguous)return null;
     // A quarter derived from year-to-date figures takes a stand-in line only when both figures pass its test.
     if(prev && (differs(ytd) || differs(prev))){reject(st,basis,end,field,taxonomy+':'+concept);continue;}
     if(prev){const start=new Date(Date.parse(prev.end)+DAY).toISOString().slice(0,10);return {value:ytd.val-prev.val,refs:[source(ytd),source(prev)],start,scope:scope(concept,def.scope),derivation:{formula:'ytd_difference',inputValues:[ytd.val,prev.val]}};}
    }
   }
  }
  return null;
 }
 const build=basis=>{ for(const end of [...(basis==='annual'?annualEnds:quarterEnds)].filter(p.day).sort().reverse().slice(0,basis==='annual'?25:48)) {
  const cur=currency(end,basis==='annual');if(!cur)continue;
  for(const st of ['income','balance','cash']) {
   const row={fiscalDateEnding:end,periodStart:null,reportedCurrency:cur,periodType:st==='balance'?'instant':basis,_sources:{},_derivations:{},_scopes:{},_signs:{}};
   // A fill-only tag sets the period only when nothing else does: its start can be a day off the
   // statement's, and the row's start decides which of its other figures are kept.
   let fillStart=null;
   for(const field of Object.keys(MAPS[st])) {
    const found=resolve(st,field,end,cur,basis);row[field]=null;if(!found)continue;
    const negate=OUTFLOWS.has(field);
    row[field]=negate?-Math.abs(found.value):found.value;
    row._sources[field]=found.refs;row._scopes[field]=found.scope;
    if(negate)row._signs[field]=-1;
    if(found.derivation)row._derivations[field]=found.derivation;
    if(found.refs.every(id=>FILLS.has(out.sources[id].taxonomy+':'+out.sources[id].concept))){if(found.start && !fillStart)fillStart=found.start;}
    else if(found.start && !row.periodStart)row.periodStart=found.start;
   }
   if(!row.periodStart)row.periodStart=fillStart;
   function combine(field, left, right, operation) {
    if(row[field]!==null || row[left]===null || row[right]===null || !p.verifiedField(out,row,left) || !p.verifiedField(out,row,right))return;
    const refs=[...row._sources[left],...row._sources[right]];
    const scopes=[row._scopes[left],row._scopes[right]];
    if(scopes[0]!==scopes[1])return;
    const versions=field=>[...new Set(row._sources[field].map(id=>out.sources[id].accessionNumber))].sort().join('|');
    if(versions(left)!==versions(right))return;
    row[field]=operation==='sum_fields'?row[left]+row[right]:row[left]-row[right];
    row._sources[field]=refs;row._scopes[field]=scopes[0];row._derivations[field]={formula:operation,inputs:[left,right],inputValues:[row[left],row[right]]};
   }
   if(st==='income') {
    // Bank net revenue is a monetary flow, not gross interest income.
    // and where a bank files both parts, their sum is its revenue: the bare
    // "Revenues" tag on a bank filing is often a fragment (First Bancorp $68m
    // against $390m of net interest plus noninterest income) or zero.
    if(/^(602|603|609)/.test(String(evidence.sic || ''))) {
     const filings=f=>[...new Set(row._sources[f].map(id=>out.sources[id].accessionNumber))].sort().join('|');
     if(row.totalRevenue!==null && row.netInterestIncome!==null && row.nonInterestIncome!==null && row.totalRevenue!==row.netInterestIncome+row.nonInterestIncome && p.verifiedField(out,row,'netInterestIncome') && p.verifiedField(out,row,'nonInterestIncome')
      && row._scopes.netInterestIncome===row._scopes.nonInterestIncome && filings('netInterestIncome')===filings('nonInterestIncome')){row.totalRevenue=null;delete row._sources.totalRevenue;delete row._scopes.totalRevenue;delete row._derivations.totalRevenue;}
     combine('totalRevenue','netInterestIncome','nonInterestIncome','sum_fields');
     // An IFRS bank has no noninterest-income total to add; Santander and BBVA present their top line ("Total
     // income", "Gross profit" — margen bruto) on the gross-profit tag, with no cost of sales above it. On a
     // bank that line is the revenue, moved rather than shown twice.
     if(row.totalRevenue===null && row.costOfRevenue===null && row.grossProfit!==null && row.grossProfit>0 && row._sources.grossProfit.every(id=>out.sources[id].taxonomy==='ifrs-full') && p.verifiedField(out,row,'grossProfit')){
      row.totalRevenue=row.grossProfit;row._sources.totalRevenue=row._sources.grossProfit;row._scopes.totalRevenue=row._scopes.grossProfit;
      row.grossProfit=null;delete row._sources.grossProfit;delete row._scopes.grossProfit;delete row._derivations.grossProfit;
     }
    }
    // A card or consumer lender (Synchrony 6199, SLM and OneMain 6141) files the same two parts and no total;
    // only fill the blank here, never replace a filed "Revenues" figure as the depository rule above does.
    else if(/^61/.test(String(evidence.sic || '')))combine('totalRevenue','netInterestIncome','nonInterestIncome','sum_fields');
    if(row.totalRevenue===null && row.revenueFromSaleOfGoods!==null && row.otherRevenue!==null && row.grossProfit!==null && row.costOfRevenue!==null && row.revenueFromSaleOfGoods+row.otherRevenue===row.grossProfit+row.costOfRevenue)combine('totalRevenue','revenueFromSaleOfGoods','otherRevenue','sum_fields');
    // Filled only when the year has no revenue figure, never in place of one,
    // and never from a line smaller than the profit it would have to produce:
    // that is a fragment (a parent-only statement, a single fee line), not the
    // company's total. The filed line stays the cited source.
    if(row.totalRevenue===null && row.reportedRevenueTotal!==null && row.reportedRevenueTotal>0 && p.verifiedField(out,row,'reportedRevenueTotal') && row.netIncome!==null && row.reportedRevenueTotal>=Math.abs(row.netIncome)) {
     row.totalRevenue=row.reportedRevenueTotal;row._sources.totalRevenue=row._sources.reportedRevenueTotal;row._scopes.totalRevenue=row._scopes.reportedRevenueTotal;
    }
    // An equity REIT whose rent is its one revenue line files no total: American Homes 4 Rent's 2025 statement
    // opens with "Rents and other single-family property revenues" on the lease-income tag and goes on to its
    // expenses (Industrial Logistics, American Strategic the same). Read from the filing and span of the row's net
    // income, never for a lender (net interest income is its top line) or below the profit it would produce.
    if(row.totalRevenue===null && out.reportingSic==='6798' && row.netInterestIncome===null && row.netIncome!==null && row.periodStart && p.verifiedField(out,row,'netIncome')){
     const accn=out.sources[row._sources.netIncome[0]]?.accessionNumber;
     const lease=(byConceptUnit.get('us-gaap:'+LEASE_REVENUE+'|'+cur) || []).filter(r=>r.accn===accn && r.end===end && r.start===row.periodStart);
     // Blackstone Mortgage Trust and Granite Point also file rent, from foreclosed property: a lender's interest
     // income outweighs it, and their "other income" total marks them too.
     if(lease.length && new Set(lease.map(r=>r.val)).size===1 && lease[0].val>0 && lease[0].val>=Math.abs(row.netIncome) && row.nonInterestIncome===null && !(Math.abs(row.interestIncome ?? 0)>=lease[0].val)){row.totalRevenue=lease[0].val;row._sources.totalRevenue=[source(lease[0])];row._scopes.totalRevenue=scope(LEASE_REVENUE,MAPS.income.totalRevenue.scope);}
    }
    if(!/^(602|603|609|63)/.test(out.reportingSic))combine('grossProfit','totalRevenue','costOfRevenue','difference_fields');
   }
   if(st==='cash')combine('operatingCashflow','operatingCashflowContinuing','operatingCashflowDiscontinued','sum_fields');
   if(st==='balance') {
    combine('shortTermDebt','shortTermBorrowings','currentLongTermDebt','sum_fields');
    combine('shortLongTermDebtTotal','shortTermDebt','longTermDebt','sum_fields');
   }
   if(lineIndex.size)fillFromLines(st,basis,row,end,cur);
   if(st==='balance' && columnIndex.size)presentedColumns(basis,row,end,cur);
   if(st==='cash' && capexIndex.size)presentedCapex(basis,row,end,cur);
   if(st==='balance' && presented.size)presentedDebt(out,row,presented,document);
   if(st==='balance')liabilitiesAndEquity(out,row,document);
   for(const field of Object.keys(row._sources))if(!p.verifiedField(out,row,field)){row[field]=null;delete row._sources[field];delete row._derivations[field];out.issues.push({code:'INCOMPATIBLE_PERIOD',field,periodEnd:end});}
   for(const [k,tags] of rejected){const [s0,b0,e0,field]=k.split('|');if(s0===st && b0===basis && e0===end && row[field]===null)out.issues.push({code:'REJECTED_PART',statement:st,basis,field,periodEnd:end,concepts:[...tags]});}
   // Net income on the cash-flow statement and D&A on the income statement are
   // the other statement's lines; on their own they are not a statement.
   if(Object.keys(row._sources).every(f=>BORROWED[st]?.includes(f)))for(const f of Object.keys(row._sources)){row[f]=null;delete row._sources[f];delete row._scopes[f];delete row._derivations[f];delete row._signs[f];}
   if(st!=='balance' && row.periodStart && Object.keys(row._sources).length && !startsAt.has(basis+'|'+end))startsAt.set(basis+'|'+end,row.periodStart);
   if(Object.keys(row._sources).length)out[st][basis+'Reports'].push(row);
  }
 } };
 build('annual');build('quarterly');
 // The newest year's four quarters should add up to the year. They are read
 // as filed up to the annual report; when a disposal was restated in the annual
 // report itself (AppLovin) only the later, restated quarters add up, so that
 // reading is tried too and the one that reconciles is kept. A year that
 // reconciles neither way is recorded, never silently published as consistent.
 if(a) {
  const unreconciled=()=>{const year=out.income.annualReports.find(r=>r.fiscalDateEnding===a.reportDate);if(!year?.periodStart)return 0;
   const quarters=out.income.quarterlyReports.filter(q=>q.fiscalDateEnding<=a.reportDate && q.periodStart && q.periodStart>=year.periodStart);if(quarters.length!==4)return 0;
   return ['totalRevenue','netIncome'].filter(f=>year[f]!==null && quarters.every(q=>q[f]!==null) && Math.abs(quarters.reduce((n,q)=>n+q[f],0)-year[f])>Math.max(Math.abs(year[f])*0.02,1e6)).length;};
  const first=unreconciled();
  if(first) {
   const kept={income:out.income.quarterlyReports,balance:out.balance.quarterlyReports,cash:out.cash.quarterlyReports,issues:out.issues.length};
   quartersAsFiled=false;for(const st of ['income','balance','cash'])out[st].quarterlyReports=[];
   build('quarterly');
   if(unreconciled()>=first){for(const st of ['income','balance','cash'])out[st].quarterlyReports=kept[st];out.issues.length=kept.issues;}
   if(unreconciled())out.issues.push({code:'QUARTERS_DO_NOT_SUM',periodEnd:a.reportDate});
  }
 }
 if(document.segmentFacts?.length){const segments=require('./sec-segment-observations'),groups=segments.extract(document.segmentFacts,out,document.industryFiling);out.segmentObservations=groups.filter(g=>{if(segments.validGroup(g,out))return true;out.issues.push({code:'UNSUPPORTED_SEGMENT_PROVENANCE',periodEnd:g.periodEnd,reason:'The original segment context or numerical receipt did not pass validation'});return false;});}
 if(document.industryTables?.length)out.industryObservations=require('./sec-industry-tables').extractTables(document.industryTables,document.industryFiling,issuer,out);
 return out;
}
module.exports={extract,presentedDebt,MAPS,OUTFLOWS,ROWS_ADDED,EXTRACTION_VERSION,VALIDATION_VERSION,partialRevenueConcept,scope,dataSetDate};
