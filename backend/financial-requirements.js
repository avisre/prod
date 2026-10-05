'use strict';
const {profile}=require('./ask-industry-profile');
const fields={bank:['totalRevenue','netInterestIncome','nonInterestIncome','loans','deposits','netInterestMargin','capitalRatios'],reit:['shortLongTermDebtTotal','ffo','affo','occupancy'],insurer:['premiums','investmentIncome','combinedRatio','lossRatio'],software:['shareBasedCompensation','operatingCashflow','arr'],'semis-hardware':['researchAndDevelopment','grossProfit','operatingIncome'],'pharma-biotech':['researchAndDevelopment','grossProfit','operatingIncome'],consumer:['inventory','operatingCashflow','comparableSales'],energy:['capitalExpenditures','operatingCashflow','shortLongTermDebtTotal'],utility:['capitalExpenditures','operatingCashflow','shortLongTermDebtTotal'],industrial:['capitalExpenditures','operatingCashflow','shortLongTermDebtTotal']};
function requirements(overview={},sic) {
 let archetype;try{archetype=profile(overview.Industry,overview.Sector)?.archetype;}catch(_){}
 const code=String(sic || '');
 if(/^(602|603|609)/.test(code))archetype='bank';
 else if(/^63/.test(code))archetype='insurer';
 else if(code==='6798')archetype='reit';
 else if(!archetype || archetype==='generic'){
  if(/^283[3-6]$/.test(code))archetype='pharma-biotech';
  else if(/^367[24]$|^357[0-9]$/.test(code))archetype='semis-hardware';
  else if(code==='7372')archetype='software';
  else if(/^49/.test(code) && !/^495/.test(code))archetype='utility';
  else if(/^13|^2911$/.test(code))archetype='energy';
  else if(/^(20|21|23|25|31|5[2-9])/.test(code))archetype='consumer';
  else if(/^(1[024-7]|2[246-9]|3[023-9])/.test(code))archetype='industrial';
 }
 if(!archetype)archetype='generic';
 const notApplicable=archetype==='insurer' && /^631/.test(code)?['combinedRatio','lossRatio']:archetype==='reit' && /mortgage/i.test(overview.Industry || '')?['occupancy']:[];
 return {archetype,classificationSource:code?'SEC SIC with industry-profile refinement':'Company industry profile',classificationSourceUrl:code?'https://www.sec.gov/search-filings/standard-industrial-classification-sic-code-list':null,notApplicable,core:['totalRevenue','netIncome','totalAssets','totalShareholderEquity','operatingCashflow'],industry:(fields[archetype] || []).filter(field=>!notApplicable.includes(field)),definitions:'Industry disclosures retain the issuer definition. Undisclosed or unsupported custom measures remain explicit gaps; generic ratios are not mandatory for every industry.'};
}
module.exports={requirements,fields};
