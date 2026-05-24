const PROD_API_URL = 'https://www.stockportfolio.pro/api';
const LOCAL_API_URL = 'http://localhost:5000/api';
const PROD_HOST_PATTERN = /(^|\.)stockportfolio\.pro$/i;
const SHARED_TOKEN_COOKIE = 'sp_token';

function resolveApiUrl() {
  try {
    if (typeof window === 'undefined' || !window.location) return '/api';
    const { protocol, hostname } = window.location;
    const localHost = hostname === 'localhost' || hostname === '127.0.0.1';
    if (protocol === 'file:') {
      return LOCAL_API_URL;
    }
    if (localHost) {
      return '/api';
    }
    if (PROD_HOST_PATTERN.test(hostname)) {
      return PROD_API_URL;
    }
    return '/api';
  } catch (_) {
    return '/api';
  }
}

function readCookie(name) {
  if (typeof document === 'undefined') return '';
  try {
    const prefix = `${name}=`;
    const cookies = document.cookie ? document.cookie.split(';') : [];
    for (const part of cookies) {
      const item = part.trim();
      if (item.startsWith(prefix)) {
        return decodeURIComponent(item.slice(prefix.length));
      }
    }
  } catch (_) {}
  return '';
}

function writeTokenCookie(token) {
  if (typeof document === 'undefined' || !token) return;
  const encoded = encodeURIComponent(String(token));
  const maxAge = 60 * 60 * 24 * 30;
  try {
    const isHttps = typeof location !== 'undefined' && location.protocol === 'https:';
    const isProdHost = typeof location !== 'undefined' && PROD_HOST_PATTERN.test(location.hostname);
    if (isHttps && isProdHost) {
      document.cookie = `${SHARED_TOKEN_COOKIE}=${encoded}; Max-Age=${maxAge}; Path=/; Domain=.stockportfolio.pro; Secure; SameSite=Lax`;
      return;
    }
    document.cookie = `${SHARED_TOKEN_COOKIE}=${encoded}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
  } catch (_) {}
}

function persistToken(token) {
  const value = String(token || '').trim();
  if (!value) return '';
  try { localStorage.setItem('token', value); } catch (_) {}
  writeTokenCookie(value);
  return value;
}

const API_URL = (typeof window !== 'undefined' && typeof window.API_URL === 'string' && window.API_URL)
  ? window.API_URL
  : resolveApiUrl();
if (typeof window !== 'undefined') {
  window.API_URL = API_URL;
}
let STRIPE_PUBLISHABLE_KEY = 'pk_test_replace_with_real_key';
const CHANGE_PASSWORD_POLICY_MESSAGE =
  'New password must be at least 8 characters and include uppercase, lowercase, and a number.';

function getPasswordPolicyStateForChange(password) {
  const value = typeof password === 'string' ? password : '';
  return {
    minLength: value.length >= 8,
    hasUppercase: /[A-Z]/.test(value),
    hasLowercase: /[a-z]/.test(value),
    hasNumber: /\d/.test(value),
  };
}

function passwordMeetsPolicyForChange(password) {
  const state = getPasswordPolicyStateForChange(password);
  return state.minLength && state.hasUppercase && state.hasLowercase && state.hasNumber;
}

function updateChangePasswordHints(password) {
  const rulesList = document.getElementById('cp-password-rules');
  if (!rulesList) return;
  const state = getPasswordPolicyStateForChange(password || '');
  const items = rulesList.querySelectorAll('.password-rule');
  items.forEach((item) => {
    const rule = item.dataset.rule;
    let isMet = false;
    if (rule === 'length') isMet = state.minLength;
    else if (rule === 'uppercase') isMet = state.hasUppercase;
    else if (rule === 'lowercase') isMet = state.hasLowercase;
    else if (rule === 'number') isMet = state.hasNumber;
    item.classList.toggle('valid', !!isMet);
    item.classList.toggle('invalid', !isMet && (password || '').length > 0);
  });
}

async function initiateStripeCheckout(email) {
  if (typeof Stripe !== 'function') {
    throw new Error('Stripe.js not loaded');
  }
  const resp = await fetch(`${API_URL}/stripe/create-checkout-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.message || 'Unable to start checkout');
  }
  const payload = await resp.json();
  if (!payload.sessionId) {
    throw new Error('Missing Stripe session ID from backend');
  }
  const stripe = Stripe(STRIPE_PUBLISHABLE_KEY);
  const { error } = await stripe.redirectToCheckout({ sessionId: payload.sessionId });
  if (error) throw error;
}
// (auth gating removed – original behavior)
const PAGE_NAME = (() => {
  const raw = location.pathname.split('/').filter(Boolean).pop();
  return raw ? raw.toLowerCase() : 'index.html';
})();
const RESTRICTED_PAGES = new Set(['dashboard.html', 'fundamentals.html', 'news.html']);
// Demo pages are publicly accessible read-only previews — they must never
// be auth-gated regardless of which path the user lands on.
const DEMO_PAGES = new Set(['demo-dashboard.html', 'demo-fundamentals.html']);
const IS_DEMO_PAGE = DEMO_PAGES.has(PAGE_NAME) ||
  /^\/demo(\/|$)/.test(location.pathname) ||
  (typeof window !== 'undefined' && window.__DEMO_MODE === true);

