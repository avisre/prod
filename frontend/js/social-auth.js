(function () {
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

  let providerConfigPromise = null;
  let googleScriptPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === 'true') {
          resolve();
          return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`Unable to load ${src}`)), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', () => {
        script.dataset.loaded = 'true';
        resolve();
      }, { once: true });
      script.addEventListener('error', () => reject(new Error(`Unable to load ${src}`)), { once: true });
      document.head.appendChild(script);
    });
  }

  function getProviderConfig() {
    if (!providerConfigPromise) {
      providerConfigPromise = fetch(`${API_URL}/auth/providers`)
        .then((response) => {
          if (!response.ok) {
            throw new Error('Unable to load social auth configuration');
          }
          return response.json();
        });
    }
    return providerConfigPromise;
  }

  async function loadGoogleSdk() {
    if (window.google && window.google.accounts && window.google.accounts.id) {
      return window.google;
    }
    if (!googleScriptPromise) {
      googleScriptPromise = loadScript('https://accounts.google.com/gsi/client').then(() => {
        if (!(window.google && window.google.accounts && window.google.accounts.id)) {
          throw new Error('Google Identity Services did not initialize');
        }
        return window.google;
      });
    }
    return googleScriptPromise;
  }

  function setStatus(root, message, tone) {
    const statusEl = root ? root.querySelector('.social-auth-status') : null;
    if (!statusEl) return;
    const text = String(message || '').trim();
    if (!text) {
      statusEl.hidden = true;
      statusEl.textContent = '';
      statusEl.classList.remove('is-error', 'is-success');
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', tone === 'error');
    statusEl.classList.toggle('is-success', tone === 'success');
  }

  async function submitSocialAuth(provider, payload, options) {
    const response = await fetch(`${API_URL}/auth/social`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        flow: options.flow || 'login',
        next: options.next || 'news.html',
        ...payload,
        ...(typeof options.getExtraPayload === 'function' ? options.getExtraPayload() : {})
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || `Unable to continue with ${provider}`);
    }
    return data;
  }

  function defaultHandleResult(result, options) {
    if (result && result.token) {
      try {
        localStorage.setItem('token', result.token);
      } catch (_) {}
    }

    if (result && result.url) {
      window.location.href = result.url;
      return;
    }

    const next = options.next || 'news.html';
    window.location.href = next;
  }

  function measureButtonWidth(mount) {
    return Math.round(
      mount.getBoundingClientRect().width ||
      mount.parentElement?.getBoundingClientRect().width ||
      280
    );
  }

  function renderGoogleButton(google, mount, options) {
    const width = Math.max(180, measureButtonWidth(mount));
    if (mount.dataset.renderedWidth === String(width)) {
      return;
    }

    mount.dataset.renderedWidth = String(width);
    mount.innerHTML = '';

    google.accounts.id.renderButton(mount, {
      theme: 'filled_black',
      size: 'large',
      shape: 'pill',
      text: options.flow === 'register' ? 'signup_with' : 'continue_with',
      width,
      logo_alignment: 'left'
    });
  }

  async function initGoogleLogin(config, options, root) {
    const mount = document.getElementById(options.googleContainerId);
    if (!mount || !config?.google?.enabled || !config.google.clientId) return false;

    const google = await loadGoogleSdk();
    mount.hidden = false;
    mount.dataset.provider = 'google';

    google.accounts.id.initialize({
      client_id: config.google.clientId,
      callback: async (response) => {
        try {
          setStatus(root, 'Continuing with Google...', 'success');
          const result = await submitSocialAuth('google', { credential: response.credential }, options);
          setStatus(root, result.url ? 'Redirecting to checkout...' : 'Signed in with Google.', 'success');
          if (typeof options.onResult === 'function') {
            options.onResult(result, options);
          } else {
            defaultHandleResult(result, options);
          }
        } catch (error) {
          setStatus(root, error.message || 'Unable to continue with Google.', 'error');
        }
      }
    });

    renderGoogleButton(google, mount, options);

    if (mount.__googleResizeObserver) {
      mount.__googleResizeObserver.disconnect();
    }

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => {
        renderGoogleButton(google, mount, options);
      });
      resizeObserver.observe(mount);
      if (mount.parentElement) {
        resizeObserver.observe(mount.parentElement);
      }
      mount.__googleResizeObserver = resizeObserver;
    }

    return true;
  }

  async function init(options) {
    const root = document.getElementById(options.rootId);
    if (!root) return;

    try {
      const config = await getProviderConfig();
      const hasConfiguredProvider = Boolean(config?.google?.enabled && config.google.clientId);
      if (!hasConfiguredProvider) {
        root.hidden = true;
        return;
      }

      root.hidden = false;
      const hasGoogle = await initGoogleLogin(config, options, root).catch(() => false);

      if (!hasGoogle) {
        root.hidden = true;
        return;
      }
      const divider = root.querySelector('.divider');
      if (divider) {
        divider.hidden = !Boolean(options.showDivider);
      }
    } catch (error) {
      root.hidden = true;
      console.warn('Social auth unavailable:', error);
    }
  }

  window.SocialAuth = { init };
})();
