#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { weekOf, CYCLE_FILE } = require('../backend/watchdog-weekly');

function writeCycle(asOf, file = CYCLE_FILE) {
    const cycle = { schemaVersion: 1, asOf, weekOf: weekOf(asOf) };
    fs.writeFileSync(file, JSON.stringify(cycle, null, 2) + '\n');
    return cycle;
}

module.exports = { writeCycle };
if (require.main === module) {
    try { console.log(JSON.stringify(writeCycle(process.env.FINANCIAL_AS_OF))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