const getToken = () => {
  const fromStorage = localStorage.getItem('token');
  if (fromStorage) return fromStorage;
  const fromCookie = readCookie(SHARED_TOKEN_COOKIE);
  if (fromCookie) {
    try { localStorage.setItem('token', fromCookie); } catch (_) {}
    return fromCookie;
  }
  return '';
};

if (!IS_DEMO_PAGE && RESTRICTED_PAGES.has(PAGE_NAME) && !getToken()) {
  const next = PAGE_NAME + (location.search || '');
  window.location.replace(`login.html?next=${encodeURIComponent(next)}`);
}

function configureNavAuthState() {
  const authed = Boolean(getToken());
  document.querySelectorAll('a[data-guarded]').forEach(link => {
    const original = link.dataset.originalHref || link.getAttribute('href');
    link.dataset.originalHref = original;
    if (!authed) {
      const next = original.replace(/^\/+/, '');
      link.setAttribute('href', `login.html?next=${encodeURIComponent(next)}`);
    } else {
      link.setAttribute('href', link.dataset.originalHref);
    }
  });

  document.querySelectorAll('[data-show-when]').forEach(el => {
    const mode = el.dataset.showWhen;
    if (mode === 'authed') {
      el.style.display = authed ? '' : 'none';
    } else if (mode === 'guest') {
      el.style.display = authed ? 'none' : '';
    }
  });
}

document.addEventListener('DOMContentLoaded', configureNavAuthState);
window.addEventListener('storage', (evt) => {
  if (evt.key === 'token') configureNavAuthState();
});
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('toggle-headings');
  if (btn) {
    btn.addEventListener('click', () => {
      const nextState = !document.body.classList.contains('show-menu');
      document.body.classList.toggle('show-menu', nextState);
      document.body.classList.toggle('show-headings', nextState);
      btn.setAttribute('aria-expanded', nextState ? 'true' : 'false');
    });
  }
  // Light, friendly blink on cartoon stickers (replacing question marks)
  try {
    document.querySelectorAll('.sticker.face').forEach((el, idx) => {
      const delay = 500 + (idx * 300) + Math.random() * 1500;
      setTimeout(() => el.classList.add('blink'), delay);
    });
  } catch (_) {}

  // Normalise any corrupted sticker/cartoon glyphs into real icons
  try {
    normaliseStickerAndCartoonIcons();
  } catch (_) {}
});

