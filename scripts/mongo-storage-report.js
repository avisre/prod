#!/usr/bin/env node
'use strict';
// Read-only storage report for the production MongoDB: what every collection
// is, how much of the Atlas free-tier 512 MB it uses (logical data + indexes,
// which is what Atlas counts), and what deleting it would cost. Deletes nothing.
//
//   node scripts/mongo-storage-report.js [--out=FILE.md]
const fs = require('fs');
const { MongoClient } = require('../backend/node_modules/mongodb');
const { prodMongoUri, describeUri } = require('./lib/prod-mongo-uri');

// kind: customer = people's accounts, money, holdings, messages (never delete
// without a backup); cache = rebuilt on demand from SEC/EDGAR, Yahoo or the AI
// model; log = analytics/usage history; orphan = nothing reads it any more.
const KNOWN = {
    users: ['customer', 'Accounts: login, plan, billing state'],
    pendingsignups: ['customer', 'Unconfirmed signups (self-expiring TTL)'],
    customer_message_threads: ['customer', 'Support/inbox threads'],
    customer_messages: ['customer', 'Support/inbox messages'],
    customer_message_broadcasts: ['customer', 'Broadcast messages sent to customers'],
    dossier_views: ['customer', 'Which dossiers each user opened (quota)'],
    monitor_views: ['customer', 'Which monitor pages each user opened (quota)'],
    ask_reports: ['customer', 'Saved Ask answers/reports'],
    ask_threads: ['customer', 'Ask chat history (has a full-text index)'],
    customer_lifecycle_events: ['customer', 'Trial/paid/cancel lifecycle history'],
    scheduled_emails: ['customer', 'Queued customer emails'],
    public_research_shares: ['customer', 'Public share links users created'],
    ask_trial_leads: ['customer', 'Trial leads from Ask'],
    manual_gmv_snapshots: ['customer', 'Revenue (GMV) snapshots entered by hand'],
    supporttickets: ['customer', 'Support tickets'],
    stocks: ['customer', 'Portfolio holdings'],
    portfolios: ['customer', 'Portfolio names/lists'],
    watchlists: ['customer', 'Watchlists'],
    appsumolicenses: ['customer', 'AppSumo licence redemptions'],
    appsumo_licenses: ['orphan', 'Probably an older/empty duplicate of appsumolicenses (only a report script reads it)'],
    grandfathered_licences: ['customer', 'Grandfathered lifetime licences'],
    ai_chat_feedback: ['customer', 'Thumbs up/down on AI answers'],
    trades: ['customer', 'Trades for the wash-sale guard'],
    theses: ['customer', 'Investment theses users wrote'],
    alertrules: ['customer', 'Smart alert rules'],
    alerts: ['customer', 'Alerts delivered to users (capped per user in code)'],
    watchstates: ['cache', 'Last-seen filing state per watched symbol'],
    filing_watch_seats: ['customer', 'Filing-watch seats'],
    affiliate_profiles: ['customer', 'Affiliate accounts'],
    affiliate_referral_clicks: ['customer', 'Affiliate clicks'],
    affiliate_referral_orders: ['customer', 'Affiliate orders'],
    affiliate_commissions: ['customer', 'Affiliate commissions owed/paid'],
    affiliate_payout_batches: ['customer', 'Affiliate payouts'],
    affiliate_audit_events: ['customer', 'Affiliate audit trail'],
    affiliate_processed_webhook_events: ['customer', 'Webhook idempotency records'],
    dealmirror_batches: ['customer', 'DealMirror code batches'],
    dealmirror_licences: ['customer', 'DealMirror licences'],
    dealmirror_imports: ['customer', 'DealMirror imports'],
    dealmirror_audit_events: ['customer', 'DealMirror audit trail'],
    ai_paper_portfolios: ['customer', 'AI paper-portfolio state'],
    ai_paper_decisions: ['customer', 'AI paper-portfolio decisions'],
    ai_paper_snapshots: ['customer', 'AI paper-portfolio daily snapshots'],
    credit_ledger: ['customer', 'Billing credit ledger'],
    credit_plan_snapshots: ['customer', 'Credit plan snapshots'],
    api_keys: ['customer', 'API keys users created'],
    oauth_clients: ['customer', 'Registered OAuth (connector) clients'],
    oauth_codes: ['log', 'OAuth codes: expiry only checked in code, expired ones pile up'],
    oauth_tokens: ['customer', 'OAuth tokens for connectors (expired ones pile up)'],
    saved_screens: ['customer', 'Saved screener screens'],
    briefing_subscribers: ['customer', 'Briefing email subscribers'],
    personal_memory: ['customer', 'Per-user Ask memory'],
    outreach_suppression: ['customer', 'Unsubscribe list: must keep'],
    outreach_sends: ['log', 'Outreach emails sent'],
    digest_deliveries: ['log', 'Digest emails delivered'],
    prepared_emails: ['customer', 'Prepared emails'],
    appsumo_portal_sales: ['customer', 'AppSumo sales imported from the portal'],
    campaign_outreach: ['log', 'Activation campaign outreach log'],
    filing_text: ['cache', 'Raw SEC filing text (refetched from EDGAR; meant to expire after 30 days)'],
    filing_reports: ['cache', 'AI summaries of filings (rebuilt with AI calls)'],
    filing_diffs: ['cache', 'AI filing-to-filing diffs (rebuilt with AI calls)'],
    company_dossiers: ['cache', 'AI research dossiers (rebuilt with AI calls)'],
    company_keypoints: ['cache', 'AI key points per company (rebuilt with AI calls)'],
    company_insights: ['cache', 'Company insights (7-day freshness)'],
    company_segments: ['cache', 'Segment data (rebuilt from filings)'],
    company_unit_economics: ['cache', 'Unit-economics extracts'],
    company_off_balance: ['cache', 'Off-balance-sheet extracts'],
    industry_context: ['cache', 'Industry context'],
    ask_segments_v2: ['cache', 'Ask segment evidence'],
    ask_segments_v1: ['orphan', 'Old version of ask_segments_v2: nothing reads it'],
    ask_report_cache: ['cache', 'Ask answer cache (12-hour freshness)'],
    ask_macro_cache: ['cache', 'Macro data cache (3-hour freshness)'],
    guru_portfolios: ['cache', '13F guru portfolios (24-hour freshness)'],
    insider_form4: ['cache', 'Insider Form 4 trades (smart alerts read it)'],
    insider_form4_meta: ['cache', 'Insider Form 4 fetch state'],
    sec_filing_index: ['cache', 'SEC filing index (7-day freshness)'],
    sec_share_history: ['cache', 'SEC share-count history'],
    sec_ticker_map: ['cache', 'SEC ticker to CIK map'],
    sec_fund_series_map: ['cache', 'SEC fund series map'],
    sec_cik_overrides: ['customer', 'Hand-curated CIK overrides: keep'],
    fund_fees: ['cache', 'Fund fees (60-day TTL)'],
    fund_holdings: ['cache', 'Fund holdings (7-day TTL)'],
    technicals_snapshot: ['cache', 'Technicals snapshot'],
    public_financial_requests: ['cache', 'Public financial request cache (capped 64 MB)'],
    public_financial_rate_limits: ['cache', 'SEC throttle state (1 doc)'],
    dossier_build_locks: ['cache', 'Dossier build locks (TTL)'],
    funnel_events: ['log', 'Funnel/analytics events (growth reports read it)'],
    ai_chat_log: ['log', 'Ask chat log (last 8 turns per user)'],
    ai_chat_usage: ['log', 'Ask monthly quota counters'],
    connector_refusals: ['log', 'Refused connector calls'],
    mcp_calls: ['log', 'Connector call log (90-day TTL)'],
    ollama_usage_events: ['log', 'AI usage events (30-day TTL)'],
    company_breadth: ['log', 'Company page breadth stats (30-day TTL)'],
    monitor_free_usage: ['log', 'Free monitor usage counters (TTL)'],
    keypoint_free_usage: ['log', 'Free key-point usage counters (TTL)'],
    insights_anon_usage: ['log', 'Anonymous insights usage counters (TTL)'],
    mcp_free_usage: ['log', 'Free connector usage counters'],
    mcp_trial_usage: ['log', 'Trial connector usage counters'],
    verify_checks: ['log', 'Verification checks'],
    boot_migrations: ['cache', 'Startup migration markers'],
    ask_memories: ['orphan', 'Legacy: migrated to personal_memory and dropped at startup']
};

