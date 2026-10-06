// The customer's private thread with the team, rendered as a reading view:
// newest first, one message per row. A message sent from the broadcast tool is
// a product update and reads as a short article; a long older one is folded.
(function () {
    'use strict';
    const list = document.getElementById('message-list');
    const form = document.getElementById('message-form');
    const body = document.getElementById('message-body');
    const status = document.getElementById('message-status');

    // Raw text by message id. The edit prompt needs what was typed, and the
    // rendered row no longer holds it as a single text node.
    const bodies = new Map();
    const expanded = new Set();
    let latest = [];
    // Past this length an older update is folded to a few lines.
    const FOLD_AT = 420;

    function esc(s) {
        return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function stamp(v) {
        try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)); }
        catch (_) { return ''; }
    }

    // What the team types is plain text. Four conventions are read out of it,
    // and only for the team's own messages: a blank line starts a paragraph,
    // "# " a heading, "- " a bullet, **bold**. Everything is escaped first, so
    // nothing typed can become markup beyond these.
    function inline(s) {
        return esc(s)
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, '<a href="$1" rel="noopener">$1</a>');
    }
    function rich(raw) {
        return String(raw || '').split(/\n{2,}/).map((block) => {
            let out = '';
            let items = [];
            const flush = () => { if (items.length) { out += `<ul>${items.join('')}</ul>`; items = []; } };
            block.split('\n').forEach((line) => {
                if (/^- /.test(line)) { items.push(`<li>${inline(line.slice(2))}</li>`); return; }
                flush();
                if (/^# /.test(line)) out += `<h3>${inline(line.slice(2))}</h3>`;
                else if (line.trim()) out += `<p>${inline(line)}</p>`;
            });
            flush();
            return out;
        }).join('');
    }

    function bubble(m, newestUpdateId) {
        const id = String(m.id);
        const mine = m.sender === 'customer';
        const meta = `${m.sender === 'admin' ? 'StockPortfolio.pro' : 'You'} · ${esc(stamp(m.createdAt))}${m.editedAt ? ' (edited)' : ''}`;
        const isUpdate = !mine && !!m.isUpdate;
        const foldable = isUpdate && id !== newestUpdateId && String(m.body || '').length > FOLD_AT;
        const folded = foldable && !expanded.has(id);
        const head = isUpdate
            ? `<span class="message-pill">Product update</span>${m.title ? `<h2 class="message-title">${esc(m.title)}</h2>` : ''}`
            : '';
        const text = mine
            ? `<div class="message-text">${esc(m.body)}</div>`
            : `<div class="message-text is-rich">${rich(m.body)}</div>`;
        const more = foldable
            ? `<button type="button" class="message-more" data-more="${esc(id)}" aria-expanded="${folded ? 'false' : 'true'}">${folded ? 'Read the full update' : 'Show less'}</button>`
            : '';
        const actions = mine
            ? `<span class="message-actions"><button type="button" data-edit="${esc(id)}">Edit</button><button type="button" data-del="${esc(id)}">Delete</button></span>`
            : '';
        return `<div class="message-bubble ${m.sender}${isUpdate ? ' is-update' : ''}${folded ? ' is-folded' : ''}" data-id="${esc(id)}"><span class="message-time">${meta}</span>${head}${text}${more}${actions}</div>`;
    }

    function render(messages) {
        latest = messages;
        bodies.clear();
        messages.forEach((m) => bodies.set(String(m.id), String(m.body || '')));
        // The server sends oldest first; a reading view leads with the newest.
        const ordered = messages.slice().reverse();
        const newestUpdate = ordered.find((m) => m.sender === 'admin' && m.isUpdate);
        const newestUpdateId = newestUpdate ? String(newestUpdate.id) : '';
        list.innerHTML = ordered.length
            ? ordered.map((m) => bubble(m, newestUpdateId)).join('')
            : '<p class="muted">Start a private conversation with our team.</p>';
    }

    async function load() {
        status.textContent = '';
        try {
            const r = await fetch('/api/messages/thread');
            if (r.status === 401) {
                // A page that renders its own signed-out state keeps the visitor.
                const locked = document.getElementById('locked');
                if (locked) { status.textContent = ''; return; }
                location.href = '/login.html?next=' + encodeURIComponent(location.pathname);
                return;
            }
            const d = await r.json();
            if (!r.ok) throw Error(d.message);
            render(d.messages || []);
        } catch (e) { status.textContent = e.message || 'Messages are unavailable.'; }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = body.value.trim();
        if (!text) return;
        const b = form.querySelector('button');
        b.disabled = true;
        status.textContent = 'Sending…';
        try {
            const r = await fetch('/api/messages/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text }) });
            const d = await r.json();
            if (!r.ok) throw Error(d.message);
            body.value = '';
            await load();
            status.textContent = 'Sent';
        } catch (e2) { status.textContent = e2.message || 'Could not send message.'; }
        finally { b.disabled = false; }
    });

    list.addEventListener('click', async (e) => {
        const data = e.target.dataset || {};
        if (data.more) {
            if (expanded.has(data.more)) expanded.delete(data.more); else expanded.add(data.more);
            render(latest);
            return;
        }
        const edit = data.edit;
        const del = data.del;
        if (!edit && !del) return;
        e.preventDefault();
        try {
            if (del) {
                if (!await v2Confirm('Delete this message? This cannot be undone.')) return;
                const r = await fetch(`/api/messages/thread/${encodeURIComponent(del)}`, { method: 'DELETE' });
                const d = await r.json();
                if (!r.ok) throw Error(d.message);
                status.textContent = 'Deleted.';
            } else {
                const current = (bodies.get(String(edit)) || '').trim();
                const next = await v2EditPrompt('Edit your message', current);
                if (next === null) return;
                const trimmed = next.trim();
                if (!trimmed || trimmed === current) return;
                const r = await fetch(`/api/messages/thread/${encodeURIComponent(edit)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: trimmed }) });
                const d = await r.json();
                if (!r.ok) throw Error(d.message);
                status.textContent = 'Edited.';
            }
            await load();
        } catch (err) { status.textContent = err.message || 'That action failed.'; }
    });

    function v2Confirm(text) {
        return new Promise((res) => {
            if (!window.V2 || !V2.modal) { res(window.confirm(text)); return; }
            V2.modal({
                label: 'Delete message', title: 'Delete message', body: text,
                actions: [{ label: 'Delete', primary: true, onClick: () => res(true) }, { label: 'Cancel', onClick: () => res(false) }],
                onDismiss: () => res(false)
            });
        });
    }
    function v2EditPrompt(title, current) {
        return new Promise((res) => {
            if (!window.V2 || !V2.modal) { res(window.prompt(title, current)); return; }
            const m = V2.modal({
                label: title, title: title,
                bodyHtml: '<textarea id="v2-msg-edit" class="input" maxlength="4000" rows="4" style="width:100%;resize:vertical;"></textarea>',
                actions: [
                    { label: 'Save', primary: true, onClick: (close) => { const v = document.getElementById('v2-msg-edit').value.trim(); close(); res(v || null); } },
                    { label: 'Cancel', onClick: () => res(null) }
                ],
                onDismiss: () => res(null)
            });
            const t = m.el.querySelector('#v2-msg-edit');
            t.value = current;
            t.focus();
            t.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); m.el.querySelector('.v2-modal-btn-primary').click(); }
            });
        });
    }

    if (window.V2) { V2.nav(''); V2.footer(); }
    // On the profile page the thread sits in a section that may be closed:
    // fetch when it is first opened rather than on every profile visit.
    const host = document.getElementById('messages-details');
    if (!host || host.open) { load(); }
    else { host.addEventListener('toggle', function () { if (host.open) load(); }, { once: true }); }
})();