function normaliseStickerAndCartoonIcons() {
  // Navigation pills (landing + app pages)
  const navIconMap = {
    Subscribe: '🚀',
    Support: '💬',
    Login: '🔐',
    Dashboard: '📊',
    Fundamentals: '📈',
    News: '📰',
    Exit: '🚪',
  };

  document.querySelectorAll('.navbar .nav-actions .btn').forEach((btn) => {
    const iconSpan = btn.querySelector('.sticker');
    if (!iconSpan) return;
    const labelNode = Array.from(btn.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
    );
    const label = (labelNode ? labelNode.textContent : btn.textContent).trim();
    const icon = navIconMap[label];
    if (icon) iconSpan.textContent = icon;
  });

  // Helper to update heading icons based on their label text
  function applyHeadingIcons(selector, iconMap) {
    document.querySelectorAll(selector).forEach((h) => {
      const iconSpan = h.querySelector('.sticker');
      if (!iconSpan) return;
      let labelText = '';
      const sibling = iconSpan.nextSibling;
      if (sibling && sibling.nodeType === Node.TEXT_NODE) {
        labelText = sibling.textContent.trim();
      } else {
        labelText = h.textContent.trim();
      }
      const icon = iconMap[labelText];
      if (icon) iconSpan.textContent = icon;
    });
  }

  // Dashboard cards
  applyHeadingIcons('#add-stock-card h3', {
    'Add Stock': '➕',
  });

  applyHeadingIcons('#charts-row .card h3', {
    'Portfolio Value': '📈',
    Allocation: '🧩',
  });

  applyHeadingIcons('.table-card > h3', {
    Holdings: '📊',
  });

  // Fundamentals cards
  applyHeadingIcons('#fundamentals-search-card h3', {
    'Find a Stock': '🔎',
  });

  applyHeadingIcons('.container .card h3', {
    Quote: '💬',
    Price: '💲',
    'Overview & Charts': '📊',
    Revenue: '💵',
    'Net Income': '📈',
    'Operating Cash Flow': '💧',
    'Assets / Liabilities': '⚖️',
    'Cash on Hand / Net Debt': '💰',
    'Shares Outstanding': '🧮',
  });
}

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const numberFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const currencyFormatterCache = new Map();
const ARROW_UP = '^';
const ARROW_DOWN = 'v';
const ARROW_FLAT = '-';
const getSharedTooltip = (() => {
  let tooltipEl = null;
  return () => {
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'chart-tooltip';
      tooltipEl.setAttribute('role', 'status');
      tooltipEl.classList.remove('show');
      (document.body || document.documentElement).appendChild(tooltipEl);
    }
    return tooltipEl;
  };
})();
const SYMBOL_TONES = {
  AAPL: { label: 'Tech', tone: 'tech' },
  MSFT: { label: 'Tech', tone: 'tech' },
  TSLA: { label: 'Auto', tone: 'auto' },
  RIVN: { label: 'Auto', tone: 'auto' },
  PFE: { label: 'Health', tone: 'health' },
  AMZN: { label: 'Commerce', tone: 'commerce' },
  GOOGL: { label: 'Tech', tone: 'tech' },
  NVDA: { label: 'Tech', tone: 'tech' },
};
const SECTOR_TONES = [
  { match: ['technology','information technology'], label:'Tech', tone:'tech' },
  { match: ['healthcare','health care','health'], label:'Health', tone:'health' },
  { match: ['consumer cyclical','consumer defensive','consumer discretionary'], label:'Consumer', tone:'commerce' },
  { match: ['financial services','financial','finance'], label:'Finance', tone:'finance' },
  { match: ['industrials','industrial'], label:'Industrials', tone:'industrial' },
  { match: ['communication services','communications'], label:'Comm', tone:'communications' },
  { match: ['energy'], label:'Energy', tone:'energy' },
  { match: ['real estate'], label:'Real Estate', tone:'realestate' },
  { match: ['utilities','utility'], label:'Utility', tone:'utility' },
  { match: ['basic materials','materials'], label:'Materials', tone:'materials' },
  { match: ['automotive','auto manufacturers'], label:'Auto', tone:'auto' }
];

function getSectorMeta(symbol, sector) {
  if (sector) {
    const normalized = sector.toString().toLowerCase();
    const match = SECTOR_TONES.find(entry => entry.match.some(label => normalized.indexOf(label) !== -1));
    if (match) return { label: match.label, tone: match.tone };
  }
  return SYMBOL_TONES[symbol] || { label: sector || 'Equity', tone: 'neutral' };
}

function normalizeCurrencyCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : 'USD';
}

function getCurrencyFormatterByCode(currencyCode) {
  const code = normalizeCurrencyCode(currencyCode);
  if (!currencyFormatterCache.has(code)) {
    currencyFormatterCache.set(code, new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2
    }));
  }
  return currencyFormatterCache.get(code);
}

