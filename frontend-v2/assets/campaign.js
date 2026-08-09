// Small no-auth campaign hydrator for pages that do not load the full V2 app.
(function () {
  'use strict';
  fetch('/api/campaign/config').then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
    if (!cfg) return;
    document.querySelectorAll('[data-appsumo-deadline]').forEach(function (el) {
      el.textContent = cfg.deadlineLabel || 'Lifetime deal available now';
    });
    document.querySelectorAll('[data-appsumo-campaign-link]').forEach(function (el) {
      var id = el.getAttribute('data-content-id') || 'campaign-appsumo';
      el.setAttribute('href', '/go/appsumo/website?content_id=' + encodeURIComponent(id));
    });
    document.querySelectorAll('[data-campaign-sales-video]').forEach(function (el) {
      if (!cfg.salesVideoUrl) { el.hidden = true; return; }
      el.hidden = false; el.setAttribute('src', cfg.salesVideoUrl); el.load();
    });
  }).catch(function () {});
})();
