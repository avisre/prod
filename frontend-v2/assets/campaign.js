// Small no-auth campaign hydrator for pages that do not load the full V2 app.
(function () {
  'use strict';
  var CAMPAIGN = 'appsumo_aug_2026';
  function consented() {
    try { return localStorage.getItem('sp_analytics_consent_v1') === 'granted'; } catch (_) { return false; }
  }
  function clickId() {
    try {
      if (window.crypto && crypto.randomUUID) return 'as-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    } catch (_) {}
    return 'as-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function emit(name, context) {
    if (!consented()) return;
    var payload = Object.assign({
      event: name,
      eventId: clickId(),
      consent: true,
      path: location.pathname,
      pageType: 'other',
      campaignId: CAMPAIGN
    }, context || {});
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) navigator.sendBeacon('/api/track/event', new Blob([body], { type: 'application/json' }));
      else fetch('/api/track/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (_) {}
  }
  fetch('/api/campaign/config').then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
    if (!cfg) return;
    CAMPAIGN = cfg.campaignId || CAMPAIGN;
    emit('appsumo_landing_view', { contentId: 'campaign-appsumo' });
    document.querySelectorAll('[data-appsumo-deadline]').forEach(function (el) {
      el.textContent = cfg.deadlineLabel || 'Lifetime deal available now';
    });
    document.querySelectorAll('[data-appsumo-campaign-link]').forEach(function (el) {
      var id = el.getAttribute('data-content-id') || 'campaign-appsumo';
      var q = new URLSearchParams({
        content_id: id,
        click_id: clickId(),
        utm_source: 'website',
        utm_medium: 'referral',
        utm_campaign: CAMPAIGN,
        utm_content: id
      });
      el.setAttribute('href', '/go/appsumo/website?' + q.toString());
    });
    document.querySelectorAll('[data-campaign-sales-video]').forEach(function (el) {
      if (!cfg.salesVideoUrl) { el.hidden = true; return; }
      el.hidden = false; el.setAttribute('src', cfg.salesVideoUrl); el.load();
    });
  }).catch(function () {});
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest && event.target.closest('[data-appsumo-cta]');
    if (!link) return;
    emit('appsumo_cta_click', {
      contentId: link.getAttribute('data-content-id') || 'campaign-appsumo',
      ctaId: link.getAttribute('data-appsumo-cta') || null
    });
  }, { capture: true });
})();