const mb = (n) => (n / 1048576).toFixed(2);
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');

async function main() {
    const uri = prodMongoUri();
    const client = new MongoClient(uri, { readPreference: 'secondaryPreferred', serverSelectionTimeoutMS: 20000 });
    await client.connect();
    const db = client.db();
    const dbStats = await db.stats();
    const infos = (await db.listCollections({}, { nameOnly: false }).toArray()).filter((c) => c.type === 'collection');
    const rows = [];
    for (const info of infos) {
        const coll = db.collection(info.name);
        let s = {};
        try {
            const [r] = await coll.aggregate([{ $collStats: { storageStats: { scale: 1 } } }]).toArray();
            s = r.storageStats || {};
        } catch (e) {
            s = { error: e.message };
        }
        const indexes = await coll.indexes().catch(() => []);
        const ttl = indexes.filter((i) => i.expireAfterSeconds !== undefined).map((i) => `${Object.keys(i.key)[0]} ${Math.round(i.expireAfterSeconds / 86400)}d`);
        // Age from ObjectId _ids when the collection uses them.
        let oldest = null, newest = null;
        try {
            const first = await coll.find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(1).next();
            const last = await coll.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).next();
            if (first?._id?.getTimestamp) oldest = first._id.getTimestamp().toISOString().slice(0, 10);
            if (last?._id?.getTimestamp) newest = last._id.getTimestamp().toISOString().slice(0, 10);
        } catch (_) {}
        const [kind, what] = KNOWN[info.name] || ['unknown', 'Not referenced by any model I mapped; check before deleting'];
        rows.push({
            name: info.name, kind, what,
            count: s.count ?? null, data: s.size || 0, index: s.totalIndexSize || 0, storage: s.storageSize || 0,
            avg: s.avgObjSize || 0, capped: !!(info.options && info.options.capped), ttl, oldest, newest, error: s.error
        });
    }
    await client.close();
    rows.sort((a, b) => (b.data + b.index) - (a.data + a.index));
    const total = rows.reduce((t, r) => t + r.data + r.index, 0);

    const lines = [];
    lines.push(`# MongoDB storage report: ${describeUri(uri)}`);
    lines.push('');
    lines.push(`Generated ${new Date().toISOString()}. Atlas free tier counts logical data + indexes against 512 MB.`);
    lines.push(`dbStats: dataSize ${mb(dbStats.dataSize)} MB, indexSize ${mb(dbStats.indexSize)} MB, total ${mb(dbStats.dataSize + dbStats.indexSize)} MB of 512 MB (${((dbStats.dataSize + dbStats.indexSize) / (512 * 1048576) * 100).toFixed(1)}%); ${dbStats.collections} collections, ${dbStats.objects} documents.`);
    lines.push('');
    lines.push('| # | Collection | Kind | What it is | Docs | Data MB | Index MB | Total MB | % of used | Oldest | Newest | Expiry |');
    lines.push('|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|');
    rows.forEach((r, i) => {
        const expiry = r.capped ? 'capped' : (r.ttl.length ? `TTL ${r.ttl.join(', ')}` : 'none');
        lines.push(`| ${i + 1} | \`${r.name}\` | ${r.kind} | ${r.what}${r.error ? ` (stats error: ${r.error})` : ''} | ${r.count ?? '?'} | ${mb(r.data)} | ${mb(r.index)} | ${mb(r.data + r.index)} | ${total ? ((r.data + r.index) / total * 100).toFixed(1) : '0'}% | ${r.oldest || ''} | ${r.newest || ''} | ${expiry} |`);
    });
    const byKind = {};
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + r.data + r.index;
    lines.push('');
    lines.push('By kind: ' + Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${mb(v)} MB`).join(', '));
    const text = lines.join('\n') + '\n';
    const out = arg('out');
    if (out) fs.writeFileSync(out, text, { mode: 0o600 });
    process.stdout.write(text);
}

main().catch((e) => { console.error('report failed:', e.message); process.exit(1); });