function formatCurrencyValue(value, currencyCode = 'USD') {
  const numeric = Number.isFinite(value) ? value : 0;
  return getCurrencyFormatterByCode(currencyCode).format(numeric);
}

function formatCurrencySigned(value, currencyCode = 'USD') {
  const numeric = Number.isFinite(value) ? value : 0;
  const abs = getCurrencyFormatterByCode(currencyCode).format(Math.abs(numeric));
  return `${numeric >= 0 ? '+' : '-'}${abs}`;
}

const APPROX_USD_RATE_BY_CURRENCY = Object.freeze({
  USD: 1,
  INR: 0.012,
  GBP: 1.27,
  EUR: 1.08,
  CAD: 0.74,
  AUD: 0.66,
  JPY: 0.0067,
  CNY: 0.14,
  HKD: 0.128,
  CHF: 1.10,
  SGD: 0.74
});

function usdRateForCurrency(currencyCode) {
  const code = normalizeCurrencyCode(currencyCode);
  return Number(APPROX_USD_RATE_BY_CURRENCY[code] || 1);
}

function toUsdValue(value, currencyCode) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric * usdRateForCurrency(currencyCode);
}

function applyTrendClass(el, value) {
  if (!el) return;
  el.classList.remove('gain', 'loss', 'neutral');
  if (value > 0) el.classList.add('gain');
  else if (value < 0) el.classList.add('loss');
  else el.classList.add('neutral');
}

