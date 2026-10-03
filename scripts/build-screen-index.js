#!/usr/bin/env node
'use strict';
// One builder publishes a matching pair; never rebuild from a request.
const {build}=require('./build-public-stock-index');
const {screenSnapshot}=build();
console.log(`Screenable verified stock listings: ${screenSnapshot.count}`);
