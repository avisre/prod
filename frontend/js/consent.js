(() => {
  const CONSENT_KEY = 'sp_analytics_consent_v1';

  const readChoice = () => {
    try {
      const value = localStorage.getItem(CONSENT_KEY);
      if (value === 'granted' || value === 'denied') return value;
    } catch (_) {}
    return '';
  };

  const saveChoice = (choice) => {
    try {
      localStorage.setItem(CONSENT_KEY, choice);
    } catch (_) {}
  };

  const updateAnalyticsConsent = (choice) => {
    if (typeof window.gtag !== 'function') return;
    const granted = choice === 'granted';
    window.gtag('consent', 'update', {
      analytics_storage: granted ? 'granted' : 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });
  };

  const removeBanner = () => {
    const existing = document.getElementById('sp-consent-banner');
    if (existing) existing.remove();
  };

  const createBanner = () => {
    const banner = document.createElement('aside');
    banner.id = 'sp-consent-banner';
    banner.className = 'sp-consent-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-live', 'polite');
    banner.setAttribute('aria-label', 'Analytics consent');

    banner.innerHTML = [
      '<div class="sp-consent-copy">',
      '<strong>Analytics preference</strong>',
      '<p>We use optional analytics for conversion measurement only. Choose whether to allow it.</p>',
      '</div>',
      '<div class="sp-consent-actions">',
      '<button type="button" class="sp-consent-btn sp-consent-accept" data-consent-choice="granted">Accept analytics</button>',
      '<button type="button" class="sp-consent-btn sp-consent-decline" data-consent-choice="denied">Decline</button>',
      '<a class="sp-consent-link" href="privacy.html">Privacy</a>',
      '</div>'
    ].join('');

    banner.querySelectorAll('[data-consent-choice]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const choice = btn.getAttribute('data-consent-choice') || 'denied';
        saveChoice(choice);
        updateAnalyticsConsent(choice);
        removeBanner();
      });
    });

    document.body.appendChild(banner);
  };

  const init = () => {
    const choice = readChoice();
    if (choice) {
      updateAnalyticsConsent(choice);
      return;
    }
    createBanner();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