// Stock suggestion dataset (shared across dashboard & fundamentals)
const STOCK_SUGGESTIONS = [
  { symbol: 'AAPL', name: 'Apple Inc.' },
  { symbol: 'MSFT', name: 'Microsoft Corporation' },
  { symbol: 'GOOGL', name: 'Alphabet Inc. Class A' },
  { symbol: 'GOOG', name: 'Alphabet Inc. Class C' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.' },
  { symbol: 'META', name: 'Meta Platforms Inc.' },
  { symbol: 'TSLA', name: 'Tesla Inc.' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation' },
  { symbol: 'AMD', name: 'Advanced Micro Devices Inc.' },
  { symbol: 'INTC', name: 'Intel Corporation' },
  { symbol: 'TSM', name: 'Taiwan Semiconductor Manufacturing' },
  { symbol: 'NFLX', name: 'Netflix Inc.' },
  { symbol: 'DIS', name: 'Walt Disney Co.' },
  { symbol: 'JPM', name: 'JPMorgan Chase & Co.' },
  { symbol: 'BAC', name: 'Bank of America Corp.' },
  { symbol: 'V', name: 'Visa Inc.' },
  { symbol: 'MA', name: 'Mastercard Inc.' },
  { symbol: 'WMT', name: 'Walmart Inc.' },
  { symbol: 'COST', name: 'Costco Wholesale Corp.' },
  { symbol: 'KO', name: 'Coca-Cola Co.' },
  { symbol: 'PEP', name: 'PepsiCo Inc.' },
  { symbol: 'NKE', name: 'Nike Inc.' },
  { symbol: 'CRM', name: 'Salesforce Inc.' },
  { symbol: 'ORCL', name: 'Oracle Corporation' },
  { symbol: 'SAP', name: 'SAP SE' },
  { symbol: 'PYPL', name: 'PayPal Holdings Inc.' },
  { symbol: 'SQ', name: 'Block Inc.' },
  { symbol: 'UBER', name: 'Uber Technologies Inc.' },
  { symbol: 'LYFT', name: 'Lyft Inc.' },
  { symbol: 'BABA', name: 'Alibaba Group Holding Ltd.' },
  { symbol: 'T', name: 'AT&T Inc.' },
  { symbol: 'VZ', name: 'Verizon Communications' },
  { symbol: 'XOM', name: 'Exxon Mobil Corporation' },
  { symbol: 'CVX', name: 'Chevron Corporation' },
  { symbol: 'ABNB', name: 'Airbnb Inc.' },
  { symbol: 'SHOP', name: 'Shopify Inc.' },
  { symbol: 'ADBE', name: 'Adobe Inc.' },
  { symbol: 'MRNA', name: 'Moderna Inc.' },
  { symbol: 'PFE', name: 'Pfizer Inc.' },
  { symbol: 'JNJ', name: 'Johnson & Johnson' },
  { symbol: 'MCD', name: "McDonald's Corporation" },
  { symbol: 'SBUX', name: 'Starbucks Corporation' }
];

function densifySeries(series, target = 12) {
  if (!Array.isArray(series) || series.length < 2) return series.slice();
  if (series.length >= target) return series.slice();
  const result = [];
  const gaps = series.length - 1;
  const extraNeeded = target - series.length;
  const perGap = Math.max(1, Math.ceil(extraNeeded / gaps));
  for (let i = 0; i < series.length - 1; i++) {
    const start = series[i];
    const end = series[i + 1];
    result.push(start);
    for (let step = 1; step <= perGap; step++) {
      const t = step / (perGap + 1);
      result.push({
        date: new Date(start.date.getTime() + t * (end.date.getTime() - start.date.getTime())),
        value: start.value + t * (end.value - start.value)
      });
    }
  }
  result.push(series[series.length - 1]);
  return result;
}

function filterStockSuggestions(query, maxResults = 8) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return STOCK_SUGGESTIONS.filter(item =>
    item.symbol.toLowerCase().includes(normalized) ||
    item.name.toLowerCase().includes(normalized)
  ).slice(0, maxResults);
}

function attachSymbolAutocomplete({ input, results, onSelect, maxResults = 8 }) {
  if (!input || !results) return;
  let suggestions = [];

  function hideList() {
    results.style.display = 'none';
    results.innerHTML = '';
    suggestions = [];
  }

  function renderList(list) {
    if (!list.length) {
      hideList();
      return;
    }
    suggestions = list;
    const frag = document.createDocumentFragment();
    list.forEach((item, index) => {
      const li = document.createElement('li');
      li.dataset.index = String(index);
      li.textContent = `${item.name} (${item.symbol})`;
      frag.appendChild(li);
    });
    results.innerHTML = '';
    results.appendChild(frag);
    results.style.display = 'block';
  }

  input.addEventListener('input', async () => {
    const q = (input.value || '').trim();
    if (q.length < 2) { hideList(); onSelect?.(null); return; }
    let list = [];
    if (window.SymbolLookup && typeof window.SymbolLookup.searchOne === 'function') {
      try { list = await window.SymbolLookup.searchOne(q); } catch {}
    }
    if (!Array.isArray(list) || !list.length) {
      list = filterStockSuggestions(q, maxResults);
    }
    if (!list.length) { hideList(); onSelect?.(null); return; }
    renderList(list);
    onSelect?.(null);
  });

  results.addEventListener('mousedown', (event) => {
    const li = event.target.closest('li');
    if (!li) return;
    event.preventDefault();
    const item = suggestions[Number(li.dataset.index)];
    hideList();
    if (item) onSelect?.(item);
  });

  document.addEventListener('click', (event) => {
    if (event.target === input || results.contains(event.target)) return;
    hideList();
  });
}

window.attachSymbolAutocomplete = attachSymbolAutocomplete;

//////////////////////////////////
// LOGIN FUNCTIONALITY
//////////////////////////////////
if (document.getElementById('login-form')) {
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault(); // Prevent default form submission
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errorMessage = document.getElementById('error-message'); // Error message div

    // Clear previous error messages
    if (errorMessage) {
      errorMessage.textContent = '';
      errorMessage.style.display = 'none';
    }
    

    try {
      const response = await fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const rawBody = await response.text();
      let data = {};
      if (rawBody) {
        try {
          data = JSON.parse(rawBody);
        } catch (_) {
          data = {};
        }
      }

      if (response.ok) {
        const token = data && data.token ? data.token : '';
        if (!token) {
          throw new Error('Login response did not include a token');
        }
        // If login is successful, save token to localStorage and redirect to fundamentals
        persistToken(token);
        window.location.href = (new URLSearchParams(location.search).get('next') || 'news.html');
      } else {
        // Display error message if login failed
        if (errorMessage) {
          errorMessage.textContent = data.message || `Login failed (${response.status}). Please try again.`;
          errorMessage.style.display = 'block';
        }
      }
    } catch (error) {
      console.error('Error logging in:', error);
      if (errorMessage) {
        if (String(error?.message || '').toLowerCase().includes('failed to fetch')) {
          errorMessage.textContent = 'Cannot reach the API server. Please check your network and try again.';
        } else {
          errorMessage.textContent = error.message || 'Something went wrong. Please try again later.';
        }
        errorMessage.style.display = 'block';
      }
    }
    
  });
}

