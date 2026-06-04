document.addEventListener('DOMContentLoaded', () => {
  const el = (id) => document.getElementById(id);
  const NAME_TOO_SHORT_MESSAGE = 'Please enter at least 2 characters for your name.';
  const PASSWORD_POLICY_MESSAGE = 'Password must be at least 8 characters and include uppercase, lowercase, and a number.';
  const TERMS_REQUIRED_MESSAGE = 'Please accept the Terms and Privacy Policy to continue.';
  const PASSWORD_CONFIRM_REQUIRED_MESSAGE = 'Please confirm your password.';
  const PASSWORD_MISMATCH_MESSAGE = 'Passwords do not match.';

  const nameInput = el('name');
  const emailInput = el('email');
  const passwordInput = el('password');
  const confirmInput = el('confirm');

  const togglePw = el('togglePw');
  const toggleConfirm = el('toggleConfirm');

  const fill = el('fill');
  const strengthText = el('strengthText');
  const scoreText = el('scoreText');
  const rulesEl = el('password-rules');

  const terms = el('terms');
  const createBtn = el('createBtn');
  const submitHint = el('submit-hint');
  const matchHint = el('matchHint');
  const form = el('register-form');
  const errorBox = el('error-message');

  if (!form) return;

  const setToggle = (btn, input) => {
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      btn.textContent = isHidden ? 'Hide' : 'Show';
      btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
      input.focus();
    });
  };

  setToggle(togglePw, passwordInput);
  setToggle(toggleConfirm, confirmInput);

  const emailLooksValid = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  const setInvalidState = (input, invalid) => {
    if (!input) return;
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  };

  const showFormError = (message, field = '') => {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.style.display = '';
    if (field) {
      errorBox.dataset.errorField = field;
    } else {
      delete errorBox.dataset.errorField;
    }
    errorBox.focus();
  };

  const getEmailServerIssue = () => (emailInput?.dataset.serverIssueMessage || '').trim();

  const evaluatePassword = (value) => {
    const checks = {
      length: value.length >= 8,
      uppercase: /[A-Z]/.test(value),
      lowercase: /[a-z]/.test(value),
      number: /[0-9]/.test(value),
    };
    const score = Object.values(checks).filter(Boolean).length;

    if (rulesEl) {
      Object.entries(checks).forEach(([key, ok]) => {
        const item = rulesEl.querySelector(`[data-rule="${key}"]`);
        if (!item) return;
        item.classList.toggle('ok', ok);
        const badge = item.querySelector('.badge');
        if (badge) badge.textContent = ok ? 'OK' : '*';
      });
    }

    if (fill) fill.style.width = `${(score / 4) * 100}%`;
    const label =
      score === 0 ? '-' : score === 1 ? 'Weak' : score === 2 ? 'Okay' : score === 3 ? 'Strong' : 'Very strong';
    if (strengthText) strengthText.textContent = `Strength: ${label}`;
    if (scoreText) scoreText.textContent = `${score} / 4`;
    return score;
  };

  const updateMatchHint = () => {
    if (!confirmInput || !matchHint) return;
    const a = passwordInput ? passwordInput.value : '';
    const b = confirmInput.value;
    if (!b) {
      matchHint.style.display = 'none';
      matchHint.textContent = '';
      setInvalidState(confirmInput, false);
      return;
    }
    matchHint.style.display = 'block';
    if (a === b) {
      matchHint.style.color = 'rgba(34,197,94,.92)';
      matchHint.textContent = 'Passwords match.';
      setInvalidState(confirmInput, false);
    } else {
      matchHint.style.color = 'rgba(239,68,68,.92)';
      matchHint.textContent = 'Passwords do not match.';
      setInvalidState(confirmInput, true);
    }
  };

  const updateButtonState = () => {
    const score = evaluatePassword(passwordInput ? passwordInput.value : '');
    const nameValue = (nameInput?.value || '').trim();
    const emailValue = (emailInput?.value || '').trim();
    const passwordValue = passwordInput?.value || '';
    const confirmValue = confirmInput?.value || '';
    const activeErrorField = (errorBox?.dataset.errorField || '').trim();
    const nameOk = !nameInput || nameValue.length >= 2;
    const emailOk = emailLooksValid(emailValue);
    const emailServerOk = !getEmailServerIssue();
    // Match the actual submit policy (length + uppercase + lowercase + number),
    // so the button never enables when submission would be rejected.
    const passwordOk = score >= 4;
    const confirmPresent = !confirmInput || confirmValue.length > 0;
    const matchOk = !confirmInput || (passwordValue && passwordValue === confirmValue);
    const termsOk = !terms || terms.checked;

    setInvalidState(nameInput, !nameOk && nameValue.length > 0);
    setInvalidState(
      emailInput,
      (activeErrorField === 'email' && !emailValue) ||
      ((!emailOk || !emailServerOk) && emailValue.length > 0)
    );
    setInvalidState(passwordInput, !passwordOk && passwordValue.length > 0);
    setInvalidState(confirmInput, confirmValue.length > 0 && !matchOk);
    if (terms) {
      terms.setAttribute('aria-invalid', termsOk ? 'false' : terms.getAttribute('aria-invalid') || 'false');
    }

    updateMatchHint();

    const canSubmit = nameOk && emailOk && emailServerOk && passwordOk && confirmPresent && matchOk && termsOk;
    if (createBtn) createBtn.disabled = !canSubmit;

    if (submitHint) {
      let nextStep = '';
      if (!nameOk) nextStep = nameValue.length ? NAME_TOO_SHORT_MESSAGE : 'Enter your full name to continue.';
      else if (!emailOk) nextStep = 'Enter a valid email address.';
      else if (!emailServerOk) nextStep = getEmailServerIssue();
      else if (!passwordOk) {
        if (passwordValue.length < 8) nextStep = 'Make your password at least 8 characters.';
        else if (!/[A-Z]/.test(passwordValue)) nextStep = 'Add an uppercase letter (A-Z) to your password.';
        else if (!/[a-z]/.test(passwordValue)) nextStep = 'Add a lowercase letter (a-z) to your password.';
        else if (!/[0-9]/.test(passwordValue)) nextStep = 'Add a number (0-9) to your password.';
        else nextStep = 'Strengthen your password to continue.';
      } else if (!confirmPresent) nextStep = PASSWORD_CONFIRM_REQUIRED_MESSAGE;
      else if (!matchOk) nextStep = PASSWORD_MISMATCH_MESSAGE;
      else if (!termsOk) nextStep = TERMS_REQUIRED_MESSAGE;
      submitHint.textContent = nextStep;
      submitHint.style.display = nextStep ? '' : 'none';
    }
    if (errorBox) {
      const errorField = (errorBox.dataset.errorField || '').trim();
      const fieldResolved =
        !errorField ||
        (errorField === 'name' && nameOk) ||
        (errorField === 'email' && emailOk && emailServerOk) ||
        (errorField === 'password' && passwordOk) ||
        (errorField === 'confirm' && confirmPresent && matchOk) ||
        (errorField === 'terms' && termsOk);
      if (fieldResolved && errorBox.style.display !== 'none') {
        errorBox.textContent = '';
        errorBox.style.display = 'none';
        delete errorBox.dataset.errorField;
      }
    }
  };

  ['input', 'change'].forEach((evt) => {
    nameInput?.addEventListener(evt, updateButtonState);
    emailInput?.addEventListener(evt, updateButtonState);
    passwordInput?.addEventListener(evt, updateButtonState);
    confirmInput?.addEventListener(evt, updateButtonState);
    terms?.addEventListener(evt, updateButtonState);
  });
  emailInput?.addEventListener('register:validation-state', updateButtonState);

  form.addEventListener('submit', (event) => {
    const nameValue = (nameInput?.value || '').trim();
    const emailValue = (emailInput?.value || '').trim();
    const passwordValue = passwordInput?.value || '';
    const confirmValue = confirmInput?.value || '';
    const emailOk = emailLooksValid(emailValue);
    const emailServerIssue = getEmailServerIssue();
    const passwordScore = evaluatePassword(passwordValue);
    const matchOk = !confirmInput || (passwordValue && passwordValue === confirmValue);
    const termsOk = !terms || terms.checked;

    if (
      (nameInput && nameValue.length < 2) ||
      !emailValue ||
      !emailOk ||
      emailServerIssue ||
      !passwordValue ||
      passwordScore < 4 ||
      (confirmInput && !confirmValue) ||
      !matchOk ||
      !termsOk
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (nameInput && !nameValue) showFormError('Please enter your full name.', 'name');
      else if (nameInput && nameValue.length < 2) showFormError(NAME_TOO_SHORT_MESSAGE, 'name');
      else if (!emailValue) showFormError('Please enter your email address.', 'email');
      else if (!emailOk) showFormError('Please enter a valid email address.', 'email');
      else if (emailServerIssue) showFormError(emailServerIssue, 'email');
      else if (!passwordValue) showFormError('Please create a password before continuing.', 'password');
      else if (passwordScore < 4) showFormError(PASSWORD_POLICY_MESSAGE, 'password');
      else if (confirmInput && !confirmValue) showFormError(PASSWORD_CONFIRM_REQUIRED_MESSAGE, 'confirm');
      else if (!matchOk) showFormError(PASSWORD_MISMATCH_MESSAGE, 'confirm');
      else showFormError(TERMS_REQUIRED_MESSAGE, 'terms');
      setInvalidState(nameInput, !nameValue || nameValue.length < 2);
      setInvalidState(emailInput, !emailOk || Boolean(emailServerIssue) || !emailValue);
      setInvalidState(passwordInput, !passwordValue || passwordScore < 4);
      setInvalidState(confirmInput, !confirmValue || !matchOk);
      if (terms) terms.setAttribute('aria-invalid', termsOk ? 'false' : 'true');
    }
  });

  evaluatePassword('');
  updateButtonState();
});
