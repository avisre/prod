#!/usr/bin/env node
'use strict';
// One builder publishes a matching pair; never rebuild from a request.
const {buildParallel}=require('./build-public-stock-index');
buildParallel().then(({screenSnapshot})=>console.log(`Screenable verified stock listings: ${screenSnapshot.count}`),e=>{console.error(e.message);process.exitCode=1;});
