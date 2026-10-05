'use strict';
const {profile}=require('./ask-industry-profile');
const fields={bank:['totalRevenue','netInterestIncome','nonInterestIncome','loans','deposits','netInterestMargin','capitalRatios'],reit:['shortLongTermDebtTotal','ffo','affo','occupancy'],insurer:['premiums','investmentIncome','combinedRatio','lossRatio'],software:['shareBasedCompensation','operatingCashflow','arr'],'semis-hardware':['researchAndDevelopment','grossProfit','operatingIncome'],'pharma-biotech':['researchAndDevelopment','grossProfit','operatingIncome'],consumer:['inventory','operatingCashflow','comparableSales'],energy:['capitalExpenditures','operatingCashflow','shortLongTermDebtTotal'],utility:['capitalExpenditures','operatingCashflow','shortLongTermDebtTotal'],industrial:['capitalExpenditures','operatingCashflow','shortLongTermDebtTotal']};
function requirements(overview={},sic) {
 let archetype;try{archetype=profile(overview.Industry,overview.Sector)?.archetype;}catch(_){}
 if(/^(602|603|609)/.test(String(sic || '')))archetype='bank';
 if(!archetype)archetype='generic';
 return {archetype,core:['totalRevenue','netIncome','totalAssets','totalShareholderEquity','operatingCashflow'],industry:fields[archetype] || [],definitions:'Industry disclosures retain the issuer definition. Undisclosed or unsupported custom measures remain explicit gaps; generic ratios are not mandatory for every industry.'};
}
module.exports={requirements,fields};
