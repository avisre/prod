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

const CHANGE_PASSWORD_POLICY_MESSAGE =
  'New password must be at least 8 characters and include uppercase, lowercase, and a number.';
const AUTO_CHECKOUT_MAX_RETRIES = 20;
const AUTO_CHECKOUT_DELAY_MS = 3000;

function getChangePasswordPolicyState(password) {
  const value = typeof password === 'string' ? password : '';
  return {
    minLength: value.length >= 8,
    hasUppercase: /[A-Z]/.test(value),
    hasLowercase: /[a-z]/.test(value),
    hasNumber: /\d/.test(value),
  };
}

function passwordMeetsPolicyForChange(password) {
  const state = getChangePasswordPolicyState(password);
  return state.minLength && state.hasUppercase && state.hasLowercase && state.hasNumber;
}

function updateChangePasswordHints(password) {
  const rulesList = document.getElementById('cp-password-rules');
  if (!rulesList) return;
  const state = getChangePasswordPolicyState(password || '');
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

function showLoginMessage(message, type = 'error') {
  const errorEl = document.getElementById('error-message');
  const successEl = document.getElementById('success-message');
  const text = String(message || '').trim();

  if (!text) {
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }
    if (successEl) {
      successEl.textContent = '';
      successEl.style.display = 'none';
    }
    return;
  }

  if (type === 'error') {
    if (successEl) {
      successEl.textContent = '';
      successEl.style.display = 'none';
    }
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
    return;
  }

  if (errorEl) {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }
  if (successEl) {
    successEl.textContent = message;
    successEl.style.display = 'block';
  }
}

async function attemptPostCheckoutSession(nextAfterAuth, retryCount = 0) {
  const params = new URLSearchParams(location.search);
  if (params.get('session') !== 'success') return;

  const token = localStorage.getItem('token');
  if (!token) {
    showLoginMessage('Your session is missing. Please sign in again.');
    return;
  }

  try {
    const response = await fetch(`${API_URL}/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      showLoginMessage('Subscription active. Redirecting to your dashboard...', 'success');
      window.location.href = nextAfterAuth;
      return;
    }

    if (response.status === 402) {
      if (retryCount < AUTO_CHECKOUT_MAX_RETRIES) {
        showLoginMessage('Payment received. Finalizing your subscription...', 'success');
        setTimeout(() => attemptPostCheckoutSession(nextAfterAuth, retryCount + 1), AUTO_CHECKOUT_DELAY_MS);
      } else {
        showLoginMessage(
          data.message || 'Payment completed, but the subscription is still activating. Please try signing in again shortly.'
        );
      }
      return;
    }

    if (response.status === 401) {
      showLoginMessage('Your session expired. Please sign in again.');
      return;
    }

    showLoginMessage(data.message || 'Unable to confirm your subscription after checkout.');
  } catch (error) {
    console.error('Post-login session check failed:', error);
    if (retryCount < AUTO_CHECKOUT_MAX_RETRIES) {
      showLoginMessage('Payment received. Finalizing your subscription...', 'success');
      setTimeout(() => attemptPostCheckoutSession(nextAfterAuth, retryCount + 1), AUTO_CHECKOUT_DELAY_MS);
    } else {
      showLoginMessage(error?.message || 'Unexpected error while confirming your subscription.');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const nextAfterAuth = params.get('next') || 'news.html';
  const loginForm = document.getElementById('login-form');
  const passwordInput = document.getElementById('password');
  const togglePw = document.getElementById('togglePw');

  if (params.get('session') === 'cancel') {
    showLoginMessage('Sign-in was interrupted. You can try again below.');
  } else if (params.get('session') === 'success') {
    showLoginMessage('Returning from checkout...', 'success');
    attemptPostCheckoutSession(nextAfterAuth);
  }

  if (togglePw && passwordInput) {
    togglePw.addEventListener('click', () => {
      const hidden = passwordInput.type === 'password';
      passwordInput.type = hidden ? 'text' : 'password';
      togglePw.textContent = hidden ? 'Hide' : 'Show';
      togglePw.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
      passwordInput.focus();
    });
  }

  if (loginForm) {
    loginForm.classList.add('login-form');
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();

      const email = document.getElementById('email')?.value?.trim() || '';
      const password = document.getElementById('password')?.value || '';

      if (!email || !password) {
        showLoginMessage('Please enter both email and password.');
        return;
      }

      showLoginMessage('', 'success');

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

        if (!response.ok) {
          showLoginMessage(data.message || `Login failed (${response.status}). Please try again.`);
          return;
        }

        const token = data && data.token ? data.token : '';
        if (!token) {
          showLoginMessage('Login succeeded but no token was returned.');
          return;
        }

        localStorage.setItem('token', token);
        window.location.href = nextAfterAuth;
      } catch (error) {
        console.error('Error logging in:', error);
        if (String(error?.message || '').toLowerCase().includes('failed to fetch')) {
          showLoginMessage('Cannot reach the API server. Please check your network and try again.');
        } else {
          showLoginMessage(error?.message || 'Something went wrong. Please try again later.');
        }
      }
    });
  }

  const changePasswordToggle = document.getElementById('toggle-change-password');
  const changePasswordForm = document.getElementById('change-password-form');
  const cpNewPassword = document.getElementById('cp-new-password');

  if (changePasswordToggle && changePasswordForm) {
    changePasswordToggle.addEventListener('click', () => {
      const isHidden = changePasswordForm.hasAttribute('hidden');
      if (isHidden) {
        changePasswordForm.removeAttribute('hidden');
        changePasswordForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        changePasswordForm.setAttribute('hidden', 'true');
      }
    });
  }

  if (cpNewPassword) {
    updateChangePasswordHints(cpNewPassword.value || '');
    cpNewPassword.addEventListener('input', (event) => {
      updateChangePasswordHints(event.target?.value || '');
    });
  }

  if (changePasswordForm) {
    changePasswordForm.addEventListener('submit', async (event) => {
      event.preventDefault();

      const email = document.getElementById('cp-email')?.value?.trim() || '';
      const currentPassword = document.getElementById('cp-current-password')?.value || '';
      const newPassword = document.getElementById('cp-new-password')?.value || '';
      const errorEl = document.getElementById('change-password-error');
      const successEl = document.getElementById('change-password-success');

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
        const response = await fetch(`${API_URL}/password/change`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, currentPassword, newPassword }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (errorEl) {
            errorEl.textContent = data.message || `Unable to change password (${response.status}).`;
            errorEl.style.display = 'block';
          }
          return;
        }

        if (successEl) {
          successEl.textContent = data.message || 'Password updated. Please sign in with your new password.';
          successEl.style.display = 'block';
        }
        changePasswordForm.reset();
        updateChangePasswordHints('');
      } catch (error) {
        if (errorEl) {
          errorEl.textContent = error?.message || 'Unexpected error while changing password.';
          errorEl.style.display = 'block';
        }
      }
    });
  }

  if (window.SocialAuth && typeof window.SocialAuth.init === 'function') {
    window.SocialAuth.init({
      flow: 'login',
      rootId: 'social-login-shell',
      googleContainerId: 'google-login-button',
      next: nextAfterAuth,
      showDivider: true,
      onResult(result, options) {
        if (result && result.token) {
          localStorage.setItem('token', result.token);
        }
        if (result && result.url) {
          showLoginMessage('Redirecting to checkout...', 'success');
          window.location.href = result.url;
          return;
        }
        showLoginMessage('Signed in successfully.', 'success');
        window.location.href = options.next || 'news.html';
      }
    });
  }
});
