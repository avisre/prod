'use strict';
const CIK='0000000123',ACC='0000000123-26-000001';
function fixture(taxonomy='us-gaap',currency='USD') {
 const keys=taxonomy==='us-gaap'?['Revenues','NetIncomeLoss','Assets','StockholdersEquity','NetCashProvidedByUsedInOperatingActivities']:['Revenue','ProfitLossAttributableToOwnersOfParent','Assets','EquityAttributableToOwnersOfParent','CashFlowsFromUsedInOperatingActivities'];
 const doc={cik:123,entityName:'Example',facts:{[taxonomy]:{}}};
 for(const [i,k] of keys.entries())doc.facts[taxonomy][k]={units:{[currency]:[{val:i===0?0:100,start:[2,3].includes(i)?undefined:'2025-01-01',end:'2025-12-31',accn:ACC,form:taxonomy==='us-gaap'?'10-K':'20-F',filed:'2026-02-01'}]}};
 const evidence={cik:CIK,lastSuccessfulCheckAt:'2026-10-03',latestAnnual:{form:taxonomy==='us-gaap'?'10-K':'20-F',filingDate:'2026-02-01',reportDate:'2025-12-31',accessionNumber:ACC,amendments:[]}};
 return {doc,evidence};
}
module.exports={fixture,CIK,ACC};
