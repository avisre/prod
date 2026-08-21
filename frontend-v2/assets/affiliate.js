// Release 1 customer ambassador dashboard. All customer-facing rows are built
// from the privacy-safe /api/affiliate/me contract; no referred identity is used.
(function () {
  'use strict';

  const TERMS_VERSION = 'customer-ambassador-v1-2026-08-13';
  const TERMS_DATE_LABEL = '2026-08-13';
  const STATUS_VALUES = new Set(['invited', 'active', 'suspended', 'declined']);
  const COMMISSION_STATUS_VALUES = new Set(['pending', 'approved', 'reversed', 'paid']);
  const ORDER_STATUS_VALUES = new Set([
    'checkout_started', 'paid', 'pending_reconciliation', 'refunded', 'disputed',
    'ineligible_existing_customer', 'unmatched'
  ]);

  const byId = (id) => document.getElementById(id);
  const esc = (value) => window.V2 && V2.esc
    ? V2.esc(String(value == null ? '' : value))
    : String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));

  let currentData = null;

  function init() {
    if (!window.V2) return;
    V2.nav('');
    V2.footer();

    if (!byId('affiliate-dashboard')) return;

    byId('aff-retry').addEventListener('click', loadDashboard);
    byId('aff-terms-checkbox').addEventListener('change', (event) => {
      byId('aff-accept').disabled = !event.currentTarget.checked;
    });
    byId('aff-accept').addEventListener('click', acceptTerms);
    byId('aff-copy-link').addEventListener('click', () => copyField('aff-referral-url', 'Referral link copied.'));
    byId('aff-copy-share').addEventListener('click', () => copyField('aff-share-copy', 'Share message copied with the disclosure.'));
    byId('aff-test-link').addEventListener('click', testReferralLink);

    loadDashboard();
  }

  async function loadDashboard() {
    showLoading();
    try {
      const response = await fetch('/api/affiliate/me', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error('dashboard_unavailable');
        error.status = response.status;
        throw error;
      }
      if (!payload || payload.eligible !== true || !payload.profile) {
        const error = new Error('invitation_unavailable');
        error.status = 404;
        throw error;
      }
      currentData = payload;
      renderDashboard(payload);
    } catch (error) {
      renderLoadError(error && error.status);
    }
  }

  function showLoading() {
    byId('aff-loading').hidden = false;
    byId('aff-error').hidden = true;
    byId('aff-content').hidden = true;
    setStatusPill('Loading', '');
    announce('');
  }

  function renderLoadError(status) {
    byId('aff-loading').hidden = true;
    byId('aff-content').hidden = true;
    byId('aff-error').hidden = false;
    setStatusPill('Unavailable', 'declined');
    const message = status === 401
      ? 'Your session has ended. Sign in again, then reopen this private dashboard.'
      : status === 404
        ? 'No active customer ambassador invitation was found, or the program is currently disabled.'
        : 'The dashboard could not be loaded safely. No referral or payout information was changed.';
    byId('aff-error-message').textContent = message;
  }

  function renderDashboard(data) {
    byId('aff-loading').hidden = true;
    byId('aff-error').hidden = true;
    byId('aff-content').hidden = false;

    const profile = data.profile && typeof data.profile === 'object' ? data.profile : {};
    const status = STATUS_VALUES.has(profile.status) ? profile.status : 'declined';
    const currentVersion = String(profile.currentTermsVersion || TERMS_VERSION);
    const termsCurrent = profile.termsCurrent === true
      && String(profile.termsVersion || '') === TERMS_VERSION
      && currentVersion === TERMS_VERSION;

    renderProfileState(status, termsCurrent);
    renderReferralLink(profile, status, termsCurrent);
    renderVolume(data);
    renderCurrencyTotals(data.totalsByCurrency);
    renderCommissions(data.commissions);
    renderOrders(data.orders);
  }

  function renderProfileState(status, termsCurrent) {
    const label = byId('aff-state-label');
    const title = byId('aff-state-title');
    const message = byId('aff-state-message');
    const termsAction = byId('aff-terms-action');
    const accept = byId('aff-accept');
    const checkbox = byId('aff-terms-checkbox');

    checkbox.checked = false;
    accept.disabled = true;
    termsAction.hidden = true;

    if (status === 'invited') {
      setStatusPill('Invitation ready', 'invited');
      label.textContent = 'Invitation';
      title.textContent = 'Review the terms before sharing';
      message.textContent = 'Your link remains inactive until you accept the current terms. Nothing is enrolled or paid automatically.';
      accept.textContent = 'Accept terms and activate';
      termsAction.hidden = false;
      return;
    }

    if (status === 'active' && !termsCurrent) {
      setStatusPill('Terms update required', 'invited');
      label.textContent = 'Terms update';
      title.textContent = 'Accept the current terms to keep sharing';
      message.textContent = `The program terms are now dated ${TERMS_DATE_LABEL}. Review and accept that version before using the link from this dashboard.`;
      accept.textContent = 'Accept current terms';
      termsAction.hidden = false;
      return;
    }

    if (status === 'active') {
      setStatusPill('Active', 'active');
      label.textContent = 'Link active';
      title.textContent = 'Your ambassador link is ready';
      message.textContent = 'Share it only where StockPortfolio.pro is genuinely relevant, and keep the commission disclosure with every endorsement.';
      return;
    }

    if (status === 'suspended') {
      setStatusPill('Sharing paused', 'suspended');
      label.textContent = 'Sharing paused';
      title.textContent = 'Your referral link is currently inactive';
      message.textContent = 'New referral attribution is paused. Historical order and commission records remain visible. Contact support if you need the reason reviewed.';
      return;
    }

    setStatusPill('Invitation closed', 'declined');
    label.textContent = 'Invitation closed';
    title.textContent = 'This invitation is not active';
    message.textContent = 'The link cannot be shared or reactivated from this page. Historical records, if any, remain visible for transparency.';
  }

  function setStatusPill(text, status) {
    const pill = byId('aff-status-pill');
    pill.textContent = text;
    pill.className = 'aff-status';
    if (status) pill.classList.add(`is-${status}`);
  }

  function renderReferralLink(profile, status, termsCurrent) {
    const section = byId('aff-link-section');
    const url = safeReferralUrl(profile && profile.referralUrl);
    const usable = status === 'active' && termsCurrent && Boolean(url);
    section.hidden = !usable;
    byId('aff-referral-url').value = usable ? url : '';
    byId('aff-share-copy').value = usable ? defaultShareCopy(url) : '';
  }

  function safeReferralUrl(value) {
    try {
      const url = new URL(String(value || ''), window.location.origin);
      const isLocalOrigin = url.origin === window.location.origin;
      const isProductionHost = ['stockportfolio.pro', 'www.stockportfolio.pro'].includes(url.hostname)
        && url.protocol === 'https:';
      if (!isLocalOrigin && !isProductionHost) return '';
      if (url.username || url.password || url.search || url.hash) return '';
      if (!/^\/r\/[a-z0-9][a-z0-9-]{2,63}$/.test(url.pathname)) return '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function defaultShareCopy(url) {
    return [
      'Affiliate link — I may earn a commission if you purchase, at no extra cost to you.',
      '',
      'I use StockPortfolio.pro to research stocks, ETFs and portfolios against original sources. You can see it here:',
      url,
      '',
      'StockPortfolio.pro is research software, not personal investment advice.'
    ].join('\n');
  }

  function renderVolume(data) {
    const clicks = safeCount(data && data.clicks);
    const purchases = safeCount(data && data.purchases);
    byId('aff-volume-grid').innerHTML = `
      <article class="card aff-volume-card">
        <span class="label">Recorded link clicks</span>
        <strong class="kpi-value">${esc(clicks.toLocaleString())}</strong>
        <span class="kpi-sub">Click events, not a claim of unique people</span>
      </article>
      <article class="card aff-volume-card">
        <span class="label">Attributed purchases</span>
        <strong class="kpi-value">${esc(purchases.toLocaleString())}</strong>
        <span class="kpi-sub">Paid or awaiting authoritative reconciliation</span>
      </article>`;
  }

  function renderCurrencyTotals(value) {
    const host = byId('aff-currency-totals');
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const rows = Object.keys(source)
      .filter((currency) => /^[a-z]{3}$/i.test(currency))
      .sort()
      .slice(0, 12)
      .map((currency) => ({ currency: currency.toLowerCase(), totals: source[currency] || {} }));

    if (!rows.length) {
      host.innerHTML = '<p class="card card-pad muted">No commission balances have been recorded yet. Currency totals will appear here without being combined.</p>';
      return;
    }

    host.innerHTML = rows.map(({ currency, totals }) => `
      <article class="card aff-currency-card">
        <div class="aff-currency-head">
          <h3 class="aff-currency-code">${esc(currency.toUpperCase())}</h3>
          <p class="small faint">${esc(formatMinor(10000, currency))} minimum per ambassador; each currency is assessed separately</p>
        </div>
        <div class="aff-money-grid">
          ${moneyCell('Pending', totals.pendingMinor, currency, 'Inside the hold or awaiting review')}
          ${moneyCell('Approved', totals.approvedMinor, currency, 'Eligible for a future manual batch')}
          ${moneyCell('Paid', totals.paidMinor, currency, 'Recorded as paid externally')}
          ${moneyCell('Reversed', totals.reversedMinor, currency, 'Refunded, disputed or ineligible')}
        </div>
      </article>`).join('');
  }

  function moneyCell(label, minor, currency, detail) {
    return `<div class="aff-money-cell">
      <b>${esc(formatMinor(minor, currency))}</b>
      <span>${esc(label)} · ${esc(detail)}</span>
    </div>`;
  }

  function renderCommissions(value) {
    const rows = Array.isArray(value) ? value.slice(0, 100) : [];
    const tbody = byId('aff-commission-rows');
    const wrapper = byId('aff-commissions-wrap');
    const empty = byId('aff-commissions-empty');

    if (!rows.length) {
      tbody.innerHTML = '';
      wrapper.hidden = true;
      empty.hidden = false;
      return;
    }

    wrapper.hidden = false;
    empty.hidden = true;
    tbody.innerHTML = rows.map((row) => {
      const currency = safeCurrency(row && row.currency);
      const amount = safeMinor(row && row.amountMinor);
      const reversal = Math.min(amount, safeMinor(row && row.reversalMinor));
      const net = Math.max(0, amount - reversal);
      const rateBps = Math.min(10000, safeMinor(row && row.rateBps));
      const status = COMMISSION_STATUS_VALUES.has(row && row.status) ? row.status : 'pending';
      const statusView = commissionStatus(status, row && row.holdUntil, row && row.reason, reversal, currency);
      return `<tr>
        <td data-label="Recorded">${esc(formatDate(row && row.createdAt))}</td>
        <td data-label="Provider">${esc(providerLabel(row && row.provider))}</td>
        <td class="num" data-label="Eligible basis">${esc(formatMinor(row && row.basisMinor, currency))}</td>
        <td class="num" data-label="Rate">${esc(formatRate(rateBps))}</td>
        <td class="num" data-label="Net commission">${esc(formatMinor(net, currency))}</td>
        <td data-label="Earliest review">${esc(formatDate(row && row.holdUntil))}</td>
        <td data-label="Status"><span class="aff-ledger-status"><strong>${esc(statusView.label)}</strong><span>${esc(statusView.detail)}</span></span></td>
      </tr>`;
    }).join('');
  }

  function commissionStatus(status, holdUntil, reason, reversalMinor, currency) {
    const reviewDate = parseDate(holdUntil);
    const now = Date.now();
    const reversalText = reversalMinor > 0 ? `${formatMinor(reversalMinor, currency)} reversed. ` : '';
    if (status === 'pending' && reviewDate && reviewDate.getTime() > now) {
      return { label: 'Pending — refund hold', detail: `${reversalText}Earliest review ${formatDate(reviewDate)}.` };
    }
    if (status === 'pending') {
      return { label: 'Pending review', detail: `${reversalText}The hold elapsed; administrator approval is still required.` };
    }
    if (status === 'approved') {
      return { label: 'Approved — manual payout', detail: `${reversalText}Paid only in a reviewed batch after the per-currency threshold.` };
    }
    if (status === 'paid') {
      return { label: 'Paid', detail: `${reversalText}An external manual payout was recorded.` };
    }
    return { label: 'Reversed', detail: friendlyReversalReason(reason) };
  }

  function friendlyReversalReason(value) {
    const reason = String(value || '').toLowerCase();
    if (reason.includes('dispute') || reason.includes('chargeback')) return 'The purchase was disputed or charged back.';
    if (reason.includes('deactivat')) return 'The AppSumo license was deactivated.';
    if (reason.includes('refund')) return 'The purchase was refunded.';
    return 'The commission became ineligible during review.';
  }

  function renderOrders(value) {
    const rows = Array.isArray(value) ? value.slice(0, 100) : [];
    const tbody = byId('aff-order-rows');
    const wrapper = byId('aff-orders-wrap');
    const empty = byId('aff-orders-empty');

    if (!rows.length) {
      tbody.innerHTML = '';
      wrapper.hidden = true;
      empty.hidden = false;
      return;
    }

    wrapper.hidden = false;
    empty.hidden = true;
    tbody.innerHTML = rows.map((row) => {
      const status = ORDER_STATUS_VALUES.has(row && row.status) ? row.status : 'unmatched';
      const currency = safeCurrency(row && row.currency);
      return `<tr>
        <td data-label="Date">${esc(formatDate(row && row.purchasedAt))}</td>
        <td data-label="Provider">${esc(providerLabel(row && row.provider))}</td>
        <td data-label="Plan">${esc(planLabel(row && row.planId))}</td>
        <td data-label="Currency">${esc(currency.toUpperCase())}</td>
        <td data-label="Status"><span class="aff-ledger-status"><strong>${esc(orderStatusLabel(status))}</strong><span>${esc(orderStatusDetail(status))}</span></span></td>
      </tr>`;
    }).join('');
  }

  function orderStatusLabel(status) {
    return ({
      checkout_started: 'Checkout started',
      paid: 'Paid',
      pending_reconciliation: 'Awaiting reconciliation',
      refunded: 'Refunded',
      disputed: 'Disputed',
      ineligible_existing_customer: 'Ineligible',
      unmatched: 'Needs review'
    })[status] || 'Needs review';
  }

  function orderStatusDetail(status) {
    return ({
      checkout_started: 'No eligible paid commission is recorded yet.',
      paid: 'Eligible commission is shown separately in the ledger.',
      pending_reconciliation: 'AppSumo Partner Portal proceeds are still authoritative.',
      refunded: 'Any related commission is reversed.',
      disputed: 'Any related commission is suspended or reversed.',
      ineligible_existing_customer: 'Release 1 pays only for a new customer.',
      unmatched: 'No customer identity is shown while the order is reviewed.'
    })[status] || 'Administrator review is required.';
  }

  async function acceptTerms() {
    const checkbox = byId('aff-terms-checkbox');
    const button = byId('aff-accept');
    if (!checkbox.checked) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    announce('Recording your acceptance…');
    try {
      const response = await fetch('/api/affiliate/accept', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ acceptTerms: true, termsVersion: TERMS_VERSION })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(safeApiMessage(payload && payload.message));
      announce('Terms accepted. Refreshing your ambassador record.');
      await loadDashboard();
    } catch (error) {
      announce(error && error.message ? error.message : 'The terms could not be accepted. No program status changed.', true);
      button.disabled = false;
    } finally {
      button.removeAttribute('aria-busy');
    }
  }

  function safeApiMessage(value) {
    const message = String(value || '').trim();
    const allowed = [
      'The ambassador terms have changed. Review the current version before accepting.',
      'A verified active customer purchase is required before accepting an ambassador invitation.',
      'A current administrator invitation is required before this link can be activated.',
      'This invitation is not active.',
      'No ambassador invitation is available for this account.'
    ];
    return allowed.includes(message) ? message : 'The terms could not be accepted. No program status changed.';
  }

  function testReferralLink() {
    const value = byId('aff-referral-url').value;
    if (!safeReferralUrl(value)) {
      announce('This link does not match the expected private referral format. Nothing was opened.', true);
      return;
    }
    announce('Link format passed. This local test created no click, cookie or commission.');
  }

  async function copyField(id, successMessage) {
    const field = byId(id);
    const value = String(field && field.value || '');
    if (!value) {
      announce('There is nothing available to copy.', true);
      return;
    }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        field.focus();
        field.select();
        if (!document.execCommand('copy')) throw new Error('copy_failed');
        field.setSelectionRange(0, 0);
      }
      announce(successMessage);
    } catch (_) {
      announce('Copy was blocked by the browser. Select the text and copy it manually.', true);
    }
  }

  function announce(message, error) {
    const live = byId('aff-live');
    if (!live) return;
    live.textContent = message || '';
    live.classList.toggle('is-error', Boolean(error));
  }

  function safeCount(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
  }

  function safeMinor(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
  }

  function safeCurrency(value) {
    const currency = String(value || 'usd').toLowerCase();
    return /^[a-z]{3}$/.test(currency) ? currency : 'usd';
  }

  function formatMinor(value, currency) {
    const code = safeCurrency(currency).toUpperCase();
    const amount = safeMinor(value) / 100;
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2
      }).format(amount);
    } catch (_) {
      return `${code} ${amount.toFixed(2)}`;
    }
  }

  function formatRate(rateBps) {
    const rate = Math.max(0, Number(rateBps || 0)) / 100;
    return `${Number.isInteger(rate) ? rate.toFixed(0) : rate.toFixed(2)}%`;
  }

  function parseDate(value) {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    const date = new Date(value || '');
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function formatDate(value) {
    const date = parseDate(value);
    if (!date) return '—';
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  }

  function providerLabel(value) {
    const provider = String(value || '').toLowerCase();
    if (provider === 'stripe') return 'Stripe';
    if (provider === 'appsumo') return 'AppSumo';
    return 'Provider';
  }

  function planLabel(value) {
    const plan = String(value || '').trim().toLowerCase();
    if (!plan) return 'Plan not reported';
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(plan)) return 'Plan';
    return plan.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
