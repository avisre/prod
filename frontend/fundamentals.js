/* Fundamentals page controller */
(function(){
  function resolveApiUrl() {
    if (typeof window !== 'undefined' && typeof window.API_URL === 'string' && window.API_URL) {
      return window.API_URL;
    }
    try {
      if (typeof window === 'undefined' || !window.location) return '/api';
      const { protocol, hostname, port } = window.location;
      const localHost = hostname === 'localhost' || hostname === '127.0.0.1';
      if (protocol === 'file:') {
        return 'http://localhost:5000/api';
      }
      if (localHost) {
        return '/api';
      }
      return '/api';
    } catch (_) {
      return '/api';
    }
  }

  const API_URL = resolveApiUrl();
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const FX_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  const MAX_ANNUAL_COLUMNS = 6;
  const MAX_QUARTERLY_COLUMNS = 8;

  const $ = (id) => document.getElementById(id);
  const getQP = (k) => new URLSearchParams(location.search).get(k);
  const showLoader = () => {
    const el = $('loading-overlay');
    if (el) el.removeAttribute('hidden');
  };
  const hideLoader = () => {
    const el = $('loading-overlay');
    if (el) el.setAttribute('hidden', '');
  };

  const state = {
    symbol: null,
    data: null,
    priceRange: '1Y',
    priceMode: 'price',
    priceOverlays: new Set(['price']),
    basis: 'annual',
    unit: 'auto',
    activeTab: 'income'
  };

  const OVERLAY_COLORS = Object.freeze({
    price: '#3b82f6',
    pe: '#a855f7'
  });

  // Style #1: bright TradingView-like colors for bar charts on dark cards.
  const TV_BAR_COLORS = Object.freeze({
    revenue: '#2558D5',
    netIncome: '#00A66A',
    operating: '#089BC9',
    investing: '#9560CC',
    free: '#00BF73',
    assets: '#3B67D9',
    liabilities: '#CF8A1D',
    cash: '#00C685',
    netDebt: '#CF3F56',
    shares: '#C34ED2',
    negative: '#CF3F56'
  });

  const memoryCache = new Map();
  const fxRateCache = new Map();

  const TAB_CONFIG = {
    income: {
      field: 'income',
      caption: 'Income Statement',
      preferred: [
        'totalRevenue',
        'costOfRevenue',
        'grossProfit',
        'operatingExpenses',
        'operatingIncome',
        'ebit',
        'ebitda',
        'interestExpense',
        'incomeBeforeTax',
        'incomeTaxExpense',
        'netIncome',
        'netIncomeFromContinuingOperations',
        'comprehensiveIncomeNetOfTax',
        'eps',
        'dilutedEPS'
      ]
    },
    balance: {
      field: 'balance',
      caption: 'Balance Sheet',
      preferred: [
        'totalAssets',
        'totalCurrentAssets',
        'cashAndCashEquivalentsAtCarryingValue',
        'cashAndShortTermInvestments',
        'inventory',
        'propertyPlantEquipment',
        'goodwill',
        'totalLiabilities',
        'totalCurrentLiabilities',
        'shortTermDebt',
        'longTermDebt',
        'shortLongTermDebtTotal',
        'totalShareholderEquity',
        'retainedEarnings',
        'commonStockSharesOutstanding'
      ]
    },
    cash: {
      field: 'cash',
      caption: 'Cash Flow',
      preferred: [
        'operatingCashflow',
        'cashflowFromInvestment',
        'cashflowFromFinancing',
        'capitalExpenditures',
        'dividendPayout',
        'proceedsFromIssuanceOfCommonStock',
        'paymentsForRepurchaseOfCommonStock',
        'changeInCashAndCashEquivalents'
      ]
    }
  };

  function authHeaders() {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function isValidCurrencyCode(value) {
    return /^[A-Z]{3}$/.test(String(value || '').trim().toUpperCase());
  }

  function getActiveCurrencyCode(payload = null) {
    const source = payload || state.data || {};
    const inferred = inferCountryCurrencyBySymbol(state.symbol || source?.overview?.Symbol || '', source?.overview || {});
    return isValidCurrencyCode(inferred.currency) ? inferred.currency : 'USD';
  }

  function isPresentValue(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return false;
    const lower = text.toLowerCase();
    return lower !== 'none' && lower !== 'null' && lower !== 'n/a' && lower !== '-';
  }

  function copyIfBetter(target, source, key) {
    const current = target[key];
    const incoming = source[key];
    if (!isPresentValue(incoming)) return;
    if (!isPresentValue(current)) {
      target[key] = incoming;
      return;
    }
    if (String(incoming).length > String(current).length) {
      target[key] = incoming;
    }
  }

  function reportArrayScore(rows) {
    if (!Array.isArray(rows) || !rows.length) return 0;
    return rows.reduce((sum, row) => sum + Object.keys(row || {}).length, 0);
  }

  function mergeReportArrays(baseRows = [], incomingRows = []) {
    const out = new Map();
    const pushRow = (row, idx) => {
      if (!row || typeof row !== 'object') return;
      const key = String(row.fiscalDateEnding || row.reportedDate || `row_${idx}`);
      const existing = out.get(key) || {};
      const merged = { ...existing };
      Object.entries(row).forEach(([k, v]) => {
        if (!isPresentValue(merged[k]) && isPresentValue(v)) {
          merged[k] = v;
        } else if (!isPresentValue(merged[k])) {
          merged[k] = v;
        }
      });
      out.set(key, merged);
    };
    baseRows.forEach((row, idx) => pushRow(row, idx));
    incomingRows.forEach((row, idx) => pushRow(row, baseRows.length + idx));
    return Array.from(out.values()).sort((a, b) => new Date(a.fiscalDateEnding || 0) - new Date(b.fiscalDateEnding || 0));
  }

  function mergeStatementSection(baseSection = {}, incomingSection = {}) {
    const baseAnnual = Array.isArray(baseSection.annualReports) ? baseSection.annualReports : [];
    const baseQuarter = Array.isArray(baseSection.quarterlyReports) ? baseSection.quarterlyReports : [];
    const incomingAnnual = Array.isArray(incomingSection.annualReports) ? incomingSection.annualReports : [];
    const incomingQuarter = Array.isArray(incomingSection.quarterlyReports) ? incomingSection.quarterlyReports : [];
    return {
      annualReports: mergeReportArrays(baseAnnual, incomingAnnual),
      quarterlyReports: mergeReportArrays(baseQuarter, incomingQuarter)
    };
  }

  function chooseSeriesPayload(basePayload = {}, incomingPayload = {}, key) {
    const baseSeries = basePayload?.[key] && typeof basePayload[key] === 'object' ? basePayload[key] : {};
    const incomingSeries = incomingPayload?.[key] && typeof incomingPayload[key] === 'object' ? incomingPayload[key] : {};
    const baseCount = Object.keys(baseSeries).length;
    const incomingCount = Object.keys(incomingSeries).length;
    return incomingCount > baseCount ? incomingPayload : basePayload;
  }

  function mergeFundamentalsPayload(symbol, payloads = []) {
    const normalizedList = payloads
      .map((payload) => normalizeFundamentalsPayload(symbol, payload))
      .filter(Boolean);
    if (!normalizedList.length) return normalizeFundamentalsPayload(symbol, {});

    const merged = normalizeFundamentalsPayload(symbol, {});

    normalizedList.forEach((payload) => {
      const quote = payload.quote?.['Global Quote'] || {};
      const targetQuote = merged.quote['Global Quote'] || {};
      if (!isPresentValue(targetQuote['05. price']) && isPresentValue(quote['05. price'])) targetQuote['05. price'] = quote['05. price'];
      if (!isPresentValue(targetQuote['09. change']) && isPresentValue(quote['09. change'])) targetQuote['09. change'] = quote['09. change'];
      if (!isPresentValue(targetQuote['10. change percent']) && isPresentValue(quote['10. change percent'])) targetQuote['10. change percent'] = quote['10. change percent'];
      if (!isPresentValue(targetQuote['01. symbol']) && isPresentValue(quote['01. symbol'])) targetQuote['01. symbol'] = quote['01. symbol'];
      merged.quote['Global Quote'] = targetQuote;

      Object.keys(payload.overview || {}).forEach((key) => copyIfBetter(merged.overview, payload.overview, key));

      const bestDaily = chooseSeriesPayload(merged.daily, payload.daily, 'Time Series (Daily)');
      const bestMonthly = chooseSeriesPayload(merged.monthly, payload.monthly, 'Monthly Adjusted Time Series');
      merged.daily = bestDaily === payload.daily ? payload.daily : merged.daily;
      merged.monthly = bestMonthly === payload.monthly ? payload.monthly : merged.monthly;

      merged.income = mergeStatementSection(merged.income, payload.income);
      merged.balance = mergeStatementSection(merged.balance, payload.balance);
      merged.cash = mergeStatementSection(merged.cash, payload.cash);
    });

    return normalizeFundamentalsPayload(symbol, merged);
  }

  function parsePercentValue(text) {
    const raw = String(text || '').replace('%', '').trim();
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function formatCurrencyByCode(value, currencyCode = 'USD', maximumFractionDigits = 2) {
    if (!Number.isFinite(value)) return '-';
    const code = isValidCurrencyCode(currencyCode) ? currencyCode : 'USD';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: code,
        maximumFractionDigits
      }).format(value);
    } catch (_) {
      return `${code} ${value.toFixed(maximumFractionDigits)}`;
    }
  }

  function formatSignedCurrencyByCode(value, currencyCode = 'USD', maximumFractionDigits = 2) {
    if (!Number.isFinite(value)) return '-';
    return `${value >= 0 ? '+' : '-'}${formatCurrencyByCode(Math.abs(value), currencyCode, maximumFractionDigits)}`;
  }

  function formatCompactCurrencyByCode(value, currencyCode = 'USD') {
    if (!Number.isFinite(value)) return '-';
    const code = isValidCurrencyCode(currencyCode) ? currencyCode : 'USD';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: code,
        notation: 'compact',
        maximumFractionDigits: 2
      }).format(value);
    } catch (_) {
      return `${code} ${value.toFixed(2)}`;
    }
  }

  function toCompactMoney(value, currencyCode = 'USD') {
    if (!Number.isFinite(value)) return '-';
    const code = isValidCurrencyCode(currencyCode) ? currencyCode : 'USD';
    const abs = Math.abs(value);
    if (abs >= 1e12) return `${code} ${(value / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${code} ${(value / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${code} ${(value / 1e6).toFixed(2)}M`;
    return formatCurrencyByCode(value, code, 2);
  }

  function fxCacheKey(currencyCode) {
    return `fx_to_usd_v1_${String(currencyCode || '').toUpperCase()}`;
  }

  function loadFxRate(currencyCode) {
    const code = String(currencyCode || '').toUpperCase();
    const memory = fxRateCache.get(code);
    if (memory && Date.now() - memory.timestamp < FX_CACHE_TTL_MS) return memory.rate;
    try {
      const raw = localStorage.getItem(fxCacheKey(code));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Number.isFinite(parsed.rate) || !parsed.timestamp) return null;
      if (Date.now() - parsed.timestamp > FX_CACHE_TTL_MS) return null;
      fxRateCache.set(code, parsed);
      return parsed.rate;
    } catch (_) {
      return null;
    }
  }

  function storeFxRate(currencyCode, rate) {
    const code = String(currencyCode || '').toUpperCase();
    if (!Number.isFinite(rate) || rate <= 0) return;
    const payload = { rate, timestamp: Date.now() };
    fxRateCache.set(code, payload);
    try {
      localStorage.setItem(fxCacheKey(code), JSON.stringify(payload));
    } catch (_) {}
  }

  async function fetchFxRateToUsd(currencyCode) {
    const code = String(currencyCode || '').toUpperCase();
    if (!isValidCurrencyCode(code)) return null;
    if (code === 'USD') return 1;

    const cached = loadFxRate(code);
    if (Number.isFinite(cached) && cached > 0) return cached;

    const endpoints = [
      `https://api.frankfurter.app/latest?from=${encodeURIComponent(code)}&to=USD`,
      `https://open.er-api.com/v6/latest/${encodeURIComponent(code)}`
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, { cache: 'no-store' });
        if (!response.ok) continue;
        const payload = await response.json().catch(() => ({}));
        const rate = Number(payload?.rates?.USD);
        if (Number.isFinite(rate) && rate > 0) {
          storeFxRate(code, rate);
          return rate;
        }
      } catch (_) {}
    }
    return null;
  }

  function cacheKey(symbol) {
    return `fundamentals_cache_v8_${symbol}`;
  }

  function toAlphaNumericString(value) {
    return Number.isFinite(value) ? String(value) : '';
  }

  function inferCountryCurrencyBySymbol(symbol, overview = {}) {
    const upper = String(symbol || '').toUpperCase();
    const explicitCountry = String(overview?.Country || overview?.country || '').trim();
    const explicitCurrency = String(overview?.Currency || overview?.currency || '').trim().toUpperCase();
    if (explicitCountry || explicitCurrency) {
      return {
        country: explicitCountry || '-',
        currency: /^[A-Z]{3}$/.test(explicitCurrency) ? explicitCurrency : '-'
      };
    }
    if (upper.endsWith('.BSE') || upper.endsWith('.NS')) {
      return { country: 'India', currency: 'INR' };
    }
    return { country: '-', currency: '-' };
  }

  function toAlphaSymbol(symbol) {
    const upper = String(symbol || '').toUpperCase().trim();
    // Alpha Vantage uses hyphen for many US class-share symbols (e.g. BRK-B).
    if (/^[A-Z]+\.[A-Z]$/.test(upper)) return upper.replace('.', '-');
    return upper;
  }


  function normalizeFundamentalsPayload(symbol, payload, companyHint = null) {
    const out = payload && typeof payload === 'object' ? payload : {};
    out.quote = out.quote && typeof out.quote === 'object' ? out.quote : { 'Global Quote': {} };
    out.overview = out.overview && typeof out.overview === 'object' ? out.overview : {};
    out.daily = out.daily && typeof out.daily === 'object' ? out.daily : { 'Time Series (Daily)': {} };
    out.monthly = out.monthly && typeof out.monthly === 'object' ? out.monthly : { 'Monthly Adjusted Time Series': {} };
    out.income = out.income && typeof out.income === 'object' ? out.income : { annualReports: [], quarterlyReports: [] };
    out.balance = out.balance && typeof out.balance === 'object' ? out.balance : { annualReports: [], quarterlyReports: [] };
    out.cash = out.cash && typeof out.cash === 'object' ? out.cash : { annualReports: [], quarterlyReports: [] };

    const q = out.quote['Global Quote'] || {};
    q['01. symbol'] = q['01. symbol'] || symbol;
    out.quote['Global Quote'] = q;

    out.overview.Symbol = out.overview.Symbol || symbol;
    if (companyHint?.name) out.overview.Name = out.overview.Name || companyHint.name;
    if (companyHint?.sector) out.overview.Sector = out.overview.Sector || companyHint.sector;
    if (companyHint?.marketCap) out.overview.MarketCapitalization = out.overview.MarketCapitalization || toAlphaNumericString(parseNumber(companyHint.marketCap));
    if (companyHint?.peRatio) out.overview.PERatio = out.overview.PERatio || toAlphaNumericString(parseNumber(companyHint.peRatio));
    if (companyHint?.eps) out.overview.EPS = out.overview.EPS || toAlphaNumericString(parseNumber(companyHint.eps));

    const inferred = inferCountryCurrencyBySymbol(symbol, out.overview);
    out.overview.Country = out.overview.Country || (inferred.country !== '-' ? inferred.country : '');
    out.overview.Currency = out.overview.Currency || (inferred.currency !== '-' ? inferred.currency : '');

    out.income.annualReports = Array.isArray(out.income.annualReports) ? out.income.annualReports : [];
    out.income.quarterlyReports = Array.isArray(out.income.quarterlyReports) ? out.income.quarterlyReports : [];
    out.balance.annualReports = Array.isArray(out.balance.annualReports) ? out.balance.annualReports : [];
    out.balance.quarterlyReports = Array.isArray(out.balance.quarterlyReports) ? out.balance.quarterlyReports : [];
    out.cash.annualReports = Array.isArray(out.cash.annualReports) ? out.cash.annualReports : [];
    out.cash.quarterlyReports = Array.isArray(out.cash.quarterlyReports) ? out.cash.quarterlyReports : [];
    return out;
  }

  function hasFinancialStatementCoverage(payload) {
    const count = (rows) => (Array.isArray(rows) ? rows.length : 0);
    const hasIncome = count(payload?.income?.annualReports) > 0 || count(payload?.income?.quarterlyReports) > 0;
    const hasBalance = count(payload?.balance?.annualReports) > 0 || count(payload?.balance?.quarterlyReports) > 0;
    const hasCash = count(payload?.cash?.annualReports) > 0 || count(payload?.cash?.quarterlyReports) > 0;
    return hasIncome && hasBalance && hasCash;
  }

  function statementReportCount(payload, section) {
    const annual = Array.isArray(payload?.[section]?.annualReports) ? payload[section].annualReports.length : 0;
    const quarterly = Array.isArray(payload?.[section]?.quarterlyReports) ? payload[section].quarterlyReports.length : 0;
    return annual + quarterly;
  }

  function financialCoverageScore(payload) {
    const incomeCount = statementReportCount(payload, 'income');
    const balanceCount = statementReportCount(payload, 'balance');
    const cashCount = statementReportCount(payload, 'cash');
    const overviewScore = Object.keys(payload?.overview || {}).length ? 2 : 0;
    const quoteScore = payload?.quote?.['Global Quote']?.['05. price'] ? 1 : 0;
    return incomeCount + balanceCount + cashCount + overviewScore + quoteScore;
  }

  async function fetchFromApiSymbol(symbolForApi, symbolForNormalize) {
    const response = await fetch(`${API_URL}/alpha/fundamentals/${encodeURIComponent(symbolForApi)}`, {
      headers: authHeaders()
    });
    if (!response.ok) return null;
    const rawPayload = await response.json().catch(() => ({}));
    return normalizeFundamentalsPayload(symbolForNormalize, rawPayload);
  }

  function loadCached(symbol) {
    const key = symbol.toUpperCase();
    const inMemory = memoryCache.get(key);
    if (inMemory && Date.now() - inMemory.timestamp < CACHE_TTL_MS) {
      return inMemory.payload;
    }
    try {
      const raw = localStorage.getItem(cacheKey(key));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.timestamp || !parsed.payload) return null;
      if (Date.now() - parsed.timestamp > CACHE_TTL_MS) {
        localStorage.removeItem(cacheKey(key));
        return null;
      }
      memoryCache.set(key, parsed);
      return parsed.payload;
    } catch (_) {
      return null;
    }
  }

  function storeCached(symbol, payload) {
    const key = symbol.toUpperCase();
    const wrapped = { timestamp: Date.now(), payload };
    memoryCache.set(key, wrapped);
    try {
      localStorage.setItem(cacheKey(key), JSON.stringify(wrapped));
    } catch (_) {
      // storage quota can fail; memory cache still works
    }
  }

  async function fetchFundamentalsForSymbol(symbol) {
    const key = symbol.toUpperCase();
    const cached = loadCached(key);
    const cachedPayload = cached ? normalizeFundamentalsPayload(key, cached) : null;
    if (cachedPayload && hasFinancialStatementCoverage(cachedPayload)) {
      return cachedPayload;
    }

    // Backend proxies Alpha Vantage with a rate gate; we just call it.
    // Try the symbol and its Alpha-formatted variant (e.g. BRK.B -> BRK-B).
    const candidates = Array.from(new Set([key, toAlphaSymbol(key)].filter(Boolean)));
    const settled = await Promise.allSettled(
      candidates.map((candidate) => fetchFromApiSymbol(candidate, key))
    );

    let lastPayload = null;
    for (const result of settled) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const payload = result.value;
      lastPayload = payload;
      if (hasFinancialStatementCoverage(payload)) {
        storeCached(key, payload);
        return payload;
      }
    }

    if (lastPayload) {
      storeCached(key, lastPayload);
      return lastPayload;
    }
    if (cachedPayload) {
      return cachedPayload;
    }
    throw new Error('Unable to load fundamentals');
  }

  async function fetchFundamentals(symbol, extraSymbols = []) {
    const candidates = Array.from(new Set([
      symbol,
      ...(Array.isArray(extraSymbols) ? extraSymbols : [])
    ]
      .map((value) => String(value || '').trim().toUpperCase())
      .filter((value) => value && isLikelySymbol(value)))).slice(0, 8);

    // Fast path: when there's only the primary symbol, skip the merge/score work.
    if (candidates.length <= 1) {
      const only = candidates[0] || String(symbol || '').toUpperCase();
      const payload = await fetchFundamentalsForSymbol(only);
      return { symbol: only, payload };
    }

    // Multiple candidates run in parallel; settle then pick best by coverage score.
    const settled = await Promise.allSettled(
      candidates.map((candidate) => fetchFundamentalsForSymbol(candidate))
    );

    const payloadCandidates = [];
    let best = null;
    settled.forEach((result, idx) => {
      if (result.status !== 'fulfilled' || !result.value) return;
      const candidate = candidates[idx];
      const payload = result.value;
      const score = financialCoverageScore(payload);
      payloadCandidates.push({ symbol: candidate, payload, score });
      if (!best || score > best.score) {
        best = { symbol: candidate, payload, score };
      }
    });

    if (!payloadCandidates.length) {
      throw new Error('Unable to load fundamentals');
    }

    const mergedPayload = mergeFundamentalsPayload(
      best?.symbol || symbol,
      payloadCandidates.map((entry) => entry.payload)
    );
    const mergedScore = financialCoverageScore(mergedPayload);
    const finalSymbol = mergedScore >= (best?.score || 0)
      ? String(mergedPayload?.overview?.Symbol || mergedPayload?.quote?.['Global Quote']?.['01. symbol'] || best?.symbol || symbol).toUpperCase()
      : best.symbol;
    const finalPayload = mergedScore >= (best?.score || 0) ? mergedPayload : best.payload;

    if (finalSymbol) storeCached(finalSymbol, finalPayload);
    return { symbol: finalSymbol || symbol, payload: finalPayload };
  }

  function parseNumber(value) {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function toCompactCurrency(value) {
    if (!Number.isFinite(value)) return '-';
    const abs = Math.abs(value);
    if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }

  function formatPeriodLabel(period) {
    const value = String(period || '');
    const year = value.slice(0, 4);
    if (state.basis === 'annual') return year || value;
    const month = parseInt(value.slice(5, 7), 10);
    if (!Number.isFinite(month)) return year || value;
    const quarter = Math.floor((month - 1) / 3) + 1;
    return `Q${quarter} ${year}`;
  }

  function determineScale(values) {
    const list = values.filter((v) => Number.isFinite(v)).map((v) => Math.abs(v));
    const max = list.length ? Math.max(...list) : 0;
    if (state.unit === 'billion') return { divisor: 1e9, label: 'Billions' };
    if (state.unit === 'million') return { divisor: 1e6, label: 'Millions' };
    if (max >= 1e10) return { divisor: 1e9, label: 'Billions' };
    return { divisor: 1e6, label: 'Millions' };
  }

  function collectMetricValues(series, keys) {
    const rows = Array.isArray(series) ? series : [];
    const metricKeys = Array.isArray(keys) ? keys : [keys];
    const values = [];
    rows.forEach((row) => {
      metricKeys.forEach((key) => {
        const value = parseNumber(row?.[key]);
        if (Number.isFinite(value)) values.push(value);
      });
    });
    return values;
  }

  function formatScaledCurrency(value, scale) {
    if (!Number.isFinite(value)) return '-';
    const scaled = value / (scale.divisor || 1);
    const text = Math.abs(scaled).toLocaleString(undefined, { maximumFractionDigits: 2 });
    return scaled < 0 ? `($${text})` : `$${text}`;
  }

  function getChartCompression(scale) {
    const label = String(scale?.label || '').toLowerCase().startsWith('billion')
      ? 'Billions'
      : 'Millions';
    return {
      divisor: 1,
      suffix: '',
      unitLabel: `USD (${label})`
    };
  }

  function scaleAbbrev(scale) {
    const label = String(scale?.label || '').toLowerCase();
    return label.startsWith('billion') ? 'B' : 'M';
  }

  function formatScaledCurrencyCompact(value, scale) {
    if (!Number.isFinite(value)) return '-';
    const compression = getChartCompression(scale);
    const scaled = (value / (scale.divisor || 1)) / (compression.divisor || 1);
    const text = Math.abs(scaled).toLocaleString(undefined, { maximumFractionDigits: 2 });
    return `${scaled < 0 ? '-' : ''}${text}(${scaleAbbrev(scale)})`;
  }

  function formatScaledAxisTick(scaledValue, scale) {
    if (!Number.isFinite(scaledValue)) return '';
    const compression = getChartCompression(scale);
    const display = scaledValue / (compression.divisor || 1);
    const text = Math.abs(display).toLocaleString(undefined, { maximumFractionDigits: 2 });
    return `${display < 0 ? '-' : ''}${text}`;
  }

  function formatCurrency(value, currencyCode = getActiveCurrencyCode()) {
    return formatCurrencyByCode(value, currencyCode, 2);
  }

  function formatNumber(value, fractionDigits) {
    if (!Number.isFinite(value)) return '-';
    return value.toLocaleString(undefined, {
      maximumFractionDigits: Number.isFinite(fractionDigits) ? fractionDigits : 2
    });
  }

  function clamp01(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(1, num));
  }

  function tuneColor(color, lightnessDelta = 0, saturationDelta = 0) {
    const hsl = d3.hsl(String(color || '#3A7AFE'));
    if (!Number.isFinite(hsl.h)) return String(color || '#3A7AFE');
    hsl.l = clamp01(hsl.l + lightnessDelta);
    hsl.s = clamp01(hsl.s + saturationDelta);
    return hsl.formatHex();
  }

  function createBarGradient(defs, baseColor, idPrefix = 'barGrad') {
    const id = `${idPrefix}${Math.random().toString(36).slice(2, 9)}`;
    const gradient = defs.append('linearGradient')
      .attr('id', id)
      .attr('x1', '0')
      .attr('y1', '0')
      .attr('x2', '0')
      .attr('y2', '1');
    gradient.append('stop').attr('offset', '0%').attr('stop-color', tuneColor(baseColor, 0.1, 0.1));
    gradient.append('stop').attr('offset', '52%').attr('stop-color', tuneColor(baseColor, 0.02, 0.06));
    gradient.append('stop').attr('offset', '100%').attr('stop-color', tuneColor(baseColor, -0.1, 0.02));
    return `url(#${id})`;
  }

  function barStrokeColor(baseColor) {
    return tuneColor(baseColor, 0.2, 0.14);
  }

  function getChartTooltip() {
    let tooltip = document.getElementById('fundamentals-chart-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'fundamentals-chart-tooltip';
      tooltip.className = 'chart-tooltip';
      document.body.appendChild(tooltip);
    }
    return tooltip;
  }

  function hideChartTooltip() {
    const tooltip = document.getElementById('fundamentals-chart-tooltip');
    if (!tooltip) return;
    tooltip.style.opacity = '0';
    tooltip.style.transform = 'translate3d(0, 4px, 0)';
  }

  function enableHorizontalDragScroll(scrollWrap) {
    if (!scrollWrap || scrollWrap.dataset.dragScrollBound === '1') return;
    scrollWrap.dataset.dragScrollBound = '1';

    let isDragging = false;
    let pointerId = null;
    let startX = 0;
    let startScrollLeft = 0;

    const finishDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      scrollWrap.classList.remove('is-dragging');
      if (pointerId != null && typeof scrollWrap.releasePointerCapture === 'function') {
        try { scrollWrap.releasePointerCapture(pointerId); } catch (_) {}
      }
      pointerId = null;
    };

    scrollWrap.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      isDragging = true;
      pointerId = event.pointerId;
      startX = event.clientX;
      startScrollLeft = scrollWrap.scrollLeft;
      scrollWrap.classList.add('is-dragging');
      if (typeof scrollWrap.setPointerCapture === 'function') {
        try { scrollWrap.setPointerCapture(pointerId); } catch (_) {}
      }
    });

    scrollWrap.addEventListener('pointermove', (event) => {
      if (!isDragging) return;
      const deltaX = event.clientX - startX;
      scrollWrap.scrollLeft = startScrollLeft - deltaX;
      event.preventDefault();
    });

    scrollWrap.addEventListener('pointerup', finishDrag);
    scrollWrap.addEventListener('pointercancel', finishDrag);
    scrollWrap.addEventListener('mouseleave', () => {
      if (isDragging && pointerId == null) finishDrag();
    });
  }

  function showChartTooltip(event, lines) {
    const tooltip = getChartTooltip();
    const rows = Array.isArray(lines) ? lines.filter(Boolean) : [];
    if (!rows.length) {
      hideChartTooltip();
      return;
    }

    tooltip.innerHTML = rows.map((line, idx) => (
      idx === 0
        ? `<div class="tooltip-title">${line}</div>`
        : `<div class="tooltip-sub">${line}</div>`
    )).join('');
    tooltip.style.opacity = '1';
    tooltip.style.transform = 'translate3d(0, 0, 0)';

    const pad = 14;
    const rect = tooltip.getBoundingClientRect();
    let left = event.clientX + pad;
    let top = event.clientY + pad;
    if (left + rect.width + 8 > window.innerWidth) left = event.clientX - rect.width - pad;
    if (top + rect.height + 8 > window.innerHeight) top = event.clientY - rect.height - pad;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function normaliseQuote(quotePayload, symbol) {
    const quote = quotePayload?.['Global Quote'] || {};
    return {
      symbol: String(quote['01. symbol'] || symbol || '').toUpperCase(),
      price: parseNumber(quote['05. price']),
      change: parseNumber(quote['09. change']),
      changePercent: String(quote['10. change percent'] || '').trim()
    };
  }

  function parseSeries(dailyPayload, monthlyPayload) {
    const dailyRaw = dailyPayload?.['Time Series (Daily)'] || {};
    const monthlyRaw = monthlyPayload?.['Monthly Adjusted Time Series'] || {};
    const daily = Object.keys(dailyRaw).map((dateKey) => {
      const row = dailyRaw[dateKey];
      return {
        date: new Date(`${dateKey}T00:00:00`),
        close: parseNumber(row['5. adjusted close'] || row['4. close']),
        volume: parseNumber(row['6. volume'])
      };
    }).filter((row) => Number.isFinite(row.close)).sort((a, b) => a.date - b.date);

    const monthly = Object.keys(monthlyRaw).map((dateKey) => {
      const row = monthlyRaw[dateKey];
      return {
        date: new Date(`${dateKey}T00:00:00`),
        close: parseNumber(row['5. adjusted close'] || row['4. close']),
        volume: parseNumber(row['6. volume'])
      };
    }).filter((row) => Number.isFinite(row.close)).sort((a, b) => a.date - b.date);

    return { daily, monthly };
  }

  async function renderQuote(payload, overview, symbol, fallbackPrice) {
    const target = $('quote');
    if (!target) return;
    const quote = normaliseQuote(payload, symbol);
    const companyName = overview?.Name || quote.symbol || symbol;
    const price = Number.isFinite(quote.price) ? quote.price : (Number.isFinite(fallbackPrice) ? fallbackPrice : null);
    const change = quote.change;
    const changePctValue = parsePercentValue(quote.changePercent);
    const changePctText = Number.isFinite(changePctValue) ? `${changePctValue >= 0 ? '+' : ''}${changePctValue.toFixed(2)}%` : (quote.changePercent || '-');
    const changeClass = Number.isFinite(change) ? (change > 0 ? 'gain' : change < 0 ? 'loss' : 'flat') : 'flat';
    const countryCurrency = inferCountryCurrencyBySymbol(symbol, overview);
    const localCurrency = isValidCurrencyCode(countryCurrency.currency) ? countryCurrency.currency : 'USD';
    const fxToUsd = await fetchFxRateToUsd(localCurrency);
    const pe = parseNumber(overview?.PERatio);
    const eps = parseNumber(overview?.EPS);
    const marketCap = parseNumber(overview?.MarketCapitalization);
    const weekHigh = parseNumber(overview?.['52WeekHigh']);
    const weekLow = parseNumber(overview?.['52WeekLow']);
    const sector = overview?.Sector || '-';
    const industry = overview?.Industry || '-';

    const metrics = [
      {
        label: 'Company',
        value: `<span class="quote-company-name">${companyName}</span><span class="quote-company-symbol">${quote.symbol || symbol}</span>`
      },
      {
        label: `Price (${localCurrency})`,
        value: `<span class="quote-price-badge ${changeClass}">${Number.isFinite(price) ? formatCurrencyByCode(price, localCurrency) : '-'}</span>${Number.isFinite(change) ? `<span class="quote-change ${changeClass}">${formatSignedCurrencyByCode(change, localCurrency)} (${changePctText})</span>` : ''}`
      },
      { label: 'P/E', value: Number.isFinite(pe) ? pe.toFixed(2) : '-' },
      { label: 'EPS', value: Number.isFinite(eps) ? eps.toFixed(2) : '-' },
      { label: `Market Cap (${localCurrency})`, value: toCompactMoney(marketCap, localCurrency) },
      { label: `52W Range (${localCurrency})`, value: Number.isFinite(weekLow) && Number.isFinite(weekHigh) ? `${toCompactMoney(weekLow, localCurrency)} - ${toCompactMoney(weekHigh, localCurrency)}` : '-' },
      { label: 'Sector', value: sector },
      { label: 'Industry', value: industry }
    ];

    target.innerHTML = metrics.map((item) => `
      <div class="quote-metric">
        <div class="metric-label">${item.label}</div>
        <div class="metric-value">${item.value}</div>
      </div>
    `).join('');
  }

  function renderOverview(overview) {
    const target = $('ratios');
    if (!target) return;
    target.innerHTML = '';
    const currencyCode = getActiveCurrencyCode({ overview });

    const rows = [
      { label: 'Market Cap', value: toCompactMoney(parseNumber(overview?.MarketCapitalization), currencyCode) },
      { label: 'P/E', value: parseNumber(overview?.PERatio) },
      { label: 'EPS', value: parseNumber(overview?.EPS) },
      { label: 'ROE', value: parseNumber(overview?.ReturnOnEquityTTM), percent: true },
      { label: 'ROA', value: parseNumber(overview?.ReturnOnAssetsTTM), percent: true },
      { label: 'Debt/Equity', value: parseNumber(overview?.DebtToEquity || overview?.DEBTtoEquity) },
      { label: 'Profit Margin', value: parseNumber(overview?.ProfitMargin), percent: true },
      { label: 'Operating Margin', value: parseNumber(overview?.OperatingMarginTTM), percent: true }
    ];

    rows.forEach((row) => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      let output = '-';
      if (typeof row.value === 'string') {
        output = row.value;
      } else if (Number.isFinite(row.value)) {
        output = row.percent ? `${(row.value * 100).toFixed(2)}%` : row.value.toFixed(2);
      } else if (row.label === 'Market Cap') {
        output = row.value;
      }
      chip.innerHTML = `${row.label} <span class="sub">${output}</span>`;
      target.appendChild(chip);
    });
  }

  function getReports(dataSection) {
    const preferred = state.basis === 'quarterly'
      ? (dataSection?.quarterlyReports || [])
      : (dataSection?.annualReports || []);
    const fallback = state.basis === 'quarterly'
      ? (dataSection?.annualReports || [])
      : (dataSection?.quarterlyReports || []);
    const source = preferred.length ? preferred : fallback;
    const sorted = source
      .filter((row) => row && row.fiscalDateEnding)
      .slice()
      .sort((a, b) => new Date(a.fiscalDateEnding) - new Date(b.fiscalDateEnding));
    const count = state.basis === 'quarterly' ? MAX_QUARTERLY_COLUMNS : MAX_ANNUAL_COLUMNS;
    return sorted.slice(-count);
  }

  function buildPriceSeries(data, overview) {
    const { daily, monthly } = parseSeries(data.daily, data.monthly);
    const baseSeries = state.priceRange === 'MAX'
      ? (monthly.length ? monthly : daily)
      : (daily.length ? daily : monthly);
    if (!baseSeries.length) return [];
    const result = baseSeries.slice();
    const end = result[result.length - 1].date;
    const start = new Date(end);
    switch (state.priceRange) {
      case '1M': start.setMonth(start.getMonth() - 1); break;
      case '6M': start.setMonth(start.getMonth() - 6); break;
      case '1Y': start.setFullYear(start.getFullYear() - 1); break;
      case '3Y': start.setFullYear(start.getFullYear() - 3); break;
      case '5Y': start.setFullYear(start.getFullYear() - 5); break;
      case '10Y': start.setFullYear(start.getFullYear() - 10); break;
      case 'MAX': break;
      default: start.setFullYear(start.getFullYear() - 1);
    }
    let filtered = state.priceRange === 'MAX' ? result : result.filter((row) => row.date >= start);
    if (!filtered.length) filtered = result;
    if (state.priceMode === 'pe') {
      const eps = parseNumber(overview?.EPS);
      const safeEps = Number.isFinite(eps) && Math.abs(eps) > 1e-9 ? eps : 1;
      return filtered.map((row) => ({ date: row.date, value: row.close / safeEps }));
    }
    return filtered.map((row) => ({ date: row.date, value: row.close }));
  }

  function drawPriceChart(data, overview) {
    const container = d3.select('#price-chart');
    if (container.empty()) return;
    container.selectAll('*').remove();
    hideChartTooltip();

    const series = buildPriceSeries(data, overview);
    if (!series.length) {
      container.append('div').attr('class', 'chart-empty').text('No data');
      return;
    }

    const node = container.node();
    const bbox = node.getBoundingClientRect();
    const W = Math.max(320, Math.floor(bbox.width));
    const H = Math.max(260, Math.floor(bbox.height));
    // In price mode we render two axes (market-cap left, price right) so we
    // need extra room on both sides; in PE mode keep the simple single axis.
    const margin = state.priceMode === 'pe'
      ? { top: 24, right: 40, bottom: 50, left: 66 }
      : { top: 24, right: 84, bottom: 50, left: 92 };
    const width = W - margin.left - margin.right;
    const height = H - margin.top - margin.bottom;
    const svgRoot = container.append('svg')
      .attr('viewBox', `0 0 ${W} ${H}`)
      .style('width', '100%')
      .style('height', '100%');
    svgRoot.append('rect').attr('x', 0).attr('y', 0).attr('width', W).attr('height', H).attr('fill', '#0b1220');
    const svg = svgRoot.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3.scaleTime().domain(d3.extent(series, (d) => d.date)).range([0, width]);
    const values = series.map((d) => d.value).filter((v) => Number.isFinite(v));
    let [minVal, maxVal] = d3.extent(values);
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
      container.append('div').attr('class', 'chart-empty').text('No data');
      return;
    }
    if (minVal === maxVal) {
      const pad = Math.max(1, Math.abs(minVal) * 0.03 || 1);
      minVal -= pad;
      maxVal += pad;
    }
    const span = Math.max(1e-9, maxVal - minVal);
    minVal -= span * 0.1;
    maxVal += span * 0.1;
    if (state.priceMode !== 'pe') minVal = Math.max(0, minVal);

    const y = d3.scaleLinear().domain([minVal, maxVal]).nice().range([height, 0]);
    const yTicks = Math.min(8, Math.max(3, values.length));
    const strokeColor = state.priceMode === 'pe' ? OVERLAY_COLORS.pe : OVERLAY_COLORS.price;
    const areaId = `priceArea${Math.random().toString(36).slice(2, 8)}`;

    const defs = svgRoot.append('defs');
    const gradient = defs.append('linearGradient').attr('id', areaId).attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1');
    gradient.append('stop').attr('offset', '0%').attr('stop-color', strokeColor).attr('stop-opacity', 0.36);
    gradient.append('stop').attr('offset', '100%').attr('stop-color', strokeColor).attr('stop-opacity', 0);

    const grid = d3.axisLeft(y).ticks(yTicks).tickSize(-width).tickFormat('');
    const gridGroup = svg.append('g').attr('class', 'chart-grid').call(grid);
    gridGroup.selectAll('.tick line').attr('stroke', '#1e293b').attr('stroke-dasharray', '3,6');
    gridGroup.select('.domain').remove();

    const area = d3.area()
      .x((d) => x(d.date))
      .y0(height)
      .y1((d) => y(d.value))
      .curve(d3.curveMonotoneX);
    svg.append('path').datum(series).attr('fill', `url(#${areaId})`).attr('d', area);

    const line = d3.line()
      .x((d) => x(d.date))
      .y((d) => y(d.value))
      .curve(d3.curveMonotoneX);
    const path = svg.append('path')
      .datum(series)
      .attr('fill', 'none')
      .attr('stroke', strokeColor)
      .attr('stroke-width', 2.4)
      .attr('d', line);
    try {
      const length = path.node().getTotalLength();
      path.attr('stroke-dasharray', `${length},${length}`).attr('stroke-dashoffset', length)
        .transition().duration(550).attr('stroke-dashoffset', 0);
    } catch (_) {}


    const xAxis = d3.axisBottom(x).ticks(Math.max(3, Math.floor(width / 95))).tickFormat(d3.timeFormat('%b %Y'));
    const chartCurrency = getActiveCurrencyCode(data);

    const xAxisGroup = svg.append('g').attr('transform', `translate(0,${height})`).call(xAxis);
    xAxisGroup.selectAll('.tick text').attr('fill', '#94a3b8');
    xAxisGroup.selectAll('.tick line').attr('stroke', '#1e293b');
    xAxisGroup.select('.domain').attr('stroke', '#1e293b');

    if (state.priceMode === 'pe') {
      // P/E mode: single axis on the left, formatted as a multiple.
      const yAxisGroup = svg.append('g')
        .call(d3.axisLeft(y).ticks(yTicks).tickFormat((v) => `${d3.format('.2f')(v)}x`));
      yAxisGroup.selectAll('.tick text').attr('fill', '#e2e8f0');
      yAxisGroup.selectAll('.tick line').attr('stroke', 'transparent');
      yAxisGroup.select('.domain').attr('stroke', '#1e293b');
    } else {
      // Price mode: market cap on the LEFT axis, stock price on the RIGHT axis.
      const overviewMcap = parseNumber(overview?.MarketCapitalization);
      const quote = data?.quote?.['Global Quote'] || {};
      const currentPrice = parseNumber(quote['05. price']);
      const declaredShares = parseNumber(overview?.SharesOutstanding);
      let shares = Number.isFinite(declaredShares) && declaredShares > 0 ? declaredShares : null;
      if (!shares && Number.isFinite(overviewMcap) && Number.isFinite(currentPrice) && currentPrice > 0) {
        shares = overviewMcap / currentPrice;
      }

      // Right axis — stock price
      const priceAxis = svg.append('g')
        .attr('transform', `translate(${width},0)`)
        .call(d3.axisRight(y).ticks(yTicks).tickFormat((v) => formatCompactCurrencyByCode(v, chartCurrency)));
      priceAxis.selectAll('.tick text').attr('fill', '#e2e8f0');
      priceAxis.selectAll('.tick line').attr('stroke', 'transparent');
      priceAxis.select('.domain').attr('stroke', '#1e293b');

      // Right-axis title
      svg.append('text')
        .attr('transform', `translate(${width + 64},${height / 2}) rotate(90)`)
        .attr('text-anchor', 'middle')
        .attr('fill', '#94a3b8')
        .attr('font-size', 11)
        .attr('font-weight', 600)
        .text(`Stock Price (${chartCurrency})`);

      // Left axis — market cap (price tick × shares outstanding)
      const mcapFormatter = (priceTick) => {
        if (!Number.isFinite(shares)) return '';
        const mcap = priceTick * shares;
        if (!Number.isFinite(mcap)) return '';
        const abs = Math.abs(mcap);
        const sign = chartCurrency === 'USD' ? '$' : '';
        if (abs >= 1e12) return `${sign}${(mcap / 1e12).toFixed(2)}T`;
        if (abs >= 1e9) return `${sign}${(mcap / 1e9).toFixed(2)}B`;
        if (abs >= 1e6) return `${sign}${(mcap / 1e6).toFixed(2)}M`;
        return `${sign}${mcap.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      };
      const mcapAxis = svg.append('g')
        .call(d3.axisLeft(y).ticks(yTicks).tickFormat(mcapFormatter));
      mcapAxis.selectAll('.tick text').attr('fill', '#e2e8f0');
      mcapAxis.selectAll('.tick line').attr('stroke', 'transparent');
      mcapAxis.select('.domain').attr('stroke', '#1e293b');

      // Left-axis title
      svg.append('text')
        .attr('transform', `translate(${-margin.left + 18},${height / 2}) rotate(-90)`)
        .attr('text-anchor', 'middle')
        .attr('fill', '#94a3b8')
        .attr('font-size', 11)
        .attr('font-weight', 600)
        .text(`Market Cap (${chartCurrency})`);
    }

    const hoverLine = svg.append('line')
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,4')
      .style('display', 'none');

    const hoverDot = svg.append('circle')
      .attr('r', 4)
      .attr('fill', '#0b1220')
      .attr('stroke', strokeColor)
      .attr('stroke-width', 2)
      .style('display', 'none');

    const bisectDate = d3.bisector((row) => row.date).center;
    const hoverLabel = state.priceMode === 'pe' ? 'P/E Ratio' : 'Price';
    const dateFormatter = d3.timeFormat('%b %d, %Y');

    svg.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('mouseenter', () => {
        hoverLine.style('display', null);
        hoverDot.style('display', null);
      })
      .on('mousemove', (event) => {
        const [mx] = d3.pointer(event);
        const clampedX = Math.max(0, Math.min(width, mx));
        const date = x.invert(clampedX);
        const index = Math.max(0, Math.min(series.length - 1, bisectDate(series, date)));
        const point = series[index];
        if (!point) return;

        const xPos = x(point.date);
        const yPos = y(point.value);
        hoverLine.attr('x1', xPos).attr('x2', xPos).attr('y1', 0).attr('y2', height);
        hoverDot.attr('cx', xPos).attr('cy', yPos);

        const valueLabel = state.priceMode === 'pe'
          ? `${formatNumber(point.value, 2)}x`
          : formatCurrency(point.value, chartCurrency);
        showChartTooltip(event, [
          dateFormatter(point.date),
          `${hoverLabel}: ${valueLabel}`
        ]);
      })
      .on('mouseleave', () => {
        hoverLine.style('display', 'none');
        hoverDot.style('display', 'none');
        hideChartTooltip();
      });
  }

  function drawBarChart(selector, series, scale, color, unitLabel) {
    const container = d3.select(selector);
    if (!container.node()) return;
    container.selectAll('*').remove();
    hideChartTooltip();
    if (!series.length) {
      container.append('div').attr('class', 'chart-empty').text('No data');
      return;
    }

    const margin = { top: 20, right: 24, bottom: 52, left: 64 };

    const normalized = series.map((row) => {
      const raw = parseNumber(row.value);
      const hasValue = Number.isFinite(raw);
      return {
        period: row.period,
        raw,
        hasValue,
        value: hasValue ? raw / (scale.divisor || 1) : 0
      };
    });
    const values = normalized.map((row) => row.value).filter((_, idx) => normalized[idx].hasValue);
    if (!values.length) {
      container.selectAll('*').remove();
      container.append('div').attr('class', 'chart-empty').text('No data');
      return;
    }
    const host = container.node();
    const scrollWrap = host.parentElement && host.parentElement.classList.contains('chart-scroll-wrap')
      ? host.parentElement
      : host;
    enableHorizontalDragScroll(scrollWrap);
    const viewportWidth = Math.max(320, Math.floor(scrollWrap.clientWidth || host.clientWidth || host.getBoundingClientRect().width || 320));
    const perPeriodWidth = state.basis === 'quarterly' ? 110 : 72;
    const contentWidth = state.basis === 'quarterly'
      ? Math.max(viewportWidth, margin.left + margin.right + (normalized.length * perPeriodWidth))
      : viewportWidth;
    const W = Math.round(contentWidth);
    const H = Math.max(220, Math.floor(host.getBoundingClientRect().height || 220));
    const width = W - margin.left - margin.right;
    const height = H - margin.top - margin.bottom;

    const svgRoot = container.append('svg').attr('viewBox', `0 0 ${W} ${H}`).style('width', `${W}px`).style('height', '100%');
    const defs = svgRoot.append('defs');
    const positiveBarFill = createBarGradient(defs, color, 'singleBarPos');
    const negativeBarFill = createBarGradient(defs, TV_BAR_COLORS.negative, 'singleBarNeg');
    svgRoot.append('rect').attr('x', 0).attr('y', 0).attr('width', W).attr('height', H).attr('fill', '#0b1220');
    const svg = svgRoot.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand().domain(normalized.map((row) => row.period)).range([0, width]).padding(0.28);
    const y = d3.scaleLinear().domain([Math.min(0, d3.min(values) || 0), Math.max(0, d3.max(values) || 1)]).nice().range([height, 0]);
    const yTicks = Math.min(6, Math.max(3, values.length));

    const grid = d3.axisLeft(y).ticks(yTicks).tickSize(-width).tickFormat('');
    const gridGroup = svg.append('g').attr('class', 'chart-grid').call(grid);
    gridGroup.selectAll('.tick line').attr('stroke', '#1e293b').attr('stroke-dasharray', '3,6');
    gridGroup.select('.domain').remove();

    function roundedTopRectPath(xPos, yPos, barWidth, barHeight, radius) {
      const w = Math.max(0, Number(barWidth) || 0);
      const h = Math.max(0, Number(barHeight) || 0);
      if (!w || !h) return '';
      const x0 = Number(xPos) || 0;
      const y0 = Number(yPos) || 0;
      const r = Math.max(0, Math.min(Number(radius) || 0, w / 2, h));
      if (!r) return `M${x0},${y0 + h}L${x0},${y0}L${x0 + w},${y0}L${x0 + w},${y0 + h}Z`;
      return [
        `M${x0},${y0 + h}`,
        `L${x0},${y0 + r}`,
        `Q${x0},${y0} ${x0 + r},${y0}`,
        `L${x0 + w - r},${y0}`,
        `Q${x0 + w},${y0} ${x0 + w},${y0 + r}`,
        `L${x0 + w},${y0 + h}`,
        'Z'
      ].join(' ');
    }

    function barPath(row, valueY) {
      const xPos = x(row.period) || 0;
      const w = x.bandwidth();
      const zeroY = y(0);
      const topY = Math.min(zeroY, valueY);
      const bottomY = Math.max(zeroY, valueY);
      const h = Math.max(0, bottomY - topY);
      const r = Math.max(2, Math.min(6, Math.floor(w * 0.2), Math.floor(h)));
      return roundedTopRectPath(xPos, topY, w, h, r);
    }

    const bars = svg.selectAll('path.bar')
      .data(normalized)
      .enter()
      .append('path')
      .attr('class', 'bar')
      .attr('d', (row) => barPath(row, y(0)))
      .attr('fill', (row) => row.value < 0 ? negativeBarFill : positiveBarFill)
      .attr('stroke', (row) => row.value < 0 ? barStrokeColor(TV_BAR_COLORS.negative) : barStrokeColor(color))
      .attr('stroke-width', 1.1);

    bars.transition().duration(500)
      .attr('d', (row) => barPath(row, y(row.value)));

    const isSharesChart = /shares/i.test(String(unitLabel || ''));
    bars
      .on('mouseenter mousemove', function(event, row) {
        if (!row.hasValue) {
          hideChartTooltip();
          return;
        }
        d3.select(this).attr('opacity', 0.9);
        const primary = isSharesChart
          ? `Shares: ${formatNumber(row.raw, 0)}`
          : `Value: ${formatScaledCurrencyCompact(row.raw, scale)}`;
        const secondary = isSharesChart
          ? `Displayed: ${formatNumber(row.value, 2)}M`
          : `Unit: ${getChartCompression(scale).unitLabel}`;
        showChartTooltip(event, [
          formatPeriodLabel(row.period),
          primary,
          secondary
        ]);
      })
      .on('mouseleave', function() {
        d3.select(this).attr('opacity', 1);
        hideChartTooltip();
      });

    const xAxisGroup = svg.append('g').attr('transform', `translate(0,${height})`).call(d3.axisBottom(x).tickSizeOuter(0));
    xAxisGroup.selectAll('.tick text').attr('fill', '#94a3b8').text((d) => formatPeriodLabel(d));
    xAxisGroup.selectAll('.tick line').attr('stroke', '#1e293b');
    xAxisGroup.select('.domain').attr('stroke', '#1e293b');

    const yTickFormatter = isSharesChart
      ? ((v) => d3.format('~s')(v).replace('G', 'B'))
      : ((v) => formatScaledAxisTick(v, scale));
    const yAxisGroup = svg.append('g').call(d3.axisLeft(y).ticks(yTicks).tickFormat(yTickFormatter));
    yAxisGroup.selectAll('.tick text').attr('fill', '#94a3b8');
    yAxisGroup.selectAll('.tick line').attr('stroke', 'transparent');
    yAxisGroup.select('.domain').attr('stroke', '#1e293b');

    svgRoot.append('text')
      .attr('x', 14)
      .attr('y', margin.top + height / 2)
      .attr('transform', `rotate(-90,14,${margin.top + height / 2})`)
      .attr('text-anchor', 'middle')
      .attr('fill', '#64748b')
      .attr('font-size', '12px')
      .text(unitLabel || getChartCompression(scale).unitLabel);
  }

  function drawStackedBars(selector, series, keys) {
    const container = d3.select(selector);
    if (!container.node()) return;
    container.selectAll('*').remove();
    hideChartTooltip();
    if (!series.length) {
      container.append('div').attr('class', 'chart-empty').text('No data');
      return;
    }

    const margin = { top: 20, right: 24, bottom: 84, left: 64 };

    const allValues = [];
    series.forEach((row) => keys.forEach((key) => {
      const value = parseNumber(row[key]);
      if (Number.isFinite(value)) allValues.push(Math.abs(value));
    }));
    const scale = options.scale || determineScale(allValues);
    const divisor = scale.divisor || 1;
    const normalized = series.map((row) => {
      const out = { period: row.period };
      let totalRaw = 0;
      keys.forEach((key) => {
        const raw = parseNumber(row[key]);
        const safeRaw = Number.isFinite(raw) ? Math.max(0, raw) : 0;
        out[key] = safeRaw / divisor;
        out[`${key}Raw`] = safeRaw;
        totalRaw += safeRaw;
      });
      out.totalRaw = totalRaw;
      return out;
    });
    const totals = normalized.map((row) => keys.reduce((sum, key) => sum + (row[key] || 0), 0));
    const maxTotal = d3.max(totals) || 0;
    if (maxTotal <= 0) {
      container.selectAll('*').remove();
      container.append('div').attr('class', 'chart-empty').text('No data');
      return;
    }
    const host = container.node();
    const scrollWrap = host.parentElement && host.parentElement.classList.contains('chart-scroll-wrap')
      ? host.parentElement
      : host;
    enableHorizontalDragScroll(scrollWrap);
    const viewportWidth = Math.max(320, Math.floor(scrollWrap.clientWidth || host.clientWidth || host.getBoundingClientRect().width || 320));
    const perPeriodWidth = state.basis === 'quarterly' ? 116 : 74;
    const contentWidth = state.basis === 'quarterly'
      ? Math.max(viewportWidth, margin.left + margin.right + (normalized.length * perPeriodWidth))
      : viewportWidth;
    const W = Math.round(contentWidth);
    const H = Math.max(240, Math.floor(host.getBoundingClientRect().height || 240));
    const width = W - margin.left - margin.right;
    const height = H - margin.top - margin.bottom;

    const svgRoot = container.append('svg').attr('viewBox', `0 0 ${W} ${H}`).style('width', `${W}px`).style('height', '100%');
    const defs = svgRoot.append('defs');
    svgRoot.append('rect').attr('x', 0).attr('y', 0).attr('width', W).attr('height', H).attr('fill', '#0b1220');
    const svg = svgRoot.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand().domain(normalized.map((row) => row.period)).range([0, width]).padding(0.22);
    const y = d3.scaleLinear().domain([0, maxTotal || 1]).nice().range([height, 0]);

    const yTicks = Math.min(6, Math.max(3, normalized.length));
    const grid = d3.axisLeft(y).ticks(yTicks).tickSize(-width).tickFormat('');
    const gridGroup = svg.append('g').attr('class', 'chart-grid').call(grid);
    gridGroup.selectAll('.tick line').attr('stroke', '#1e293b').attr('stroke-dasharray', '3,6');
    gridGroup.select('.domain').remove();

    const palette = d3.scaleOrdinal().domain(keys).range([
      TV_BAR_COLORS.operating,
      TV_BAR_COLORS.investing,
      TV_BAR_COLORS.free,
      TV_BAR_COLORS.assets,
      TV_BAR_COLORS.liabilities,
      TV_BAR_COLORS.cash,
      TV_BAR_COLORS.netDebt
    ]);
    const fillForKey = new Map();
    const strokeForKey = new Map();
    keys.forEach((key, idx) => {
      const base = String(palette(key) || TV_BAR_COLORS.revenue);
      fillForKey.set(key, createBarGradient(defs, base, `stackBar${idx}`));
      strokeForKey.set(key, barStrokeColor(base));
    });
    const stack = d3.stack().keys(keys);
    const stacked = stack(normalized);

    const layers = svg.selectAll('g.layer').data(stacked).enter().append('g').attr('class', 'layer');
    const segments = layers.selectAll('rect')
      .data((layer) => layer.map((segment) => ({ key: layer.key, segment })))
      .enter()
      .append('rect')
      .attr('x', (row) => x(row.segment.data.period))
      .attr('width', x.bandwidth())
      .attr('y', y(0))
      .attr('height', 0)
      .attr('fill', (row) => fillForKey.get(row.key) || palette(row.key))
      .attr('stroke', (row) => strokeForKey.get(row.key) || barStrokeColor(palette(row.key)))
      .attr('stroke-width', 1);

    segments.transition().duration(500)
      .attr('y', (row) => y(row.segment[1]))
      .attr('height', (row) => Math.max(0, y(row.segment[0]) - y(row.segment[1])));

    segments
      .on('mouseenter mousemove', function(event, row) {
        const raw = row.segment.data[`${row.key}Raw`];
        const total = row.segment.data.totalRaw;
        d3.select(this).attr('opacity', 0.9);
        showChartTooltip(event, [
          formatPeriodLabel(row.segment.data.period),
          `${toLabel(row.key)}: ${formatScaledCurrencyCompact(raw, scale)}`,
          `Total: ${formatScaledCurrencyCompact(total, scale)}`
        ]);
      })
      .on('mouseleave', function() {
        d3.select(this).attr('opacity', 1);
        hideChartTooltip();
      });

    const xAxisGroup = svg.append('g').attr('transform', `translate(0,${height})`).call(d3.axisBottom(x));
    xAxisGroup.selectAll('.tick text').attr('fill', '#94a3b8').text((d) => formatPeriodLabel(d));
    xAxisGroup.selectAll('.tick line').attr('stroke', '#1e293b');
    xAxisGroup.select('.domain').attr('stroke', '#1e293b');

    const yAxisGroup = svg.append('g').call(d3.axisLeft(y).ticks(yTicks).tickFormat((v) => formatScaledAxisTick(v, scale)));
    yAxisGroup.selectAll('.tick text').attr('fill', '#94a3b8');
    yAxisGroup.selectAll('.tick line').attr('stroke', 'transparent');
    yAxisGroup.select('.domain').attr('stroke', '#1e293b');

    svgRoot.append('text')
      .attr('x', 14)
      .attr('y', margin.top + height / 2)
      .attr('transform', `rotate(-90,14,${margin.top + height / 2})`)
      .attr('text-anchor', 'middle')
      .attr('fill', '#64748b')
      .attr('font-size', '12px')
      .text(getChartCompression(scale).unitLabel);
  }

  // Grouped bars (side-by-side) for multi-metric comparisons in one card.
  function drawGroupedBars(selector, series, keys, options = {}) {
    const container = d3.select(selector);
    if (!container.node()) return;
    container.selectAll('*').remove();
    hideChartTooltip();
    if (!series.length) {
      container.append('div').attr('class', 'chart-empty').text('No data');
      return;
    }

    const margin = { top: 24, right: 24, bottom: 84, left: 64 };
    const allValues = [];
    series.forEach((row) => keys.forEach((key) => {
      const value = parseNumber(row[key]);
      if (Number.isFinite(value)) allValues.push(Math.abs(value));
    }));
    const scale = options.scale || determineScale(allValues);
    const divisor = scale.divisor || 1;

    const normalized = series.map((row) => {
      const out = { period: row.period };
      let netRaw = 0;
      keys.forEach((key) => {
        const raw = parseNumber(row[key]);
        const safeRaw = Number.isFinite(raw) ? raw : 0;
        out[key] = safeRaw / divisor;
        out[`${key}Raw`] = safeRaw;
        netRaw += safeRaw;
      });
      out.netRaw = netRaw;
      return out;
    });

    const values = normalized.flatMap((row) => keys.map((key) => row[key] || 0));
    if (!values.length) {
      container.append('div').attr('class', 'chart-empty').text('No data');
      return;
    }
    let minValue = Math.min(0, d3.min(values) || 0);
    let maxValue = Math.max(0, d3.max(values) || 0);
    if (minValue === maxValue) {
      const pad = Math.max(1, Math.abs(maxValue) * 0.1);
      minValue -= pad;
      maxValue += pad;
    }

    const host = container.node();
    const scrollWrap = host.parentElement && host.parentElement.classList.contains('chart-scroll-wrap')
      ? host.parentElement
      : host;
    enableHorizontalDragScroll(scrollWrap);
    const viewportWidth = Math.max(320, Math.floor(scrollWrap.clientWidth || host.clientWidth || host.getBoundingClientRect().width || 320));
    const perPeriodWidth = state.basis === 'quarterly' ? 118 : 98;
    const contentWidth = Math.max(viewportWidth, margin.left + margin.right + (normalized.length * perPeriodWidth));
    const W = Math.round(contentWidth);
    const H = Math.max(240, Math.floor(host.getBoundingClientRect().height || 240));
    const width = W - margin.left - margin.right;
    const height = H - margin.top - margin.bottom;

    const svgRoot = container.append('svg').attr('viewBox', `0 0 ${W} ${H}`).style('width', `${W}px`).style('height', '100%');
    const defs = svgRoot.append('defs');
    svgRoot.append('rect').attr('x', 0).attr('y', 0).attr('width', W).attr('height', H).attr('fill', '#0b1220');
    const svg = svgRoot.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand().domain(normalized.map((row) => row.period)).range([0, width]).padding(0.24);
    const xInner = d3.scaleBand().domain(keys).range([0, x.bandwidth()]).padding(0.18);
    const y = d3.scaleLinear().domain([minValue, maxValue]).nice().range([height, 0]);
    const yTicks = Math.min(6, Math.max(3, normalized.length));

    const grid = d3.axisLeft(y).ticks(yTicks).tickSize(-width).tickFormat('');
    const gridGroup = svg.append('g').attr('class', 'chart-grid').call(grid);
    gridGroup.selectAll('.tick line').attr('stroke', '#1e293b').attr('stroke-dasharray', '3,6');
    gridGroup.select('.domain').remove();

    const zeroY = y(0);

    const defaultColors = {
      operating: TV_BAR_COLORS.operating,
      investing: TV_BAR_COLORS.investing,
      free: TV_BAR_COLORS.free,
      assets: TV_BAR_COLORS.assets,
      liabilities: TV_BAR_COLORS.liabilities,
      cash: TV_BAR_COLORS.cash,
      netDebt: TV_BAR_COLORS.netDebt
    };
    const fallbackPalette = d3.scaleOrdinal().domain(keys).range([
      TV_BAR_COLORS.revenue,
      TV_BAR_COLORS.investing,
      TV_BAR_COLORS.free,
      TV_BAR_COLORS.operating,
      TV_BAR_COLORS.shares
    ]);
    const colorForKey = (key) => options.colors?.[key] || defaultColors[key] || fallbackPalette(key);
    const fillForKey = new Map();
    const strokeForKey = new Map();
    keys.forEach((key, idx) => {
      const base = String(colorForKey(key) || TV_BAR_COLORS.revenue);
      fillForKey.set(key, createBarGradient(defs, base, `groupBar${idx}`));
      strokeForKey.set(key, barStrokeColor(base));
    });

    const grouped = [];
    normalized.forEach((row) => {
      keys.forEach((key) => {
        grouped.push({
          period: row.period,
          key,
          value: row[key] || 0,
          raw: row[`${key}Raw`] || 0,
          netRaw: row.netRaw || 0
        });
      });
    });

    function roundedTopRectPath(xPos, yPos, barWidth, barHeight, radius) {
      const w = Math.max(0, Number(barWidth) || 0);
      const h = Math.max(0, Number(barHeight) || 0);
      if (!w || !h) return '';
      const x0 = Number(xPos) || 0;
      const y0 = Number(yPos) || 0;
      const r = Math.max(0, Math.min(Number(radius) || 0, w / 2, h));
      if (!r) return `M${x0},${y0 + h}L${x0},${y0}L${x0 + w},${y0}L${x0 + w},${y0 + h}Z`;
      return [
        `M${x0},${y0 + h}`,
        `L${x0},${y0 + r}`,
        `Q${x0},${y0} ${x0 + r},${y0}`,
        `L${x0 + w - r},${y0}`,
        `Q${x0 + w},${y0} ${x0 + w},${y0 + r}`,
        `L${x0 + w},${y0 + h}`,
        'Z'
      ].join(' ');
    }

    function groupedBarPath(row, valueY) {
      const xPos = (x(row.period) || 0) + (xInner(row.key) || 0);
      const w = Math.max(3, xInner.bandwidth());
      const topY = Math.min(zeroY, valueY);
      const bottomY = Math.max(zeroY, valueY);
      const h = Math.max(0, bottomY - topY);
      const r = Math.max(2, Math.min(5, Math.floor(w * 0.2), Math.floor(h)));
      return roundedTopRectPath(xPos, topY, w, h, r);
    }

    const bars = svg.selectAll('path.grouped-bar')
      .data(grouped)
      .enter()
      .append('path')
      .attr('class', 'grouped-bar')
      .attr('d', (row) => groupedBarPath(row, zeroY))
      .attr('fill', (row) => fillForKey.get(row.key) || colorForKey(row.key))
      .attr('stroke', (row) => strokeForKey.get(row.key) || barStrokeColor(colorForKey(row.key)))
      .attr('stroke-width', 1.1);

    bars.transition().duration(500)
      .attr('d', (row) => groupedBarPath(row, y(row.value)));

    bars
      .on('mouseenter mousemove', function(event, row) {
        d3.select(this).attr('opacity', 0.9);
        showChartTooltip(event, [
          formatPeriodLabel(row.period),
          `${toLabel(row.key)}: ${formatScaledCurrencyCompact(row.raw, scale)}`,
          `Net: ${formatScaledCurrencyCompact(row.netRaw, scale)}`
        ]);
      })
      .on('mouseleave', function() {
        d3.select(this).attr('opacity', 1);
        hideChartTooltip();
      });

    const xAxisGroup = svg.append('g').attr('transform', `translate(0,${height})`).call(d3.axisBottom(x));
    xAxisGroup.selectAll('.tick text').attr('fill', '#94a3b8').text((d) => formatPeriodLabel(d));
    xAxisGroup.selectAll('.tick line').attr('stroke', '#1e293b');
    xAxisGroup.select('.domain').attr('stroke', '#1e293b');

    const yAxisGroup = svg.append('g').call(d3.axisLeft(y).ticks(yTicks).tickFormat((v) => formatScaledAxisTick(v, scale)));
    yAxisGroup.selectAll('.tick text').attr('fill', '#94a3b8');
    yAxisGroup.selectAll('.tick line').attr('stroke', 'transparent');
    yAxisGroup.select('.domain').attr('stroke', '#1e293b');

    const legend = svgRoot.append('g').attr('transform', `translate(${margin.left},8)`);
    keys.forEach((key, idx) => {
      const gx = legend.append('g').attr('transform', `translate(${idx * 124},0)`);
      gx.append('rect').attr('x', 0).attr('y', 0).attr('width', 12).attr('height', 12).attr('rx', 2).attr('fill', colorForKey(key));
      gx.append('text').attr('x', 18).attr('y', 10).attr('fill', '#94a3b8').attr('font-size', '11px').text(toLabel(key));
    });

    svgRoot.append('text')
      .attr('x', 14)
      .attr('y', margin.top + height / 2)
      .attr('transform', `rotate(-90,14,${margin.top + height / 2})`)
      .attr('text-anchor', 'middle')
      .attr('fill', '#64748b')
      .attr('font-size', '12px')
      .text(getChartCompression(scale).unitLabel);
  }

  function renderCharts(data) {
    const income = getReports(data.income);
    const cash = getReports(data.cash);
    const balance = getReports(data.balance);

    const revenue = income.map((row) => ({ period: row.fiscalDateEnding, value: parseNumber(row.totalRevenue) }));
    const netIncome = income.map((row) => ({ period: row.fiscalDateEnding, value: parseNumber(row.netIncome) }));
    const cashFlow = cash.map((row) => ({
      period: row.fiscalDateEnding,
      operating: parseNumber(row.operatingCashflow),
      investing: parseNumber(row.cashflowFromInvestment),
      free: (parseNumber(row.operatingCashflow) || 0) + (parseNumber(row.capitalExpenditures) || 0)
    }));
    const balanceAL = balance.map((row) => ({
      period: row.fiscalDateEnding,
      assets: parseNumber(row.totalAssets)
        ?? parseNumber(row.totalAssetsNetMinorityInterest)
        ?? parseNumber(row.totalCurrentAssets),
      liabilities: parseNumber(row.totalLiabilities)
        ?? parseNumber(row.totalLiabilitiesNetMinorityInterest)
        ?? ((parseNumber(row.totalCurrentLiabilities) || 0) + (parseNumber(row.totalNonCurrentLiabilitiesNetMinorityInterest) || parseNumber(row.nonCurrentLiabilitiesTotal) || 0))
    }));
    const cashNet = balance.map((row) => {
      const cashOnHand = parseNumber(row.cashAndCashEquivalentsAtCarryingValue)
        ?? parseNumber(row.cashAndShortTermInvestments)
        ?? parseNumber(row.cashAndCashEquivalents);
      const debtTotal = parseNumber(row.shortLongTermDebtTotal)
        ?? ((parseNumber(row.longTermDebt) || 0) + (parseNumber(row.shortTermDebt) || 0));
      return {
        period: row.fiscalDateEnding,
        cash: cashOnHand,
        netDebt: Number.isFinite(debtTotal) ? debtTotal - (cashOnHand || 0) : null
      };
    });
    const shares = balance.map((row) => ({
      period: row.fiscalDateEnding,
      value: parseNumber(row.commonStockSharesOutstanding)
    }));

    const sharedMoneyScale = determineScale([
      ...collectMetricValues(revenue, 'value'),
      ...collectMetricValues(netIncome, 'value'),
      ...collectMetricValues(cashFlow, ['operating', 'investing', 'free']),
      ...collectMetricValues(balanceAL, ['assets', 'liabilities']),
      ...collectMetricValues(cashNet, ['cash', 'netDebt'])
    ]);

    drawBarChart('#rev-chart', revenue, sharedMoneyScale, TV_BAR_COLORS.revenue);
    drawBarChart('#ni-chart', netIncome, sharedMoneyScale, TV_BAR_COLORS.netIncome);
    drawGroupedBars('#ocf-chart', cashFlow, ['operating', 'investing', 'free'], {
      scale: sharedMoneyScale
    });
    drawGroupedBars('#balance-chart', balanceAL, ['assets', 'liabilities'], {
      scale: sharedMoneyScale,
      colors: { assets: TV_BAR_COLORS.assets, liabilities: TV_BAR_COLORS.liabilities }
    });
    drawGroupedBars('#cashnet-chart', cashNet, ['cash', 'netDebt'], {
      scale: sharedMoneyScale,
      colors: { cash: TV_BAR_COLORS.cash, netDebt: TV_BAR_COLORS.netDebt }
    });
    drawBarChart('#shares-chart', shares, { divisor: 1e6, label: 'Millions' }, TV_BAR_COLORS.shares, 'Shares (M)');
  }

  function toLabel(key) {
    const map = {
      ebitda: 'EBITDA',
      ebit: 'EBIT',
      eps: 'EPS',
      dilutedEPS: 'Diluted EPS',
      totalRevenue: 'Total Revenue',
      operatingIncome: 'Operating Income',
      netIncome: 'Net Income',
      operatingCashflow: 'Operating Cash Flow',
      cashflowFromInvestment: 'Cash Flow From Investment',
      cashflowFromFinancing: 'Cash Flow From Financing'
    };
    if (map[key]) return map[key];
    return String(key)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function renderTableHeader(periods, caption) {
    const thead = $('tbl-head');
    if (!thead) return;
    thead.innerHTML = `
      <tr class="fin-caption">
        <th class="fin-name">${caption}</th>
        ${periods.map(() => '<th></th>').join('')}
      </tr>
      <tr>
        <th>Metric</th>
        ${periods.map((period) => `<th>${period}</th>`).join('')}
      </tr>
    `;
  }

  function renderTableBody(rows) {
    const tbody = $('tbl-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      const metric = document.createElement('td');
      metric.className = 'fin-name';
      metric.textContent = row.label;
      tr.appendChild(metric);
      row.values.forEach((value) => {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function renderRatiosTable(overview) {
    const numericEntries = Object.entries(overview || {})
      .map(([key, value]) => [key, parseNumber(value)])
      .filter(([, value]) => Number.isFinite(value));
    renderTableHeader(['Value'], 'Overview Ratios');
    renderTableBody(numericEntries.map(([key, value]) => ({
      label: toLabel(key),
      values: [formatNumber(value, 4)]
    })));
  }

  function renderStatementTable(data) {
    if (state.activeTab === 'ratios') {
      renderRatiosTable(data.overview || {});
      return;
    }

    const config = TAB_CONFIG[state.activeTab];
    const reports = getReports(data[config.field]);
    if (!reports.length) {
      renderTableHeader([], `${config.caption} (No Data)`);
      renderTableBody([]);
      return;
    }

    const periods = reports.map((report) => formatPeriodLabel(report.fiscalDateEnding));
    const keySet = new Set();
    reports.forEach((report) => {
      Object.keys(report).forEach((key) => {
        if (key !== 'fiscalDateEnding' && key !== 'reportedCurrency') keySet.add(key);
      });
    });

    const preferredOrder = config.preferred || [];
    const preferredSet = new Set(preferredOrder);
    const extraKeys = Array.from(keySet).filter((key) => !preferredSet.has(key)).sort();
    const orderedKeys = Array.from(new Set([...preferredOrder, ...extraKeys]));
    // Row is "good enough" only if at least half the period cells carry a
    // real number. Filters out dead rows AND rows where only one of five
    // years has data (which renders as a wall of dashes with one number).
    const fillThreshold = Math.max(1, Math.ceil(reports.length / 2));
    const filledCount = (key) => reports.reduce((acc, report) => {
      const raw = report[key];
      if (raw === undefined || raw === null || raw === '') return acc;
      const num = parseNumber(raw);
      return (Number.isFinite(num) && num !== 0) ? acc + 1 : acc;
    }, 0);
    const visibleKeys = orderedKeys.filter((key) => filledCount(key) >= fillThreshold);

    const scaleCandidates = [];
    visibleKeys.forEach((key) => {
      reports.forEach((report) => {
        const value = parseNumber(report[key]);
        if (Number.isFinite(value)) scaleCandidates.push(value);
      });
    });
    const scale = determineScale(scaleCandidates);

    renderTableHeader(
      periods,
      `${config.caption} | ${state.basis === 'annual' ? 'Annual' : 'Quarterly'} | ${scale.label} of US $`
    );

    const rows = visibleKeys.map((key) => ({
      label: toLabel(key),
      values: reports.map((report) => formatScaledCurrency(parseNumber(report[key]), scale))
    }));
    renderTableBody(rows);
  }

  // ---- Price-chart summary above chart ----
  function renderPriceSummary(overview, quote, payload) {
    const priceEl = $('pc-price');
    const changeEl = $('pc-change');
    const mcapEl = $('pc-mcap');
    const peEl = $('pc-pe');
    const medPeEl = $('pc-median-pe');
    if (!priceEl || !mcapEl) return;

    const q = quote && quote['Global Quote'] ? quote['Global Quote'] : {};
    const price = parseNumber(q['05. price']);
    const change = parseNumber(q['09. change']);
    const pctRaw = String(q['10. change percent'] || '').replace('%', '').trim();
    const pct = parseNumber(pctRaw);
    const currency = isValidCurrencyCode(overview?.Currency) ? overview.Currency : 'USD';
    const marketCap = parseNumber(overview?.MarketCapitalization);
    const pe = parseNumber(overview?.PERatio);

    if (priceEl) {
      priceEl.textContent = Number.isFinite(price) ? formatCurrencyByCode(price, currency, 2) : '—';
    }
    if (changeEl) {
      if (Number.isFinite(change) && Number.isFinite(pct)) {
        const sign = change > 0 ? '+' : (change < 0 ? '−' : '');
        changeEl.textContent = `${sign}${Math.abs(change).toFixed(2)} (${sign}${Math.abs(pct).toFixed(2)}%)`;
        changeEl.classList.toggle('positive', change > 0);
        changeEl.classList.toggle('negative', change < 0);
      } else {
        changeEl.textContent = '';
      }
    }
    if (mcapEl) mcapEl.textContent = compactMoney(marketCap, currency);
    if (peEl) peEl.textContent = Number.isFinite(pe) ? pe.toFixed(2) : '—';

    // Median P/E proxy: median of (close / EPS) across the daily window
    if (medPeEl) {
      const series = parseSeries(payload?.daily, payload?.monthly);
      const closes = (series.daily.length ? series.daily : series.monthly).map((d) => d.close).filter(Number.isFinite);
      const eps = parseNumber(overview?.EPS);
      if (closes.length && Number.isFinite(eps) && eps > 0) {
        const ratios = closes.map((c) => c / eps).sort((a, b) => a - b);
        const median = ratios[Math.floor(ratios.length / 2)];
        medPeEl.textContent = Number.isFinite(median) ? median.toFixed(2) : '—';
      } else {
        medPeEl.textContent = '—';
      }
    }
  }

  // ---- Screener-style render helpers ----
  function renderScreenerHeader(symbol, overview, quote) {
    const nameEl = $('company-name');
    const symEl = $('company-symbol');
    const sectorEl = $('company-sector');
    const exchEl = $('company-exchange');
    const priceEl = $('quote-price');
    const changeEl = $('quote-change');
    const name = overview?.Name || symbol;
    if (nameEl) nameEl.textContent = name;
    if (symEl) symEl.textContent = symbol;
    if (sectorEl) sectorEl.textContent = overview?.Sector || overview?.Industry || 'Equity';
    if (exchEl) exchEl.textContent = overview?.Exchange || 'US Equity';

    const q = quote && quote['Global Quote'] ? quote['Global Quote'] : {};
    const price = parseNumber(q['05. price']);
    const change = parseNumber(q['09. change']);
    const pctRaw = String(q['10. change percent'] || '').replace('%', '').trim();
    const pct = parseNumber(pctRaw);
    const currency = isValidCurrencyCode(overview?.Currency) ? overview.Currency : 'USD';
    if (priceEl) {
      priceEl.textContent = Number.isFinite(price) ? formatCurrencyByCode(price, currency, 2) : '—';
    }
    if (changeEl) {
      if (Number.isFinite(change) && Number.isFinite(pct)) {
        const sign = change > 0 ? '+' : (change < 0 ? '−' : '');
        changeEl.textContent = `${sign}${Math.abs(change).toFixed(2)} (${sign}${Math.abs(pct).toFixed(2)}%)`;
        changeEl.classList.toggle('positive', change > 0);
        changeEl.classList.toggle('negative', change < 0);
      } else {
        changeEl.textContent = '';
      }
    }
  }

  function tileHTML(label, valueHTML, sub) {
    const subHTML = sub ? `<div class="scr-tile-sub">${sub}</div>` : '';
    return `
      <div class="scr-tile">
        <div class="scr-tile-label">${label}</div>
        <div class="scr-tile-value">${valueHTML || '—'}</div>
        ${subHTML}
      </div>
    `;
  }

  function compactMoney(value, currencyCode) {
    if (!Number.isFinite(value)) return '—';
    const symbol = currencyCode === 'USD' ? '$' : '';
    const abs = Math.abs(value);
    let suffix = '';
    let scaled = value;
    if (abs >= 1e12) { scaled = value / 1e12; suffix = ' T'; }
    else if (abs >= 1e9) { scaled = value / 1e9; suffix = ' B'; }
    else if (abs >= 1e6) { scaled = value / 1e6; suffix = ' M'; }
    return `${symbol}${scaled.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
  }

  function renderMetricTiles(overview, quote) {
    const host = $('metric-tiles');
    if (!host) return;
    const q = quote && quote['Global Quote'] ? quote['Global Quote'] : {};
    const currency = isValidCurrencyCode(overview?.Currency) ? overview.Currency : 'USD';
    const price = parseNumber(q['05. price']);
    const high = parseNumber(q['03. high']);
    const low = parseNumber(q['04. low']);
    const weekHigh = parseNumber(overview?.['52WeekHigh']);
    const weekLow = parseNumber(overview?.['52WeekLow']);
    const pe = parseNumber(overview?.PERatio);
    const pegRatio = parseNumber(overview?.PEGRatio);
    const eps = parseNumber(overview?.EPS);
    const bookValue = parseNumber(overview?.BookValue);
    const dividendYield = parseNumber(overview?.DividendYield);
    const roe = parseNumber(overview?.ReturnOnEquityTTM);
    const roa = parseNumber(overview?.ReturnOnAssetsTTM);
    const profitMargin = parseNumber(overview?.ProfitMargin);
    const operatingMargin = parseNumber(overview?.OperatingMarginTTM);
    const debtEq = parseNumber(overview?.DebtToEquity || overview?.DEBTtoEquity);
    const marketCap = parseNumber(overview?.MarketCapitalization);

    const fmtPct = (v, scale = 100) =>
      Number.isFinite(v) ? `${(v * scale).toFixed(2)}%` : '—';
    const fmtNum = (v, digits = 2) =>
      Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
    const fmtMoney = (v) =>
      Number.isFinite(v) ? formatCurrencyByCode(v, currency, 2) : '—';

    const tiles = [
      { label: 'Market Cap', value: compactMoney(marketCap, currency) },
      { label: 'Current Price', value: fmtMoney(price) },
      {
        label: 'High / Low',
        value: Number.isFinite(weekHigh) && Number.isFinite(weekLow)
          ? `${fmtMoney(weekHigh)} / ${fmtMoney(weekLow)}`
          : (Number.isFinite(high) && Number.isFinite(low) ? `${fmtMoney(high)} / ${fmtMoney(low)}` : '—')
      },
      { label: 'Stock P/E', value: fmtNum(pe) },
      { label: 'Book Value', value: fmtMoney(bookValue) },
      { label: 'Dividend Yield', value: fmtPct(dividendYield) },
      { label: 'ROCE', value: fmtPct(roa) },
      { label: 'ROE', value: fmtPct(roe) },
      { label: 'EPS', value: fmtMoney(eps) }
    ];

    host.innerHTML = tiles.map((t) => tileHTML(t.label, t.value)).join('');
  }

  function renderAbout(overview) {
    const section = $('about-section');
    const body = $('company-about');
    const tags = $('company-tags');
    const description = String(overview?.Description || '').trim();
    if (!description) {
      if (section) section.hidden = true;
      return;
    }
    if (section) section.hidden = false;
    if (body) body.textContent = description;
    if (tags) {
      tags.innerHTML = '';
      const labels = [overview?.Sector, overview?.Industry, overview?.Country, overview?.Exchange]
        .map((v) => String(v || '').trim())
        .filter(Boolean);
      labels.forEach((text) => {
        const t = document.createElement('span');
        t.className = 'scr-tag';
        t.textContent = text;
        tags.appendChild(t);
      });
    }
  }

  function renderProsCons(overview, payload) {
    const section = $('pros-cons-section');
    const prosUl = $('company-pros');
    const consUl = $('company-cons');
    if (!section || !prosUl || !consUl) return;

    const pros = [];
    const cons = [];
    const pe = parseNumber(overview?.PERatio);
    const roe = parseNumber(overview?.ReturnOnEquityTTM);
    const profitMargin = parseNumber(overview?.ProfitMargin);
    const debtEq = parseNumber(overview?.DebtToEquity || overview?.DEBTtoEquity);
    const dividendYield = parseNumber(overview?.DividendYield);
    const eps = parseNumber(overview?.EPS);

    if (Number.isFinite(roe) && roe > 0.15) pros.push(`Strong return on equity of ${(roe * 100).toFixed(1)}% (TTM).`);
    if (Number.isFinite(profitMargin) && profitMargin > 0.10) pros.push(`Healthy profit margin of ${(profitMargin * 100).toFixed(1)}%.`);
    if (Number.isFinite(debtEq) && debtEq < 0.5) pros.push('Low debt-to-equity ratio (well-capitalised balance sheet).');
    if (Number.isFinite(dividendYield) && dividendYield > 0.02) pros.push(`Dividend yield of ${(dividendYield * 100).toFixed(2)}%.`);

    // Revenue trend
    const annualIncome = Array.isArray(payload?.income?.annualReports) ? payload.income.annualReports.slice(0, 3) : [];
    if (annualIncome.length >= 2) {
      const newer = parseNumber(annualIncome[0]?.totalRevenue);
      const older = parseNumber(annualIncome[annualIncome.length - 1]?.totalRevenue);
      if (Number.isFinite(newer) && Number.isFinite(older) && older > 0) {
        const growth = ((newer - older) / older) * 100;
        if (growth > 8) pros.push(`Revenue grew ${growth.toFixed(1)}% over the last ${annualIncome.length} years.`);
        else if (growth < -3) cons.push(`Revenue declined ${Math.abs(growth).toFixed(1)}% over the last ${annualIncome.length} years.`);
      }
    }

    if (Number.isFinite(pe) && pe > 40) cons.push(`Stock trades at a high P/E of ${pe.toFixed(1)} — priced for growth.`);
    if (Number.isFinite(roe) && roe < 0.05 && roe > -1) cons.push(`Low return on equity of ${(roe * 100).toFixed(1)}%.`);
    if (Number.isFinite(profitMargin) && profitMargin < 0) cons.push(`Negative profit margin of ${(profitMargin * 100).toFixed(1)}%.`);
    if (Number.isFinite(debtEq) && debtEq > 2) cons.push(`Elevated debt-to-equity ratio of ${debtEq.toFixed(2)}.`);
    if (Number.isFinite(eps) && eps < 0) cons.push('Reported negative earnings per share.');

    if (!pros.length && !cons.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    prosUl.innerHTML = pros.length ? pros.map((t) => `<li>${t}</li>`).join('') : '<li>Awaiting more data to surface positive signals.</li>';
    consUl.innerHTML = cons.length ? cons.map((t) => `<li>${t}</li>`).join('') : '<li>No notable risk signals from current ratios.</li>';
  }

  function trackRecentSymbol(symbol, overview) {
    if (!symbol) return;
    try {
      const raw = localStorage.getItem('recentSymbols') || '[]';
      const list = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
      const upper = String(symbol).toUpperCase();
      const without = list.filter((entry) => (entry && entry.symbol) !== upper);
      const entry = {
        symbol: upper,
        name: String(overview?.Name || upper).slice(0, 40),
        viewedAt: Date.now()
      };
      const next = [entry, ...without].slice(0, 10);
      localStorage.setItem('recentSymbols', JSON.stringify(next));
    } catch (_) {}
  }

  // Fetches just GLOBAL_QUOTE — used to overlay a fresh price on top of
  // a locally-cached fundamentals payload (the static cache deliberately
  // skips quote so the bundled JSON file isn't stale by minutes).
  async function fetchLiveQuote(symbol) {
    try {
      const r = await fetch(`${API_URL}/alpha/quote/${encodeURIComponent(symbol)}`, { headers: authHeaders() });
      if (!r.ok) return null;
      const data = await r.json().catch(() => null);
      const price = data && data['Global Quote'] && data['Global Quote']['05. price'];
      return price ? data : null;
    } catch (_) { return null; }
  }

  async function renderPage(symbol, payload) {
    state.symbol = symbol.toUpperCase();
    state.data = payload;
    const overview = payload.overview || {};
    const fallbackSeries = parseSeries(payload.daily, payload.monthly);
    const fallbackPrice = (fallbackSeries.daily.length ? fallbackSeries.daily[fallbackSeries.daily.length - 1]?.close : null)
      ?? (fallbackSeries.monthly.length ? fallbackSeries.monthly[fallbackSeries.monthly.length - 1]?.close : null);

    // Persist for the news page's Recently Viewed widget.
    trackRecentSymbol(state.symbol, overview);

    // Screener-style top section
    renderScreenerHeader(state.symbol, overview, payload.quote);
    renderMetricTiles(overview, payload.quote);
    renderAbout(overview);
    renderProsCons(overview, payload);
    renderPriceSummary(overview, payload.quote, payload);

    // Keep the legacy renderers running so existing data hooks work too.
    await renderQuote(payload.quote, overview, state.symbol, fallbackPrice);
    renderOverview(overview);
    drawPriceChart(payload, overview);
    renderCharts(payload);
    renderStatementTable(payload);

    // If the cached payload has no live quote (e.g. came from the static
    // S&P 500 cache), fetch a fresh one in the background and patch.
    const cachedPrice = payload?.quote?.['Global Quote']?.['05. price'];
    if (!cachedPrice) {
      fetchLiveQuote(state.symbol).then((liveQuote) => {
        if (!liveQuote || state.symbol !== symbol.toUpperCase()) return;
        payload.quote = liveQuote;
        renderScreenerHeader(state.symbol, overview, liveQuote);
        renderMetricTiles(overview, liveQuote);
        renderPriceSummary(overview, liveQuote, payload);
        renderQuote(liveQuote, overview, state.symbol, fallbackPrice);
      }).catch(() => {});
    }
  }

  function syncToggles() {
    const setActive = (selector, attr, expected) => {
      document.querySelectorAll(selector).forEach((btn) => {
        const match = btn.dataset[attr] === expected;
        btn.classList.toggle('active', match);
        btn.classList.toggle('btn-primary', match);
      });
    };
    setActive('#price-range-controls .scr-toggle-btn, #price-range-controls .range', 'range', state.priceRange);
    setActive('#price-mode-controls .scr-toggle-btn, #price-mode-controls .range', 'mode', state.priceMode);
    setActive('#basis-controls .scr-toggle-btn, #basis-controls .range', 'basis', state.basis);
    setActive('#unit-controls .scr-toggle-btn, #unit-controls .range', 'unit', state.unit);
    document.querySelectorAll('.fin-tabs .tab, .fin-tabs .scr-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
    });
    document.querySelectorAll('#price-overlay-controls .scr-overlay-btn').forEach((btn) => {
      btn.classList.toggle('active', state.priceOverlays.has(btn.dataset.overlay));
    });
  }

  function parseInputSymbol(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    const match = value.match(/\(([^)]+)\)\s*$/);
    if (match) return match[1].trim().toUpperCase();
    return value.split(/[,\s]+/)[0].toUpperCase();
  }

  function isLikelySymbol(value) {
    return /^[A-Z][A-Z0-9.\-]{0,23}$/.test(String(value || '').trim().toUpperCase());
  }

  async function resolveInputSymbol(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;

    const parsed = parseInputSymbol(value);
    const looksTypedAsSymbol = /[.\-\d]/.test(value) || value === value.toUpperCase();
    const explicit = /\([^)]+\)\s*$/.test(value) || (value.indexOf(' ') === -1 && looksTypedAsSymbol);
    if (parsed && explicit && isLikelySymbol(parsed)) return parsed;

    if (window.SymbolLookup && typeof window.SymbolLookup.searchOne === 'function') {
      const matches = await window.SymbolLookup.searchOne(value).catch(() => []);
      if (Array.isArray(matches) && matches[0]?.symbol) {
        const resolved = String(matches[0].symbol).toUpperCase();
        if (isLikelySymbol(resolved)) return resolved;
      }
    }

    if (parsed && isLikelySymbol(parsed) && value.indexOf(' ') === -1 && looksTypedAsSymbol) return parsed;
    return null;
  }

  async function collectLookupCandidates(raw, resolvedSymbol) {
    const value = String(raw || '').trim();
    if (!value) return [];
    if (!window.SymbolLookup || typeof window.SymbolLookup.searchOne !== 'function') return [];

    const shouldLookupByName = value.indexOf(' ') !== -1
      || /\([^)]+\)\s*$/.test(value)
      || value.toUpperCase() !== String(resolvedSymbol || '').toUpperCase();
    if (!shouldLookupByName) return [];

    const matches = await window.SymbolLookup.searchOne(value).catch(() => []);
    if (!Array.isArray(matches)) return [];
    return matches
      .map((item) => String(item?.symbol || '').toUpperCase())
      .filter((sym) => sym && sym !== resolvedSymbol && isLikelySymbol(sym))
      .slice(0, 8);
  }

  async function loadSymbol(symbol) {
    const rawInput = String(symbol || '').trim();
    const key = await resolveInputSymbol(rawInput);
    if (!key) return;

    // Render cached fundamentals immediately so the page feels instant on revisit;
    // a fresh fetch then trickles in updated numbers.
    let renderedFromCache = false;
    const cachedRaw = loadCached(key);
    if (cachedRaw) {
      const cachedPayload = normalizeFundamentalsPayload(key, cachedRaw);
      try {
        await renderPage(key, cachedPayload);
        renderedFromCache = true;
        const cachedInput = $('symbol-input');
        if (cachedInput) cachedInput.value = key;
        const cachedQuery = new URLSearchParams(location.search);
        cachedQuery.set('symbol', key);
        history.replaceState({}, '', `${location.pathname}?${cachedQuery.toString()}`);
      } catch (_) {}
    }

    if (!renderedFromCache) showLoader();
    try {
      // Run name-based candidate lookup and the primary fetch in parallel —
      // SymbolLookup hits the network and used to add ~hundreds of ms before
      // we ever touched the fundamentals API.
      const [extraCandidates, primaryResult] = await Promise.all([
        collectLookupCandidates(rawInput, key).catch(() => []),
        fetchFundamentalsForSymbol(key).catch(() => null)
      ]);

      let result;
      if (primaryResult && (!extraCandidates || extraCandidates.length === 0)) {
        result = { symbol: key, payload: primaryResult };
      } else {
        result = await fetchFundamentals(key, extraCandidates || []);
      }

      const activeSymbol = result?.symbol || key;
      const payload = result?.payload || null;
      if (!payload) {
        if (renderedFromCache) return;
        throw new Error('Unable to load fundamentals');
      }

      await renderPage(activeSymbol, payload);
      const input = $('symbol-input');
      if (input) input.value = activeSymbol;
      const query = new URLSearchParams(location.search);
      query.set('symbol', activeSymbol);
      history.replaceState({}, '', `${location.pathname}?${query.toString()}`);
    } catch (error) {
      console.error('Fundamentals load failed:', error);
      if (renderedFromCache) return;
      const quote = $('quote');
      if (quote) quote.innerHTML = `<div class="quote-metric"><div class="metric-label">Error</div><div class="metric-value">${error.message || 'Unable to load fundamentals.'}</div></div>`;
    } finally {
      hideLoader();
    }
  }

  function bindControls() {
    const go = $('go-btn');
    const input = $('symbol-input');
    if (go) {
      go.addEventListener('click', () => loadSymbol(input?.value || getQP('symbol')));
    }
    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          go?.click();
        }
      });
    }

    const list = $('symbol-results');
    if (input && list) {
      let suggestions = [];
      const hideList = () => {
        list.style.display = 'none';
        list.innerHTML = '';
        suggestions = [];
      };
      const renderList = (items) => {
        suggestions = items;
        list.innerHTML = '';
        const fragment = document.createDocumentFragment();
        items.forEach((item, idx) => {
          const li = document.createElement('li');
          li.dataset.index = String(idx);
          li.textContent = `${item.name} (${item.symbol})`;
          fragment.appendChild(li);
        });
        list.appendChild(fragment);
        list.style.display = items.length ? 'block' : 'none';
      };

      input.addEventListener('input', async () => {
        const query = (input.value || '').trim();
        if (query.length < 2 || !window.SymbolLookup || typeof window.SymbolLookup.searchOne !== 'function') {
          hideList();
          return;
        }
        const items = await window.SymbolLookup.searchOne(query).catch(() => []);
        if (!items.length) {
          hideList();
          return;
        }
        renderList(items.slice(0, 8));
      });

      list.addEventListener('mousedown', (event) => {
        const itemNode = event.target.closest('li');
        if (!itemNode) return;
        event.preventDefault();
        const item = suggestions[Number(itemNode.dataset.index)];
        hideList();
        if (!item?.symbol) return;
        input.value = item.symbol;
        go?.click();
      });

      document.addEventListener('click', (event) => {
        if (event.target === input || list.contains(event.target)) return;
        hideList();
      });
    }

    document.querySelectorAll('#price-range-controls .scr-toggle-btn, #price-range-controls .range').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.priceRange = btn.dataset.range || '1Y';
        syncToggles();
        if (state.data) drawPriceChart(state.data, state.data.overview || {});
      });
    });

    document.querySelectorAll('#price-mode-controls .scr-toggle-btn, #price-mode-controls .range').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.priceMode = btn.dataset.mode || 'price';
        syncToggles();
        if (state.data) drawPriceChart(state.data, state.data.overview || {});
      });
    });

    document.querySelectorAll('#basis-controls .scr-toggle-btn, #basis-controls .range').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.basis = btn.dataset.basis || 'annual';
        syncToggles();
        if (state.data) {
          renderCharts(state.data);
          renderStatementTable(state.data);
        }
      });
    });

    document.querySelectorAll('#unit-controls .scr-toggle-btn, #unit-controls .range').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.unit = btn.dataset.unit || 'auto';
        syncToggles();
        if (state.data) {
          renderCharts(state.data);
          renderStatementTable(state.data);
        }
      });
    });

    document.querySelectorAll('.fin-tabs .tab, .fin-tabs .scr-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.dataset.tab || 'income';
        syncToggles();
        if (state.data) renderStatementTable(state.data);
      });
    });

    document.querySelectorAll('#price-overlay-controls .scr-overlay-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.overlay;
        if (!key) return;
        // Two simple modes: price (with market-cap dual axis) and PE.
        state.priceMode = key === 'pe' ? 'pe' : 'price';
        state.priceOverlays = new Set([state.priceMode]);
        syncToggles();
        if (state.data) drawPriceChart(state.data, state.data.overview || {});
      });
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindControls();
    syncToggles();
    const symbolFromQuery = parseInputSymbol(getQP('symbol'));
    if (symbolFromQuery) {
      const input = $('symbol-input');
      if (input) input.value = symbolFromQuery;
      await loadSymbol(symbolFromQuery);
    }
  });
})();
