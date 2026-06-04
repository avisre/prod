function resolveApiUrl() {
  try {
    if (typeof window === 'undefined' || !window.location) return '/api';
    const { protocol, hostname } = window.location;
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

const API_URL = (typeof window !== 'undefined' && typeof window.API_URL === 'string' && window.API_URL)
  ? window.API_URL
  : resolveApiUrl();
if (typeof window !== 'undefined') {
  window.API_URL = API_URL;
}

const REGISTER_CREDENTIALS_KEY = 'pendingRegisterCredentials';
const AUTO_LOGIN_MAX_RETRIES = 20;
const AUTO_LOGIN_DELAY_MS = 3000;
const NAME_TOO_SHORT_MESSAGE = 'Please enter at least 2 characters for your name.';
const PASSWORD_POLICY_MESSAGE = 'Password must be at least 8 characters and include uppercase, lowercase, and a number.';
const DUPLICATE_EMAIL_MESSAGE = 'This email is already registered. Use a different email address or sign in with the existing account.';
const CONFIRM_PASSWORD_REQUIRED_MESSAGE = 'Please confirm your password.';
const PASSWORD_MISMATCH_MESSAGE = 'Passwords do not match.';
const TERMS_REQUIRED_MESSAGE = 'Please accept the Terms and Privacy Policy to continue.';
const ATTR_STORAGE_KEY = 'sp_attribution_params';
const ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'msclkid'];
const PLAN_CONFIG = Object.freeze({
  annual: {
    plan: 'annual',
    label: 'Annual',
    summary: 'Annual selected. Save \u00a354 per year, keep the full dashboard unlocked, and avoid monthly rebilling.',
    subcopy: 'Annual plan gives you 12 months of access for \u00a3270/year and keeps your workspace ready year-round.',
    trustPrice: 'Annual plan: \u00a3270/year. Save \u00a354 versus monthly billing.',
    trustBilling: 'Full access starts immediately and renews once a year, so your workspace is ready whenever markets move.',
    submitLabel: 'Subscribe \u2014 \u00a3270/year',
    ctaCaption: 'Billed \u00a3270 today, renews yearly. Cancel anytime.',
    startingMessage: 'Redirecting to annual checkout...',
    redirectMessage: 'Redirecting to annual checkout...'
  },
  monthly: {
    plan: 'monthly',
    label: 'Monthly',
    summary: 'Monthly selected. \u00a327/month, billed today. Cancel anytime.',
    subcopy: 'Monthly plan billed at \u00a327/month.',
    trustPrice: '\u00a327/month, billed today.',
    trustBilling: 'Renews monthly. Cancel anytime.',
    submitLabel: 'Subscribe \u2014 \u00a327/month',
    ctaCaption: '\u00a327/month, billed today. Cancel anytime.',
    startingMessage: 'Starting your subscription...',
    redirectMessage: 'Redirecting to Stripe checkout...'
  }
});
let selectedPlan = 'monthly';

function normalizePlan(value) {
  const plan = String(value || '').trim().toLowerCase();
  if (plan === 'annual' || plan === 'year' || plan === 'yearly') return 'annual';
  if (plan === 'monthly' || plan === 'month') return 'monthly';
  // Default to the monthly plan.
  return 'monthly';
}

function getSelectedPlanConfig() {
  return PLAN_CONFIG[selectedPlan] || PLAN_CONFIG.annual;
}

function syncPlanInUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('plan', selectedPlan);
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (_) {}
}

