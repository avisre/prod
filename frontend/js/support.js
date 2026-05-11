document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('support-form');
  if (!form) return;

  const statusEl = document.getElementById('support-status');
  const submitBtn = document.getElementById('support-submit');
  const fields = {
    name: document.getElementById('support-name'),
    email: document.getElementById('support-email'),
    subject: document.getElementById('support-subject'),
    message: document.getElementById('support-message')
  };

  const apiPrefix = (typeof API_URL === 'string' && API_URL.length > 0) ? API_URL : '/api';
  const supportEndpoint = `${apiPrefix.replace(/\/$/, '')}/support`;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const updateStatus = (type, message) => {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.classList.remove('error', 'success', 'visible');
    if (message) {
      if (type) statusEl.classList.add(type);
      statusEl.classList.add('visible');
    }
  };

  const collectPayload = () => ({
    name: fields.name.value.trim(),
    email: fields.email.value.trim(),
    subject: fields.subject.value.trim(),
    message: fields.message.value.trim()
  });

  const validate = (payload) => {
    if (!payload.name || !payload.email || !payload.subject || !payload.message) {
      updateStatus('error', 'All fields are required.');
      return false;
    }
    if (!emailRegex.test(payload.email)) {
      updateStatus('error', 'Please provide a valid email address.');
      return false;
    }
    return true;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = collectPayload();
    if (!validate(payload)) return;

    try {
      submitBtn.disabled = true;
      updateStatus('', 'Sending your ticket...');

      const response = await fetch(supportEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || 'Unable to submit your ticket right now.');
      }

      updateStatus('success', data.message || 'Thanks, your ticket is in.');
      form.reset();
    } catch (error) {
      updateStatus('error', error.message || 'Unable to submit your ticket right now.');
    } finally {
      submitBtn.disabled = false;
    }
  });
});
