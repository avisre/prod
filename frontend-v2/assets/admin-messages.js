(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { selected: new Set(), page: 0, active: null, loading: false, timer: null };
  const list = $('thread-list');
  const search = $('customer-search');
  const audience = $('customer-audience');
  const selectPage = $('select-page');
  const loadMore = $('load-more');
  const selectedCount = $('selected-count');
  const emailToggle = $('send-email');
  const emailSubjectField = $('email-subject-field');
  const compose = $('admin-message-form');
  const status = $('bulk-status');

  function esc(value) {
    return String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function accessError(response) {
    if (response.status === 401) location.href = '/login.html?next=%2Fadmin%2Fmessages';
    if (response.status === 403) document.body.innerHTML = '<main class="container messages-page"><h1>Access denied</h1><p>This page is available only to rin@gmail.com.</p></main>';
  }
  function updateSelection() {
    const count = state.selected.size;
    selectedCount.textContent = `${count} selected`;
    $('send-summary').textContent = count ? `${count} customer${count === 1 ? '' : 's'} selected` : 'Select recipients from the left.';
    $('bulk-send').textContent = count > 1 ? `Send to ${count} customers` : 'Send message';
    document.querySelectorAll('[data-select-user]').forEach((box) => { box.checked = state.selected.has(box.dataset.selectUser); });
    const visible = [...document.querySelectorAll('[data-select-user]')];
    selectPage.checked = visible.length > 0 && visible.every((box) => box.checked);
    selectPage.indeterminate = visible.some((box) => box.checked) && !selectPage.checked;
  }
  function renderCustomer(customer) {
    const name = customer.name || customer.email;
    const note = `${customer.plan || customer.audience}${customer.emailOptedOut ? ' · email opted out' : ''}`;
    return `<div class="thread-row ${state.active === customer.userId ? 'is-selected' : ''}"><input data-select-user="${customer.userId}" type="checkbox" aria-label="Select ${esc(name)}"><span class="thread-row-main" data-open-user="${customer.userId}"><strong>${esc(name)}</strong><span>${esc(customer.email)}</span><span>${esc(note)}</span>${customer.unread ? `<span class="thread-unread">${customer.unread} unread</span>` : ''}</span></div>`;
  }
  function wireRows() {
    list.querySelectorAll('[data-select-user]').forEach((box) => {
      box.addEventListener('change', () => { box.checked ? state.selected.add(box.dataset.selectUser) : state.selected.delete(box.dataset.selectUser); updateSelection(); });
    });
    list.querySelectorAll('[data-open-user]').forEach((row) => row.addEventListener('click', () => openThread(row.dataset.openUser)));
  }
  function renderAdminBubble(message) {
    const mine = message.sender === 'admin';
    const meta = `${mine ? 'You' : 'Customer'} · ${esc(new Date(message.createdAt).toLocaleString())}${message.editedAt ? ' (edited)' : ''}`;
    const actions = mine ? `<span class="message-actions"><button type="button" data-msg-edit="${message.id}">Edit</button><button type="button" data-msg-del="${message.id}">Delete</button></span>` : '';
    return `<div class="message-bubble ${message.sender}" data-id="${message.id}">${esc(message.body)}<span class="message-time">${meta}</span>${actions}</div>`;
  }
  async function loadCustomers(reset) {
    if (state.loading) return;
    if (reset) { state.page = 0; list.innerHTML = ''; }
    state.loading = true;
    try {
      const params = new URLSearchParams({ q: search.value.trim(), audience: audience.value, page: String(state.page), limit: '50' });
      const response = await fetch(`/api/admin/messages/customers?${params}`);
      if (!response.ok) { accessError(response); throw new Error('Unable to load customers.'); }
      const data = await response.json();
      if (reset && !data.customers.length) list.innerHTML = '<p class="small muted" style="padding:14px">No customers found.</p>';
      else list.insertAdjacentHTML('beforeend', data.customers.map(renderCustomer).join(''));
      wireRows(); updateSelection();
      loadMore.hidden = !data.hasMore;
      loadMore.disabled = false;
    } catch (error) { if (error.message !== 'Unable to load customers.') status.textContent = 'Customer directory is unavailable.'; }
    finally { state.loading = false; }
  }
  async function openThread(userId) {
    state.active = userId;
    $('admin-status').textContent = 'Loading…';
    try {
      const response = await fetch(`/api/admin/messages/threads/${encodeURIComponent(userId)}`);
      if (!response.ok) { accessError(response); throw new Error('Unable to load conversation.'); }
      const data = await response.json();
      $('customer-name').textContent = data.customer.name || data.customer.email;
      $('customer-email').textContent = data.customer.email;
      $('admin-empty').hidden = true; $('admin-thread').hidden = false;
      $('admin-message-list').innerHTML = (data.messages || []).map(renderAdminBubble).join('') || '<p class="muted">No messages yet.</p>';
      $('admin-message-list').scrollTop = $('admin-message-list').scrollHeight;
      $('admin-status').textContent = '';
      // The whole-directory reload after every click was the lag: the read is
      // already recorded server-side, so update just this row — drop its
      // unread badge, mark it active — instead of re-running the scan.
      const row = list.querySelector(`[data-open-user="${CSS.escape(String(userId))}"]`);
      if (row) {
        const badge = row.querySelector('.thread-unread');
        if (badge) badge.remove();
        list.querySelectorAll('.thread-row.is-selected').forEach((el) => el.classList.remove('is-selected'));
        const rowWrap = row.closest('.thread-row');
        if (rowWrap) rowWrap.classList.add('is-selected');
      }
    } catch (error) { $('admin-status').textContent = error.message; }
  }
  $('admin-reply-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const field = $('admin-reply-body');
    const body = field.value.trim();
    if (!body || !state.active) return;
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      const response = await fetch(`/api/admin/messages/threads/${encodeURIComponent(state.active)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, sendEmail: false }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      field.value = '';
      await openThread(state.active);
      $('admin-status').textContent = 'Sent.';
    } catch (error) { $('admin-status').textContent = error.message || 'Could not send this message.'; }
    finally { button.disabled = false; }
  });
  // Shared-dialog replacements for window.confirm/prompt (D5): the raw
  // browser chrome reads as a different app and isn't keyboard-consistent
  // with the rest of the admin tooling. Falls back to the natives if app.js
  // didn't mount.
  function confirmModal(title, body) {
    return new Promise((resolve) => {
      if (!window.V2 || !V2.modal) { resolve(window.confirm(body)); return; }
      V2.modal({
        label: title,
        title,
        body,
        actions: [
          { label: 'Delete', primary: true, onClick: () => resolve(true) },
          { label: 'Cancel', onClick: () => resolve(false) }
        ],
        onDismiss: () => resolve(false)
      });
    });
  }
  function promptModal(title, { label, placeholder = '', value = '', maxLength }) {
    return new Promise((resolve) => {
      if (!window.V2 || !V2.modal) { resolve(window.prompt(title, value)); return; }
      const m = V2.modal({
        label: title,
        title,
        bodyHtml: `<input class="input" id="admin-modal-input" ${maxLength ? `maxlength="${maxLength}" ` : ''}placeholder="${placeholder}" style="width:100%;">`,
        actions: [
          { label: label || 'Save', primary: true, onClick: (close) => { const v = document.getElementById('admin-modal-input').value; close(); resolve(v); } },
          { label: 'Cancel', onClick: () => resolve(null) }
        ],
        onDismiss: () => resolve(null)
      });
      const field = m.el.querySelector('#admin-modal-input');
      field.value = value;
      field.focus();
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.el.querySelector('.v2-modal-btn-primary').click(); } });
    });
  }

  $('admin-message-list').addEventListener('click', async (event) => {
    const target = event.target;
    const editId = target.dataset && target.dataset.msgEdit;
    const deleteId = target.dataset && target.dataset.msgDel;
    if ((!editId && !deleteId) || !state.active) return;
    event.preventDefault();
    try {
      let done = '';
      if (deleteId) {
        if (!await confirmModal('Delete message', 'Delete this message? This cannot be undone.')) return;
        const response = await fetch(`/api/admin/messages/threads/${encodeURIComponent(state.active)}/${encodeURIComponent(deleteId)}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);
        done = 'Deleted.';
      } else {
        const bubble = $('admin-message-list').querySelector(`[data-id="${editId}"]`);
        const current = bubble ? bubble.childNodes[0].textContent.trim() : '';
        const next = await promptModal('Edit your message', { label: 'Save', value: current, maxLength: 4000 });
        if (next === null) return;
        const trimmed = next.trim();
        if (!trimmed || trimmed === current) return;
        const response = await fetch(`/api/admin/messages/threads/${encodeURIComponent(state.active)}/${encodeURIComponent(editId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: trimmed }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);
        done = 'Edited.';
      }
      await openThread(state.active);
      $('admin-status').textContent = done;
    } catch (error) { $('admin-status').textContent = error.message || 'That action failed.'; }
  });
  selectPage.addEventListener('change', () => {
    document.querySelectorAll('[data-select-user]').forEach((box) => { selectPage.checked ? state.selected.add(box.dataset.selectUser) : state.selected.delete(box.dataset.selectUser); });
    updateSelection();
  });
  search.addEventListener('input', () => { clearTimeout(state.timer); state.timer = setTimeout(() => loadCustomers(true), 250); });
  audience.addEventListener('change', () => loadCustomers(true));
  loadMore.addEventListener('click', () => { state.page++; loadMore.disabled = true; loadCustomers(false); });
  emailToggle.addEventListener('change', () => { emailSubjectField.hidden = !emailToggle.checked; });
  compose.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = $('admin-message-body').value.trim();
    const ids = [...state.selected];
    if (!body) { status.textContent = 'Write a message first.'; return; }
    if (!ids.length) { status.textContent = 'Select at least one customer.'; return; }
    if (ids.length > 100) { status.textContent = 'Select no more than 100 customers per batch.'; return; }
    const sendEmail = emailToggle.checked;
    const subject = $('admin-message-subject').value.trim();
    if (sendEmail && !subject) { status.textContent = 'Enter an email subject.'; return; }
    let confirmation = `SEND ${ids.length}`;
    if (ids.length > 1) {
      // Typed confirmation kept (error prevention), but inside the shared
      // dialog so the batch size is stated in-app, not in browser chrome.
      const expected = `SEND ${ids.length}`;
      confirmation = await promptModal(`This will send to ${ids.length} selected customers`, { label: `Type ${expected} to send`, placeholder: expected });
      if (confirmation !== expected) { status.textContent = 'Send cancelled.'; return; }
    }
    const button = $('bulk-send'); button.disabled = true; status.textContent = 'Sending…';
    try {
      const request = { userIds: ids, body, subject, sendInApp: true, sendEmail, confirmation, idempotencyKey: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '') };
      const response = await fetch('/api/admin/messages/broadcasts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Could not send this message.');
      const c = data.counts || {}; status.textContent = `Done: ${c.inApp || 0} in-app message${c.inApp === 1 ? '' : 's'}${sendEmail ? ` · ${c.sent || 0} emails sent${c.suppressed ? ` · ${c.suppressed} opted out` : ''}${c.failed ? ` · ${c.failed} email failures` : ''}` : ''}.`;
      $('admin-message-body').value = ''; $('admin-message-subject').value = ''; state.selected.clear(); updateSelection();
      if (state.active && ids.includes(state.active)) openThread(state.active); else loadCustomers(true);
    } catch (error) { status.textContent = error.message || 'Could not send this message.'; }
    finally { button.disabled = false; }
  });
  loadCustomers(true);
}());