function updatePlanSelectionUi() {
  const planConfig = getSelectedPlanConfig();
  document.querySelectorAll('[data-plan-option]').forEach((option) => {
    const isSelected = option.dataset.planOption === planConfig.plan;
    option.classList.toggle('is-selected', isSelected);
    option.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  });

  const hiddenPlanInput = document.getElementById('selected-plan');
  if (hiddenPlanInput) {
    hiddenPlanInput.value = planConfig.plan;
  }

  const summaryEl = document.getElementById('register-plan-summary');
  if (summaryEl) {
    summaryEl.textContent = planConfig.summary;
  }

  const subcopyEl = document.getElementById('register-subcopy');
  if (subcopyEl) {
    subcopyEl.textContent = planConfig.subcopy;
  }

  const trustPriceEl = document.getElementById('register-trust-price');
  if (trustPriceEl) {
    trustPriceEl.textContent = planConfig.trustPrice;
  }

  const trustBillingEl = document.getElementById('register-trust-billing');
  if (trustBillingEl) {
    trustBillingEl.textContent = planConfig.trustBilling;
  }

  const submitBtn = document.getElementById('createBtn');
  if (submitBtn) {
    submitBtn.textContent = planConfig.submitLabel;
  }

  const ctaCaptionEl = document.getElementById('cta-caption');
  if (ctaCaptionEl) {
    ctaCaptionEl.textContent = planConfig.ctaCaption;
  }
}

function setSelectedPlan(plan, syncUrl = true) {
  selectedPlan = normalizePlan(plan);
  updatePlanSelectionUi();
  if (syncUrl) {
    syncPlanInUrl();
  }
}

function getPasswordPolicyState(password) {
  const value = typeof password === 'string' ? password : '';
  return {
    minLength: value.length >= 8,
    hasUppercase: /[A-Z]/.test(value),
    hasLowercase: /[a-z]/.test(value),
    hasNumber: /\d/.test(value),
  };
}

function passwordMeetsPolicyClient(password) {
  const state = getPasswordPolicyState(password);
  return state.minLength && state.hasUppercase && state.hasLowercase && state.hasNumber;
}

function updatePasswordHints(password) {
  const rulesList = document.getElementById('password-rules');
  if (!rulesList) return;
  const state = getPasswordPolicyState(password || '');
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

const emailLooksValid = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
let emailAlreadyActive = false;
let lastCheckedEmail = '';
let emailCheckTimer = null;
let emailCheckRequestId = 0;

function getEmailInput() {
  return document.getElementById('email');
}

function notifyEmailValidationChanged() {
  const emailInput = getEmailInput();
  if (!emailInput) return;
  emailInput.dispatchEvent(new CustomEvent('register:validation-state'));
}

function setEmailServerIssue(message = '', code = '') {
  const emailInput = getEmailInput();
  if (!emailInput) return;
  const text = String(message || '').trim();
  if (text) {
    emailInput.dataset.serverIssueMessage = text;
    if (code) {
      emailInput.dataset.serverIssueCode = String(code);
    } else {
      delete emailInput.dataset.serverIssueCode;
    }
    emailInput.setAttribute('aria-invalid', 'true');
  } else {
    delete emailInput.dataset.serverIssueMessage;
    delete emailInput.dataset.serverIssueCode;
    if (emailLooksValid(emailInput.value || '')) {
      emailInput.setAttribute('aria-invalid', 'false');
    }
  }
  notifyEmailValidationChanged();
}

function clearEmailServerIssue() {
  setEmailServerIssue('', '');
}

function clearMessages() {
  const errorEl = document.getElementById('error-message');
  const successEl = document.getElementById('success-message');
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
    delete errorEl.dataset.errorCode;
    delete errorEl.dataset.errorField;
  }
  if (successEl) {
    successEl.textContent = '';
    successEl.style.display = 'none';
  }
}