const changePasswordToggle = document.getElementById('toggle-change-password');
if (changePasswordToggle) {
  const changePasswordForm = document.getElementById('change-password-form');
  changePasswordToggle.addEventListener('click', () => {
    if (!changePasswordForm) return;
    const isHidden = changePasswordForm.hasAttribute('hidden');
    if (isHidden) {
      changePasswordForm.removeAttribute('hidden');
      changePasswordForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      changePasswordForm.setAttribute('hidden', 'true');
    }
  });
}

if (document.getElementById('change-password-form')) {
  document.getElementById('change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('cp-email');
    const currentPasswordInput = document.getElementById('cp-current-password');
    const newPasswordInput = document.getElementById('cp-new-password');
    const errorEl = document.getElementById('change-password-error');
    const successEl = document.getElementById('change-password-success');

    const email = emailInput?.value?.trim() || '';
    const currentPassword = currentPasswordInput?.value || '';
    const newPassword = newPasswordInput?.value || '';

    if (errorEl) {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }
    if (successEl) {
      successEl.textContent = '';
      successEl.style.display = 'none';
    }

    if (!email || !currentPassword || !newPassword) {
      if (errorEl) {
        errorEl.textContent = 'Please fill in all fields to change your password.';
        errorEl.style.display = 'block';
      }
      return;
    }

    if (!passwordMeetsPolicyForChange(newPassword)) {
      updateChangePasswordHints(newPassword);
      if (errorEl) {
        errorEl.textContent = CHANGE_PASSWORD_POLICY_MESSAGE;
        errorEl.style.display = 'block';
      }
      return;
    }

    try {
      const resp = await fetch(`${API_URL}/password/change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, currentPassword, newPassword }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        if (successEl) {
          successEl.textContent = data.message || 'Password updated successfully.';
          successEl.style.display = 'block';
        }
        if (currentPasswordInput) currentPasswordInput.value = '';
        if (newPasswordInput) newPasswordInput.value = '';
      } else if (errorEl) {
        errorEl.textContent = data.message || 'Unable to change password. Please check your details and try again.';
        errorEl.style.display = 'block';
      }
    } catch (err) {
      console.error('Error changing password:', err);
      if (errorEl) {
        errorEl.textContent = 'Something went wrong. Please try again later.';
        errorEl.style.display = 'block';
      }
    }
  });

  const newPasswordInput = document.getElementById('cp-new-password');
  if (newPasswordInput) {
    updateChangePasswordHints(newPasswordInput.value || '');
    newPasswordInput.addEventListener('input', (e) => {
      const value = e.target.value || '';
      updateChangePasswordHints(value);
      const errorEl = document.getElementById('change-password-error');
      if (passwordMeetsPolicyForChange(value) && errorEl && errorEl.textContent === CHANGE_PASSWORD_POLICY_MESSAGE) {
        errorEl.textContent = '';
        errorEl.style.display = 'none';
      }
    });
  }
}
const checkoutAction = document.getElementById('checkout-button');
if (checkoutAction) {
  checkoutAction.addEventListener('click', async () => {
    const emailInput = document.getElementById('email');
    const email = emailInput ? emailInput.value.trim() : '';
    if (!email) {
      alert('Please enter an email address before starting checkout.');
      emailInput?.focus();
      return;
    }
    try {
      await initiateStripeCheckout(email);
    } catch (err) {
      console.error('Stripe checkout failed:', err);
      alert(err.message || 'Unable to start checkout.');
    }
  });
}

async function loadStripeConfig() {
  try {
    const response = await fetch('/stripe/config');
    if (!response.ok) return;
    const data = await response.json();
    if (data.publishableKey) {
      STRIPE_PUBLISHABLE_KEY = data.publishableKey;
    }
  } catch (err) {
    console.warn('Unable to load Stripe configuration:', err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadStripeConfig();
});



























