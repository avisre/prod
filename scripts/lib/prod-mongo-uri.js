'use strict';
// Reads MONGODB_URI out of backend/.env into a local value for the operator
// scripts that must talk to production (backup, storage report). It never
// touches process.env and never prints the URI: see the dotenv rule in
// CLAUDE.md and scripts/lib/dev-env.js for why.
const fs = require('fs');
const path = require('path');

function prodMongoUri(envFile = path.join(__dirname, '..', '..', 'backend', '.env')) {
    const text = fs.readFileSync(envFile, 'utf8');
    const match = text.match(/^\s*MONGODB_URI\s*=\s*(.*)$/m);
    const uri = match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
    if (!/^mongodb(\+srv)?:\/\//.test(uri)) throw new Error(`No MONGODB_URI in ${envFile}`);
    return uri;
}

// Host and database only, for log lines.
function describeUri(uri) {
    const u = new URL(uri);
    return `${u.hostname}${u.pathname}`;
}

module.exports = { prodMongoUri, describeUri };