function mapRegisterError(data = {}, status = 0) {
  const code = String(data?.code || '').trim().toUpperCase();
  if (code === 'EMAIL_ALREADY_REGISTERED') {
    return { message: DUPLICATE_EMAIL_MESSAGE, field: 'email', code };
  }
  if (code === 'EMAIL_INVALID') {
    return { message: 'Please enter a valid email address.', field: 'email', code };
  }
  if (code === 'EMAIL_REQUIRED') {
    return { message: 'Please enter your email address.', field: 'email', code };
  }
  if (code === 'NAME_REQUIRED') {
    return { message: 'Please enter your full name.', field: 'name', code };
  }
  if (code === 'NAME_TOO_SHORT') {
    return { message: NAME_TOO_SHORT_MESSAGE, field: 'name', code };
  }
  if (code === 'PASSWORD_REQUIRED') {
    return { message: 'Please create a password before continuing.', field: 'password', code };
  }
  if (code === 'PASSWORD_POLICY_FAILED') {
    return { message: PASSWORD_POLICY_MESSAGE, field: 'password', code };
  }
  if (code === 'CHECKOUT_UNAVAILABLE') {
    return { message: 'Checkout is temporarily unavailable. Please try again in a moment.', code };
  }
  if (code === 'CHECKOUT_URL_MISSING') {
    return { message: 'Checkout could not be started. Please try again.', code };
  }
  if (code === 'DATABASE_UNAVAILABLE') {
    return { message: 'Signup is temporarily unavailable. Please try again shortly.', code };
  }
  if (status === 409) {
    return { message: DUPLICATE_EMAIL_MESSAGE, field: 'email', code: code || 'EMAIL_ALREADY_REGISTERED' };
  }
  if (status === 429) {
    return { message: 'Too many attempts. Please wait a minute and try again.', code: 'RATE_LIMITED' };
  }
  if (status >= 500) {
    return { message: 'Something went wrong on our side. Please try again shortly.', code: code || 'SERVER_ERROR' };
  }
  const fallback = String(data?.message || data?.error || '').trim();
  return {
    message: fallback || `Unable to start subscription (status ${status || 'unknown'}).`,
    field: String(data?.field || '').trim().toLowerCase(),
    code
  };
}

function extractAttributionFromSearch(search) {
  const params = new URLSearchParams(search || '');
  const stored = {};
  ATTR_KEYS.forEach((key) => {
    const value = params.get(key);
    if (value) stored[key] = value;
  });
  return stored;
}

