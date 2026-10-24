'use strict';
const obs=require('./company-observations');
const RULES={netMarginPct:['netIncome','totalRevenue','ratio'],grossMarginPct:['grossProfit','totalRevenue','ratio'],opMarginPct:['operatingIncome','totalRevenue','ratio'],rdIntensityPct:['researchAndDevelopment','totalRevenue','ratio'],freeCashflow:['operatingCashflow','capitalExpenditures','free_cash']};
function compatible(a,b) {
 return a && b && obs.validSupplement(a,a.issuer) && obs.validSupplement(b,a.issuer) && ['issuer','currency','unit','periodStart','periodEnd','basis','accountingBasis','scope','sourceType','sourceName'].every(k=>a[k]===b[k]) && JSON.stringify([...new Set(a.sourceVersions || [])].sort())===JSON.stringify([...new Set(b.sourceVersions || [])].sort());
}
function value(a,b,rule){return rule==='ratio'?b.value>0?a.value/b.value*100:null:a.value-Math.abs(b.value);}
// compatible() needs every one of these equal, so a bucket on them holds every
// candidate partner; scanning all facts per fact took ~1s for a large filer.
const PAIR_KEYS=['issuer','currency','unit','periodStart','periodEnd','basis','accountingBasis','scope','sourceType','sourceName'];
const pairKey=f=>JSON.stringify(PAIR_KEYS.map(k=>f[k]));
function calculate(facts) {
 const output=[],partners=new Map();
 for(const f of facts)if(f.state==='available'){const key=f.field+'|'+pairKey(f);if(!partners.has(key))partners.set(key,[]);partners.get(key).push(f);}
 for(const [field,[left,right,rule]]of Object.entries(RULES))for(const a of facts.filter(f=>f.field===left && f.state==='available')) {
  const b=(partners.get(right+'|'+pairKey(a)) || []).find(f=>compatible(a,f));if(!b)continue;
  const result=value(a,b,rule);
  output.push({...a,field,definition:rule==='ratio'?left+' divided by compatible reported revenue, percent':'Operating cash flow minus the magnitude of reported capital expenditure',value:result,unit:rule==='ratio'?'%':a.unit,sourceType:'calculation',sourceOrigin:a.sourceType,verificationMethod:'compatible_calculation',formula:rule==='ratio'?'numerator / denominator * 100':'operatingCashflow - abs(capitalExpenditures)',inputs:[a,b],sourceIds:result===null?[]:[...new Set([...a.sourceIds,...b.sourceIds])],state:result===null?'undefined_calculation':'available',remainingReason:result===null?'A non-positive revenue denominator makes this calculation undefined':null});
 }
 return output;
}
function validCalculation(c) {
 const rule=RULES[c?.field];if(!rule || c.verificationMethod!=='compatible_calculation' || c.inputs?.length!==2 || !compatible(...c.inputs))return false;
 const [a,b]=c.inputs;return a.field===rule[0] && b.field===rule[1] && c.value===value(a,b,rule[2]) && c.unit===(rule[2]==='ratio'?'%':a.unit) && c.periodEnd===a.periodEnd && c.currency===a.currency && c.accountingBasis===a.accountingBasis && c.sourceIds?.length>0 && ['issuer','periodStart','periodEnd','basis','accountingBasis','scope','currency'].every(k=>c[k]===a[k]) && c.state==='available' && JSON.stringify([...new Set(c.sourceIds)].sort())===JSON.stringify([...new Set([...a.sourceIds,...b.sourceIds])].sort());
}
module.exports={calculate,validCalculation,compatible,RULES};
