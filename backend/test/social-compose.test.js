'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const social = require('../../scripts/social-compose');

test('social queue drafts have platform-safe tracked links and current sources', async () => {
    for (const id of ['x-20260729-shares-main', 'x-20260729-shares-cta', 'linkedin-20260729-shares']) {
        const draft = social.loadDraft(id);
        const checked = await social.validateDraft(draft);
        assert.equal(checked.id, id);
        assert.ok(checked.text.length <= social.MAX_CHARS[checked.platform]);
    }
});

test('social safeguards reject unapproved or mismatched drafts', async () => {
    const draft = social.loadDraft('x-20260729-shares-main');
    await assert.rejects(() => social.validateDraft({ ...draft, approved: false }), /not marked approved/);
    await assert.rejects(() => social.validateDraft({ ...draft, ctaUrl: draft.ctaUrl.replace('source=x', 'source=linkedin') }), /CTA source/);
    await assert.rejects(() => social.validateDraft({ ...draft, contentId: 'tool-unknown' }), /allowlisted/);
});

test('composer source contains no automated publish click', () => {
    const fs = require('node:fs');
    const source = fs.readFileSync(require.resolve('../../scripts/social-compose'), 'utf8');
    assert.doesNotMatch(source, /\.click\s*\(/);
    assert.match(source, /never clicks it/);
});
