'use strict';
// ---- Retargeting pixels: Meta Pixel + Google Ads (env-driven, no-op-safe) ----
// Every ID is read from the environment. When the IDs are unset (the default),
// nothing renders and nothing loads — shipping with these absent is completely
// safe: no markup, no network calls, no console errors.
//
// Two delivery paths share this one source of truth:
//   1. SSR marketing pages (/stocks, /compare, /vs) inject pixelHeadSnippet()
//      straight into <head> — the same place those pages already load GA/Clarity.
//   2. App pages (the 19 static frontend-v2 pages) fetch /api/analytics/config
//      and load the pixels from assets/app.js, gated behind analytics consent.
//
// Both paths expose the same window.spTrack(name, params) helper and read the
// same window.__spPixelCfg, so a funnel event fires identically wherever it is
// raised. See docs/PIXELS.md.

function pixelConfig() {
    return {
        metaPixelId: process.env.META_PIXEL_ID || '',
        googleAdsId: process.env.GOOGLE_ADS_ID || '',
        signupLabel: process.env.GOOGLE_ADS_CONVERSION_LABEL_SIGNUP || '',
        subscribeLabel: process.env.GOOGLE_ADS_CONVERSION_LABEL_SUBSCRIBE || ''
    };
}

// The shared client runtime, as a string of JS with the config inlined. It:
//   - stores the config on window.__spPixelCfg,
//   - defines window.spTrack (a no-op until a pixel actually loads),
//   - injects the Meta base pixel (+ PageView) when metaPixelId is set,
//   - registers the Google Ads gtag config when googleAdsId is set.
// It NEVER throws: every external call is guarded, so a missing/blocked network
// or a private-mode localStorage can't break the page. app.js carries a
// byte-for-byte equivalent loader for the consent-gated app-page path.
function pixelRuntime(cfg) {
    return `(function(C){
  window.__spPixelCfg = C;
  // spTrack: the single funnel entry point. Safe to call before (or without)
  // any pixel loading — it simply checks what's present at call time.
  if (!window.spTrack) window.spTrack = function(name, params){
    params = params || {}; var k = window.__spPixelCfg || {};
    try {
      if (window.fbq) {
        if (name === 'signup') window.fbq('track','CompleteRegistration');
        else if (name === 'trial_start') window.fbq('track','StartTrial');
        else if (name === 'initiate_checkout') window.fbq('track','InitiateCheckout');
        else if (name === 'subscribe') window.fbq('track','Purchase', {value: params.value, currency: params.currency || 'USD'});
      }
    } catch(e){}
    try {
      if (window.gtag && k.googleAdsId) {
        if (name === 'signup' && k.signupLabel) window.gtag('event','conversion',{send_to: k.googleAdsId+'/'+k.signupLabel});
        else if (name === 'subscribe' && k.subscribeLabel) window.gtag('event','conversion',{send_to: k.googleAdsId+'/'+k.subscribeLabel, value: params.value, currency: params.currency || 'USD'});
      }
    } catch(e){}
  };
  // Meta Pixel base — only when an ID is configured.
  if (C.metaPixelId && !window.fbq) {
    try {
      !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
      window.fbq('init', C.metaPixelId);
      window.fbq('track','PageView');
    } catch(e){}
  }
  // Google Ads — reuse the gtag already on the page (GA loads it); just add the
  // Ads config id. Defensively shim gtag in case the Ads tag arrives first.
  if (C.googleAdsId) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function(){ window.dataLayer.push(arguments); };
      if (!window.__spAdsScript) {
        window.__spAdsScript = true;
        var s = document.createElement('script'); s.async = true;
        s.src = 'https://www.googletagmanager.com/gtag/js?id=' + C.googleAdsId;
        document.head.appendChild(s);
        window.gtag('js', new Date());
      }
      window.gtag('config', C.googleAdsId);
    } catch(e){}
  }
})(${JSON.stringify(cfg)});`;
}

// Inline <head> snippet for the SSR marketing pages. Returns '' (no markup at
// all) when nothing is configured. Hostname-gated to production, and it skips
// loading if the visitor has EXPLICITLY declined analytics consent on an app
// page (the same sp_analytics_consent_v1 key the consent banner writes).
function pixelHeadSnippet() {
    const cfg = pixelConfig();
    if (!cfg.metaPixelId && !cfg.googleAdsId) return '';
    return `<script>(function(){
  try {
    var consent = localStorage.getItem('sp_analytics_consent_v1');
    if (consent === 'denied') return;
    // GDPR/ePrivacy: in the EU/UK, marketing pixels need EXPLICIT opt-in, so on
    // these SSR pages (which carry no consent banner) only fire for an EU/UK
    // visitor who has actively granted consent on an app page. Region is
    // approximated client-side via timezone — this works with the cached SSR
    // HTML, where per-request server geo cannot (the cache is one body for all).
    var tz = '';
    try { tz = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || ''; } catch (e) {}
    if (tz.indexOf('Europe/') === 0 && consent !== 'granted') return;
  } catch(e){}
  if (location.hostname.indexOf('stockportfolio.pro') < 0) return;
  ${pixelRuntime(cfg)}
})();</script>`;
}

module.exports = { pixelConfig, pixelRuntime, pixelHeadSnippet };
