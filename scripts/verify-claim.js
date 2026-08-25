#!/usr/bin/env node
'use strict';

// Thin CLI wrapper over the existing claim-verification path in backend/verify.js
// (the same detectLie() the /api/verify route calls). It adds no verification
// logic of its own — argument parsing and printing only, so the CLI and the web
// route can never disagree about a verdict.
//
//   node scripts/verify-claim.js --ticker TGT --claim "TGT posts operational breakout, EPS $4.11"
//   node scripts/verify-claim.js --ticker WMT --claim "Walmart revenue hits $187.9B in Q2" --json
//
// --ticker is optional when the claim text contains a recognisable ticker;
// detectLie() extracts one itself and errors clearly when it cannot.

const verifyHeadline = require('../backend/verify');

function parseArgs(argv) {
    const out = { ticker: null, claim: null, metric: 'revenue', json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') out.json = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--ticker' || a === '-t') out.ticker = argv[++i];
        else if (a === '--claim' || a === '-c') out.claim = argv[++i];
        else if (a === '--metric' || a === '-m') out.metric = argv[++i];
        else if (a.startsWith('--ticker=')) out.ticker = a.slice(9);
        else if (a.startsWith('--claim=')) out.claim = a.slice(8);
        else if (a.startsWith('--metric=')) out.metric = a.slice(9);
        else if (!a.startsWith('-') && !out.claim) out.claim = a;
    }
    return out;
}

const USAGE = `verify-claim — check a headline claim against the filed number.

Usage:
  node scripts/verify-claim.js --ticker TGT --claim "TGT EPS $4.11 operational breakout"

Options:
  -t, --ticker SYMBOL   US ticker. Optional if the claim text names one.
  -c, --claim  TEXT     The claim/headline to check. Must contain a $ figure.
  -m, --metric NAME     Metric to compare (default: revenue).
      --json            Print the raw result object instead of the report.
  -h, --help            This message.

Exit codes: 0 claim matches the filing · 2 claim differs from the filing
            1 could not verify (bad input, no filed data, no ticker).`;

function fmt(value) {
    if (value == null || !Number.isFinite(value)) return 'n/a';
    const abs = Math.abs(value);
    if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
    return `$${value.toFixed(2)}`;
}

function report(r) {
    const lines = [];
    lines.push(`Ticker:  ${r.ticker}`);
    lines.push(`Period:  ${r.period}`);
    lines.push(`Claimed: ${r.pr.raw}${r.pr.label ? ` (${r.pr.label})` : ''}`);
    lines.push(`Filed:   ${fmt(r.filed.value)} ${r.filed.currency || ''}`.trim());
    if (Number.isFinite(r.diffPct)) lines.push(`Delta:   ${fmt(r.diff)} (${r.diffPct.toFixed(2)}%)`);
    lines.push('');
    lines.push(`VERDICT: ${r.verdict}`);
    if (r.filed.sourceUrl) lines.push(`Source:  ${r.filed.sourceUrl}`);
    else if (r.filed.source) lines.push(`Source:  ${r.filed.source}`);
    for (const w of r.warnings || []) lines.push(`WARNING: ${w}`);
    return lines.join('\n');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.claim) {
        console.log(USAGE);
        process.exit(args.help ? 0 : 1);
    }
    let result;
    try {
        result = await verifyHeadline.detectLie({ prText: args.claim, ticker: args.ticker, metric: args.metric });
    } catch (err) {
        console.error(`Could not verify: ${err.message}`);
        process.exit(1);
    }
    console.log(args.json ? JSON.stringify(result, null, 2) : report(result));
    // A claim that disagrees with the filing is a real finding, not a failure —
    // exit 2 so a script can branch on it without parsing the text.
    process.exit(/differ/i.test(result.verdict) ? 2 : 0);
}

main().catch((err) => { console.error(`verify-claim failed: ${err.message}`); process.exit(1); });
