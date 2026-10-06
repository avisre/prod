#!/usr/bin/env node
'use strict';
// Sweep every issuer's stored segment groups through the same selection and
// naming the company page uses, and report what a reader would see. Exits
// non-zero when a name is not in plain words or a shown breakdown does not
// account for revenue. Read-only; no network.
const fs = require('fs');
const path = require('path');
const store = require('../backend/sec-segment-observations');

function audit(dir = path.join(require('../backend/sec-coverage').DATA_DIR, 'sec-financials')) {
    const out = { issuers: 0, withGroups: 0, shown: 0, withheld: 0, olderPeriod: 0, overRevenue: 0, longLists: 0, mergedNames: 0, failures: [] };
    for (const file of fs.readdirSync(dir)) {
        let data;
        try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (_) { continue; }
        out.issuers++;
        const groups = data.segmentObservations || [];
        if (!groups.length) continue;
        out.withGroups++;
        const group = store.preferred(groups).usable;
        if (!group) { out.withheld++; continue; }
        out.shown++;
        const { rows, coverage } = store.shown(group), byMember = new Map(group.entries.map(e => [e.member, e]));
        const names = rows.map(r => store.displayName(byMember.get(r.member)));
        if (group.periodEnd < groups.map(g => g.periodEnd).sort().pop()) out.olderPeriod++;
        if (coverage > 1.02) out.overRevenue++;
        if (rows.length > 8) out.longLists++;
        if (new Set(names).size !== names.length) out.mergedNames++;
        const who = `${data.issuerName} [${file.replace('.json', '')}]`;
        for (const name of names) if (!name || /:|_|Member$/.test(name)) out.failures.push(`${who}: name "${name}"`);
        if (rows.length < 2 || coverage < 0.9 || coverage > 1.1) out.failures.push(`${who}: ${rows.length} rows covering ${(coverage * 100).toFixed(0)}%`);
    }
    return out;
}

if (require.main === module) {
    const result = audit();
    console.log(JSON.stringify({ ...result, failures: result.failures.length, sample: result.failures.slice(0, 20) }, null, 2));
    process.exit(result.failures.length ? 1 : 0);
}
module.exports = { audit };
