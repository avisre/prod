#!/usr/bin/env node
// Leak gate for the PUBLIC plugin repo, adapted from
// /Users/drasharaghavan/prod/mcp-server/scripts/no-leak-check.js.
//
// Adapted, not copied, and the difference matters: that gate also refuses
// /anthropic|claude-\d/, which is correct for the npm bridge (a client-agnostic
// package has no business naming any vendor) but wrong here — this plugin IS a
// Claude plugin, so "Claude" and "claude.ai" appear legitimately and must not
// fail. What stays refused is the actual trade secret: the AI provider behind
// the hosted Ask, plus every secret class.

const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
if (!root) {
    console.error('usage: no-leak-check.js <plugin-root>');
    process.exit(2);
}

const PATTERNS = [
    { what: 'AI provider identity', re: /\bollama\b|\bglm[-_ ]?\d|\bzhipu\b|\bmoonshot\b|\bdeepseek\b|\bminimax\b|\bqwen\b|\bmistral\b|\bgemini\b/i },
    { what: 'model ids / keys', re: /\bsk-[a-z0-9]{8,}|OLLAMA_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY/i },
    { what: 'payment secrets', re: /sk_live_|sk_test_|STRIPE_SECRET|whsec_/ },
    { what: 'database / session secrets', re: /mongodb(\+srv)?:\/\/|MONGODB_URI|JWT_SECRET|SESSION_SECRET/ },
    { what: 'backend internals', re: /free-tools\.js|asset-profile\.js|ai-chat\.js|ai-client\.js|mcp-endpoint\.js/ },
    // The one path a listing must never point at: avisre/prod is public and
    // names the provider in backend/ai-client.js and CLAUDE.md.
    { what: 'a link to the avisre/prod repo', re: /avisre\/prod/i },
];

const SKIP_DIRS = new Set(['.git', 'node_modules']);

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

let failures = 0;
let scanned = 0;
for (const file of walk(root)) {
    let source;
    try {
        source = fs.readFileSync(file, 'utf8');
    } catch {
        continue;   // binary
    }
    scanned++;
    for (const { what, re } of PATTERNS) {
        const hit = source.match(re);
        if (hit) {
            console.error(`::error:: ${path.relative(root, file)} leaks ${what}: ${JSON.stringify(hit[0])}`);
            failures++;
        }
    }
}

if (failures) {
    console.error(`\nFAIL — ${failures} leak(s) in ${scanned} files. This repo is public; nothing above may ship.`);
    process.exit(1);
}
console.log(`OK — ${scanned} files scanned, no provider identity, secrets, or backend internals.`);
