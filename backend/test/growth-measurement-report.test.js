'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport, sanitizeSnapshot } = require('../../scripts/report-growth-measurement');

const windowEnd = new Date('2026-08-11T00:00:00.000Z');

function row(eventName, occurredAt, extra = {}) {
    return {
        eventName,
        schemaVersion: 'growth-measurement-v1',
        eventId: `${eventName}-${occurredAt}`,
        occurredAt,
        reportable: true,
        anonymousId: 'anon-123456789012',
        sessionId: `session-${occurredAt.slice(11, 13)}`,
        firstTouch: { source: 'x', contentId: 'x-20260801-post-01' },
        lastNonDirectTouch: { source: 'x', contentId: 'x-20260801-post-01' },
        ...extra
    };
}

test('report separates visitors, sessions, signups, activation and paid truth', () => {
    const rows = [
        row('page_view', '2026-08-01T00:00:00.000Z', { sessionId: 'session-a', pagePath: '/compare' }),
        row('appsumo_outbound_clicked', '2026-08-01T00:01:00.000Z', { sessionId: 'session-a', ctaId: 'compare-appsumo', pagePath: '/compare', contentId: 'x-20260801-post-01' }),
        row('signup_completed', '2026-08-01T00:02:00.000Z', { sessionId: 'session-a', userId: 'user-1', pagePath: '/register' }),
        row('activation_completed', '2026-08-02T00:02:00.000Z', { sessionId: 'session-b', userId: 'user-1', pagePath: '/stocks/AAPL' }),
        row('invoice_paid', '2026-08-10T00:02:00.000Z', { sessionId: 'session-c', userId: 'user-1', pagePath: '/pricing' })
    ];
    const report = buildReport(rows, { days: 28, until: windowEnd });
    assert.equal(report.current.uniqueVisitors, 1);
    assert.equal(report.current.uniqueSessions, 3);
    assert.equal(report.current.signups, 1);
    assert.equal(report.current.activatedAccounts, 1);
    assert.equal(report.current.paidCustomers, 1);
    assert.equal(report.current.stripe.paidConversions, 1);
    assert.equal(report.current.stripe.activeMrr, null);
    assert.equal(report.current.ctas['compare-appsumo'].clicks, 1);
    assert.equal(report.current.content['x:x-20260801-post-01'].activations, 1);
    assert.equal(report.current.retention.D1.eligible, 1);
});

test('external snapshots are allowlisted and cannot carry PII', () => {
    const snapshot = sanitizeSnapshot({ activeUsers: 4, firstUserSource: [{ source: 'x', users: 2 }], email: 'do-not-keep@example.com', userId: 'raw-id', prompt: 'private' });
    assert.equal(snapshot.activeUsers, 4);
    assert.deepEqual(snapshot.firstUserSource, [{ source: 'x', users: 2 }]);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'email'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'userId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'prompt'), false);
});
