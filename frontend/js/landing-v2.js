document.addEventListener('DOMContentLoaded', () => {
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

  const ATTR_KEYS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'gclid',
    'fbclid',
    'msclkid'
  ];

  const readAttribution = () => {
    const params = new URLSearchParams(window.location.search || '');
    const kept = new URLSearchParams();
    ATTR_KEYS.forEach((key) => {
      const value = params.get(key);
      if (value) kept.set(key, value);
    });
    if (kept.toString()) {
      try {
        sessionStorage.setItem('sp_attribution_params', kept.toString());
      } catch (_) {}
      return kept;
    }
    try {
      const stored = sessionStorage.getItem('sp_attribution_params');
      if (stored) {
        return new URLSearchParams(stored);
      }
    } catch (_) {}
    return new URLSearchParams();
  };

  const appendAttributionToAuthLinks = (attribution) => {
    if (!attribution || !attribution.toString()) return;
    document.querySelectorAll('a[href^="register.html"], a[href^="login.html"]').forEach((link) => {
      const rawHref = link.getAttribute('href');
      if (!rawHref) return;
      const url = new URL(rawHref, window.location.href);
      attribution.forEach((value, key) => {
        if (!url.searchParams.has(key)) {
          url.searchParams.set(key, value);
        }
      });
      link.setAttribute('href', `${url.pathname.split('/').pop()}${url.search}`);
    });
  };

  const attribution = readAttribution();
  appendAttributionToAuthLinks(attribution);

  // --- Scroll reveal (professional, subtle) ---
  const revealCandidates = [];
  const seen = new Set();

  const addRevealGroup = (elements, stepMs = 70, maxMs = 420, baseMs = 0) => {
    Array.from(elements).forEach((el, index) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      el.classList.add('lp-reveal');
      el.style.setProperty('--lp-reveal-delay', `${baseMs + Math.min(index * stepMs, maxMs)}ms`);
      revealCandidates.push(el);
    });
  };

  addRevealGroup(document.querySelectorAll('.lp-hero-copy > *'), 65, 520, 0);
  addRevealGroup(document.querySelectorAll('.lp-hero-demo'), 0, 0, 140);

  document.querySelectorAll('.lp-section').forEach((section) => {
    const header = section.querySelector('.lp-section-header');
    if (header) addRevealGroup(header.children, 60, 240, 0);

    addRevealGroup(
      section.querySelectorAll(
        '.lp-preview-media, .lp-preview-point, article.lp-card, .lp-quote-card, .lp-founder-note, .lp-pricing-card, .lp-how-card, .lp-faq-item'
      ),
      80,
      520,
      60
    );
  });

  addRevealGroup(document.querySelectorAll('.lp-final-cta-inner > *'), 70, 240, 0);

  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    revealCandidates.forEach((el) => el.classList.add('is-inview'));
  } else {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-inview');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.16, rootMargin: '0px 0px -10% 0px' }
    );
    revealCandidates.forEach((el) => observer.observe(el));
  }

  // --- Demo tabs (animated transitions) ---
  const tabs = Array.from(document.querySelectorAll('.lp-demo-tab'));
  const panels = Array.from(document.querySelectorAll('.lp-demo-panel'));
  let demoHideToken = 0;

  const setActiveTab = (activeTab) => {
    tabs.forEach((btn) => {
      const isActive = btn === activeTab;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      btn.tabIndex = isActive ? 0 : -1;
    });
  };

  const setActivePanel = (panelId) => {
    const nextPanel = panels.find((p) => p.id === panelId);
    const currentPanel = panels.find((p) => p.classList.contains('is-active')) ?? panels[0];
    if (!nextPanel || nextPanel === currentPanel) return;

    if (prefersReducedMotion) {
      panels.forEach((panel) => {
        const isMatch = panel.id === panelId;
        panel.hidden = !isMatch;
        panel.classList.toggle('is-active', isMatch);
      });
      return;
    }

    nextPanel.hidden = false;
    delete nextPanel.dataset.hideToken;
    nextPanel.classList.remove('is-active');

    currentPanel.classList.remove('is-active');

    requestAnimationFrame(() => {
      nextPanel.classList.add('is-active');
    });

    demoHideToken += 1;
    const token = String(demoHideToken);
    currentPanel.dataset.hideToken = token;

    window.setTimeout(() => {
      if (currentPanel.dataset.hideToken !== token) return;
      if (currentPanel.classList.contains('is-active')) return;
      currentPanel.hidden = true;
      delete currentPanel.dataset.hideToken;
    }, 300);
  };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetId = tab.getAttribute('aria-controls');
      if (!targetId) return;
      if (tab.classList.contains('is-active')) return;
      setActiveTab(tab);
      setActivePanel(targetId);
    });

    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const currentIndex = tabs.indexOf(tab);
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
      tabs[nextIndex]?.click();
      tabs[nextIndex]?.focus();
    });
  });

  // --- Demo modal ---
  const modal = document.getElementById('lp-demo-modal');
  const modalOpenButtons = Array.from(document.querySelectorAll('[data-demo-open]'));
  const modalCloseButtons = Array.from(document.querySelectorAll('[data-demo-close]'));
  const modalVideo = modal?.querySelector('video');
  let lastFocus = null;

  const closeModal = () => {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-modal-open');
    if (modalVideo) modalVideo.pause();
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  };

  const openModal = (sourceEl) => {
    if (!modal) return;
    lastFocus = sourceEl || document.activeElement;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-modal-open');
    if (modalVideo) {
      const playPromise = modalVideo.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
      }
    }
    const firstFocusable = modal.querySelector('.lp-demo-modal-close');
    if (firstFocusable) firstFocusable.focus();
  };

  modalOpenButtons.forEach((button) => {
    button.addEventListener('click', () => openModal(button));
  });

  modalCloseButtons.forEach((button) => {
    button.addEventListener('click', closeModal);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });

  // --- Pricing local currency estimate ---
  const pricingLocalEls = Array.from(document.querySelectorAll('.lp-pricing-local[data-gbp-price]'));

  if (pricingLocalEls.length) {
    const locale = navigator.language || 'en-US';
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const isIndia = /-IN$/i.test(locale) || timezone === 'Asia/Kolkata';
    const targetCurrency = isIndia ? 'INR' : 'USD';
    const fxRate = isIndia ? 106 : 1.27;

    pricingLocalEls.forEach((pricingLocal) => {
      const gbp = Number(pricingLocal.dataset.gbpPrice || '0');
      const billingLabel = String(pricingLocal.dataset.billingLabel || '').trim().toLowerCase() === 'year'
        ? 'year'
        : 'month';
      if (!gbp) return;

      const formatted = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: targetCurrency,
        maximumFractionDigits: 2
      }).format(gbp * fxRate);

      pricingLocal.textContent = `Approx. ${formatted}/${billingLabel} (${targetCurrency})`;
    });
  }

  // --- FAQ accordion (height/opacity animation) ---
  const faqTriggers = Array.from(document.querySelectorAll('.lp-faq-trigger'));

  const openFaq = (trigger, panel) => {
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('is-open');
    panel.hidden = false;

    if (prefersReducedMotion) return;

    panel.style.height = '0px';
    panel.style.opacity = '0';
    panel.getBoundingClientRect();
    panel.style.height = `${panel.scrollHeight}px`;
    panel.style.opacity = '1';

    const onEnd = (e) => {
      if (e.propertyName !== 'height') return;
      panel.style.height = 'auto';
      panel.removeEventListener('transitionend', onEnd);
    };
    panel.addEventListener('transitionend', onEnd);
  };

  const closeFaq = (trigger, panel) => {
    trigger.setAttribute('aria-expanded', 'false');
    trigger.classList.remove('is-open');

    if (prefersReducedMotion) {
      panel.hidden = true;
      panel.style.height = '';
      panel.style.opacity = '';
      return;
    }

    panel.style.height = `${panel.scrollHeight}px`;
    panel.style.opacity = '1';
    panel.getBoundingClientRect();
    panel.style.height = '0px';
    panel.style.opacity = '0';

    const onEnd = (e) => {
      if (e.propertyName !== 'height') return;
      panel.hidden = true;
      panel.style.height = '';
      panel.style.opacity = '';
      panel.removeEventListener('transitionend', onEnd);
    };
    panel.addEventListener('transitionend', onEnd);
  };

  faqTriggers.forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const panelId = trigger.getAttribute('aria-controls');
      const panel = panelId ? document.getElementById(panelId) : null;
      if (!panel) return;

      const isExpanded = trigger.getAttribute('aria-expanded') === 'true';
      if (isExpanded) {
        closeFaq(trigger, panel);
        return;
      }

      faqTriggers.forEach((otherTrigger) => {
        if (otherTrigger === trigger) return;
        if (otherTrigger.getAttribute('aria-expanded') !== 'true') return;
        const otherPanelId = otherTrigger.getAttribute('aria-controls');
        const otherPanel = otherPanelId ? document.getElementById(otherPanelId) : null;
        if (otherPanel) closeFaq(otherTrigger, otherPanel);
      });

      openFaq(trigger, panel);
    });
  });

  // --- Active section highlight (nav) ---
  const navLinks = Array.from(document.querySelectorAll('.lp-nav-links a[href^="#"]'));
  const linkBySection = new Map();

  navLinks.forEach((link) => {
    const href = link.getAttribute('href');
    if (!href || href.length < 2) return;
    const id = href.slice(1);
    const section = document.getElementById(id);
    if (!section) return;
    linkBySection.set(section, link);
  });

  const setActiveNavLink = (activeLink) => {
    navLinks.forEach((link) => link.classList.toggle('is-active', link === activeLink));
  };

  if (!prefersReducedMotion && 'IntersectionObserver' in window && linkBySection.size) {
    const sectionObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => (b.intersectionRatio ?? 0) - (a.intersectionRatio ?? 0))[0];

        if (!visible) return;
        const link = linkBySection.get(visible.target);
        if (link) setActiveNavLink(link);
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: [0.01, 0.1, 0.25, 0.4] }
    );

    Array.from(linkBySection.keys()).forEach((section) => sectionObserver.observe(section));
  }
});
