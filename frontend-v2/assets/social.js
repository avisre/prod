// Google sign-in for the v2 auth pages. Server-gated: /api/auth/providers
// only enables Google on configured production hosts, so the shell stays
// hidden locally and everywhere else.
(function () {
  let gsiPromise = null;

  function loadGsi() {
    if (window.google && window.google.accounts && window.google.accounts.id) {
      return Promise.resolve(window.google);
    }
    if (!gsiPromise) {
      gsiPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.defer = true;
        s.onload = () => (window.google && window.google.accounts && window.google.accounts.id)
          ? resolve(window.google)
          : reject(new Error('Google Identity Services did not initialize'));
        s.onerror = () => reject(new Error('Unable to load Google Identity Services'));
        document.head.appendChild(s);
      });
    }
    return gsiPromise;
  }

  function setStatus(el, message, isError) {
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
    el.classList.toggle('delta-neg', Boolean(isError));
  }

  function renderButton(google, mount, flow) {
    const width = Math.max(180, Math.round(mount.getBoundingClientRect().width || 320));
    if (mount.dataset.renderedWidth === String(width)) return;
    mount.dataset.renderedWidth = String(width);
    mount.innerHTML = '';
    google.accounts.id.renderButton(mount, {
      theme: 'outline',
      size: 'large',
      shape: 'rectangular',
      text: flow === 'register' ? 'signup_with' : 'continue_with',
      width,
      logo_alignment: 'left'
    });
  }

  // opts: { flow, shellId, mountId, statusId, next, getExtraPayload }
  async function init(opts) {
    const shell = document.getElementById(opts.shellId);
    const mount = document.getElementById(opts.mountId);
    const status = opts.statusId ? document.getElementById(opts.statusId) : null;
    if (!shell || !mount) return;
    try {
      const config = await fetch(`${V2.API}/auth/providers`).then((r) => r.ok ? r.json() : null);
      if (!config || !config.google || !config.google.enabled || !config.google.clientId) return;

      const google = await loadGsi();
      google.accounts.id.initialize({
        client_id: config.google.clientId,
        callback: async (response) => {
          try {
            setStatus(status, 'Continuing with Google…');
            const r = await fetch(`${V2.API}/auth/social`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                provider: 'google',
                flow: opts.flow,
                credential: response.credential,
                next: opts.next || 'dashboard.html',
                ...(typeof opts.getExtraPayload === 'function' ? opts.getExtraPayload() : {})
              })
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.message || 'Unable to continue with Google.');
            if (data.url) {
              setStatus(status, 'Redirecting to checkout…');
              location.href = data.url; // Stripe checkout (subscription needed)
              return;
            }
            setStatus(status, 'Signed in — redirecting…');
            location.href = '/' + String(opts.next || 'dashboard.html').replace(/^\/+/, '');
          } catch (error) {
            setStatus(status, error.message || 'Unable to continue with Google.', true);
          }
        }
      });

      shell.hidden = false;
      renderButton(google, mount, opts.flow);
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => renderButton(google, mount, opts.flow)).observe(mount);
      }
    } catch (error) {
      console.warn('Google sign-in unavailable:', error);
    }
  }

  // Stripe return for social checkouts (?session=success&checkout=social):
  // the token was stored before redirecting to Stripe — poll /api/session
  // until the webhook activates the subscription, then continue.
  // Returns true when it handled the return (caller should skip its own flow).
  function confirmCheckout(opts) {
    const params = new URLSearchParams(location.search);
    if (params.get('session') !== 'success' || params.get('checkout') !== 'social') return false;
    const status = opts && opts.statusId ? document.getElementById(opts.statusId) : null;
    const nextRaw = params.get('next') || 'dashboard.html';
    const next = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(nextRaw) ? 'dashboard.html' : nextRaw.replace(/^\/+/, '');
    const token = typeof V2.token === 'function' ? V2.token() : '';
    if (!token) {
      setStatus(status, 'Payment completed, but your session is missing — please sign in with Google again.', true);
      return true;
    }
    if (status) status.hidden = false;
    (async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const r = await fetch(`${V2.API}/session`, { headers: { Authorization: `Bearer ${token}` } });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.subscription && data.subscription.isActive) {
            setStatus(status, 'Subscription active — redirecting…');
            location.href = '/' + next;
            return;
          }
          if (r.status === 401) {
            setStatus(status, 'Payment completed, but your session expired — please sign in with Google again.', true);
            return;
          }
          // 402 webhook lag / 429 / 5xx — retry
        } catch (_) { /* transient — retry */ }
        setStatus(status, 'Payment received — finalising your subscription…');
        await new Promise((res) => setTimeout(res, 3000));
      }
      setStatus(status, 'Payment completed, but activation is taking a moment — try logging in shortly.', true);
    })();
    return true;
  }

  window.V2Social = { init, confirmCheckout };
})();
