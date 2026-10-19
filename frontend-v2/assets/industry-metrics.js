/* Bank and insurer metrics for the company page.
   One pure module over a company's filed annual rows. It runs in the browser
   (company.js draws from it), under Node (backend/test/industry-metrics.test.js)
   and in the dossier build, so the page and every later screener agree on what
   "efficiency ratio" means.

   Every output is a filed number or arithmetic on filed numbers. A measure whose
   inputs are missing is null and carries the reason in a `why` field; nothing is
   estimated. Ratios that divide a flow by a balance use the average of the
   opening and closing balances, and the page labels that basis.

   The SIC lists are the only classification table. They are checked against
   SEC's Standard Industrial Classification list: banks 6021, 6022, 6029, 6035,
   6036; insurers 6311, 6321, 6324, 6331, 6351, 6361, 6399. Insurance agents and
   brokers (6411) are not carriers and are deliberately excluded. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IndustryMetrics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BANK_SIC = ['6021', '6022', '6029', '6035', '6036'];
  const INSURER_SIC = ['6311', '6321', '6324', '6331', '6351', '6361', '6399'];
  // 6331 fire/marine/casualty, 6351 surety, 6361 title and 6399 carriers NEC
  // underwrite property and casualty risk. Life (6311), accident & health (6321)
  // and hospital & medical service plans (6324) do not report a combined ratio.
  const PC_SIC = new Set(['6331', '6351', '6361', '6399']);
  const LIFE_SIC = new Set(['6311', '6321']);
  const HEALTH_SIC = new Set(['6324']);
  const YEARS = 5;
  const YEAR_MS = 365.2425 * 86400000;

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const time = (end) => Date.parse(end);
  const pct = (v) => (v === null ? null : v * 100);

  function fyOf(end) {
    const t = time(end);
    if (Number.isNaN(t)) return '';
    return 'FY' + new Date(t - 10 * 86400000).getUTCFullYear();
  }

  function kindFromSic(sic) {
    const code = String(sic || '').trim().padStart(4, '0');
    if (BANK_SIC.includes(code)) return 'bank';
    if (INSURER_SIC.includes(code)) return 'insurer';
    return null;
  }

  function insurerType(sic) {
    const code = String(sic || '').trim().padStart(4, '0');
    if (LIFE_SIC.has(code)) return 'life';
    if (HEALTH_SIC.has(code)) return 'health';
    if (PC_SIC.has(code)) return 'pc';
    return null;
  }

  const hasCombinedRatio = (sic) => PC_SIC.has(String(sic || '').trim().padStart(4, '0'));

  // The fields the two panels read, in the order the statements carry them.
  const FIELDS = [
    'netInterestIncome', 'nonInterestIncome', 'nonInterestExpense', 'provisionForCreditLosses',
    'interestIncome', 'interestExpense', 'netInvestmentIncome', 'investmentIncome',
    'premiums', 'lossesAndLossAdjustmentExpense', 'policyAcquisitionExpense', 'otherUnderwritingExpense',
    'netIncome', 'totalAssets', 'totalShareholderEquity', 'loans', 'deposits',
    'commonStockSharesOutstanding', 'weightedAverageSharesDiluted', 'interestEarningAssets'
  ];
  const FIELD_SET = new Set(FIELDS);

  // A period can be filed on the income, balance and cash statements, and a
  // bank with no SEC statements has regulator observations instead. SEC figures
  // win; the FDIC call report fills only what the SEC statements do not hold.
  function collect(data) {
    const byEnd = new Map();
    const row = (end) => {
      if (!end || Number.isNaN(time(end))) return null;
      if (!byEnd.has(end)) byEnd.set(end, { end: String(end), basis: null });
      return byEnd.get(end);
    };
    const put = (target, field, value) => {
      const n = num(value);
      if (target && n !== null && target[field] === undefined) target[field] = n;
    };
    for (const st of ['income', 'balance', 'cash']) {
      for (const r of (data?.[st]?.annualReports) || []) {
        const target = row(r?.fiscalDateEnding);
        if (!target) continue;
        for (const field of FIELDS) put(target, field, r[field]);
        target.currency = target.currency || r.reportedCurrency || null;
        target.periodStart = target.periodStart || r.periodStart || null;
        target.basis = 'SEC';
      }
    }
    const observations = (data?.supplementalObservations || [])
      .filter((f) => (f.historyBasis || f.basis) === 'annual' && FIELD_SET.has(f.field))
      .slice().sort((a, b) => (/^FDIC/.test(b.sourceName || '') - /^FDIC/.test(a.sourceName || '')));
    for (const f of observations) {
      const target = row(f?.periodEnd);
      if (!target) continue;
      put(target, f.field, f.value);
      target.currency = target.currency || f.currency || null;
      target.periodStart = target.periodStart || f.periodStart || null;
      if (!target.basis) target.basis = /^FDIC/.test(f.sourceName || '') ? 'FDIC' : 'provider';
    }
    return [...byEnd.values()]
      .filter((r) => FIELDS.some((field) => r[field] !== undefined))
      .sort((a, b) => String(a.end).localeCompare(String(b.end)));
  }

  // The filed year immediately before this one. A gap longer than a year is a
  // missing year, not an opening balance.
  function prevYear(rows, i) {
    const t = time(rows[i].end);
    for (let j = i - 1; j >= 0; j -= 1) {
      const gap = (t - time(rows[j].end)) / YEAR_MS;
      if (gap >= 0.93 && gap <= 1.04) return rows[j];
      if (gap > 1.04) return null;
    }
    return null;
  }

  const average = (a, b) => num(a) !== null && num(b) !== null ? (a + b) / 2 : null;
  const ratio = (a, b) => num(a) !== null && num(b) !== null && b > 0 ? a / b : null;

  function missing(field, fy) {
    return `Not available: ${field} for ${fy} is not in our filings data.`;
  }
  function opening(field) {
    return `Not available: the opening ${field} is not in our filings data, so the average cannot be formed.`;
  }

  function buildBank(rows, options = {}) {
    const all = rows.filter((r) => ['netInterestIncome', 'nonInterestExpense', 'totalAssets', 'loans', 'deposits']
      .some((f) => r[f] !== undefined));
    const out = [];
    for (let i = 0; i < all.length; i += 1) {
      const r = all[i], prev = prevYear(all, i), fy = fyOf(r.end);
      const values = {}, why = {};
      const set = (key, value, reason) => { values[key] = value; if (value === null) why[key] = reason; };
      const nii = num(r.netInterestIncome), ni = num(r.netIncome);
      const avgAssets = average(r.totalAssets, prev?.totalAssets);
      const avgEquity = average(r.totalShareholderEquity, prev?.totalShareholderEquity);
      const avgLoans = average(r.loans, prev?.loans);
      set('netInterestIncome', nii, missing('net interest income', fy));
      set('netInterestIncomeGrowthPct', nii !== null && prev && num(prev.netInterestIncome) > 0
        ? pct(nii / prev.netInterestIncome - 1) : null,
        !prev ? `Not available: ${fy} has no filed year before it for a growth rate.`
          : num(prev.netInterestIncome) === null ? missing('prior-year net interest income', prev ? fyOf(prev.end) : fy)
            : 'Not shown: prior-year net interest income was not positive.');
      // A true net interest margin needs interest-earning assets, which almost
      // no filer tags. Without it the same flow is shown over average total
      // assets and labelled as that, never as NIM.
      const earning = num(r.interestEarningAssets);
      const nimBase = earning !== null ? average(earning, prev?.interestEarningAssets) : avgAssets;
      values.netInterestMarginPct = nimBase !== null ? pct(ratio(nii, nimBase)) : null;
      values.nimBasis = nimBase === null ? null : earning !== null ? 'interest-earning assets' : 'average total assets';
      if (values.netInterestMarginPct === null) why.netInterestMarginPct = nimBase === null ? opening('balance') : missing('net interest income', fy);
      const fees = num(r.nonInterestIncome), cost = num(r.nonInterestExpense);
      const revenue = nii !== null && fees !== null ? nii + fees : null;
      set('efficiencyPct', cost !== null && revenue !== null && revenue > 0 ? pct(cost / revenue) : null,
        cost === null ? missing('noninterest expense', fy) : fees === null ? missing('noninterest income', fy)
          : nii === null ? missing('net interest income', fy) : 'Not shown: net interest income plus noninterest income was not positive.');
      set('loansToDepositsPct', ratio(r.loans, r.deposits) !== null ? pct(ratio(r.loans, r.deposits)) : null,
        num(r.loans) === null ? missing('loans', fy) : num(r.deposits) === null ? missing('deposits', fy)
          : 'Not shown: deposits were not positive.');
      const provision = num(r.provisionForCreditLosses);
      set('provisionToLoansPct', provision !== null && avgLoans !== null && avgLoans > 0 ? pct(provision / avgLoans) : null,
        provision === null ? missing('provision for credit losses', fy)
          : avgLoans === null ? opening('loan balance') : 'Not shown: average loans were not positive.');
      set('roaPct', ni !== null && avgAssets !== null && avgAssets > 0 ? pct(ni / avgAssets) : null,
        ni === null ? missing('net income', fy) : avgAssets === null ? opening('total assets') : 'Not shown: average assets were not positive.');
      set('roePct', ni !== null && avgEquity !== null && avgEquity > 0 ? pct(ni / avgEquity) : null,
        ni === null ? missing('net income', fy) : avgEquity === null ? opening('shareholder equity') : 'Not shown: average equity was not positive.');
      set('equityToAssetsPct', ratio(r.totalShareholderEquity, r.totalAssets) !== null ? pct(ratio(r.totalShareholderEquity, r.totalAssets)) : null,
        num(r.totalShareholderEquity) === null ? missing('shareholder equity', fy) : num(r.totalAssets) === null ? missing('total assets', fy)
          : 'Not shown: total assets were not positive.');
      out.push({ fy, end: r.end, currency: r.currency || null, basis: r.basis || null, values, why });
    }
    return {
      kind: 'bank', label: 'Bank metrics', years: YEARS,
      sic: options.sic || null, insurerType: null, showCombinedRatio: false,
      rows: out.slice(-YEARS), latest: out[out.length - 1] || null,
      why: out.length ? null : 'Not available: no filed bank lines (net interest income, noninterest expense, loans or deposits) are in our data.'
    };
  }

  function buildInsurance(rows, options = {}) {
    const sic = options.sic || null;
    const all = rows.filter((r) => ['premiums', 'lossesAndLossAdjustmentExpense', 'netInvestmentIncome', 'investmentIncome', 'totalAssets']
      .some((f) => r[f] !== undefined));
    const pc = hasCombinedRatio(sic);
    const out = [];
    for (let i = 0; i < all.length; i += 1) {
      const r = all[i], prev = prevYear(all, i), fy = fyOf(r.end);
      const values = {}, why = {};
      const set = (key, value, reason) => { values[key] = value; if (value === null) why[key] = reason; };
      const premiums = num(r.premiums);
      set('premiumsEarned', premiums, missing('premiums earned', fy));
      set('premiumsGrowthPct', premiums !== null && prev && num(prev.premiums) > 0
        ? pct(premiums / prev.premiums - 1) : null,
        !prev ? `Not available: ${fy} has no filed year before it for a growth rate.`
          : num(prev.premiums) === null ? missing('prior-year premiums earned', prev ? fyOf(prev.end) : fy)
            : 'Not shown: prior-year premiums earned were not positive.');
      const losses = num(r.lossesAndLossAdjustmentExpense);
      const acquisition = num(r.policyAcquisitionExpense), other = num(r.otherUnderwritingExpense);
      const underwriting = acquisition !== null && other !== null ? acquisition + other : null;
      const notPc = `Not shown: ${insurerType(sic) === 'health' ? 'health' : 'life'} insurers do not report a combined ratio.`;
      set('lossRatioPct', pc && premiums !== null && losses !== null && premiums > 0 ? pct(losses / premiums) : null,
        !pc ? notPc : losses === null ? missing('losses and loss adjustment expense', fy) : premiums === null ? missing('premiums earned', fy)
          : 'Not shown: premiums earned were not positive.');
      set('expenseRatioPct', pc && premiums !== null && underwriting !== null && premiums > 0 ? pct(underwriting / premiums) : null,
        !pc ? notPc : acquisition === null ? missing('policy acquisition expense', fy) : other === null ? missing('other underwriting expense', fy)
          : premiums === null ? missing('premiums earned', fy) : 'Not shown: premiums earned were not positive.');
      set('combinedRatioPct', values.lossRatioPct !== null && values.expenseRatioPct !== null ? values.lossRatioPct + values.expenseRatioPct : null,
        !pc ? notPc : values.lossRatioPct === null ? (why.lossRatioPct || missing('loss ratio', fy))
          : why.expenseRatioPct || missing('expense ratio', fy));
      const nii = num(r.netInvestmentIncome) ?? num(r.investmentIncome);
      set('netInvestmentIncome', nii, missing('net investment income', fy));
      const ni = num(r.netIncome), avgEquity = average(r.totalShareholderEquity, prev?.totalShareholderEquity);
      set('roePct', ni !== null && avgEquity !== null && avgEquity > 0 ? pct(ni / avgEquity) : null,
        ni === null ? missing('net income', fy) : avgEquity === null ? opening('shareholder equity') : 'Not shown: average equity was not positive.');
      const shares = num(r.commonStockSharesOutstanding);
      const diluted = num(r.weightedAverageSharesDiluted);
      const perShare = num(r.totalShareholderEquity);
      const shareBasis = shares !== null ? 'year-end shares' : diluted !== null ? 'diluted weighted-average shares' : null;
      const shareCount = shares !== null ? shares : diluted;
      set('bookValuePerShare', perShare !== null && shareCount !== null && shareCount > 0 ? perShare / shareCount : null,
        perShare === null ? missing('shareholder equity', fy) : shareCount === null ? missing('share count', fy) : 'Not shown: the share count was not positive.');
      values.bookValueBasis = shareBasis;
      out.push({ fy, end: r.end, currency: r.currency || null, basis: r.basis || null, values, why });
    }
    return {
      kind: 'insurer', label: 'Insurance metrics', years: YEARS,
      sic, insurerType: insurerType(sic), showCombinedRatio: pc,
      rows: out.slice(-YEARS), latest: out[out.length - 1] || null,
      why: out.length ? null : 'Not available: no filed insurance lines (premiums, losses or investment income) are in our data.'
    };
  }

  function classify(data) {
    const sic = String(data?.coverage?.sic || data?.reportingSic || data?.coverage?.industry?.sic || '').trim();
    let kind = kindFromSic(sic);
    const archetype = data?.coverage?.industry?.archetype;
    if (!kind && archetype === 'bank') kind = 'bank';
    if (!kind && archetype === 'insurer') kind = 'insurer';
    // A bank that reports to its regulator instead of the SEC has no SIC in our
    // data; the FDIC call report's net interest income identifies it.
    if (!kind && (data?.supplementalObservations || []).some((f) => /^FDIC/.test(f.sourceName || '') && f.field === 'netInterestIncome')) kind = 'bank';
    return { kind, sic: sic || null, insurerType: insurerType(sic), showCombinedRatio: hasCombinedRatio(sic) };
  }

  // Free cash flow means nothing for a bank or a life insurer: loans, deposits
  // and policyholder balances run through operating cash flow. An insurer whose
  // filings carry no capital spending line has none either. Every FCF measure
  // (the SBC table, FCF margin, the reverse and forward DCF) is left out for
  // these rather than shown as missing (owner, 2026-10-19). Checked 2026-10-19
  // against S&P Global's statements on stockanalysis.com: JPM, WFC, MET, TRV
  // and CB carry no FCF row; PGR and UNH file capex and carry one, so they keep
  // FCF. Yahoo's JPM "free cash flow" is operating cash flow relabelled
  // (-$147.8B for 2025).
  const NO_FCF = 'Free cash flow is not shown for this company: for a bank or insurer, loans, deposits, premiums and claims run through operating cash flow, so free cash flow would not measure the cash the business generates.';
  function filesCapex(data) {
    // Filed values can arrive as numbers or numeric strings.
    return ((data?.cash?.annualReports) || []).some((r) => {
      const v = r.capitalExpenditures;
      return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    });
  }
  function hasNoFcf(data) {
    const c = classify(data);
    if (c.kind === 'bank') return true;
    return c.kind === 'insurer' && (c.insurerType === 'life' || !filesCapex(data));
  }

  // A metric with no value in any year shown is left out and named once,
  // never drawn as a row of dashes (TRV and CB file no other underwriting
  // expense, so they have no expense or combined ratio).
  function emptyKeys(m) {
    const rows = (m && m.rows) || [];
    if (!rows.length) return [];
    return Object.keys(rows[0].values || {}).filter((k) => rows.every((r) => r.values[k] === null || r.values[k] === undefined));
  }

  function build(data) {
    const c = classify(data);
    if (!c.kind) return null;
    const rows = collect(data);
    const built = c.kind === 'bank' ? buildBank(rows, c) : buildInsurance(rows, c);
    built.basis = rows.length ? (rows.some((r) => r.basis === 'FDIC') ? (rows.some((r) => r.basis === 'SEC') ? 'SEC and FDIC' : 'FDIC') : 'SEC') : null;
    return built;
  }

  return { build, classify, hasNoFcf, emptyKeys, NO_FCF, collect, buildBank, buildInsurance, kindFromSic, insurerType, hasCombinedRatio, fyOf, BANK_SIC, INSURER_SIC, YEARS };
});