function persistAttribution() {
  const direct = extractAttributionFromSearch(window.location.search);
  if (Object.keys(direct).length) {
    try {
      localStorage.setItem(ATTR_STORAGE_KEY, JSON.stringify(direct));
    } catch (_) {}
    return direct;
  }
  try {
    const raw = localStorage.getItem(ATTR_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function getAttributionPayload() {
  const source = persistAttribution();
  if (!source || !Object.keys(source).length) return undefined;
  return source;
}

async function checkEmailAvailability(email) {
  const errorEl = document.getElementById('error-message');
  const normalized = (email || '').trim().toLowerCase();
  if (!emailLooksValid(normalized)) {
    emailAlreadyActive = false;
    clearEmailServerIssue();
    return;
  }
  if (normalized === lastCheckedEmail) return;
  lastCheckedEmail = normalized;
  const requestId = ++emailCheckRequestId;
  try {
    const response = await fetch(`${API_URL}/check-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: normalized }),
    });
    if (requestId !== emailCheckRequestId) return;
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    emailAlreadyActive = Boolean(data && (data.exists || data.active));
    if (emailAlreadyActive) {
      const message = String(data?.message || DUPLICATE_EMAIL_MESSAGE).trim() || DUPLICATE_EMAIL_MESSAGE;
      setEmailServerIssue(message, String(data?.code || 'EMAIL_ALREADY_REGISTERED'));
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.style.display = '';
        errorEl.dataset.errorCode = String(data?.code || 'EMAIL_ALREADY_REGISTERED');
        errorEl.dataset.errorField = 'email';
        errorEl.focus();
      }
    } else if (errorEl && errorEl.dataset.errorCode === 'EMAIL_ALREADY_REGISTERED') {
      clearEmailServerIssue();
      errorEl.textContent = '';
      errorEl.style.display = 'none';
      delete errorEl.dataset.errorCode;
      delete errorEl.dataset.errorField;
    } else if (!emailAlreadyActive) {
      clearEmailServerIssue();
    }
  } catch (_) {
    // Silent fail: this check is only for helpful feedback.
  }
}

async function startSubscription(event) {
  event.preventDefault();
  const errorEl = document.getElementById('error-message');
  const successEl = document.getElementById('success-message');
  const planConfig = getSelectedPlanConfig();
  const email = document.getElementById('email')?.value?.trim().toLowerCase() || '';
  const password = document.getElementById('password')?.value || '';
  const termsAccepted = Boolean(document.getElementById('terms')?.checked);
  const nextAfterAuth = new URLSearchParams(window.location.search).get('next') || 'news.html';

  if (!email) return showError('Please enter your email address.', { code: 'EMAIL_REQUIRED', field: 'email' });
  if (!emailLooksValid(email)) return showError('Please enter a valid email address.', { code: 'EMAIL_INVALID', field: 'email' });

  if (!passwordMeetsPolicyClient(password)) {
    updatePasswordHints(password);
    if (!password) {
      return showError('Please create a password before continuing.', { code: 'PASSWORD_REQUIRED', field: 'password' });
    }
    return showError(PASSWORD_POLICY_MESSAGE, { code: 'PASSWORD_POLICY_FAILED', field: 'password' });
  }

  if (emailAlreadyActive) {
    showError(DUPLICATE_EMAIL_MESSAGE, { code: 'EMAIL_ALREADY_REGISTERED', field: 'email' });
    return;
  }

  if (!termsAccepted) {
    return showError(TERMS_REQUIRED_MESSAGE, { code: 'TERMS_REQUIRED', field: 'terms' });
  }

  clearMessages();
  if (successEl) {
    successEl.textContent = planConfig.startingMessage;
    successEl.style.display = '';
  }

  const payload = { email, password, flow: 'register', next: nextAfterAuth, plan: planConfig.plan };
  const attribution = getAttributionPayload();
  if (attribution) payload.attribution = attribution;

  try {
    const response = await fetch(`${API_URL}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = mapRegisterError(data, response.status);
      showError(failure.message, { code: failure.code, field: failure.field });
      return;
    }

    if (data && data.token) {
      localStorage.setItem('token', data.token);
      sessionStorage.removeItem(REGISTER_CREDENTIALS_KEY);
      window.location.href = nextAfterAuth;
      return;
    }

    sessionStorage.setItem(REGISTER_CREDENTIALS_KEY, JSON.stringify({ email, password }));
    if (successEl) {
      successEl.textContent = planConfig.redirectMessage;
      successEl.style.display = '';
    }

    if (data.url) {
      window.location.href = data.url;
      return;
    }

    if (errorEl) {
      errorEl.textContent = 'Subscription started, but no checkout URL was returned.';
      errorEl.style.display = '';
      errorEl.focus();
    }
    if (successEl) {
      successEl.textContent = '';
      successEl.style.display = 'none';
    }
  } catch (err) {
    console.error('Subscription creation failed:', err);
    showError(
      navigator.onLine === false
        ? 'You appear to be offline. Check your connection and try again.'
        : (err.message || 'Something went wrong.')
    );
  }
}

function showError(message, options = {}) {
  const errorEl = document.getElementById('error-message');
  const successEl = document.getElementById('success-message');
  const code = String(options.code || '').trim();
  const field = String(options.field || '').trim().toLowerCase();
  const nameInput = document.getElementById('name');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const confirmInput = document.getElementById('confirm');
  const termsInput = document.getElementById('terms');

  [nameInput, passwordInput, confirmInput].forEach((input) => {
    if (input) input.setAttribute('aria-invalid', 'false');
  });
  if (termsInput) {
    termsInput.setAttribute('aria-invalid', 'false');
  }

  if (field === 'email' || code === 'EMAIL_ALREADY_REGISTERED') {
    setEmailServerIssue(message, code);
  } else if (emailInput && emailLooksValid(emailInput.value || '')) {
    emailInput.setAttribute('aria-invalid', 'false');
  }
  if (field === 'name' && nameInput) nameInput.setAttribute('aria-invalid', 'true');
  if (field === 'password' && passwordInput) passwordInput.setAttribute('aria-invalid', 'true');
  if (field === 'confirm' && confirmInput) confirmInput.setAttribute('aria-invalid', 'true');
  if (field === 'terms' && termsInput) termsInput.setAttribute('aria-invalid', 'true');
  if (successEl) {
    successEl.textContent = '';
    successEl.style.display = 'none';
  }
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = '';
    if (code) {
      errorEl.dataset.errorCode = code;
    } else {
      delete errorEl.dataset.errorCode;
    }
    if (field) {
      errorEl.dataset.errorField = field;
    } else {
      delete errorEl.dataset.errorField;
    }
    errorEl.focus();
  }
}

function showSuccess(message) {
  const successEl = document.getElementById('success-message');
  clearMessages();
  if (successEl) {
    successEl.textContent = message;
    successEl.style.display = '';
  }
}

async function attemptPostCheckoutLogin(retryCount = 0) {
  const params = new URLSearchParams(location.search);
  if (params.get('session') !== 'success') return;
  const nextAfterAuth = params.get('next') || 'news.html';
  const checkoutType = String(params.get('checkout') || '').trim().toLowerCase();

  if (checkoutType === 'social') {
    const token = localStorage.getItem('token');
    if (!token) {
      showError('Payment completed, but your login session is missing. Please sign in again.');
      return;
    }

    try {
      const sessionResp = await fetch(`${API_URL}/session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await sessionResp.json().catch(() => ({}));

      if (sessionResp.ok) {
        showSuccess('Subscription active. Redirecting to your dashboard...');
        window.location.href = nextAfterAuth;
        return;
      }

      if (sessionResp.status === 402) {
        if (retryCount < AUTO_LOGIN_MAX_RETRIES) {
          showSuccess('Payment received. Finalizing your subscription...');
          setTimeout(() => attemptPostCheckoutLogin(retryCount + 1), AUTO_LOGIN_DELAY_MS);
        } else {
          showError(data.message || 'Payment completed, but the subscription is still activating. Please try again shortly.');
        }
        return;
      }

      if (sessionResp.status === 401) {
        showError('Payment completed, but your session expired. Please sign in again.');
        return;
      }

      showError(data.message || 'Unable to confirm your subscription after checkout.');
      return;
    } catch (err) {
      console.error('Social checkout confirmation failed:', err);
      if (retryCount < AUTO_LOGIN_MAX_RETRIES) {
        showSuccess('Payment received. Finalizing your subscription...');
        setTimeout(() => attemptPostCheckoutLogin(retryCount + 1), AUTO_LOGIN_DELAY_MS);
      } else {
        showError(err.message || 'Unexpected error while confirming your subscription.');
      }
      return;
    }
  }

  const credentials = sessionStorage.getItem(REGISTER_CREDENTIALS_KEY);
  if (!credentials) return;

  try {
    const { email, password } = JSON.parse(credentials);
    if (!email || !password) return;
    const loginResp = await fetch(`${API_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const rawBody = await loginResp.text();
    let data = {};
    if (rawBody) {
      try {
        data = JSON.parse(rawBody);
      } catch (_) {
        data = {};
      }
    }

    if (loginResp.ok) {
      if (!data.token) {
        throw new Error('Auto-login response did not include a token.');
      }
      localStorage.setItem('token', data.token);
      sessionStorage.removeItem(REGISTER_CREDENTIALS_KEY);
      window.location.href = 'news.html';
    } else if (loginResp.status === 402) {
      if (retryCount < AUTO_LOGIN_MAX_RETRIES) {
        showError(data.message || 'Subscription is still being activated. We will redirect you as soon as it is ready...');
        setTimeout(() => attemptPostCheckoutLogin(retryCount + 1), AUTO_LOGIN_DELAY_MS);
      } else {
        showError(data.message || 'Subscription is still activating. Please try logging in again shortly.');
      }
    } else {
      showError(data.message || 'Unable to log you in automatically. Please try logging in again.');
    }
  } catch (err) {
    console.error('Auto-login after payment failed:', err);
    if (retryCount < AUTO_LOGIN_MAX_RETRIES) {
      setTimeout(() => attemptPostCheckoutLogin(retryCount + 1), AUTO_LOGIN_DELAY_MS);
    } else {
      showError(err.message || 'Unexpected error while logging you in.');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  persistAttribution();
  const params = new URLSearchParams(location.search);
  const nextAfterAuth = params.get('next') || 'news.html';
  const initialPlan = normalizePlan(params.get('plan'));

  const form = document.getElementById('register-form');
  const nameInput = document.getElementById('name');
  const passwordInput = document.getElementById('password');
  const confirmInput = document.getElementById('confirm');
  const emailInput = document.getElementById('email');
  const termsInput = document.getElementById('terms');
  const planOptions = document.querySelectorAll('[data-plan-option]');

  setSelectedPlan(initialPlan);

  planOptions.forEach((option) => {
    option.addEventListener('click', () => {
      setSelectedPlan(option.dataset.planOption);
    });
  });

  if (form) {
    form.addEventListener('submit', startSubscription);
  }

  if (passwordInput) {
    updatePasswordHints(passwordInput.value || '');
    passwordInput.addEventListener('input', (e) => {
      const value = e.target.value || '';
      updatePasswordHints(value);
      const errorEl = document.getElementById('error-message');
      if (passwordMeetsPolicyClient(value) && errorEl && errorEl.textContent === PASSWORD_POLICY_MESSAGE) {
        errorEl.textContent = '';
        errorEl.style.display = 'none';
      }
    });
  }

  if (emailInput) {
    ['blur', 'input'].forEach((evt) => {
      emailInput.addEventListener(evt, () => {
        emailAlreadyActive = false;
        clearEmailServerIssue();
        if (lastCheckedEmail && ((emailInput.value || '').trim().toLowerCase() !== lastCheckedEmail)) {
          lastCheckedEmail = '';
        }
        const errorEl = document.getElementById('error-message');
        if (errorEl && errorEl.dataset.errorField === 'email') {
          errorEl.textContent = '';
          errorEl.style.display = 'none';
          delete errorEl.dataset.errorCode;
          delete errorEl.dataset.errorField;
        }
        if (emailCheckTimer) clearTimeout(emailCheckTimer);
        emailCheckTimer = setTimeout(() => {
          checkEmailAvailability(emailInput.value);
        }, 350);
      });
    });
  }

  if (nameInput) {
    nameInput.addEventListener('input', () => {
      if (nameInput.value.trim().length >= 2) {
        nameInput.setAttribute('aria-invalid', 'false');
      }
    });
  }

  if (confirmInput) {
    confirmInput.addEventListener('input', () => {
      const hasValue = confirmInput.value.length > 0;
      const matches = confirmInput.value === (passwordInput?.value || '');
      if (!hasValue || matches) {
        confirmInput.setAttribute('aria-invalid', 'false');
      }
    });
  }

  if (termsInput) {
    termsInput.addEventListener('change', () => {
      if (termsInput.checked) {
        termsInput.setAttribute('aria-invalid', 'false');
      }
    });
  }

  try {
    const session = params.get('session');
    if (session === 'cancel') {
      const checkoutType = String(params.get('checkout') || '').trim().toLowerCase();
      const planConfig = getSelectedPlanConfig();
      showError(
        checkoutType === 'social'
          ? 'Social checkout was interrupted. You can try again below.'
          : 'Checkout was interrupted. You can try again below.'
      );
    }
  } catch (_) {}

  attemptPostCheckoutLogin();

  if (window.SocialAuth && typeof window.SocialAuth.init === 'function') {
    window.SocialAuth.init({
      flow: 'register',
      rootId: 'social-register-shell',
      googleContainerId: 'google-register-button',
      next: nextAfterAuth,
      showDivider: true,
      getExtraPayload() {
        const planConfig = getSelectedPlanConfig();
        const attribution = getAttributionPayload();
        return attribution
          ? { attribution, plan: planConfig.plan }
          : { plan: planConfig.plan };
      },
      onResult(result, options) {
        const planConfig = getSelectedPlanConfig();
        if (result && result.token) {
          localStorage.setItem('token', result.token);
        }
        if (result && result.url) {
          showSuccess(planConfig.redirectMessage);
          window.location.href = result.url;
          return;
        }
        showSuccess('Subscription active. Redirecting to your dashboard...');
        window.location.href = options.next || 'news.html';
      }
    });
  }
});

