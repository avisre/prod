'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport, dataQuality, sanitizeSnapshot } = require('../../scripts/report-growth-measurement');

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
        row('activation_completed', '2026-08-02T00:02:00.000Z', { sessionId: 'session-b', userId: 'user-1', pagePath: '/stocks/AAPL', dedupeKey: 'activation_completed:user-1' }),
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

test('account activation counts only the canonical dedupe key, never per-feature rows', () => {
    const rows = [
        row('activation_completed', '2026-08-02T00:00:00.000Z', { sessionId: 's1', userId: 'user-1', dedupeKey: 'activation_completed:user-1' }),
        row('activation_completed', '2026-08-03T00:00:00.000Z', { sessionId: 's2', userId: 'user-1', dedupeKey: 'activation-job:user-1:dossier' }),
        row('feature_activation_completed', '2026-08-04T00:00:00.000Z', { sessionId: 's3', userId: 'user-1', dedupeKey: 'activation-job:user-1:filing_monitor' }),
        row('briefing_viewed', '2026-08-05T00:00:00.000Z', { sessionId: 's4', userId: 'user-1', dedupeKey: 'briefing_viewed:user-1:2026-08-05' })
    ];
    const report = buildReport(rows, { days: 28, until: windowEnd });
    assert.equal(report.current.activatedAccounts, 1);
    assert.equal(report.current.eventCounts.activation_completed, 2, 'raw event counts still reflect the historical row name');
    assert.equal(report.current.eventCounts.feature_activation_completed, 1);
    assert.equal(report.current.eventCounts.briefing_viewed, 1);
    assert.equal(report.current.landingPages['/'].activations, 1);
    assert.equal(report.current.retention.D1.eligible, 1);
});

test('retention counts meaningful action events, never generic visits', () => {
    const rows = [
        row('activation_completed', '2026-08-02T00:00:00.000Z', { sessionId: 's1', userId: 'user-1', dedupeKey: 'activation_completed:user-1' }),
        // The D1 target day for a 2026-08-02 activation is 2026-08-03. A visit
        // and a pricing view on that day are intent, not product use.
        row('page_view', '2026-08-03T09:00:00.000Z', { sessionId: 's2', userId: 'user-1' }),
        row('pricing_viewed', '2026-08-03T10:00:00.000Z', { sessionId: 's3', userId: 'user-1' })
    ];
    let report = buildReport(rows, { days: 28, until: windowEnd });
    assert.equal(report.current.retention.D1.eligible, 1);
    assert.equal(report.current.retention.D1.returned, 0, 'a generic visit is not a return');

    rows.push(row('briefing_viewed', '2026-08-03T11:00:00.000Z', { sessionId: 's4', userId: 'user-1', dedupeKey: 'briefing_viewed:user-1:2026-08-03' }));
    report = buildReport(rows, { days: 28, until: windowEnd });
    assert.equal(report.current.retention.D1.returned, 1, 'a meaningful action on the target day counts');
});

test('data-quality client/server event counts include the new repeat-use events', () => {
    const quality = dataQuality([
        row('dossier_mode_selected', '2026-08-05T00:00:00.000Z'),
        row('feature_activation_completed', '2026-08-05T00:01:00.000Z'),
        row('briefing_viewed', '2026-08-05T00:02:00.000Z'),
        row('dossier_viewed', '2026-08-05T00:03:00.000Z'),
        row('filing_monitor_viewed', '2026-08-05T00:04:00.000Z')
    ]);
    assert.equal(quality.clientServerCounts.browserIntentEvents, 1);
    assert.equal(quality.clientServerCounts.serverTruthEvents, 4);
});

test('Dossier and Monitor views count as meaningful returns, but only on the target day', () => {
    const rows = [
        row('activation_completed', '2026-08-02T00:00:00.000Z', { sessionId: 's1', userId: 'user-1', dedupeKey: 'activation_completed:user-1' }),
        row('dossier_viewed', '2026-08-03T09:00:00.000Z', { sessionId: 's2', userId: 'user-1', dedupeKey: 'dossier_viewed:user-1:2026-08-03' }),
        row('filing_monitor_viewed', '2026-08-03T10:00:00.000Z', { sessionId: 's3', userId: 'user-1', dedupeKey: 'filing_monitor_viewed:user-1:2026-08-03' })
    ];
    const report = buildReport(rows, { days: 28, until: windowEnd });
    assert.equal(report.current.retention.D1.eligible, 1);
    assert.equal(report.current.retention.D1.returned, 1);
});

test('external snapshots are allowlisted and cannot carry PII', () => {
    const snapshot = sanitizeSnapshot({ activeUsers: 4, firstUserSource: [{ source: 'x', users: 2 }], email: 'do-not-keep@example.com', userId: 'raw-id', prompt: 'private' });
    assert.equal(snapshot.activeUsers, 4);
    assert.deepEqual(snapshot.firstUserSource, [{ source: 'x', users: 2 }]);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'email'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'userId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'prompt'), false);
});
